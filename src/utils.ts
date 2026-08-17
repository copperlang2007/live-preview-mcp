import { randomBytes } from 'crypto';
import portfinder from 'portfinder';
import { existsSync, realpathSync } from 'fs';
import { resolve, relative, isAbsolute } from 'path';

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '9000', 10),
  ALLOWED_DIRS: (process.env.ALLOWED_DIRS || process.cwd()).split(',').map(d => {
    try { return realpathSync(resolve(d.trim())); } catch { return resolve(d.trim()); }
  }),
  DOCKER_ENABLED: process.env.DOCKER_ENABLED !== 'false',
  TUNNEL_PROVIDER: (process.env.TUNNEL_PROVIDER || 'cloudflare') as 'cloudflare' | 'ngrok',
  REMOTE_ACCESS: process.env.REMOTE_ACCESS === 'true',
  AUTH_SECRET: process.env.AUTH_SECRET || randomBytes(32).toString('hex'),
  MAX_LOG_LINES: 500,
  READINESS_TIMEOUT_MS: 60_000,
  BIND_HOST: process.env.REMOTE_ACCESS === 'true' ? '0.0.0.0' : '127.0.0.1',
  MAX_CONCURRENT_PREVIEWS: parseInt(process.env.MAX_CONCURRENT_PREVIEWS || '10', 10),
  WS_MAX_CONNECTIONS_PER_PREVIEW: 20,
  WS_RATE_LIMIT_WINDOW_MS: 10_000,
  WS_RATE_LIMIT_MAX: 30,
};

export function isPathAllowed(projectPath: string): boolean {
  let resolved: string;
  try {
    resolved = realpathSync(resolve(projectPath));
  } catch {
    resolved = resolve(projectPath);
  }
  return CONFIG.ALLOWED_DIRS.some(dir => {
    const rel = relative(dir, resolved);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred) {
    try {
      const p = await portfinder.getPortPromise({ port: preferred, stopPort: preferred });
      if (p === preferred) return preferred;
    } catch {}
  }
  return portfinder.getPortPromise({ port: 3000, stopPort: 9999 });
}

export class CircularLogBuffer {
  private lines: string[] = [];
  private max: number;
  private timestamps: string[] = [];
  constructor(max = CONFIG.MAX_LOG_LINES) { this.max = max; }
  append(line: string): void {
    const ts = new Date().toISOString();
    const sanitized = sanitizeLogLine(line);
    this.lines.push(sanitized);
    this.timestamps.push(ts);
    if (this.lines.length > this.max) { this.lines.shift(); this.timestamps.shift(); }
  }
  get(since?: string, limit = 100): { logs: string[]; lastTimestamp: string } {
    let start = 0;
    if (since) {
      const idx = this.timestamps.findIndex(t => t >= since);
      start = idx === -1 ? this.timestamps.length : idx;
    }
    const slice = this.lines.slice(start).slice(-limit);
    const lastTs = this.timestamps[this.timestamps.length - 1] || new Date().toISOString();
    return { logs: slice, lastTimestamp: lastTs };
  }
  clear(): void { this.lines = []; this.timestamps = []; }
}

export function sanitizeLogLine(line: string): string {
  return line
    .replace(/(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|BEARER|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[=:\s]+["']?[^\s"'&]+["']?/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, '[JWT_REDACTED]')
    .replace(/(AKIA|ASIA)[A-Z0-9]{16}/g, '[AWS_KEY_REDACTED]')
    .replace(/xox[baprs]-[0-9a-zA-Z-]+/g, '[SLACK_TOKEN_REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{36}/g, '[GH_TOKEN_REDACTED]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[OPENAI_KEY_REDACTED]');
}

export function generateId(): string { return randomBytes(16).toString('hex'); }
export function generateToken(): string { return randomBytes(32).toString('base64url'); }

export function detectCloudIDE(): { isCloud: boolean; forwardedBase?: string } {
  if (process.env.CODESPACES === 'true' && process.env.CODESPACE_NAME) {
    return { isCloud: true, forwardedBase: `https://${process.env.CODESPACE_NAME}-{port}.app.github.dev` };
  }
  if (process.env.GITPOD_WORKSPACE_ID && process.env.GITPOD_WORKSPACE_URL) {
    const base = process.env.GITPOD_WORKSPACE_URL.replace(/^https?:\/\//, '');
    return { isCloud: true, forwardedBase: `https://{port}-${base}` };
  }
  if (process.env.VSCODE_REMOTE_CONTAINERS_SESSION || process.env.REMOTE_CONTAINERS) {
    return { isCloud: true };
  }
  return { isCloud: false };
}

export function readinessPatterns(framework?: string): RegExp[] {
  const common = [/ready in \d+/i, /Local:\s+https?:\/\//i, /listening on/i, /started server/i, /compiled successfully/i, /webpack compiled/i, /Vite.*ready/i, /Next\.js.*ready/i, /Server running/i, /expo.*started/i, /Metro waiting/i];
  switch (framework) {
    case 'vite': return [/Vite.*ready/i, /Local:\s+http/i, /ready in/i];
    case 'next': return [/Ready in/i, /Local:\s+http/i, /started server/i];
    case 'expo': return [/Metro waiting/i, /exp:\/\//i, /Web is waiting/i, /Starting/i];
    case 'flutter': return [/Flutter run key commands/i, /http:\/\/127\.0\.0\.1/i, /Serving/i];
    default: return common;
  }
}

const SAFE_ENV_KEYS = new Set(['NODE_ENV', 'PORT', 'HOST', 'HOSTNAME', 'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'npm_config_user_agent', 'npm_config_cache', 'CI', 'DEBUG', 'FORCE_COLOR', 'NO_COLOR']);

export function buildSafeEnv(userEnv?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'TERM', 'NODE_ENV']) {
    if (process.env[key]) base[key] = process.env[key]!;
  }
  if (userEnv) {
    for (const [k, v] of Object.entries(userEnv)) {
      if (typeof v !== 'string') continue;
      if (['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONHOME', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'PS4'].includes(k)) continue;
      if (SAFE_ENV_KEYS.has(k) || k.startsWith('NEXT_PUBLIC_') || k.startsWith('VITE_') || k.startsWith('REACT_APP_') || k.startsWith('EXPO_PUBLIC_') || k.startsWith('PUBLIC_')) {
        base[k] = v;
      }
    }
  }
  return base;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private windowMs: number, private max: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    let timestamps = this.hits.get(key) || [];
    timestamps = timestamps.filter(t => now - t < this.windowMs);
    if (timestamps.length >= this.max) {
      this.hits.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }
}
