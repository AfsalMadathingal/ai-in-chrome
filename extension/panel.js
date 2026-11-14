// Side panel backend: chat transcripts, routing to the AI (a headless Claude Code / Codex run by the native host,
// or an AI already open in the user's terminal that listens with sidepanel_wait), and permission prompts.

let deps; // { hostSend(msg) -> boolean, setCurrentTab(id), runTool(name, args), refAt(ref, ts), locate(target), settle() }
let seq = 0;

const ports = new Map(); // sid -> Set<Port>
const chats = new Map(); // sid -> { events: [], busy, sessionId, kind }
const approvals = new Map(); // id -> { resolve(decision), browser }
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
  chrome.storage.local.set({ [`chat:${sid}`]: { events, sessionId: c.sessionId, kind: c.kind, parent: c.parent, agent: c.agent, url: c.url, bgTasks: c.bgTasks } });
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
  if (ev.t === 'busy' && !ev.on && c.queue?.length) setTimeout(() => flushQueue(sid), 0);
  if (c.events.length > EVENT_LIMIT) c.events.splice(0, c.events.length - EVENT_LIMIT);
  broadcast(sid, { type: 'event', ev });
  if (c.parent) bgProgress(sid, c, ev);
  if ((ev.t === 'busy' && !ev.on) || ev.t === 'user') persist(sid);
}

// Events from the native host (headless Claude Code / Codex).
export function onAgentEvent(sid, ev) {
  // Side results, not part of the chat.
  if (ev.t === 'voice_fixed' || ev.t === 'suggested' || ev.t === 'folder_picked') return broadcast(sid, { type: ev.t, id: ev.id, text: ev.text, error: ev.error });
  // Plan usage belongs to the account, not the chat: every panel reads it from storage.
  if (ev.t === 'usage') return ev.info && chrome.storage.local.set({ claudeUsage: { ...ev.info, at: Date.now() } });
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
        port.postMessage({ type: 'history', events: c.events, busy: c.busy, terminal: terminalStatus(), parent: c.parent, agent: c.agent });
        port.postMessage(queueMsg(msg.sid, c));
        await listAgents(msg.sid, port);
      } else if (msg.type === 'send') await send(msg);
      else if (msg.type === 'stop') stop(msg.sid, { restore: true });
      else if (msg.type === 'send_now') stop(msg.sid);
      else if (msg.type === 'voice_fix' && !deps.hostSend({ ...msg, type: 'agent_voice_fix' })) port.postMessage({ type: 'voice_fixed', id: msg.id, text: null });
      else if (msg.type === 'suggest' && !deps.hostSend({ ...msg, type: 'agent_suggest' })) port.postMessage({ type: 'suggested', id: msg.id, text: null });
      else if (msg.type === 'pick_folder' && !deps.hostSend({ ...msg, type: 'agent_pick_folder' })) port.postMessage({ type: 'folder_picked', id: msg.id, text: null, error: 'Native host not connected.' });
      else if (msg.type === 'unqueue') {
        const c = await chat(msg.sid);
        c.queue = (c.queue || []).filter((q) => q.id !== msg.id);
        broadcast(msg.sid, queueMsg(msg.sid, c));
      }
      else if (msg.type === 'refresh_agents') await listAgents(msg.sid, port);
      else if (msg.type === 'list_chats') port.postMessage({ type: 'chats', chats: await listChats() });
      else if (msg.type === 'delete_chat' || msg.type === 'reset') {
        await deleteChat(msg.sid);
        port.postMessage({ type: 'chats', chats: await listChats() });
      } else if (msg.type === 'approve') approvals.get(msg.id)?.resolve(msg.decision);
      else if (msg.type === 'answer') approvals.get(msg.id)?.resolve(msg.answers ? { answers: msg.answers } : 'skip');
      else if (msg.type === 'set_mode') setMode(msg.mode);
      else if (msg.type === 'save_workflow') port.postMessage({ type: 'workflow_saved', ...(await saveWorkflow(msg)) });
      else if (msg.type === 'run_workflow') await runWorkflow(msg);
      else if (msg.type === 'bg_task') await startBackground(msg);
    } catch (e) {
      port.postMessage({ type: 'event', ev: { t: 'error', message: String(e.message || e) } });
    }
  });
});

// Ask the host which AIs are installed (and which Ollama models), at the Ollama address set in the panel.
async function listAgents(sid, port) {
  const { panelSettings } = await chrome.storage.local.get('panelSettings');
  if (!deps.hostSend({ type: 'agent_list', sid, ollamaUrl: panelSettings?.ollamaUrl || '', cwd: panelSettings?.cwd || '~' })) {
    port.postMessage({ type: 'event', ev: { t: 'available', host: false } });
  }
}

async function tabLine(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return tab ? `[Tab ${tab.id}: ${tab.title || ''} — ${tab.url || ''}]` : '[No tab]';
}

// Tabs the AI opened earlier (the AI group), so it can pick up where it left off instead of starting over.
async function aiTabsLine(tabId) {
  const [group] = await chrome.tabGroups.query({ title: 'AI' }).catch(() => []);
  const own = group ? (await chrome.tabs.query({ groupId: group.id })).filter((t) => t.id !== tabId).slice(-3) : [];
  return own.length ? `[Your AI tabs: ${own.map((t) => `${t.id} ${clip(t.title || t.url, 60)}`).join(' · ')}]\n` : '';
}

const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

// A short look at the user's tab ({ key, text }), sent when the tab (or its page) changes: most questions are about it,
// so the AI starts from what's on screen instead of searching or opening other tabs.
async function pageGlance(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^(https?|file):/.test(tab.url || '')) return null;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const sel = String(getSelection() || '').trim();
      const desc = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '';
      const main = document.querySelector('main, article, [role="main"]') || document.body;
      const text = (main?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      return { sel, desc, text };
    },
  }).catch(() => []);
  const r = res?.result;
  if (!r) return null;
  return { key: `${tabId}|${tab.url}|${r.sel}`, text: [
    '<page note="the user\'s tab right now; start here">',
    r.sel && `Selected text: ${clip(r.sel, 1500)}`,
    r.desc && `Description: ${clip(r.desc, 200)}`,
    r.text && `Opening text:\n${clip(r.text, 1500)}`,
    '</page>',
  ].filter(Boolean).join('\n') };
}

// Tabs the user picked with #: the first is the current tab; the AI reaches the others by tabId.
async function tabLines(tabId, tabIds) {
  if (!tabIds.length) return tabLine(tabId);
  const lines = await Promise.all(tabIds.map(tabLine));
  const note = tabIds.length > 1 ? `\nThe user is talking about these ${tabIds.length} tabs. The first is the current tab; pass tabId to work on the others.` : '';
  return `${lines.join('\n')}${note}`;
}

// ---------- follow-ups typed while the AI works: queued, then sent together when it finishes ----------

const queueMsg = (sid, c) => ({ type: 'queue', sid, items: (c.queue || []).map(({ id, text, label, thumbs }) => ({ id, text: label || text, images: thumbs?.length || 0 })) });

async function flushQueue(sid) {
  const c = await chat(sid);
  if (c.busy || !c.queue?.length) return;
  const items = c.queue.splice(0);
  broadcast(sid, queueMsg(sid, c));
  const last = items[items.length - 1];
  try {
    await send({
      ...last,
      text: items.map((q) => q.text).join('\n\n'),
      images: items.flatMap((q) => q.images || []),
      thumbs: items.flatMap((q) => q.thumbs || []),
    });
  } catch (e) {
    await emit(sid, { t: 'error', message: String(e.message || e) });
  }
}

async function send(msg) {
  const { sid, kind, text, label, tabId, tabIds = [], cwd, mode, model, ollamaUrl, images = [], thumbs = [] } = msg;
  const c = await chat(sid);
  // Claude Code reads a message mid-task (at its next step); other AIs get it when they finish.
  if (c.busy && kind === 'claude' && c.kind === 'claude') return steer(msg, c);
  if (c.busy) {
    (c.queue ||= []).push({ ...msg, id: `q${++seq}` });
    broadcast(sid, queueMsg(sid, c));
    return;
  }
  c.kind = kind;
  if (tabId != null && !c.parent) deps.setCurrentTab(tabId); // a background task works in its own tab
  const line = c.parent ? `[Tab: your own background tab, opened at ${c.url || 'about:blank'}]` : await tabLines(tabId, tabIds);
  await emit(sid, { t: 'user', text, label, tab: line, thumbs: thumbs.length ? thumbs : undefined });
  const index = await chatIndex();
  await touchChat(sid, { title: index[sid]?.title || (label || text).replace(/\s+/g, ' ').slice(0, 80) || 'Image', kind });
  // What the AI gets but the chat doesn't show: news from @agent tasks, and a nudge for the suggested reply.
  const notes = c.parent ? '' : bgNotes(c);
  const nudge = kind === 'terminal' ? '' : '\n\n<reminder>End your reply with <suggest>…</suggest> (the user\'s likely next message).</reminder>';
  // The page glance goes out with the first message about a page, or when the page or selection changed.
  let glance = '';
  if (!c.parent && tabId != null) {
    const g = await pageGlance(tabId);
    if (g && g.key !== c.lastGlance) {
      c.lastGlance = g.key;
      glance = `${g.text}\n`;
    }
  }
  const aiTabs = c.parent ? '' : await aiTabsLine(tabId);
  const full = `${notes}${line}\n${aiTabs}${glance}${text}${nudge}`;

  if (kind === 'terminal') {
    await emit(sid, { t: 'busy', on: true });
    if (images.length) await emit(sid, { t: 'notice', text: 'Images are not passed to a terminal AI; only the text was sent.' });
    inbox.push({ sid, text: full });
    flushInbox();
    if (!terminalListening()) await emit(sid, { t: 'notice', text: 'Queued. No terminal AI is listening right now: in your terminal AI, say "listen to the AI in Chrome side panel".' });
    return;
  }
  if (!deps.hostSend({ type: 'agent_send', sid, kind, text: full, cwd, mode, model, ollamaUrl, images, sessionId: c.sessionId })) {
    throw new Error('Native host not connected. Run `aichrome install`, then click the extension icon.');
  }
}

async function steer({ sid, text, label, tabId, tabIds = [], images = [], thumbs = [] }, c) {
  const line = c.parent ? '' : await tabLines(tabId, tabIds);
  await emit(sid, { t: 'user', text, label, tab: line || undefined, thumbs: thumbs.length ? thumbs : undefined, steer: true });
  const full = `${line ? `${line}\n` : ''}<the user sent this while you were working; take it into account>\n${text}`;
  if (!deps.hostSend({ type: 'agent_send', sid, kind: 'claude', text: full, images })) {
    throw new Error('Native host not connected. Run `aichrome install`, then click the extension icon.');
  }
}

// restore: a plain Stop also cancels queued follow-ups and gives their text back to the composer.
// Without it ("Send now"), the queue goes out as soon as the AI has stopped.
function stop(sid, { restore = false } = {}) {
  const c = chats.get(sid);
  if (restore && c?.queue?.length) {
    const text = c.queue.map((q) => q.text).join('\n\n');
    c.queue = [];
    broadcast(sid, { ...queueMsg(sid, c), restore: text });
  }
  if (c?.replay) {
    c.replay.stopped = true;
    return;
  }
  if (c?.kind === 'terminal') {
    for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].sid === sid) inbox.splice(i, 1);
    if (terminalSid === sid) terminalSid = null;
    emit(sid, { t: 'stopped' });
    emit(sid, { t: 'busy', on: false });
    return;
  }
  deps.hostSend({ type: 'agent_stop', sid });
  for (const [id, a] of approvals) if (id.startsWith(`${sid}:`)) a.resolve('deny');
}

// ---------- permissions (Claude Code --permission-prompt-tool) ----------

const READ_ONLY = new Set(['tabs_context', 'read_page', 'find', 'get_page_text', 'read_console_messages', 'read_network_requests', 'sidepanel_reply']);
const READ_ONLY_COMPUTER = new Set(['screenshot', 'zoom', 'wait', 'scroll', 'scroll_to', 'hover', 'mouse_move']);
// Read-only web tools that touch neither the browser nor the computer: "Act without asking" covers them too.
const WEB_READ = new Set(['WebSearch', 'WebFetch', 'web_search']);
// File edits: "Act without asking" covers them as well. Shell commands still ask.
const FILE_EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// File reads: Claude Code only asks about these outside its working folder; "Act without asking" allows them anywhere.
const FILE_READ = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

// A shell command that only reads: one plain command from a short list, with no pipes, chaining, redirects,
// substitution or flags that write or run things. Anything else still asks, even in "Act without asking".
const READ_CMDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'find', 'tree', 'stat', 'file', 'du', 'df', 'grep', 'rg', 'which', 'realpath', 'basename', 'dirname', 'echo']);
function readOnlyShell(command) {
  const c = String(command || '').trim().replace(/^cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/, ''); // "cd folder && ls" is fine
  if (!c || /[;&|`$<>(){}\n\\]/.test(c)) return false;
  const [bin, ...args] = c.split(/\s+/);
  if (!READ_CMDS.has(bin)) return false;
  if (bin === 'find' && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/.test(a))) return false;
  if ((bin === 'rg' || bin === 'grep') && args.some((a) => /^--pre/.test(a))) return false;
  return true;
}

// What "Act without asking" lets through without a card.
const autoOk = (tool, input, browser) => browser || WEB_READ.has(tool) || FILE_EDIT.has(tool) || FILE_READ.has(tool) || (tool === 'Bash' && readOnlyShell(input?.command));

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

// The mode the panel shows now. The `mode` an AI process was started with goes stale when the user switches
// mid-chat (Claude Code keeps running with the old AICHROME_MODE), so the panel setting wins.
async function currentMode(fallback) {
  const { panelSettings } = await chrome.storage.local.get('panelSettings');
  return panelSettings?.mode || fallback || 'ask';
}

// Switching to "Act without asking" also answers the browser permission cards already waiting.
function setMode(mode) {
  if (mode !== 'auto') return;
  for (const a of approvals.values()) if (a.auto) a.resolve('allow');
}

// Claude's AskUserQuestion: show the questions as a card in the panel, and hand the picked answers back to Claude.
async function askUser({ sid, input, allow, deny }) {
  const where = ports.get(sid)?.size ? sid : chats.get(sid)?.parent;
  if (!sid || !where || !ports.get(where)?.size) return deny('The AI in Chrome side panel is closed, so the user could not answer. Ask in plain text instead.');
  const id = `${sid}:${++seq}`;
  const agent = where !== sid ? chats.get(sid)?.agent : undefined;
  const questions = (input.questions || []).map((q) => ({
    question: String(q.question || ''), header: String(q.header || ''), multiSelect: !!q.multiSelect,
    options: (q.options || []).map((o) => ({ label: String(o.label || ''), description: String(o.description || '') })),
  }));
  await emit(where, { t: 'question', id, agent, questions });
  const reply = await new Promise((resolve) => {
    approvals.set(id, { resolve, sid, key: 'AskUserQuestion' });
    setTimeout(() => resolve('timeout'), 30 * 60 * 1000);
  });
  approvals.delete(id);
  const answers = reply?.answers;
  await emit(where, { t: 'question_done', id, answers: answers || null, reason: answers ? undefined : reply });
  if (answers) return allow(answers);
  return deny(reply === 'timeout' ? 'The user did not answer within 30 minutes.' : 'The user skipped these questions. Use your best judgment, or ask in plain text.');
}

export async function approve_action({ sid, mode, tool_name: tool = '', input = {} }) {
  const allow = JSON.stringify({ behavior: 'allow', updatedInput: input });
  const deny = (message) => JSON.stringify({ behavior: 'deny', message });
  const browser = tool.startsWith('mcp__ai-in-chrome__');
  const short = tool.replace(/^mcp__ai-in-chrome__/, '');
  if (short === 'approve_action') return deny('Not allowed.');
  if (tool === 'AskUserQuestion') return askUser({ sid, input, allow: (answers) => JSON.stringify({ behavior: 'allow', updatedInput: { ...input, answers } }), deny });
  const auto = autoOk(tool, input, browser);
  if (auto && (await currentMode(mode)) === 'auto') return allow;
  if (browser && (READ_ONLY.has(short) || (short === 'computer' && READ_ONLY_COMPUTER.has(input.action)))) return allow;
  const key = browser ? permissionKey(tool, input) : tool;
  if (allowed.get(sid)?.has(key)) return allow;
  // A background @agent task has no panel of its own: ask in the chat that started it.
  const where = ports.get(sid)?.size ? sid : chats.get(sid)?.parent;
  if (!sid || !where || !ports.get(where)?.size) return deny('The AI in Chrome side panel is closed, so the user could not approve this action.');

  const id = `${sid}:${++seq}`;
  const agent = where !== sid ? chats.get(sid)?.agent : undefined;
  await emit(where, { t: 'permission', id, tool: browser ? short : tool, key, browser, agent, input: JSON.stringify(input).slice(0, 1500) });
  const decision = await new Promise((resolve) => {
    approvals.set(id, { resolve, browser, sid, key, auto });
    setTimeout(() => resolve('timeout'), 5 * 60 * 1000);
  });
  approvals.delete(id);
  await emit(where, { t: 'permission_done', id, decision });
  if (decision === 'always') {
    if (!allowed.has(sid)) allowed.set(sid, new Set());
    allowed.get(sid).add(key);
    // The same request may already be waiting a second time (parallel tool calls): answer it too.
    for (const a of approvals.values()) if (a.sid === sid && a.key === key) a.resolve('always');
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

// ---------- workflows: replay what the AI did, step by step, without the AI ----------

// Browser actions worth replaying. Reading and looking (read_page, find, screenshots…) only helped the AI decide.
const REPLAYABLE = new Set(['navigate', 'tabs_create', 'computer', 'form_input', 'file_upload']);
const SKIP_COMPUTER = new Set(['screenshot', 'zoom', 'mouse_move']);
const short = (name) => String(name || '').replace(/^mcp__ai-in-chrome__/, '').replace(/^ai-in-chrome__/, '');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWorkflows() {
  return (await chrome.storage.local.get('workflows')).workflows || [];
}

// The browser actions that worked in a chat, from `since` on (one reply, or the whole chat).
function workflowSteps(events, since = 0) {
  const pending = new Map();
  const steps = [];
  const seen = new Map(); // ref -> target, from read_page / find output (backup if the worker restarted since)
  let startUrl = '';
  for (const ev of events) {
    if ((ev.ts || 0) < since) continue;
    if (ev.t === 'user' && !startUrl) startUrl = /— (\S+)\]$/.exec(ev.tab || '')?.[1] || '';
    if (ev.t === 'tool') {
      const tool = short(ev.name);
      let input;
      try {
        input = typeof ev.input === 'string' ? JSON.parse(ev.input) : { ...ev.input };
      } catch {
        continue;
      }
      if (!REPLAYABLE.has(tool) || !input || (tool === 'computer' && SKIP_COMPUTER.has(input.action))) continue;
      delete input.tabId;
      if (input.target) {
        // already a replayed step
      } else if (input.ref) {
        const target = deps.refAt(input.ref, ev.ts) || seen.get(input.ref);
        if (target) input.target = target;
        else input.lost = true; // replay hands this step to the AI
      }
      delete input.ref;
      pending.set(ev.id, { tool, input });
    } else if (ev.t === 'tool_result' && ev.ok && !pending.has(ev.id)) {
      for (const m of String(ev.text || '').matchAll(/^\s*([\w-]+) "([^"]*)" \[(ref_\d+)\]/gm)) seen.set(m[3], { role: m[1], name: m[2] });
    } else if (ev.t === 'tool_result' && ev.ok && pending.has(ev.id)) {
      steps.push(pending.get(ev.id));
      pending.delete(ev.id);
    }
  }
  // Start where the task started, unless the first step goes somewhere itself.
  if (steps.length && startUrl && /^https?:/.test(startUrl) && !['navigate', 'tabs_create'].includes(steps[0].tool)) {
    steps.unshift({ tool: 'navigate', input: { url: startUrl } });
  }
  return steps;
}

async function saveWorkflow({ sid, name, since }) {
  name = String(name || '').trim().replace(/^\//, '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!name) return { error: 'Give the workflow a name' };
  const c = await chat(sid);
  const steps = workflowSteps(c.events, since || 0);
  if (!steps.length) return { error: 'No browser actions to save there' };
  const title = (await chatIndex())[sid]?.title || '';
  const workflows = (await getWorkflows()).filter((w) => w.name !== name);
  workflows.push({ name, title, steps, created: Date.now() });
  await chrome.storage.local.set({ workflows });
  return { name, count: steps.length };
}

// What a step does, for the hand-off to the AI when a replay gets stuck.
function stepText(step) {
  const { tool, input } = step;
  const what = input.target ? `the ${input.target.role} "${input.target.name}"` : input.coordinate ? `at (${input.coordinate})` : input.lost ? 'an element (not recorded; find the right one)' : '';
  if (tool === 'navigate' || tool === 'tabs_create') return `Open ${input.url}`;
  if (tool === 'form_input') return `Set ${what} to "${input.value}"`;
  if (tool === 'file_upload') return `Upload a file to ${what}`;
  if (input.action === 'type') return `Type "${input.text}"${what ? ` into ${what}` : ''}`;
  if (input.action === 'key') return `Press ${input.text}`;
  if (input.action === 'wait') return `Wait ${input.duration || 1}s`;
  if (input.action === 'scroll') return `Scroll ${input.scroll_direction || 'down'}${what ? ` in ${what}` : ''}`;
  return `${input.action?.replace(/_/g, ' ') || tool} ${what}`.trim();
}

async function runWorkflow({ sid, name, tabId }) {
  const wf = (await getWorkflows()).find((w) => w.name === name);
  if (!wf) throw new Error(`No workflow named /${name}`);
  const c = await chat(sid);
  if (c.busy) throw new Error('Still working. Press Stop first.');
  if (tabId != null) deps.setCurrentTab(tabId);
  await emit(sid, { t: 'user', text: `/${name}`, tab: await tabLine(tabId), workflow: name });
  const index = await chatIndex();
  await touchChat(sid, { title: index[sid]?.title || `/${name}`, kind: c.kind });
  await emit(sid, { t: 'busy', on: true });
  const replay = (c.replay = { stopped: false });
  const started = Date.now();
  try {
    for (const [i, step] of wf.steps.entries()) {
      if (replay.stopped) return await emit(sid, { t: 'stopped' });
      const id = `w${++seq}`;
      await emit(sid, { t: 'tool', id, name: `mcp__ai-in-chrome__${step.tool}`, input: JSON.stringify(step.input) });
      try {
        const { target, lost, ...args } = step.input;
        if (lost) throw new Error('This step’s element wasn’t recorded, so it can’t be replayed on its own');
        if (target) {
          // The page may still be rendering: look for the element for a few seconds.
          for (let tries = 0; !args.ref && tries < 16 && !replay.stopped; tries++) {
            args.ref = await deps.locate(target).catch(() => null);
            if (!args.ref) await pause(400);
          }
          if (!args.ref) throw new Error(`Couldn't find the ${target.role}${target.name ? ` "${target.name}"` : ''} on the page`);
        }
        const result = await deps.runTool(step.tool, args);
        await emit(sid, { t: 'tool_result', id, ok: true, text: String(typeof result === 'string' ? result : result?.text || 'Done').slice(0, 300) });
        await deps.settle();
        await pause(step.tool === 'computer' && step.input.action === 'type' ? 150 : 400);
      } catch (e) {
        const error = String(e?.message || e);
        await emit(sid, { t: 'tool_result', id, ok: false, text: error });
        const rest = wf.steps.slice(i).map((s, n) => `${n + 1}. ${stepText(s)}`).join('\n');
        await emit(sid, {
          t: 'workflow_failed', name, done: i, total: wf.steps.length, error,
          prompt: `I was replaying my saved workflow "/${name}"${wf.title ? ` (originally: ${wf.title})` : ''}. ` +
            `${i ? `The first ${i} step${i === 1 ? '' : 's'} worked, then this` : 'The first'} step failed: ${error}\n\n` +
            `Finish the task from where it stopped. The remaining steps were:\n${rest}`,
        });
        return;
      }
    }
    await emit(sid, { t: 'done', ms: Date.now() - started, replay: true, steps: wf.steps.length });
  } finally {
    c.replay = null;
    await emit(sid, { t: 'busy', on: false });
  }
}

// ---------- @agent: a task run in its own background chat and tab, summarized in the chat that started it ----------

const AI_KINDS = new Set(['claude', 'codex', 'ollama', 'fm']);

export function bgInfo(sid) {
  const c = chats.get(sid);
  return c?.parent ? { url: c.url } : null;
}

async function startBackground({ sid, agent, text, tabId, cwd, mode, model, ollamaUrl, kind }) {
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const bg = `bg-${crypto.randomUUID()}`;
  const c = await chat(bg);
  Object.assign(c, { parent: sid, agent, url: /^https?:/.test(tab?.url || '') ? tab.url : '' });
  const runKind = AI_KINDS.has(agent) ? agent : 'claude';
  const prompt = AI_KINDS.has(agent)
    ? `${text}\n\nThis runs in the background. When you're done, end with a short summary of the result.`
    : `Use the "${agent}" subagent for this task. When it's done, reply with a short summary of what it found or did.\n\n${text}`;
  await emit(sid, { t: 'bg_task', bg, agent, text });
  const parent = await chat(sid);
  (parent.bgTasks ||= []).push({ bg, agent, text, status: 'running', told: '' });
  await touchChat(bg, { title: `@${agent}: ${text.replace(/\s+/g, ' ').slice(0, 70)}`, kind: runKind });
  // The panel's model setting belongs to the AI picked in the panel; another AI uses its default.
  await send({ sid: bg, kind: runKind, text: prompt, cwd, mode, model: runKind === kind ? model : '', ollamaUrl });
}

// Live progress for the card in the parent chat, and the result when it ends.
function bgProgress(sid, c, ev) {
  if (ev.t === 'tool' || ev.t === 'tool_result' || ev.t === 'busy') {
    const steps = c.events.filter((e) => e.t === 'tool' && !e.parent).length;
    broadcast(c.parent, { type: 'bg_update', bg: sid, steps, tool: ev.t === 'tool' ? { name: ev.name, input: ev.input } : undefined, busy: c.busy });
  }
  if (ev.t === 'done' || ev.t === 'error' || ev.t === 'stopped') {
    const text = [...c.events].reverse().find((e) => e.t === 'text' && !e.parent)?.text || '';
    const steps = c.events.filter((e) => e.t === 'tool' && !e.parent).length;
    const task = chats.get(c.parent)?.bgTasks?.find((x) => x.bg === sid);
    if (task) Object.assign(task, { status: ev.t === 'done' && !ev.error ? 'done' : ev.t, result: (ev.t === 'error' ? ev.message : ev.error || text).replace(/\s*<suggest>[\s\S]*?<\/suggest>/g, '') });
    emit(c.parent, {
      t: 'bg_done', bg: sid, agent: c.agent, ok: ev.t === 'done' && !ev.error, steps, ms: ev.ms, tokens: ev.tokens,
      text: ev.t === 'stopped' ? 'Stopped.' : ev.t === 'error' ? ev.message : ev.error || text,
    });
  }
}

// The chat's AI doesn't see @agent tasks on its own: tell it about each one once when it starts and once
// with the result, at the top of the next message the user sends.
function bgNotes(c) {
  const lines = [];
  for (const t of c.bgTasks || []) {
    if (t.status === 'running' && !t.told) {
      lines.push(`- @${t.agent} is still working on: ${t.text}`);
      t.told = 'start';
    } else if (t.status !== 'running' && t.told !== 'end') {
      const what = t.status === 'done' ? 'finished' : t.status === 'stopped' ? 'was stopped' : 'failed';
      lines.push(`- @${t.agent} ${what}. Task: ${t.text}\n  Result:\n${String(t.result || '(no result)').slice(0, 6000).replace(/^/gm, '    ')}`);
      t.told = 'end';
    }
  }
  return lines.length
    ? `<background-tasks>\nThe user ran these tasks in the background with @agent from the side panel; their results are yours to use:\n${lines.join('\n')}\n</background-tasks>\n\n`
    : '';
}
