import { spawn, ChildProcess } from 'child_process';
import { CONFIG } from './utils.js';

export interface TunnelResult {
  process: ChildProcess;
  publicUrl: string;
}

export async function startTunnel(
  localPort: number,
  provider: 'cloudflare' | 'ngrok' = CONFIG.TUNNEL_PROVIDER
): Promise<TunnelResult> {
  if (provider === 'cloudflare') {
    return startCloudflare(localPort);
  }
  return startNgrok(localPort);
}

function startCloudflare(port: number): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('Cloudflare tunnel timed out'));
      }
    }, 30_000);

    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ process: proc, publicUrl: match[0] });
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with ${code}`));
      }
    });
  });
}

function startNgrok(port: number): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ngrok', ['http', String(port), '--log=stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        proc.kill();
        reject(new Error('ngrok timed out'));
      }
    }, 30_000);

    const onData = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/url=(https:\/\/[a-z0-9-]+\.ngrok[-a-z]*\.app)/) ||
                    text.match(/(https:\/\/[a-z0-9-]+\.ngrok\.io)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ process: proc, publicUrl: match[1] });
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

export function stopTunnel(proc: ChildProcess | null | undefined): void {
  if (proc && !proc.killed) {
    try {
      proc.kill('SIGTERM');
    } catch {}
  }
}
