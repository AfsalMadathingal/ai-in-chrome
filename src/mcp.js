// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). Works with any MCP client.
import readline from 'node:readline';
import { TOOLS } from './tools.js';
import { callTool } from './client.js';

const VERSION = '0.1.0';

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
                'read_page/find for element refs or computer screenshot for visual control.',
            },
          });
        case 'ping':
          return send({ id, result: {} });
        case 'tools/list':
          return send({ id, result: { tools: TOOLS } });
        case 'tools/call': {
          try {
            // One browser: run tool calls strictly in order, even if the client sends them in parallel.
            const run = queue.then(() => callTool(params.name, params.arguments || {}));
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
