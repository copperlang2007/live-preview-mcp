import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import type { Request, Response, NextFunction } from 'express';
import { getPreview } from './preview-manager.js';
import { validateToken, extractToken } from './auth.js';

export function createPreviewProxy() {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = req.params.id;
    const preview = getPreview(id);
    if (!preview) {
      res.status(404).json({ error: 'Preview not found' });
      return;
    }

    if (preview.authRequired) {
      const token = extractToken(req);
      if (!validateToken(id, token)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    if (preview.status !== 'ready' && preview.status !== 'starting') {
      res.status(503).json({ error: 'Preview not ready', status: preview.status });
      return;
    }

    const target = `http://127.0.0.1:${preview.port}`;

    const proxyOpts: Options = {
      target,
      changeOrigin: true,
      ws: true,
      pathRewrite: {
        [`^/proxy/${id}`]: '',
      },
      on: {
        proxyRes: (proxyRes) => {
          delete proxyRes.headers['x-frame-options'];
          delete proxyRes.headers['content-security-policy'];
          proxyRes.headers['content-security-policy'] = "frame-ancestors *";
          proxyRes.headers['access-control-allow-origin'] = '*';
          proxyRes.headers['x-content-type-options'] = 'nosniff';
        },
        error: (err, _req, res) => {
          console.error('Proxy error', err.message);
          if (res && typeof (res as any).status === 'function') {
            (res as Response).status(502).json({ error: 'Upstream error', detail: err.message });
          }
        },
      },
    };

    return createProxyMiddleware(proxyOpts)(req, res, next);
  };
}
