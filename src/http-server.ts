import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { CONFIG, RateLimiter } from './utils.js';
import { getPreview, listPreviews, getLogs } from './preview-manager.js';
import { createPreviewProxy } from './proxy.js';
import { validateToken, extractToken } from './auth.js';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '32kb' }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const wsConnections = new Map<string, Set<WebSocket>>();
const wsRateLimiter = new RateLimiter(CONFIG.WS_RATE_LIMIT_WINDOW_MS, CONFIG.WS_RATE_LIMIT_MAX);

function requireAuth(previewIdParam = 'id') {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = req.params[previewIdParam];
    const preview = getPreview(id);
    if (!preview) return res.status(404).json({ error: 'Not found' });
    if (preview.authRequired) {
      const token = extractToken(req);
      if (!validateToken(id, token)) return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

function dashboardHtml(id: string, preview: any): string {
  const qrImg = preview.qrCode
    ? `<img src="${preview.qrCode}" alt="QR Code" style="width:180px;height:180px;margin:8px 0;" />`
    : '';
  const tunnel = preview.tunnelUrl
    ? `<a href="${preview.tunnelUrl}" target="_blank" class="btn">Open Tunnel</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Preview – ${id.slice(0, 8)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; height: 100vh; display: flex; flex-direction: column; }
    .toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #1e293b; border-bottom: 1px solid #334155; }
    .toolbar h1 { font-size: 14px; font-weight: 600; flex: 1; }
    .status { font-size: 12px; padding: 2px 8px; border-radius: 9999px; background: #334155; }
    .status.ready { background: #065f46; color: #a7f3d0; }
    .status.error { background: #7f1d1d; color: #fecaca; }
    .btn { background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; text-decoration: none; }
    .btn:hover { background: #2563eb; }
    .main { flex: 1; display: flex; overflow: hidden; }
    .iframe-wrap { flex: 1; position: relative; background: #000; }
    iframe { width: 100%; height: 100%; border: none; }
    .side { width: 320px; background: #1e293b; border-left: 1px solid #334155; display: flex; flex-direction: column; }
    .logs { flex: 1; overflow-y: auto; padding: 8px; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.4; }
    .log-line { white-space: pre-wrap; word-break: break-all; margin-bottom: 2px; color: #94a3b8; }
    .qr-box { padding: 12px; text-align: center; border-top: 1px solid #334155; }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>Preview ${id.slice(0, 8)}…</h1>
    <span class="status ${preview.status}" id="status">${preview.status}</span>
    <button class="btn" onclick="reload()">Reload</button>
    <a class="btn" href="${preview.localUrl}" target="_blank">Open Direct</a>
    ${tunnel}
  </div>
  <div class="main">
    <div class="iframe-wrap">
      <iframe id="frame" src="/proxy/${id}/" allow="fullscreen"></iframe>
    </div>
    <div class="side">
      <div class="logs" id="logs"></div>
      <div class="qr-box">${qrImg}<div style="font-size:11px;color:#64748b;margin-top:4px;">${preview.expoUrl || ''}</div></div>
    </div>
  </div>
  <script>
    const id = "${id}";
    const logsEl = document.getElementById('logs');
    const statusEl = document.getElementById('status');
    const frame = document.getElementById('frame');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(protocol + '//' + location.host + '/ws/preview/' + id + (location.search || ''));

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'log') {
          const div = document.createElement('div');
          div.className = 'log-line';
          div.textContent = msg.line;
          logsEl.appendChild(div);
          logsEl.scrollTop = logsEl.scrollHeight;
        } else if (msg.type === 'status') {
          statusEl.textContent = msg.status;
          statusEl.className = 'status ' + msg.status;
        } else if (msg.type === 'reload') {
          frame.src = frame.src;
        }
      } catch {}
    };

    function reload() {
      ws.send(JSON.stringify({ action: 'reload' }));
      frame.src = frame.src;
    }

    fetch('/api/preview/' + id + '/logs' + (location.search || ''))
      .then(r => r.json())
      .then(d => {
        (d.logs || []).forEach(l => {
          const div = document.createElement('div');
          div.className = 'log-line';
          div.textContent = l;
          logsEl.appendChild(div);
        });
      }).catch(() => {});
  </script>
</body>
</html>`;
}

app.get('/preview/:id', requireAuth('id'), (req, res) => {
  const preview = getPreview(req.params.id);
  if (!preview) return res.status(404).send('Preview not found');
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(dashboardHtml(req.params.id, preview));
});

app.get('/api/preview/:id/status', requireAuth('id'), (req, res) => {
  const p = getPreview(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: p.status,
    localUrl: p.localUrl,
    dashboardUrl: p.dashboardUrl,
    tunnelUrl: p.tunnelUrl,
    uptime: p.uptime,
    health: p.health,
    containerId: p.container?.id,
    port: p.port,
    framework: p.framework,
  });
});

app.get('/api/preview/:id/logs', requireAuth('id'), (req, res) => {
  try {
    const since = req.query.since as string | undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500);
    const data = getLogs(req.params.id, since, limit);
    res.json(data);
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

app.get('/api/previews', (_req, res) => {
  res.json({
    previews: listPreviews().map(p => ({
      previewId: p.id,
      projectPath: p.projectPath,
      status: p.status,
      localUrl: p.localUrl,
      port: p.port,
      startedAt: p.startedAt.toISOString(),
    })),
  });
});

app.use('/proxy/:id', createPreviewProxy());
app.use('/proxy/:id/*', createPreviewProxy());

app.get('/health', (_req, res) => res.json({ ok: true, previews: listPreviews().length }));

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/ws\/preview\/([a-f0-9-]+)/);
  if (!match) {
    ws.close(1008, 'Invalid path');
    return;
  }
  const id = match[1];
  const preview = getPreview(id);
  if (!preview) {
    ws.close(1008, 'Preview not found');
    return;
  }

  if (preview.authRequired) {
    const token = url.searchParams.get('token');
    if (!validateToken(id, token)) {
      ws.close(1008, 'Unauthorized');
      return;
    }
  }

  const remote = (req.socket.remoteAddress || 'unknown') + ':' + id;
  if (!wsRateLimiter.allow(remote)) {
    ws.close(1008, 'Rate limited');
    return;
  }

  let set = wsConnections.get(id);
  if (!set) {
    set = new Set();
    wsConnections.set(id, set);
  }
  if (set.size >= CONFIG.WS_MAX_CONNECTIONS_PER_PREVIEW) {
    ws.close(1008, 'Too many connections for this preview');
    return;
  }
  set.add(ws);

  ws.send(JSON.stringify({ type: 'status', status: preview.status }));

  let lastTs = '';
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      return;
    }
    try {
      const { logs, lastTimestamp } = getLogs(id, lastTs || undefined, 40);
      lastTs = lastTimestamp;
      for (const line of logs) {
        ws.send(JSON.stringify({ type: 'log', line }));
      }
    } catch {
      clearInterval(interval);
    }
  }, 1200);

  ws.on('message', (data) => {
    if (!wsRateLimiter.allow(remote + ':msg')) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.action === 'reload') {
        const clients = wsConnections.get(id);
        if (clients) {
          for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'reload' }));
            }
          }
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    clearInterval(interval);
    set!.delete(ws);
    if (set!.size === 0) wsConnections.delete(id);
  });
});

export function startHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    server.listen(CONFIG.PORT, CONFIG.BIND_HOST, () => {
      console.error(`[http] Live Preview MCP dashboard listening on http://${CONFIG.BIND_HOST}:${CONFIG.PORT}`);
      resolve();
    });
  });
}

export { app, server };
