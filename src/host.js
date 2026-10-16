// Native messaging host. Chrome launches this when the extension calls connectNative().
// Relays: clients (CLI / MCP) <-> Unix socket <-> this process <-> stdio <-> extension.
// stdout belongs to Chrome's framing protocol: never print anything else to it.
import fs from 'node:fs';
import net from 'node:net';
import { HOME, SOCKET, LOG_FILE } from './paths.js';

function log(...args) {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${args.join(' ')}\n`);
  } catch {}
}

export function runHost() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  log('host started, pid', process.pid, 'origin', process.argv.slice(3).join(' '));

  const pending = new Map(); // request id -> reply callback
  let seq = 0;
  let socketIno = null;

  // Chrome -> host: 4-byte little-endian length + UTF-8 JSON.
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      try {
        onExtensionMessage(JSON.parse(body));
      } catch (e) {
        log('bad message from extension', e.message);
      }
    }
  });
  process.stdin.on('end', shutdown);

  function toExtension(msg) {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
  }

  // Chrome rejects host->extension messages over 1 MB, so large requests (uploads) go in chunks.
  const CHUNK = 512 * 1024;
  function sendRequest(msg) {
    const json = JSON.stringify(msg);
    if (json.length <= CHUNK) return toExtension(msg);
    const total = Math.ceil(json.length / CHUNK);
    for (let i = 0; i < total; i++) {
      toExtension({ type: 'chunk', id: msg.id, index: i, total, data: json.slice(i * CHUNK, (i + 1) * CHUNK) });
    }
  }

  function onExtensionMessage(msg) {
    if (msg.type === 'hello') log('extension connected, version', msg.version);
    if (msg.type === 'tool_response') {
      const reply = pending.get(msg.id);
      if (reply) {
        pending.delete(msg.id);
        reply(msg);
      }
    }
  }

  // Clients -> host: newline-delimited JSON { id, tool, args }.
  const server = net.createServer((sock) => {
    let lines = '';
    sock.on('data', (d) => {
      lines += d;
      let i;
      while ((i = lines.indexOf('\n')) >= 0) {
        const line = lines.slice(0, i);
        lines = lines.slice(i + 1);
        handle(line);
      }
    });
    sock.on('error', () => {});

    function handle(line) {
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        return;
      }
      if (req.tool === '__status') {
        sock.write(JSON.stringify({ id: req.id, result: { text: 'connected' } }) + '\n');
        return;
      }
      const id = ++seq;
      pending.set(id, (msg) => {
        if (!sock.destroyed) sock.write(JSON.stringify({ id: req.id, result: msg.result, error: msg.error }) + '\n');
      });
      sock.on('close', () => pending.delete(id));
      sendRequest({ type: 'tool_request', id, tool: req.tool, args: req.args || {} });
    }
  });

  try {
    fs.unlinkSync(SOCKET);
  } catch {}
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    socketIno = fs.statSync(SOCKET).ino;
    log('listening on', SOCKET);
  });
  server.on('error', (e) => {
    log('socket error', e.message);
    process.exit(1);
  });

  function shutdown() {
    // Only remove the socket if it is still ours (a newer host may have replaced it).
    try {
      if (socketIno && fs.statSync(SOCKET).ino === socketIno) fs.unlinkSync(SOCKET);
    } catch {}
    log('host exiting');
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
