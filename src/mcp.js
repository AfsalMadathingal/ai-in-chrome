// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). Works with any MCP client.
import readline from 'node:readline';
import { TOOLS } from './tools.js';
import { callTool } from './client.js';

const VERSION = '0.3.0';

export function runMcp() {
  let queue = Promise.resolve();
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (msg.id === undefined) return; // notification
    const { id, method, params } = msg;
    try {
      switch (method) {
        case 'initialize':
          return send({
            id,
            result: {
              protocolVersion: params?.protocolVersion || '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'ai-in-chrome', version: VERSION },
              instructions:
                'AI in Chrome controls the user\'s real Chrome browser. Start with tabs_context or tabs_create, then use ' +
                'read_page/find for element refs or computer screenshot for visual control. For API debugging use read_network_requests → network_request → http_request / network_intercept.',
            },
          });
        case 'ping':
          return send({ id, result: {} });
        case 'tools/list':
          // approve_action only exists for the Claude Code process the side panel launched.
          return send({ id, result: { tools: process.env.AICHROME_SESSION ? TOOLS : TOOLS.filter((t) => t.name !== 'approve_action') } });
        case 'tools/call': {
          try {
            // One browser: run tool calls strictly in order, even if the client sends them in parallel.
            const args = { ...(params.arguments || {}) };
            if (params.name === 'approve_action') Object.assign(args, { sid: process.env.AICHROME_SESSION, mode: process.env.AICHROME_MODE });
            // Waiting for the side panel must not block the other tools.
            if (params.name === 'sidepanel_wait' || params.name === 'approve_action') {
              const res = await callTool(params.name, args);
              return send({ id, result: { content: [{ type: 'text', text: res.text || '' }] } });
            }
            const run = queue.then(() => callTool(params.name, args));
            queue = run.catch(() => {});
            const res = await run;
            const content = [];
            if (res.text) content.push({ type: 'text', text: res.text });
            if (res.image) content.push({ type: 'image', data: res.image.data, mimeType: res.image.mimeType });
            return send({ id, result: { content } });
          } catch (e) {
            return send({ id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
          }
        }
        default:
          return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      send({ id, error: { code: -32603, message: e.message } });
    }
  });
}
