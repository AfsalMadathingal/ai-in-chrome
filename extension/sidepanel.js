// AI in Chrome side panel: a chat UI. The service worker routes messages to the user's terminal AI
// (headless Claude Code / Codex via the native host, or an AI listening in a terminal) and streams events back.

const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const sendBtn = $('send');

let windowId;
let sid;
let port;
let busy = false;
let streamEl = null; // assistant bubble receiving deltas
let available = {};
let terminal = { listening: false, recent: false };
const toolEls = new Map();
const permEls = new Map();
let settings = { agent: 'claude', mode: 'ask', cwd: '~', model: '' };

// ---------- tiny Markdown renderer (escaped first, so model output can't inject HTML) ----------

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
}

function markdown(src) {
  const out = [];
  const parts = esc(src).split(/```[^\n]*\n?([\s\S]*?)(?:```|$)/);
  parts.forEach((part, i) => {
    if (i % 2) return out.push(`<pre><code>${part.replace(/\n$/, '')}</code></pre>`);
    let list = null;
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of part.split('\n')) {
      const h = /^(#{1,3})\s+(.*)/.exec(line);
      const ul = /^\s*[-*]\s+(.*)/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
      if (h) {
        flush(); closeList();
        out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      } else if (ul || ol) {
        flush();
        const kind = ul ? 'ul' : 'ol';
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
      } else if (!line.trim()) {
        flush(); closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flush(); closeList();
  });
  return out.join('');
}

// ---------- rendering ----------

function add(el) {
  $('empty')?.remove();
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.appendChild(el);
  if (stick) log.scrollTop = log.scrollHeight;
  return el;
}

function div(cls, html) {
  const el = document.createElement('div');
  el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
}

function scrollDown() {
  log.scrollTop = log.scrollHeight;
}

function toolLabel(name, inputStr) {
  const short = name.replace(/^mcp__ai-in-chrome__/, '').replace(/^ai-in-chrome__/, '');
  let arg = inputStr || '';
  try {
    const o = JSON.parse(inputStr);
    if (short === 'computer') arg = [o.action, o.ref, o.coordinate && `(${o.coordinate})`, o.text && JSON.stringify(o.text)].filter(Boolean).join(' ');
    else arg = o.url || o.query || o.ref || o.text || o.command || o.requestId || o.pattern || o.description || Object.values(o).filter((v) => typeof v !== 'object').join(' ');
  } catch {}
  return { short, arg: String(arg) };
}

function closeStream() {
  if (streamEl) streamEl.classList.remove('streaming');
  streamEl = null;
}

function render(ev) {
  switch (ev.t) {
    case 'user': {
      closeStream();
      const el = div('msg-user');
      if (ev.tab) el.appendChild(Object.assign(document.createElement('span'), { className: 'tab', textContent: ev.tab.replace(/^\[|\]$/g, '') }));
      el.appendChild(document.createTextNode(ev.text));
      add(el);
      scrollDown();
      break;
    }
    case 'delta':
      if (!streamEl) {
        streamEl = add(div('msg-ai streaming'));
        streamEl.raw = '';
      }
      streamEl.raw += ev.text;
      streamEl.innerHTML = markdown(streamEl.raw);
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 120) scrollDown();
      break;
    case 'text': {
      const el = streamEl || add(div('msg-ai'));
      el.innerHTML = markdown(ev.text);
      el.classList.remove('streaming');
      streamEl = null;
      break;
    }
    case 'thinking':
      break;
    case 'tool': {
      closeStream();
      const { short, arg } = toolLabel(ev.name, ev.input);
      const d = document.createElement('details');
      d.className = 'tool';
      d.innerHTML = `<summary><span class="name"></span><span class="arg"></span><span class="st run"></span></summary><pre></pre>`;
      d.querySelector('.name').textContent = short;
      d.querySelector('.arg').textContent = arg;
      d.querySelector('pre').textContent = ev.input || '';
      toolEls.set(ev.id, d);
      add(d);
      break;
    }
    case 'tool_result': {
      const d = toolEls.get(ev.id);
      if (!d) break;
      const st = d.querySelector('.st');
      st.className = `st ${ev.ok ? 'ok' : 'bad'}`;
      st.textContent = ev.ok ? '✓' : '✕';
      if (ev.text) d.querySelector('pre').textContent += `\n\n→ ${ev.text}`;
      break;
    }
    case 'permission': {
      closeStream();
      const el = div('perm');
      el.innerHTML = `<div class="q"></div><pre></pre><div class="btns"><button class="primary" data-d="allow">Allow once</button><button data-d="always">Always allow</button><button data-d="deny">Deny</button></div>`;
      el.querySelector('.q').textContent = `Allow ${ev.tool}${ev.key && ev.key.includes(':') ? ` (${ev.key.split(':')[1]})` : ''}?`;
      el.querySelector('pre').textContent = ev.input;
      el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => port.postMessage({ type: 'approve', id: ev.id, decision: b.dataset.d })));
      permEls.set(ev.id, el);
      add(el);
      scrollDown();
      break;
    }
    case 'permission_done': {
      const el = permEls.get(ev.id);
      if (el) el.querySelector('.btns').outerHTML = `<div class="result">${{ allow: 'Allowed once', always: 'Always allowed in this chat', deny: 'Denied', timeout: 'Timed out' }[ev.decision] || ev.decision}</div>`;
      break;
    }
    case 'done': {
      closeStream();
      const bits = [ev.ms && `${(ev.ms / 1000).toFixed(1)}s`, ev.cost && `$${ev.cost.toFixed(4)}`, ev.turns > 1 && `${ev.turns} turns`].filter(Boolean);
      if (ev.error) add(div('error')).textContent = ev.error;
      else if (bits.length) add(div('meta')).textContent = bits.join(' · ');
      break;
    }
    case 'stopped':
      closeStream();
      add(div('notice')).textContent = 'Stopped.';
      break;
    case 'notice':
      add(div('notice')).textContent = ev.text;
      break;
    case 'error':
      closeStream();
      add(div('error')).textContent = ev.message;
      break;
    case 'session':
      break;
    case 'busy':
      setBusy(ev.on);
      break;
    case 'available':
      available = ev;
      updateHint();
      break;
  }
}

function setBusy(on) {
  busy = on;
  document.body.classList.toggle('busy', on);
  sendBtn.title = on ? 'Stop' : 'Send (Enter)';
  updateStatus();
}

function updateStatus() {
  const st = $('status');
  if (settings.agent === 'terminal') {
    st.innerHTML = terminal.listening
      ? '<span class="dot on"></span>Terminal AI is listening'
      : `<span class="dot"></span>${terminal.recent ? 'Terminal AI is busy or paused' : 'No terminal AI listening yet'}`;
  } else st.textContent = busy ? 'Working…' : '';
}

function updateHint() {
  const h = $('agentHint');
  if (available.host === false) {
    h.innerHTML = 'Native host not connected. Run <code>aichrome install</code>, then click the extension icon.';
    return;
  }
  if (settings.agent === 'terminal') {
    h.innerHTML = 'In any terminal AI connected to the <code>ai-in-chrome</code> MCP server, say: <code>listen to the AI in Chrome side panel</code>.';
  } else if (settings.agent === 'claude') {
    h.innerHTML = available.claude ? `Uses your logged-in Claude Code (<code>${esc(available.claude)}</code>).` : 'Claude Code not found. Install it, then run <code>aichrome install</code> again.';
  } else {
    h.innerHTML = available.codex ? `Uses your logged-in Codex (<code>${esc(available.codex)}</code>).` : 'Codex not found. Install it, then run <code>aichrome install</code> again.';
  }
}

// ---------- current tab ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab;
}

async function showTab() {
  const tab = await activeTab();
  $('tabTitle').textContent = tab ? tab.title || tab.url : 'No tab';
  $('tabIcon').src = tab?.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl) ? tab.favIconUrl : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
}

chrome.tabs.onActivated.addListener((i) => i.windowId === windowId && showTab());
chrome.tabs.onUpdated.addListener((id, info, tab) => tab.windowId === windowId && tab.active && (info.title || info.favIconUrl || info.url) && showTab());

// ---------- connection ----------

function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'history') {
      log.querySelectorAll(':scope > :not(#empty)').forEach((e) => e.remove());
      toolEls.clear();
      permEls.clear();
      streamEl = null;
      terminal = msg.terminal || terminal;
      for (const ev of msg.events) render(ev);
      // A permission prompt that is no longer pending can't be answered after a reload.
      setBusy(msg.busy);
      scrollDown();
    } else if (msg.type === 'event') render(msg.ev);
    else if (msg.type === 'terminal') {
      terminal = msg;
      updateStatus();
    }
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 300)); // service worker restarted
  port.postMessage({ type: 'hello', sid });
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  const tab = await activeTab();
  port.postMessage({ type: 'send', sid, kind: settings.agent, text, tabId: tab?.id, cwd: settings.cwd || '~', mode: settings.mode, model: settings.model });
  input.value = '';
  autosize();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

async function newChat() {
  if (busy) port.postMessage({ type: 'stop', sid });
  sid = crypto.randomUUID();
  await chrome.storage.local.set({ [`panelChat:${windowId}`]: sid });
  location.reload();
}

// ---------- init ----------

async function init() {
  windowId = (await chrome.windows.getCurrent()).id;
  const stored = await chrome.storage.local.get(['panelSettings', `panelChat:${windowId}`]);
  settings = { ...settings, ...stored.panelSettings };
  sid = stored[`panelChat:${windowId}`];
  if (!sid) {
    sid = crypto.randomUUID();
    await chrome.storage.local.set({ [`panelChat:${windowId}`]: sid });
  }
  $('agent').value = settings.agent;
  $('mode').value = settings.mode;
  $('cwd').value = settings.cwd;
  $('model').value = settings.model;
  for (const id of ['agent', 'mode', 'cwd', 'model']) {
    $(id).addEventListener('change', () => {
      settings[id] = $(id).value.trim();
      chrome.storage.local.set({ panelSettings: settings });
      updateHint();
      updateStatus();
    });
  }
  $('settingsBtn').addEventListener('click', () => ($('settings').hidden = !$('settings').hidden));
  $('newChat').addEventListener('click', newChat);
  sendBtn.addEventListener('click', () => (busy ? port.postMessage({ type: 'stop', sid }) : send(input.value)));
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  document.querySelectorAll('.suggest button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));
  updateHint();
  updateStatus();
  showTab();
  connect();
  input.focus();
}

init();
