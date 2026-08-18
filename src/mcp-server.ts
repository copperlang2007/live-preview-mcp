import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  startPreview,
  stopPreview,
  getPreview,
  listPreviews,
  getLogs,
  reloadPreview,
  updatePreviewConfig,
} from './preview-manager.js';
import { createShareToken, setAuthToken } from './auth.js';
import { generateQRCode } from './mobile.js';
import { CONFIG } from './utils.js';

const server = new Server(
  {
    name: 'live-preview-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'start_preview',
        description: 'Start a live preview of a project. Returns URLs for local, dashboard, proxy, optional tunnel and QR.',
        inputSchema: {
          type: 'object',
          properties: {
            projectPath: { type: 'string', description: 'Absolute or relative path to the project root' },
            command: { type: 'string', description: 'Optional override for the start command' },
            buildCommand: { type: 'string' },
            port: { type: 'number' },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            framework: { type: 'string' },
            useContainer: { type: 'boolean', default: false },
            tunnel: { type: 'boolean', default: false },
            tunnelProvider: { type: 'string', enum: ['cloudflare', 'ngrok'] },
            mobile: { type: 'boolean' },
            authRequired: { type: 'boolean' },
          },
          required: ['projectPath'],
        },
      },
      {
        name: 'stop_preview',
        description: 'Stop a running preview and clean up processes/containers/tunnels',
        inputSchema: {
          type: 'object',
          properties: {
            previewId: { type: 'string' },
          },
          required: ['previewId'],
        },
      },
      {
        name: 'get_preview_status',
        description: 'Get current status, URLs and health of a preview',
        inputSchema: {
          type: 'object',
          properties: {
            previewId: { type: 'string' },
          },
          required: ['previewId'],
        },
      },
      {
        name: 'get_preview_logs',
        description: 'Retrieve recent logs from a preview',
        inputSchema: {
          type: 'object',
          properties: {
            previewId: { type: 'string' },
            since: { type: 'string', description: 'ISO timestamp' },
            limit: { type: 'number', default: 100 },
          },
          required: ['previewId'],
        },
      },
      {
        name: 'list_previews',
        description: 'List all active previews',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'reload_preview',
        description: 'Trigger a reload of the preview (useful for HMR or force refresh)',
        inputSchema: {
          type: 'object',
          properties: {
            previewId: { type: 'string' },
          },
          required: ['previewId'],
        },
      },
      {
        name: 'update_preview_config',
        description: 'Update command/env/port and restart the preview',
        inputSchema: {
          type: 'object',
          properties: {
            previewId: { type: 'string' },
            command: { type: 'string' },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            port: { type: 'number' },
          },
          required: ['previewId'],
        },
      },
      {
        name: 'share_preview',
        description: 'Create a shareable link with optional expiration and token',
        inputSchema: {
          type: 'object',
          properties: {
            previewId: { type: 'string' },
            expiresIn: { type: 'string', description: 'e.g. 1h, 30m, 2d' },
            allowAnonymous: { type: 'boolean' },
          },
          required: ['previewId'],
        },
      },
      {
        name: 'get_mobile_qr',
        description: 'Get QR code data URL and expo URL for mobile previews',
        inputSchema: {
          type: 'object',
          properties: {
            previewId: { type: 'string' },
          },
          required: ['previewId'],
        },
      },
      {
        name: 'set_auth_token',
        description: 'Set or override the access token for a preview',
        inputSchema: {
          type: 'object',
          properties: {
            previewId: { type: 'string' },
            token: { type: 'string' },
          },
          required: ['previewId', 'token'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'start_preview': {
        const preview = await startPreview(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                previewId: preview.id,
                status: preview.status,
                localUrl: preview.localUrl,
                dashboardUrl: preview.dashboardUrl,
                proxyUrl: preview.proxyUrl,
                tunnelUrl: preview.tunnelUrl,
                qrCode: preview.qrCode,
                expoUrl: preview.expoUrl,
              }, null, 2),
            },
          ],
        };
      }
      case 'stop_preview': {
        const ok = await stopPreview((args as any).previewId);
        return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
      }
      case 'get_preview_status': {
        const p = getPreview((args as any).previewId);
        if (!p) throw new Error('Preview not found');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: p.status,
                localUrl: p.localUrl,
                dashboardUrl: p.dashboardUrl,
                tunnelUrl: p.tunnelUrl,
                uptime: p.uptime,
                health: p.health,
                containerId: p.container?.id,
              }),
            },
          ],
        };
      }
      case 'get_preview_logs': {
        const data = getLogs((args as any).previewId, (args as any).since, (args as any).limit);
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }
      case 'list_previews': {
        const list = listPreviews().map(p => ({
          previewId: p.id,
          projectPath: p.projectPath,
          status: p.status,
          localUrl: p.localUrl,
          port: p.port,
          startedAt: p.startedAt.toISOString(),
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ previews: list }) }] };
      }
      case 'reload_preview': {
        const ok = await reloadPreview((args as any).previewId);
        return { content: [{ type: 'text', text: JSON.stringify({ success: ok }) }] };
      }
      case 'update_preview_config': {
        const preview = await updatePreviewConfig((args as any).previewId, args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                previewId: preview.id,
                status: preview.status,
                localUrl: preview.localUrl,
                dashboardUrl: preview.dashboardUrl,
                proxyUrl: preview.proxyUrl,
                tunnelUrl: preview.tunnelUrl,
              }),
            },
          ],
        };
      }
      case 'share_preview': {
        const { previewId, expiresIn, allowAnonymous } = args as any;
        const p = getPreview(previewId);
        if (!p) throw new Error('Preview not found');
        const { token, expiresAt } = createShareToken(previewId, expiresIn || '1h', !!allowAnonymous);
        const shareUrl = `${p.dashboardUrl}?token=${token}`;
        return {
          content: [{ type: 'text', text: JSON.stringify({ shareUrl, expiresAt }) }],
        };
      }
      case 'get_mobile_qr': {
        const p = getPreview((args as any).previewId);
        if (!p) throw new Error('Preview not found');
        let qr = p.qrCode;
        if (!qr && p.expoUrl) qr = await generateQRCode(p.expoUrl);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ qrCode: qr, expoUrl: p.expoUrl }),
            },
          ],
        };
      }
      case 'set_auth_token': {
        setAuthToken((args as any).previewId, (args as any).token);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const previews = listPreviews();
  const resources = previews.flatMap(p => [
    {
      uri: `preview://${p.id}/logs`,
      name: `Logs for ${p.id.slice(0, 8)}`,
      mimeType: 'text/plain',
    },
    {
      uri: `preview://${p.id}/status`,
      name: `Status for ${p.id.slice(0, 8)}`,
      mimeType: 'application/json',
    },
    {
      uri: `preview://${p.id}/dashboard`,
      name: `Dashboard URL for ${p.id.slice(0, 8)}`,
      mimeType: 'text/uri-list',
    },
  ]);
  if (previews.some(p => p.qrCode)) {
    previews.filter(p => p.qrCode).forEach(p => {
      resources.push({
        uri: `preview://${p.id}/qr`,
        name: `QR for ${p.id.slice(0, 8)}`,
        mimeType: 'image/png',
      });
    });
  }
  return { resources };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const match = uri.match(/^preview:\/\/([a-f0-9-]+)\/(logs|status|dashboard|qr)$/);
  if (!match) throw new Error('Invalid resource URI');
  const [, id, kind] = match;
  const p = getPreview(id);
  if (!p) throw new Error('Preview not found');

  switch (kind) {
    case 'logs': {
      const { logs } = getLogs(id, undefined, 200);
      return {
        contents: [{ uri, mimeType: 'text/plain', text: logs.join('\n') }],
      };
    }
    case 'status': {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              status: p.status,
              localUrl: p.localUrl,
              dashboardUrl: p.dashboardUrl,
              tunnelUrl: p.tunnelUrl,
              health: p.health,
              uptime: p.uptime,
            }),
          },
        ],
      };
    }
    case 'dashboard': {
      return {
        contents: [{ uri, mimeType: 'text/uri-list', text: p.dashboardUrl }],
      };
    }
    case 'qr': {
      if (!p.qrCode) throw new Error('No QR available');
      return {
        contents: [{ uri, mimeType: 'text/plain', text: p.qrCode }],
      };
    }
    default:
      throw new Error('Unknown resource kind');
  }
});

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] Live Preview MCP server running on stdio');
}
