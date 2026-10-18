import net from 'node:net';
import { SOCKET } from './paths.js';
import { prepareArgs, saveFile } from './files.js';
import { httpRequest } from './http.js';

const NOT_CONNECTED =
  'AI in Chrome is not connected. Make sure Chrome is running with the AI in Chrome extension loaded, ' +
  'and that you ran `aichrome install` once. Clicking the extension icon forces a reconnect.';

// Call a tool: local file paths are read here, and returned files (e.g. GIFs) are saved here.
export async function callTool(tool, args = {}, opts = {}) {
  // http_request runs here (it may send from Node); it asks the extension for cookies/captures as needed.
  if (tool === 'http_request') return httpRequest(args, (t, a) => sendRaw(t, a, opts));
  const res = await sendRaw(tool, prepareArgs(tool, args), opts);
  if (res.file) {
    const saved = saveFile(res.file, args.save_path);
    return { ...res, file: undefined, text: `${res.text || ''}\nSaved to ${saved}`.trim() };
  }
  return res;
}

// Send one tool call to the native host and resolve with { text, image?, file? }.
function sendRaw(tool, args = {}, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for "${tool}"`));
    }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, tool, args }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      const msg = JSON.parse(buf.slice(0, i));
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result || { text: '' });
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error(NOT_CONNECTED) : e);
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!buf.includes('\n')) reject(new Error('Connection to Chrome closed before a reply (was Chrome or the extension restarted?)'));
    });
  });
}
