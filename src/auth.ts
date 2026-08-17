import { generateToken, CONFIG } from './utils.js';

interface TokenEntry {
  token: string;
  previewId: string;
  expiresAt: number;
  allowAnonymous: boolean;
}

const tokens = new Map<string, TokenEntry>(); // token -> entry
const previewTokens = new Map<string, string>(); // previewId -> token

export function createShareToken(
  previewId: string,
  expiresIn: string = '1h',
  allowAnonymous = false
): { token: string; expiresAt: string } {
  // parse expiresIn simple: 1h, 30m, 2d
  let ms = 3600_000;
  const match = expiresIn.match(/^(\d+)([hmd])$/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (match[2] === 'h') ms = n * 3600_000;
    else if (match[2] === 'm') ms = n * 60_000;
    else if (match[2] === 'd') ms = n * 86400_000;
  }

  const token = generateToken();
  const expiresAt = Date.now() + ms;
  const entry: TokenEntry = { token, previewId, expiresAt, allowAnonymous };
  tokens.set(token, entry);
  previewTokens.set(previewId, token);

  // cleanup expired periodically
  setTimeout(() => {
    tokens.delete(token);
    if (previewTokens.get(previewId) === token) previewTokens.delete(previewId);
  }, ms + 1000);

  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export function setAuthToken(previewId: string, token: string): void {
  const expiresAt = Date.now() + 24 * 3600_000; // 24h default
  tokens.set(token, { token, previewId, expiresAt, allowAnonymous: false });
  previewTokens.set(previewId, token);
}

export function validateToken(previewId: string, provided?: string | null): boolean {
  const required = previewTokens.get(previewId);
  if (!required) return true; // no auth required

  if (!provided) return false;
  const entry = tokens.get(provided);
  if (!entry) return false;
  if (entry.previewId !== previewId) return false;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(provided);
    previewTokens.delete(previewId);
    return false;
  }
  return true;
}

export function getTokenForPreview(previewId: string): string | undefined {
  return previewTokens.get(previewId);
}

export function clearAuth(previewId: string): void {
  const t = previewTokens.get(previewId);
  if (t) {
    tokens.delete(t);
    previewTokens.delete(previewId);
  }
}

export function extractToken(req: { headers: any; query: any }): string | null {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.query?.token) return String(req.query.token);
  return null;
}
