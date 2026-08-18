import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import treeKill from 'tree-kill';
import { v4 as uuidv4 } from 'uuid';
import {
  CircularLogBuffer,
  findFreePort,
  isPathAllowed,
  readinessPatterns,
  detectCloudIDE,
  CONFIG,
  buildSafeEnv,
} from './utils.js';
import { detectFramework, DetectionResult } from './detector.js';
import { startTunnel, stopTunnel } from './tunnel.js';
import { startContainer, stopContainer, isDockerAvailable, ContainerInfo, reapOrphanContainers } from './docker.js';
import { generateQRCode, extractExpoUrl } from './mobile.js';
import { createShareToken, setAuthToken, clearAuth } from './auth.js';

export type PreviewStatus = 'starting' | 'ready' | 'error' | 'stopped';

export interface Preview {
  id: string;
  projectPath: string;
  status: PreviewStatus;
  localUrl: string;
  dashboardUrl: string;
  proxyUrl: string;
  tunnelUrl?: string;
  qrCode?: string;
  expoUrl?: string;
  port: number;
  process?: ChildProcess;
  container?: ContainerInfo;
  tunnelProc?: ChildProcess;
  logs: CircularLogBuffer;
  startedAt: Date;
  framework?: string;
  command: string;
  env: Record<string, string>;
  useContainer: boolean;
  mobile: boolean;
  authRequired: boolean;
  health: 'healthy' | 'unhealthy' | 'unknown';
  uptime: number;
}

const previews = new Map<string, Preview>();

export function listPreviews(): Preview[] {
  return Array.from(previews.values()).map(p => ({
    ...p,
    uptime: Date.now() - p.startedAt.getTime(),
  }));
}

export function getPreview(id: string): Preview | undefined {
  const p = previews.get(id);
  if (p) p.uptime = Date.now() - p.startedAt.getTime();
  return p;
}

function isProcessAlive(preview: Preview): boolean {
  if (preview.container) return true;
  if (!preview.process || preview.process.killed) return false;
  try {
    process.kill(preview.process.pid!, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForReadiness(
  preview: Preview,
  patterns: RegExp[],
  timeoutMs = CONFIG.READINESS_TIMEOUT_MS
): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = async () => {
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      if (!isProcessAlive(preview) && !preview.container) {
        resolve(false);
        return;
      }
      const { logs } = preview.logs.get(undefined, 80);
      for (const line of logs) {
        for (const re of patterns) {
          if (re.test(line)) {
            resolve(true);
            return;
          }
        }
      }
      if (Date.now() - start > 2500) {
        try {
          const res = await fetch(preview.localUrl, { signal: AbortSignal.timeout(1500) });
          if (res.status >= 200 && res.status < 500) {
            resolve(true);
            return;
          }
        } catch {}
      }
      setTimeout(check, 700);
    };
    check();
  });
}

export async function startPreview(opts: {
  projectPath: string;
  command?: string;
  buildCommand?: string;
  port?: number;
  env?: Record<string, string>;
  framework?: string;
  useContainer?: boolean;
  tunnel?: boolean;
  tunnelProvider?: 'cloudflare' | 'ngrok';
  mobile?: boolean;
  authRequired?: boolean;
}): Promise<Preview> {
  const active = Array.from(previews.values()).filter(p => p.status === 'starting' || p.status === 'ready').length;
  if (active >= CONFIG.MAX_CONCURRENT_PREVIEWS) {
    throw new Error(`Maximum concurrent previews (${CONFIG.MAX_CONCURRENT_PREVIEWS}) reached`);
  }

  const projectPath = resolve(opts.projectPath);
  if (!isPathAllowed(projectPath)) {
    throw new Error(`Project path not allowed: ${projectPath}. Allowed roots: ${CONFIG.ALLOWED_DIRS.join(', ')}`);
  }

  const detection: DetectionResult = detectFramework(projectPath);
  const framework = opts.framework || detection.framework;
  let command = opts.command || detection.command;
  if (!command) {
    throw new Error(`Could not detect framework or command for ${projectPath}. Provide a command.`);
  }

  if (opts.buildCommand) {
    try {
      const [bCmd, ...bArgs] = opts.buildCommand.trim().split(/\s+/).filter(Boolean);
      await new Promise<void>((res, rej) => {
        const b = spawn(bCmd, bArgs, { cwd: projectPath, stdio: 'ignore', shell: false });
        b.on('exit', code => (code === 0 ? res() : rej(new Error(`build exited ${code}`))));
        b.on('error', rej);
        setTimeout(() => { try { b.kill(); } catch {}; rej(new Error('build timeout')); }, 120_000);
      });
    } catch (e) {
      console.error('[buildCommand]', (e as Error).message);
    }
  }

  const isMobile = opts.mobile ?? detection.isMobile;
  const useContainer = opts.useContainer ?? false;
  const port = await findFreePort(opts.port || detection.portHint);
  const id = uuidv4();
  const cloud = detectCloudIDE();

  let localUrl = `http://127.0.0.1:${port}`;
  if (cloud.isCloud && cloud.forwardedBase) {
    localUrl = cloud.forwardedBase.replace('{port}', String(port));
  }

  const baseHttp = `http://${CONFIG.BIND_HOST === '0.0.0.0' ? '127.0.0.1' : CONFIG.BIND_HOST}:${CONFIG.PORT}`;
  const dashboardUrl = `${baseHttp}/preview/${id}`;
  const proxyUrl = `${baseHttp}/proxy/${id}/`;

  const safeEnv = buildSafeEnv(opts.env);
  safeEnv.PORT = String(port);
  safeEnv.HOST = '0.0.0.0';

  const preview: Preview = {
    id,
    projectPath,
    status: 'starting',
    localUrl,
    dashboardUrl,
    proxyUrl,
    port,
    logs: new CircularLogBuffer(),
    startedAt: new Date(),
    framework,
    command,
    env: safeEnv,
    useContainer,
    mobile: isMobile,
    authRequired: opts.authRequired ?? false,
    health: 'unknown',
    uptime: 0,
  };

  previews.set(id, preview);

  try {
    if (useContainer && (await isDockerAvailable())) {
      const container = await startContainer(projectPath, command, port, safeEnv);
      preview.container = container;
      preview.logs.append(`[docker] started container ${container.id.slice(0, 12)} (no-shell, CapDrop=ALL)`);
    } else {
      const argv = command.trim().split(/\s+/).filter(Boolean);
      if (argv.length === 0) throw new Error('Empty command');
      const [cmd, ...args] = argv;
      const child = spawn(cmd, args, {
        cwd: projectPath,
        env: safeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: false,
      });
      preview.process = child;

      child.stdout?.on('data', (d: Buffer) => {
        d.toString().split('\n').filter(Boolean).forEach(l => preview.logs.append(l));
      });
      child.stderr?.on('data', (d: Buffer) => {
        d.toString().split('\n').filter(Boolean).forEach(l => preview.logs.append(`[stderr] ${l}`));
      });
      child.on('exit', (code) => {
        if (preview.status !== 'stopped') {
          preview.status = 'error';
          preview.health = 'unhealthy';
          preview.logs.append(`[process] exited with code ${code}`);
        }
      });
      child.on('error', (err) => {
        preview.logs.append(`[process] spawn error: ${err.message}`);
        preview.status = 'error';
      });
    }

    if (opts.tunnel && !cloud.isCloud) {
      try {
        const t = await startTunnel(port, opts.tunnelProvider);
        preview.tunnelProc = t.process;
        preview.tunnelUrl = t.publicUrl;
        preview.logs.append(`[tunnel] ${t.publicUrl}`);
      } catch (err) {
        preview.logs.append(`[tunnel] failed: ${(err as Error).message}`);
      }
    }

    const patterns = readinessPatterns(framework);
    const ready = await waitForReadiness(preview, patterns);
    if (ready) {
      preview.status = 'ready';
      preview.health = 'healthy';
    } else {
      preview.status = 'error';
      preview.health = 'unhealthy';
      preview.logs.append('[readiness] timed out or process died');
    }

    if (isMobile || framework === 'expo' || framework === 'flutter') {
      const { logs } = preview.logs.get(undefined, 200);
      const expoUrl = extractExpoUrl(logs) || preview.tunnelUrl || localUrl;
      preview.expoUrl = expoUrl;
      try {
        preview.qrCode = await generateQRCode(expoUrl);
      } catch (e) {
        preview.logs.append(`[qr] ${(e as Error).message}`);
      }
    }

    if (preview.authRequired) {
      const { token } = createShareToken(id, '24h', false);
      setAuthToken(id, token);
    }

    return preview;
  } catch (err) {
    preview.status = 'error';
    preview.health = 'unhealthy';
    preview.logs.append(`[error] ${(err as Error).message}`);
    try { await stopPreview(id); } catch {}
    throw err;
  }
}

export async function stopPreview(id: string): Promise<boolean> {
  const preview = previews.get(id);
  if (!preview) return false;

  preview.status = 'stopped';
  clearAuth(id);

  if (preview.process && preview.process.pid) {
    try {
      await new Promise<void>((res) => {
        treeKill(preview.process!.pid!, 'SIGTERM', (err) => {
          if (err) {
            try { preview.process!.kill('SIGKILL'); } catch {}
          }
          res();
        });
      });
    } catch {
      try { preview.process.kill('SIGKILL'); } catch {}
    }
  }

  if (preview.container) {
    await stopContainer(preview.container.id);
  }

  stopTunnel(preview.tunnelProc);
  previews.delete(id);
  return true;
}

export async function reloadPreview(id: string): Promise<boolean> {
  const preview = previews.get(id);
  if (!preview) return false;
  preview.logs.append('[reload] requested');
  return true;
}

export async function updatePreviewConfig(
  id: string,
  updates: { command?: string; env?: Record<string, string>; port?: number }
): Promise<Preview> {
  const old = previews.get(id);
  if (!old) throw new Error('Preview not found');

  await stopPreview(id);
  return startPreview({
    projectPath: old.projectPath,
    command: updates.command || old.command,
    env: updates.env ? { ...old.env, ...updates.env } : old.env,
    port: updates.port || old.port,
    useContainer: old.useContainer,
    mobile: old.mobile,
    authRequired: old.authRequired,
    framework: old.framework,
  });
}

export function getLogs(id: string, since?: string, limit = 100) {
  const p = previews.get(id);
  if (!p) throw new Error('Preview not found');
  return p.logs.get(since, limit);
}

export async function startupCleanup(): Promise<void> {
  try {
    const n = await reapOrphanContainers();
    if (n > 0) console.error(`[cleanup] reaped ${n} orphan containers`);
  } catch (e) {
    console.error('[cleanup]', (e as Error).message);
  }
}
