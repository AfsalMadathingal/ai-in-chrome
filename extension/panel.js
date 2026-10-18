// Side panel backend: chat transcripts, routing to the AI (a headless Claude Code / Codex run by the native host,
// or an AI already open in the user's terminal that listens with sidepanel_wait), and permission prompts.

let deps; // { hostSend(msg) -> boolean, setCurrentTab(id) }
let seq = 0;

const ports = new Map(); // sid -> Set<Port>
const chats = new Map(); // sid -> { events: [], busy, sessionId, kind }
const approvals = new Map(); // id -> resolve(decision)
const allowed = new Map(); // sid -> Set<key> ("Always allow" for this chat)
const inbox = []; // messages waiting for the terminal AI
const waiters = []; // pending sidepanel_wait calls
let terminalSid = null; // chat the terminal AI is answering
let terminalSeen = 0; // last time a terminal AI listened

const EVENT_LIMIT = 1500;
const TERMINAL_FRESH_MS = 15 * 60 * 1000;

export function initPanel(d) {
  deps = d;
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// ---------- transcript ----------

async function chat(sid) {
  let c = chats.get(sid);
  if (!c) {
    const saved = (await chrome.storage.local.get(`chat:${sid}`))[`chat:${sid}`];
    c = { events: [], busy: false, sessionId: null, ...saved, busy: false };
    chats.set(sid, c);
  }
  return c;
}

const KEEP_IMAGES = 8; // screenshots kept in a saved chat (newest first)

function persist(sid) {
  const c = chats.get(sid);
  if (!c) return;
  let images = 0;
  const events = c.events.slice(-EVENT_LIMIT).reverse().map((ev) => {
    if (!ev.image) return ev;
    return ++images <= KEEP_IMAGES ? ev : { ...ev, image: undefined };
  }).reverse();
  chrome.storage.local.set({ [`chat:${sid}`]: { events, sessionId: c.sessionId, kind: c.kind } });
}

// ---------- chat list (history drawer) ----------

async function chatIndex() {
  return (await chrome.storage.local.get('chatIndex')).chatIndex || {};
}

async function touchChat(sid, fields) {
  const index = await chatIndex();
  index[sid] = { ...index[sid], ...fields, updated: Date.now() };
  await chrome.storage.local.set({ chatIndex: index });
}

async function listChats() {
  const index = await chatIndex();
  return Object.entries(index).map(([sid, v]) => ({ sid, ...v })).sort((a, b) => b.updated - a.updated);
}

async function deleteChat(sid) {
  stop(sid);
  deps.hostSend({ type: 'agent_reset', sid });
  chats.delete(sid);
  allowed.delete(sid);
  const index = await chatIndex();
  delete index[sid];
  await chrome.storage.local.set({ chatIndex: index });
  await chrome.storage.local.remove(`chat:${sid}`);
}

function broadcast(sid, msg) {
  for (const p of ports.get(sid) || []) {
    try {
      p.postMessage(msg);
    } catch {}
  }
}

function broadcastAll(msg) {
  for (const sid of ports.keys()) broadcast(sid, msg);
}

// Record an event in the chat and show it in every panel open on that chat.
export async function emit(sid, ev) {
  const c = await chat(sid);
  ev.ts ??= Date.now();
  const last = c.events[c.events.length - 1];
  if (last?.t === 'thinking' && ev.t !== 'thinking' && ev.t !== 'busy' && !last.end) last.end = ev.ts;
  if (ev.t === 'delta') {
    if (last?.t === 'delta') last.text += ev.text;
    else c.events.push({ ...ev });
  } else if (ev.t === 'thinking') {
    if (last?.t === 'thinking') {
      last.text = (last.text || '') + (ev.text || '');
      last.end = ev.ts;
    } else c.events.push({ ...ev, text: ev.text || '' });
  } else if (ev.t === 'text' && last?.t === 'delta') c.events[c.events.length - 1] = ev;
  else if (ev.t !== 'busy' && ev.t !== 'available') c.events.push(ev);
  if (ev.t === 'session') c.sessionId = ev.id;
  if (ev.t === 'busy') c.busy = ev.on;
  if (c.events.length > EVENT_LIMIT) c.events.splice(0, c.events.length - EVENT_LIMIT);
  broadcast(sid, { type: 'event', ev });
  if ((ev.t === 'busy' && !ev.on) || ev.t === 'user') persist(sid);
}

// Events from the native host (headless Claude Code / Codex).
export function onAgentEvent(sid, ev) {
  emit(sid, ev);
}

// ---------- panel connections ----------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  let sid = null;
  const subscribe = (next) => {
    if (sid) ports.get(sid)?.delete(port);
    sid = next;
    if (!ports.has(sid)) ports.set(sid, new Set());
    ports.get(sid).add(port);
  };
  port.onDisconnect.addListener(() => sid && ports.get(sid)?.delete(port));
  port.onMessage.addListener(async (msg) => {
    try {
      if (msg.type === 'hello') {
        subscribe(msg.sid);
        const c = await chat(msg.sid);
        port.postMessage({ type: 'history', events: c.events, busy: c.busy, terminal: terminalStatus() });
        if (!deps.hostSend({ type: 'agent_list', sid: msg.sid })) port.postMessage({ type: 'event', ev: { t: 'available', host: false } });
      } else if (msg.type === 'send') await send(msg);
      else if (msg.type === 'stop') stop(msg.sid);
      else if (msg.type === 'list_chats') port.postMessage({ type: 'chats', chats: await listChats() });
      else if (msg.type === 'delete_chat' || msg.type === 'reset') {
        await deleteChat(msg.sid);
        port.postMessage({ type: 'chats', chats: await listChats() });
      } else if (msg.type === 'approve') approvals.get(msg.id)?.(msg.decision);
    } catch (e) {
      port.postMessage({ type: 'event', ev: { t: 'error', message: String(e.message || e) } });
    }
  });
});

async function tabLine(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab ? `[Tab ${tab.id}: ${tab.title || ''} — ${tab.url || ''}]` : '[No tab]';
}

async function send({ sid, kind, text, tabId, cwd, mode, model, images = [], thumbs = [] }) {
  const c = await chat(sid);
  if (c.busy) throw new Error('Still working. Press Stop first.');
  c.kind = kind;
  if (tabId != null) deps.setCurrentTab(tabId);
  const line = await tabLine(tabId);
  await emit(sid, { t: 'user', text, tab: line, thumbs: thumbs.length ? thumbs : undefined });
  const index = await chatIndex();
  await touchChat(sid, { title: index[sid]?.title || text.replace(/\s+/g, ' ').slice(0, 80) || 'Image', kind });
  const full = `${line}\n${text}`;

  if (kind === 'terminal') {
    await emit(sid, { t: 'busy', on: true });
    if (images.length) await emit(sid, { t: 'notice', text: 'Images are not passed to a terminal AI; only the text was sent.' });
    inbox.push({ sid, text: full });
    flushInbox();
    if (!terminalListening()) await emit(sid, { t: 'notice', text: 'Queued. No terminal AI is listening right now: in your terminal AI, say "listen to the AI in Chrome side panel".' });
    return;
  }
  if (!deps.hostSend({ type: 'agent_send', sid, kind, text: full, cwd, mode, model, images, sessionId: c.sessionId })) {
    throw new Error('Native host not connected. Run `aichrome install`, then click the extension icon.');
  }
}

function stop(sid) {
  const c = chats.get(sid);
  if (c?.kind === 'terminal') {
    for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].sid === sid) inbox.splice(i, 1);
    if (terminalSid === sid) terminalSid = null;
    emit(sid, { t: 'stopped' });
    emit(sid, { t: 'busy', on: false });
    return;
  }
  deps.hostSend({ type: 'agent_stop', sid });
  for (const [id, resolve] of approvals) if (id.startsWith(`${sid}:`)) resolve('deny');
}

// ---------- permissions (Claude Code --permission-prompt-tool) ----------

const READ_ONLY = new Set(['tabs_context', 'read_page', 'find', 'get_page_text', 'read_console_messages', 'read_network_requests', 'sidepanel_reply']);
const READ_ONLY_COMPUTER = new Set(['screenshot', 'zoom', 'wait', 'scroll', 'scroll_to', 'hover', 'mouse_move']);

function permissionKey(tool, input) {
  const short = tool.replace(/^mcp__ai-in-chrome__/, '');
  if (short === 'computer') return `computer:${input?.action}`;
  if (short === 'navigate' || short === 'tabs_create') {
    try {
      return `${short}:${new URL(/^https?:/.test(input?.url) ? input.url : `https://${input?.url}`).hostname}`;
    } catch {
      return short;
    }
  }
  return short;
}

export async function approve_action({ sid, mode, tool_name: tool = '', input = {} }) {
  const allow = JSON.stringify({ behavior: 'allow', updatedInput: input });
  const deny = (message) => JSON.stringify({ behavior: 'deny', message });
  const browser = tool.startsWith('mcp__ai-in-chrome__');
  const short = tool.replace(/^mcp__ai-in-chrome__/, '');
  if (short === 'approve_action') return deny('Not allowed.');
  if (browser && mode === 'auto') return allow;
  if (browser && (READ_ONLY.has(short) || (short === 'computer' && READ_ONLY_COMPUTER.has(input.action)))) return allow;
  const key = browser ? permissionKey(tool, input) : tool;
  if (allowed.get(sid)?.has(key)) return allow;
  if (!sid || !ports.get(sid)?.size) return deny('The AI in Chrome side panel is closed, so the user could not approve this action.');

  const id = `${sid}:${++seq}`;
  await emit(sid, { t: 'permission', id, tool: browser ? short : tool, key, input: JSON.stringify(input).slice(0, 1500) });
  const decision = await new Promise((resolve) => {
    approvals.set(id, resolve);
    setTimeout(() => resolve('timeout'), 5 * 60 * 1000);
  });
  approvals.delete(id);
  await emit(sid, { t: 'permission_done', id, decision });
  if (decision === 'always') {
    if (!allowed.has(sid)) allowed.set(sid, new Set());
    allowed.get(sid).add(key);
  }
  if (decision === 'allow' || decision === 'always') return allow;
  return deny(decision === 'timeout' ? 'No answer from the user within 5 minutes.' : 'The user denied this action in the side panel. Ask what they want instead.');
}

// ---------- terminal AI channel ----------

const terminalListening = () => waiters.length > 0 || Date.now() - terminalSeen < 30000;
const terminalStatus = () => ({ listening: waiters.length > 0, recent: Date.now() - terminalSeen < TERMINAL_FRESH_MS });

function flushInbox() {
  while (inbox.length && waiters.length) {
    const msg = inbox.shift();
    const w = waiters.shift();
    clearTimeout(w.timer);
    terminalSid = msg.sid;
    w.resolve(
      `Message from the user in the AI in Chrome side panel:\n${msg.text}\n\n` +
      'Do what they ask using the browser tools (your activity is shown in the panel), then answer with sidepanel_reply, ' +
      'then call sidepanel_wait again to keep listening.',
    );
  }
  broadcastAll({ type: 'terminal', ...terminalStatus() });
}

export async function sidepanel_wait({ timeout = 600 }) {
  terminalSeen = Date.now();
  const p = new Promise((resolve) => {
    const w = { resolve };
    w.timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      terminalSeen = Date.now();
      broadcastAll({ type: 'terminal', ...terminalStatus() });
      resolve('No message yet. Call sidepanel_wait again to keep listening (or stop if the user is done).');
    }, Math.min(Number(timeout) || 600, 3600) * 1000);
    waiters.push(w);
  });
  flushInbox();
  return p;
}

export async function sidepanel_reply({ text, done = true }) {
  if (!terminalSid) throw new Error('No side panel message is waiting for a reply. Call sidepanel_wait first.');
  terminalSeen = Date.now();
  const sid = terminalSid;
  await emit(sid, { t: 'text', text: String(text ?? ''), agent: 'terminal' });
  if (done) {
    terminalSid = null;
    await emit(sid, { t: 'done' });
    await emit(sid, { t: 'busy', on: false });
  }
  return 'Shown in the side panel. Call sidepanel_wait to get the next message.';
}

// While the terminal AI works on a panel message, mirror its browser tool calls into the chat.
export function onToolCall(name, args) {
  if (!terminalSid || name.startsWith('sidepanel_') || name.startsWith('__') || name === 'approve_action') return null;
  const sid = terminalSid;
  const id = `t${++seq}`;
  const { tabId, ...rest } = args || {};
  emit(sid, { t: 'tool', id, name, input: JSON.stringify(rest).slice(0, 400) });
  return (ok, text) => emit(sid, { t: 'tool_result', id, ok, text: String(text || '').slice(0, 300) });
}
