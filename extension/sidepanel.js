// AI in Chrome side panel: a chat UI. The service worker (panel.js) routes messages to the user's terminal AI
// (headless Claude Code / Codex via the native host, or an AI listening in a terminal) and streams events back.

const $ = (id) => document.getElementById(id);
const log = $('log');
const input = $('input');
const sendBtn = $('send');

let windowId;
let sid;
let port;
let busy = false;
let busySince = 0;
let replaying = false;
let available = {};
let terminal = { listening: false, recent: false };
let lastModel = '';
let attachments = []; // { mediaType, data, thumb }
let chatList = [];
let workflows = []; // saved replays: { name, title, steps, created }
let lastUserTs = 0;
let settings = { agent: 'claude', mode: 'ask', cwd: '~', model: '', ollamaModel: '', ollamaUrl: '', theme: 'system', voiceFix: true, shortcuts: [] };

// Per-render state for the assistant turn being built.
let turn = null;
let steps = null;
let thinkEl = null;
let streamEl = null;
const stepEls = new Map();
const permEls = new Map();

// ---------- icons ----------

const P = {
  spark: '<path d="M12 2.5c.5 4.6 2.6 7.6 9.5 9.5-6.9 1.9-9 4.9-9.5 9.5-.5-4.6-2.6-7.6-9.5-9.5 6.9-1.9 9-4.9 9.5-9.5z" fill="currentColor" stroke="none"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  cursor: '<path d="m4 4 7 17 2.5-7.5L21 11z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>',
  scroll: '<path d="M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  cookie: '<path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5h.01M16 15.5h.01M12 12h.01M11 17h.01M7 14h.01"/>',
  film: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 8h5M2 16h5M17 8h5M17 16h5M2 12h20"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  tabs: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  wand: '<path d="m15 4 5 5L9 20l-5-5zM4 4l2 2M12 2v2M2 12h2"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  play: '<path d="M6 4v16l14-8z"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24">${P[name] || P.bolt}</svg>`;

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

const calm = matchMedia('(prefers-reduced-motion: reduce)');
const fold = (inner) => `<div class="fold"><div>${inner}</div></div>`;
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 120;
const scrollDown = () => (log.scrollTop = log.scrollHeight);

function add(node, parent = log) {
  log.querySelector(':scope > .empty')?.remove();
  if (!node.classList.contains('pending')) log.querySelector(':scope > .pending')?.remove();
  const stick = replaying || nearBottom();
  parent.appendChild(node);
  if (stick) scrollDown();
  return node;
}

function fmtMs(ms) {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function hostOf(url) {
  try {
    const u = new URL(/^[a-z]+:/i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return String(url || '');
  }
}

const clip = (s, n = 60) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function toast(text, ms = 1400) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed');
  }
}

const GLOBE_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a877f" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>')}`;
const favicon = (tab) => (tab?.favIconUrl && /^https?:|^data:/.test(tab.favIconUrl) ? tab.favIconUrl : GLOBE_ICON);

// ---------- markdown (escaped first, so model output can't inject HTML) ----------

function inline(s) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => hold(`<a href="${u}" target="_blank" rel="noreferrer">${t}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'])/g, (_, p, u) => p + hold(`<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`));
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));

function blocks(text) {
  const lines = text.split('\n');
  const out = [];
  let para = [];
  const lists = []; // stack of { kind, indent }
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
    para = [];
  };
  const closeLists = (indent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > indent) out.push(`</${lists.pop().kind}>`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] || '')) {
      flush(); closeLists();
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if ((m = /^(#{1,4})\s+(.*)/.exec(line))) {
      flush(); closeLists();
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush(); closeLists();
      out.push('<hr>');
    } else if (/^\s*&gt;/.test(line)) {
      flush(); closeLists();
      const quote = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) quote.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      i--;
      out.push(`<blockquote>${blocks(quote.join('\n'))}</blockquote>`);
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)/.exec(line))) {
      flush();
      const indent = m[1].replace(/\t/g, '  ').length;
      const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (!top || top.indent < indent) {
        out.push(`<${kind}>`);
        lists.push({ kind, indent });
      } else if (top.kind !== kind) {
        out.push(`</${lists.pop().kind}><${kind}>`);
        lists.push({ kind, indent });
      }
      const task = /^\[([ xX])\]\s+(.*)/.exec(m[3]);
      out.push(task ? `<li class="task"><input type="checkbox" disabled ${task[1] !== ' ' ? 'checked' : ''}><span>${inline(task[2])}</span></li>` : `<li>${inline(m[3])}</li>`);
    } else if (!line.trim()) {
      flush(); closeLists();
    } else if (lists.length && /^\s+/.test(line)) {
      // continuation of a list item
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
    } else {
      closeLists();
      para.push(line);
    }
  }
  flush(); closeLists();
  return out.join('');
}

// The AI ends replies with <suggest>next message</suggest>: hidden here, offered in the composer instead.
const SUGGEST = /\s*<suggest>([\s\S]*?)(?:<\/suggest>|$)/g;
const visible = (s) => String(s ?? '').replace(SUGGEST, '').replace(/\s*<(?:s(?:u(?:g(?:g(?:e(?:st?)?)?)?)?)?)?$/, '');
const suggestionIn = (s) => {
  const m = [...String(s ?? '').matchAll(/<suggest>([\s\S]*?)<\/suggest>/g)].pop();
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : '';
};

function markdown(src) {
  src = visible(src);
  const out = [];
  const parts = String(src).split(/^[ \t]*```([^\n`]*)\n?([\s\S]*?)(?:^[ \t]*```[ \t]*$|$(?![\s\S]))/m);
  for (let i = 0; i < parts.length; i += 3) {
    out.push(blocks(esc(parts[i])));
    if (i + 2 < parts.length) {
      const lang = esc(parts[i + 1].trim() || 'text');
      out.push(`<div class="code"><div class="bar"><span>${lang}</span><button class="mini" data-copy title="Copy code">${icon('copy')}</button></div><pre><code>${esc(parts[i + 2].replace(/\n$/, ''))}</code></pre></div>`);
    }
  }
  return out.join('');
}

// ---------- tool descriptions ----------

const strip = (name) => String(name || '').replace(/^mcp__ai-in-chrome__/, '').replace(/^ai-in-chrome__/, '').replace(/^mcp__[^_]+__/, '');

function parseInput(s) {
  if (s && typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const q = (s, n) => `“${esc(clip(s, n || 40))}”`;
const c = (s, n) => `<code>${esc(clip(s, n || 48))}</code>`;
const file = (p) => c(String(p || '').split('/').pop());

// Element names learned from read_page / find results, so a step says Click “Sign in” button, not Click ref_12.
const refNames = new Map();
function learnRefs(text) {
  for (const m of String(text || '').matchAll(/^\s*([\w-]+)(?: "([^"]*)")? \[(ref_\d+)\]/gm)) refNames.set(m[3], { role: m[1], name: m[2] || '' });
}
const ROLE_WORDS = {
  link: 'link', button: 'button', textbox: 'field', searchbox: 'search box', checkbox: 'checkbox', radio: 'option', combobox: 'dropdown',
  listbox: 'list', option: 'option', img: 'image', heading: 'heading', tab: 'tab', menuitem: 'menu item', slider: 'slider', spinbutton: 'field', switch: 'switch',
};
function element(o, fallback = 'an element') {
  const r = o.target || (o.ref && refNames.get(o.ref));
  if (r) {
    const kind = ROLE_WORDS[r.role] || '';
    return r.name.trim() ? `${q(r.name, 32)}${kind ? ` ${kind}` : ''}` : `a ${esc(kind || r.role)}`;
  }
  return o.ref ? fallback : o.coordinate ? 'on the page' : '';
}

const KEY_NAMES = { cmd: '⌘', command: '⌘', meta: '⌘', super: '⌘', ctrl: 'Ctrl', control: 'Ctrl', shift: '⇧', alt: '⌥', option: '⌥', return: 'Enter', enter: 'Enter', escape: 'Esc', esc: 'Esc', arrowup: '↑', up: '↑', arrowdown: '↓', down: '↓', arrowleft: '←', left: '←', arrowright: '→', right: '→', backspace: '⌫', delete: 'Del', space: 'Space', tab: 'Tab', pagedown: 'Page Down', pageup: 'Page Up' };
const keys = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).slice(0, 4)
  .map((combo) => combo.split('+').map((k) => `<kbd>${esc(KEY_NAMES[k.toLowerCase()] || (k.length === 1 ? k.toUpperCase() : k))}</kbd>`).join('')).join(' ');

const humanize = (s) => {
  s = String(s || 'tool').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// computer actions -> [label, verb (status line), icon, done (summary)]
const COMPUTER = {
  left_click: ['Click', 'Clicking', 'cursor', 'clicked'], click: ['Click', 'Clicking', 'cursor', 'clicked'],
  right_click: ['Right-click', 'Clicking', 'cursor', 'clicked'], double_click: ['Double-click', 'Clicking', 'cursor', 'clicked'],
  triple_click: ['Triple-click', 'Clicking', 'cursor', 'clicked'], left_click_drag: ['Drag', 'Dragging', 'cursor', 'dragged'],
  hover: ['Hover over', 'Hovering', 'cursor', 'hovered'], mouse_move: ['Move the mouse', 'Moving the mouse', 'cursor', 'moved the mouse'],
  type: ['Type', 'Typing', 'keyboard', 'typed'], key: ['Press', 'Pressing keys', 'keyboard', 'pressed keys'],
  screenshot: ['Take a screenshot', 'Looking at the page', 'camera', 'looked at the page'], zoom: ['Zoom in for a closer look', 'Looking closer', 'camera', 'looked at the page'],
  scroll: ['Scroll', 'Scrolling', 'scroll', 'scrolled'], scroll_to: ['Scroll to', 'Scrolling', 'scroll', 'scrolled'], wait: ['Wait', 'Waiting', 'clock', 'waited'],
};

// -> { label (HTML), verb (status line), icon, done (past tense, for the steps summary) }
function describe(name, inputStr) {
  const short = strip(name);
  const o = parseInput(inputStr) || {};
  const raw = typeof inputStr === 'string' && !parseInput(inputStr) ? inputStr : '';
  switch (short) {
    case 'navigate': {
      if (o.url === 'back' || o.url === 'forward') return { label: `Go ${o.url}`, verb: `Going ${o.url}`, icon: 'globe', done: 'navigated' };
      return { label: `Open ${c(hostOf(o.url || ''))}`, verb: 'Opening the page', icon: 'globe', done: 'navigated' };
    }
    case 'tabs_create': return { label: o.url ? `Open ${c(hostOf(o.url))} in a new tab` : 'Open a new tab', verb: 'Opening a tab', icon: 'tabs', done: 'opened a tab' };
    case 'tabs_close': return { label: 'Close a tab', verb: 'Closing a tab', icon: 'tabs', done: 'closed a tab' };
    case 'tabs_select': return { label: 'Switch to another tab', verb: 'Switching tabs', icon: 'tabs', done: 'switched tabs' };
    case 'tabs_context': return { label: 'Check which tabs are open', verb: 'Checking tabs', icon: 'tabs', done: 'checked tabs' };
    case 'computer': {
      const [l, verb, ic, done] = COMPUTER[o.action] || [humanize(o.action || 'act'), 'Working on the page', 'cursor', 'used the page'];
      let label = esc(l);
      if (o.action === 'type') label += ` ${q(o.text)}${o.ref || o.target ? ` into ${element(o, 'a field')}` : ''}`;
      else if (o.action === 'key') label += ` ${keys(o.text || o.key)}`;
      else if (o.action === 'scroll') label += ` ${esc(o.scroll_direction || o.direction || '')}${o.ref ? ` in ${element(o)}` : ''}`;
      else if (o.action === 'scroll_to') label += ` ${element(o, 'an element')}`;
      else if (o.action === 'wait') label += ` ${esc(o.duration ?? 1)} second${Number(o.duration) === 1 ? '' : 's'}`;
      else if (COMPUTER[o.action]?.[2] === 'cursor') label += ` ${element(o)}`;
      return { label: label.trim(), verb, icon: ic, done };
    }
    case 'read_page': return { label: o.ref ? `Read ${element(o, 'part of the page')}` : 'Read the page', verb: 'Reading the page', icon: 'doc', done: 'read the page' };
    case 'get_page_text': return { label: 'Read the page text', verb: 'Reading the page', icon: 'doc', done: 'read the page' };
    case 'find': return { label: `Look for ${q(o.query)}`, verb: 'Looking around the page', icon: 'search', done: 'searched the page' };
    case 'form_input': return { label: `Fill ${element(o, 'a field')}${o.value != null ? ` with ${q(o.value, 30)}` : ''}`, verb: 'Filling in the form', icon: 'pencil', done: 'filled a form' };
    case 'javascript_tool': return { label: 'Run a script on the page', verb: 'Running a script', icon: 'code', done: 'ran a script' };
    case 'read_console_messages': return { label: 'Check the console for messages', verb: 'Checking the console', icon: 'terminal', done: 'checked the console' };
    case 'read_network_requests': return { label: 'Look at the page’s network requests', verb: 'Checking network activity', icon: 'activity', done: 'checked the network' };
    case 'network_request': return { label: 'Inspect a network request', verb: 'Inspecting a request', icon: 'activity', done: 'inspected a request' };
    case 'http_request': return { label: `Send ${esc(o.method || 'GET')} to ${c(hostOf(o.url || ''))}`, verb: 'Sending a request', icon: 'activity', done: 'sent a request' };
    case 'network_intercept': return { label: { add: 'Intercept matching requests', remove: 'Stop intercepting a request', clear: 'Stop intercepting requests', list: 'List intercepted requests' }[o.action] || 'Intercept network requests', verb: 'Setting up interception', icon: 'activity', done: 'intercepted requests' };
    case 'network_export': return { label: 'Export network activity (HAR)', verb: 'Exporting', icon: 'activity', done: 'exported a HAR' };
    case 'cookies': return { label: { set: 'Set a cookie', delete: 'Delete a cookie', clear: 'Clear cookies' }[o.action] || `Read cookies${o.url ? ` for ${c(hostOf(o.url))}` : ''}`, verb: 'Working with cookies', icon: 'cookie', done: 'checked cookies' };
    case 'gif_creator': return { label: { start_recording: 'Start recording a GIF', stop_recording: 'Stop recording', export: 'Save the GIF', clear: 'Discard the recording' }[o.action] || 'Record a GIF', verb: 'Recording', icon: 'film', done: 'recorded a GIF' };
    case 'file_upload': return { label: `Upload a file${o.ref ? ` to ${element(o, 'the page')}` : ''}`, verb: 'Uploading', icon: 'upload', done: 'uploaded a file' };
    case 'upload_image': return { label: 'Upload an image', verb: 'Uploading', icon: 'upload', done: 'uploaded an image' };
    case 'resize_window': return { label: `Resize the window${o.width && o.height ? ` to ${esc(o.width)}×${esc(o.height)}` : ''}`, verb: 'Resizing', icon: 'window', done: 'resized the window' };
    case 'cdp_command': return { label: `Send a browser command ${c(o.method || '', 30)}`, verb: 'Talking to the browser', icon: 'plug', done: 'sent a browser command' };
    case 'extension_reload': return { label: 'Reload the extension', verb: 'Reloading', icon: 'plug', done: 'reloaded the extension' };
    case 'Bash': case 'shell': case 'command_execution': {
      const cmd = raw || (Array.isArray(o.command) ? o.command.join(' ') : o.command || '');
      return { label: o.description ? `${esc(clip(o.description, 50))}` : `Run ${c(cmd, 50)}`, verb: 'Running a command', icon: 'terminal', done: 'ran a command' };
    }
    case 'Read': return { label: `Read ${file(o.file_path)}`, verb: 'Reading a file', icon: 'doc', done: 'read a file' };
    case 'Write': return { label: `Create ${file(o.file_path)}`, verb: 'Writing a file', icon: 'pencil', done: 'wrote a file' };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { label: `Edit ${file(o.file_path || o.notebook_path)}`, verb: 'Editing a file', icon: 'pencil', done: 'edited a file' };
    case 'file_change': return { label: 'Edit files', verb: 'Editing files', icon: 'pencil', done: 'edited files' };
    case 'Grep': return { label: `Search files for ${q(o.pattern)}`, verb: 'Searching files', icon: 'search', done: 'searched files' };
    case 'Glob': return { label: `Find files ${c(o.pattern || '')}`, verb: 'Finding files', icon: 'folder', done: 'searched files' };
    case 'LS': return { label: `List ${c(o.path || '')}`, verb: 'Listing files', icon: 'folder', done: 'listed files' };
    case 'WebFetch': return { label: `Fetch ${c(hostOf(o.url || ''))}`, verb: 'Fetching a page', icon: 'link', done: 'fetched a page' };
    case 'WebSearch': case 'web_search': return { label: `Search the web for ${q(o.query || raw)}`, verb: 'Searching the web', icon: 'search', done: 'searched the web' };
    case 'Task': case 'Agent': return { label: `Subagent: ${esc(clip(o.description || o.prompt || '', 50))}`, verb: 'Subagent working', icon: 'bot', done: 'used a subagent' };
    case 'TodoWrite': return { label: 'Update the plan', verb: 'Planning', icon: 'list', done: 'updated the plan' };
    case 'sidepanel_reply': return { label: 'Reply', verb: 'Writing', icon: 'spark', done: 'replied' };
    default: {
      const arg = Object.values(o).find((v) => typeof v === 'string');
      return { label: `${esc(humanize(short))}${arg ? ` ${c(arg, 40)}` : ''}`, verb: humanize(short), icon: 'bolt', done: humanize(short).toLowerCase() };
    }
  }
}

// "Read the page, clicked 3× and typed"
function summarize(dones) {
  const counts = new Map();
  for (const d of dones) counts.set(d, (counts.get(d) || 0) + 1);
  const parts = [...counts].map(([d, n]) => (n > 1 ? `${d} ${n}×` : d));
  const s = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pretty(s) {
  const o = parseInput(s);
  return o ? JSON.stringify(o, null, 2) : String(s ?? '');
}

// ---------- turn building ----------

function ensureTurn() {
  if (!turn) {
    turn = add(el('div', 'turn'));
    turn.since = lastUserTs;
  }
  return turn;
}

function closeThink(ts) {
  if (!thinkEl) return;
  const t = thinkEl;
  thinkEl = null;
  const end = t.end || ts || t.start;
  const dur = Math.max(0, end - t.start);
  const lbl = t.querySelector('.lbl');
  lbl.classList.remove('shimmer');
  lbl.textContent = dur >= 1000 ? `Thought for ${fmtMs(dur)}` : 'Thought briefly';
  // Nothing to show (thinking hidden by the model, or too short to matter): drop the row.
  if (!t.raw.trim()) t.remove();
}

function closeStream() {
  const m = streamEl;
  streamEl = null;
  if (m) finishText(m);
}

function closeSteps() {
  if (!steps) return;
  const g = steps;
  steps = null;
  updateSteps(g);
  if (!g.toggled && !g.querySelector('.step.run')) g.classList.remove('open');
}

function closeTurn(ts) {
  closeThink(ts);
  closeStream();
  closeSteps();
  turn = null;
}

function updateSteps(g) {
  const all = [...g.querySelectorAll('.step:not(.sub)')];
  const running = all.filter((s) => s.classList.contains('run')).length;
  const failed = all.filter((s) => s.classList.contains('bad')).length;
  const last = all[all.length - 1];
  const head = g.querySelector('.sum');
  const n = `${all.length} step${all.length === 1 ? '' : 's'}`;
  head.innerHTML = running
    ? `<b class="shimmer">${last?.querySelector('.lbl').innerHTML || 'Working'}…</b> <span class="n">${n}</span>`
    : `<b>${esc(summarize(all.map((s) => s.done)))}</b> <span class="n">${n}${failed ? ` · <span class="bad">${failed} failed</span>` : ''}</span>`;
  const first = all[0]?.start;
  const end = Math.max(...all.map((s) => s.end || s.start || 0));
  g.querySelector('.gdur').textContent = !running && first ? fmtMs(end - first) : '';
}

function makeStep(ev, cls) {
  const d = describe(ev.name, ev.input);
  const s = el('div', `step run${cls ? ` ${cls}` : ''}`);
  s.start = ev.ts;
  s.verb = d.verb;
  s.done = d.done;
  s.innerHTML = `<button class="step-row" title="Show details"><span class="si">${icon(d.icon)}</span><span class="lbl">${d.label}</span><span class="dur"></span><span class="st"><span class="spin"></span></span></button>
    ${fold(`<div class="step-detail"><div class="k">Tool · ${esc(strip(ev.name))}</div><pre class="in"></pre></div>`)}`;
  s.querySelector('.in').textContent = pretty(ev.input);
  s.querySelector('.step-row').addEventListener('click', () => s.classList.toggle('open'));
  stepEls.set(ev.id, s);
  return s;
}

// A subagent's own work, nested under its Agent step: a live line while it runs, the full list when opened.
function subBox(parent) {
  let box = parent.querySelector(':scope > .fold .subs');
  if (!box) {
    box = el('div', 'subs');
    parent.querySelector(':scope > .fold > div').prepend(box);
    parent.querySelector(':scope > .step-row').insertAdjacentElement('afterend', el('div', 'live'));
    parent.querySelector('.step-row').title = 'Show what the subagent did';
  }
  return box;
}

function updateSub(parent) {
  const subs = [...parent.querySelectorAll(':scope > .fold .subs > .step')];
  const live = parent.querySelector(':scope > .live');
  const running = parent.classList.contains('run');
  const cur = subs.filter((x) => x.classList.contains('run')).pop() || subs[subs.length - 1];
  live.innerHTML = `${running && cur ? `<span class="shimmer">${cur.querySelector('.lbl').innerHTML}</span> · ` : ''}${subs.length} step${subs.length === 1 ? '' : 's'}${running ? '' : ' · click to see them'}`;
}

function addSubStep(ev) {
  const parent = stepEls.get(ev.parent);
  if (!parent) return;
  const s = makeStep(ev, 'sub');
  s.parentStep = parent;
  subBox(parent).appendChild(s);
  updateSub(parent);
  updateStatus();
}

function addSubText(ev) {
  const parent = stepEls.get(ev.parent);
  if (!parent) return;
  const m = el('div', 'md subtext', markdown(clip(ev.text, 600)));
  m.raw = ev.text;
  subBox(parent).appendChild(m);
  updateSub(parent);
}

function addStep(ev) {
  if (ev.parent) return addSubStep(ev);
  ensureTurn();
  closeThink(ev.ts);
  closeStream();
  if (!steps) {
    steps = add(el('div', `steps${replaying ? '' : ' open'}`), turn);
    steps.innerHTML = `<button class="steps-head">${icon('chev').replace('<svg', '<svg class="chev"')}<span class="sum"></span><span class="dur gdur"></span></button>${fold('<div class="steps-list"></div>')}`;
    const g = steps;
    g.querySelector('.steps-head').addEventListener('click', () => {
      g.toggled = true;
      g.classList.toggle('open');
    });
  }
  const s = makeStep(ev);
  steps.querySelector('.steps-list').appendChild(s);
  updateSteps(steps);
  if (!replaying && nearBottom()) scrollDown();
  updateStatus();
}

function finishStep(ev) {
  const s = stepEls.get(ev.id);
  if (!s) return;
  s.classList.remove('run');
  s.classList.add(ev.ok ? 'ok' : 'bad');
  s.end = ev.ts;
  s.querySelector('.st').innerHTML = icon(ev.ok ? 'check' : 'x');
  if (ev.ts && s.start) s.querySelector('.dur').textContent = fmtMs(ev.ts - s.start);
  const det = s.querySelector('.step-detail');
  if (ev.text) {
    if (ev.ok) learnRefs(ev.text);
    det.insertAdjacentHTML('beforeend', `<div class="k">${ev.ok ? 'Result' : 'What went wrong'}</div><pre></pre>`);
    det.lastElementChild.textContent = ev.text;
    // Say why a step failed without making people open it.
    if (!ev.ok) s.querySelector('.step-row').insertAdjacentElement('afterend', el('div', 'why')).textContent = clip(ev.text.replace(/^error:\s*/i, ''), 140);
  }
  if (ev.image) {
    const img = el('img', 'shot-thumb');
    img.src = ev.image;
    img.dataset.zoom = '';
    s.appendChild(img);
  }
  if (s.parentStep) updateSub(s.parentStep);
  if (s.querySelector(':scope > .live')) updateSub(s);
  updateSteps(s.closest('.steps'));
  updateStatus();
}

function addThinking(ev) {
  ensureTurn();
  closeStream();
  closeSteps();
  if (!thinkEl) {
    thinkEl = add(el('div', 'think'), turn);
    thinkEl.start = ev.ts || Date.now();
    thinkEl.raw = '';
    thinkEl.innerHTML = `<button>${icon('chev').replace('<svg', '<svg class="chev"')}<span class="lbl shimmer">Thinking…</span></button>${fold('<div class="body"></div>')}`;
    const t = thinkEl;
    t.querySelector('button').addEventListener('click', () => t.raw.trim() && t.classList.toggle('open'));
  }
  thinkEl.raw += ev.text || '';
  thinkEl.end = ev.end || ev.ts || thinkEl.end;
  thinkEl.querySelector('.body').textContent = thinkEl.raw;
  updateStatus();
}

function addText(ev, final) {
  ensureTurn();
  closeThink(ev.ts);
  closeSteps();
  if (!streamEl) {
    streamEl = add(el('div', 'md streaming'), turn);
    streamEl.raw = '';
    streamEl.shown = 0;
  }
  const m = streamEl;
  m.raw = final ? ev.text || '' : m.raw + (ev.text || '');
  if (final) {
    // The block is complete; let the reveal catch up on its own, and start a fresh block for any text after it.
    m.final = true;
    streamEl = null;
  }
  if (replaying || calm.matches || document.hidden) finishText(m);
  else if (!m.raf) m.raf = requestAnimationFrame(() => revealText(m));
  updateStatus();
}

// Text arrives in uneven chunks; reveal it at a steady pace that speeds up when it falls behind.
function revealText(m) {
  m.raf = 0;
  const left = m.raw.length - m.shown;
  if (left > 0) {
    const stick = nearBottom();
    m.shown = Math.min(m.raw.length, m.shown + Math.max(3, Math.ceil(left / 8)));
    m.innerHTML = markdown(m.raw.slice(0, m.shown));
    if (stick) scrollDown();
  }
  if (m.shown < m.raw.length) m.raf = requestAnimationFrame(() => revealText(m));
  else if (m.final) finishText(m);
}

function finishText(m) {
  cancelAnimationFrame(m.raf);
  m.raf = 0;
  const stick = replaying || nearBottom();
  if (m.shown !== m.raw.length || !m.innerHTML) m.innerHTML = markdown(m.raw);
  m.shown = m.raw.length;
  if (m !== streamEl) m.classList.remove('streaming');
  if (stick) scrollDown();
}

function renderPlan(ev) {
  ensureTurn();
  closeThink(ev.ts);
  closeStream();
  const items = ev.items || [];
  let card = turn.querySelector(':scope > .plan');
  if (!card) {
    closeSteps();
    card = add(el('div', 'plan'), turn);
  }
  const done = items.filter((i) => i.status === 'completed').length;
  card.innerHTML = `<div class="plan-head">${icon('list')}<span>Plan</span><span class="count">${done}/${items.length} done</span></div>
    <div class="bar"><i style="width:${items.length ? (done / items.length) * 100 : 0}%"></i></div>
    <ul>${items.map((i) => `<li class="${esc(i.status)}"><span class="box">${i.status === 'completed' ? icon('check') : ''}</span><span>${esc(i.status === 'in_progress' && i.active ? i.active : i.text)}</span></li>`).join('')}</ul>`;
}

function renderPermission(ev) {
  ensureTurn();
  closeThink(ev.ts);
  closeStream();
  const d = describe(ev.tool, ev.input);
  // Only browser actions happen "on" a site; web search, shell and file tools don't.
  const browserTool = ev.browser ?? !/^[A-Z]/.test(ev.tool || '');
  const where = ev.key && ev.key.includes(':') && /\./.test(ev.key) ? ev.key.split(':').slice(1).join(':') : browserTool ? currentHost : '';
  const card = add(el('div', 'perm'), turn);
  card.innerHTML = `<div class="q"><span class="si">${icon(d.icon)}</span><div><b>${d.label}</b><small>${ev.agent ? `@${esc(ev.agent)} (background) wants to do this. ` : ''}Allow this${where ? ` on ${esc(where)}` : ''}?</small></div></div>
    <details><summary>Show exact request</summary><pre></pre></details>
    <div class="btns"><button class="btn primary" data-d="allow">Allow once</button><button class="btn" data-d="always">Always allow</button><button class="btn" data-d="deny">Deny</button></div>`;
  card.querySelector('pre').textContent = pretty(ev.input);
  card.querySelectorAll('.btns button').forEach((b) => b.addEventListener('click', () => port?.postMessage({ type: 'approve', id: ev.id, decision: b.dataset.d })));
  permEls.set(ev.id, card);
  if (!replaying) scrollDown();
}

function resolvePermission(ev) {
  const card = permEls.get(ev.id);
  if (!card) return;
  const text = { allow: 'Allowed once', always: 'Always allowed in this chat', deny: 'Denied', timeout: 'Timed out' }[ev.decision] || ev.decision;
  const ok = ev.decision === 'allow' || ev.decision === 'always';
  card.classList.add('resolved');
  card.querySelector('.btns')?.replaceWith(el('div', 'result', `${icon(ok ? 'check' : 'x')}${esc(text)}`));
}

function renderDone(ev) {
  const t = turn;
  closeTurn(ev.ts);
  if (ev.error) return add(el('div', 'error', `${icon('alert')}<span></span>`)).querySelector('span').textContent = ev.error;
  const bits = ev.replay
    ? [`Replayed ${ev.steps} step${ev.steps === 1 ? '' : 's'} in ${fmtMs(ev.ms)}`, 'no AI, 0 tokens']
    : [ev.ms && fmtMs(ev.ms), ev.turns > 1 && `${ev.turns} turns`, ev.tokens && `${fmtTokens(ev.tokens)} tokens`, ev.cost && `$${ev.cost.toFixed(4)}`, lastModel].filter(Boolean);
  const canSave = !ev.replay && t?.querySelector('.step');
  const meta = el('div', 'turn-meta', `<span class="ok">${icon(ev.replay ? 'play' : 'check')}</span><span>${esc(bits.join(' · '))}</span><span class="acts"><button class="mini" data-a="copy" title="Copy answer">${icon('copy')}</button>${canSave ? `<button class="mini" data-a="save" title="Save these steps as a workflow you can replay without the AI">${icon('bookmark')}</button>` : ''}</span>`);
  meta.querySelector('[data-a="copy"]').addEventListener('click', () => copy([...(t || log).querySelectorAll(':scope > .md')].map((m) => visible(m.raw)).filter(Boolean).join('\n\n')));
  if (!ev.replay && !ev.error) {
    const answer = [...(t || log).querySelectorAll(':scope > .md')].map((m) => m.raw).filter(Boolean);
    const own = suggestionIn(answer[answer.length - 1]);
    if (own) setSuggestion(own);
    else if (answer.length) suggestNext(answer.map(visible).join('\n\n'));
  }
  meta.querySelector('[data-a="save"]')?.addEventListener('click', () => askWorkflowName(meta, t.since));
  add(meta, t || log);
}

// Inline "name this workflow" form under a reply.
function askWorkflowName(after, since) {
  after.parentElement.querySelector('.savewf')?.remove();
  const f = el('form', 'savewf', `${icon('bookmark')}<span>/</span><input placeholder="name, e.g. daily-report" spellcheck="false" maxlength="40" /><button class="btn primary">Save</button><button type="button" class="mini" title="Cancel">${icon('x')}</button>`);
  const name = f.querySelector('input');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    port?.postMessage({ type: 'save_workflow', sid, name: name.value, since });
    f.remove();
  });
  f.querySelector('button[type="button"]').addEventListener('click', () => f.remove());
  after.after(f);
  name.focus();
  if (nearBottom()) scrollDown();
}

function renderWorkflowFailed(ev) {
  closeTurn(ev.ts);
  const card = add(el('div', 'wf-failed', `<div class="q"><span class="si">${icon('alert')}</span><div><b>Replay of /${esc(ev.name)} stopped at step ${ev.done + 1} of ${ev.total}</b><small></small></div></div>
    <div class="btns"><button class="btn primary">${icon('spark')}Let the AI finish</button><button class="btn" data-a="retry">${icon('play')}Try again</button></div>`));
  card.querySelector('small').textContent = ev.error;
  const [finish, retry] = card.querySelectorAll('button');
  finish.addEventListener('click', () => send(ev.prompt));
  retry.addEventListener('click', () => runWorkflow(ev.name));
}

function renderUser(ev) {
  closeTurn(ev.ts);
  setSuggestion('');
  lastUserTs = ev.ts || 0;
  const m = el('div', `msg-user${ev.workflow ? ' wf' : ''}`);
  if (ev.tab) {
    const tab = el('div', 'tab', `${icon('globe')}<span></span>`);
    tab.querySelector('span').textContent = ev.tab.replace(/^\[|\]$/g, '').replace(/^Tab \d+:\s*/, '');
    m.appendChild(tab);
  }
  if (ev.thumbs?.length) {
    const th = el('div', 'thumbs');
    for (const src of ev.thumbs) {
      const img = document.createElement('img');
      img.src = src;
      img.dataset.zoom = '';
      th.appendChild(img);
    }
    m.appendChild(th);
  }
  const b = el('div', 'bubble');
  if (ev.workflow) b.innerHTML = `${icon('play')}<span></span>`;
  (ev.workflow ? b.querySelector('span') : b).textContent = ev.workflow ? `Replay /${ev.workflow}` : ev.text;
  m.appendChild(b);
  const acts = el('div', 'acts', `<button class="mini" title="Copy">${icon('copy')}</button><button class="mini" title="Edit and resend">${icon('edit')}</button>`);
  const [cp, ed] = acts.querySelectorAll('button');
  cp.addEventListener('click', () => copy(ev.text));
  ed.addEventListener('click', () => {
    input.value = ev.text;
    autosize();
    input.focus();
  });
  m.appendChild(acts);
  add(m);
  if (!replaying) scrollDown();
}

function render(ev) {
  switch (ev.t) {
    case 'user': return renderUser(ev);
    case 'delta': return addText(ev, false);
    case 'text': return addText(ev, true);
    case 'thinking': return addThinking(ev);
    case 'tool': return addStep(ev);
    case 'tool_result': return finishStep(ev);
    case 'todo': return renderPlan(ev);
    case 'permission': return renderPermission(ev);
    case 'permission_done': return resolvePermission(ev);
    case 'done': return renderDone(ev);
    case 'workflow_failed': return renderWorkflowFailed(ev);
    case 'sub_text': return addSubText(ev);
    case 'bg_task': return renderBgTask(ev);
    case 'bg_done': return finishBgTask(ev);
    case 'stopped':
      closeTurn(ev.ts);
      return add(el('div', 'notice', 'Stopped'));
    case 'notice':
      return add(el('div', 'notice')).append(ev.text);
    case 'error':
      closeTurn(ev.ts);
      return add(el('div', 'error', `${icon('alert')}<span></span>`)).querySelector('span').append(ev.message || 'Error');
    case 'session':
      if (ev.model) lastModel = ev.model;
      return;
    case 'busy':
      if (ev.on) busySince = ev.ts || Date.now();
      return setBusy(ev.on);
    case 'available':
      available = { ...available, ...ev };
      renderAgentUI();
      return;
  }
}

function resetLog() {
  log.textContent = '';
  setSuggestion('');
  turn = steps = thinkEl = streamEl = null;
  stepEls.clear();
  bgCards.clear();
  refNames.clear();
  permEls.clear();
  lastModel = '';
}

// ---------- empty state ----------

const SUGGESTIONS = [
  ['doc', 'Summarize this page'],
  ['search', 'Find the main buttons and forms on this page'],
  ['activity', 'List the API requests this page makes'],
  ['wand', 'Check this page for errors in the console'],
];

let currentTab = null;
let currentHost = '';

function renderEmpty() {
  if (log.querySelector(':scope > :not(.empty)')) return;
  log.textContent = '';
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Up late?' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const e = el('div', 'empty', `<div class="mark"><img src="icons/icon-128.png" alt="" /></div><h1>${hello}</h1><p>What should we do on this page?</p>
    <div class="pagecard"><img alt="" /><div><div class="pt"></div><div class="ph"></div></div></div>
    <div class="suggest">${SUGGESTIONS.map(([i, t]) => `<button>${icon(i)}<span>${esc(t)}</span></button>`).join('')}</div>`);
  e.querySelectorAll('.suggest button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));
  log.appendChild(e);
  updatePageCard();
}

function updatePageCard() {
  const card = log.querySelector('.pagecard');
  if (!card) return;
  card.querySelector('img').src = favicon(currentTab);
  card.querySelector('.pt').textContent = currentTab?.title || 'No tab';
  card.querySelector('.ph').textContent = currentTab?.url ? hostOf(currentTab.url) : '';
}

// ---------- status ----------

function setBusy(on) {
  busy = on;
  if (on && !busySince) busySince = Date.now();
  if (!on) busySince = 0;
  document.body.classList.toggle('busy', on);
  updateSendState();
  clearInterval(setBusy.timer);
  if (on) setBusy.timer = setInterval(updateStatus, 1000);
  // Something to look at between sending and the first word back.
  if (on && !turn && !replaying && !log.querySelector(':scope > .pending')) add(el('div', 'pending', '<i></i><i></i><i></i>'));
  if (!on) log.querySelector(':scope > .pending')?.remove();
  updateStatus();
}

function updateStatus() {
  const st = $('status');
  if (voice) {
    st.innerHTML = `<span class="rec"></span><span class="verb">${voice.heard || voice.interim ? 'Listening' : 'Listening… start speaking'}</span><span class="esc">pause to send · <kbd>Esc</kbd> to cancel</span>`;
  } else if (busy) {
    const running = [...log.querySelectorAll('.step.run')].pop();
    const verb = running ? running.verb : thinkEl ? 'Thinking' : streamEl ? 'Writing' : 'Working';
    const secs = busySince ? Math.max(0, Math.round((Date.now() - busySince) / 1000)) : 0;
    st.innerHTML = `<span class="spark">${icon('spark')}</span><span class="verb shimmer">${esc(verb)}…</span><span class="time">${secs}s</span><span class="esc"><kbd>Esc</kbd> to stop</span>`;
  } else if (settings.agent === 'terminal') {
    st.innerHTML = terminal.listening
      ? '<span class="dot on"></span>Terminal AI is listening'
      : `<span class="dot"></span>${terminal.recent ? 'Terminal AI is busy or paused' : 'No terminal AI listening yet'}`;
  } else if (available.host === false) {
    st.innerHTML = '<span class="dot off"></span>Native host not connected. Run <code>aichrome install</code>.';
  } else st.textContent = '';
}

// ---------- agent + mode UI ----------

const AGENTS = {
  claude: { name: 'Claude Code', desc: 'Your logged-in Claude Code, run in the background', icon: 'spark' },
  codex: { name: 'Codex', desc: 'Your logged-in Codex CLI', icon: 'code' },
  ollama: { name: 'Ollama', desc: 'Open-source models running on your computer', icon: 'bot' },
  terminal: { name: 'Terminal AI', desc: 'An AI already open in your terminal answers', icon: 'terminal' },
};

// Model suggestions per AI. Ollama lists the models installed on this computer.
const MODEL_HINTS = { claude: ['sonnet', 'opus', 'haiku'], codex: ['gpt-5-codex', 'gpt-5'] };
const isOllama = () => settings.agent === 'ollama';
const currentModel = () => (isOllama() ? settings.ollamaModel : settings.model);
// Tool calling is what lets a model drive the browser; prefer families known to support it.
const TOOL_MODELS = /^(qwen3|qwen2\.5|llama3\.[123]|gpt-oss|mistral|mistral-small|granite3|command-r|hermes3|devstral|magistral|deepseek-v3)/i;

function renderModelField() {
  const models = isOllama() ? available.ollama?.models || [] : MODEL_HINTS[settings.agent] || [];
  $('models').innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
  if (document.activeElement !== $('model')) $('model').value = currentModel() || '';
  $('model').placeholder = isOllama() ? (models[0] || 'e.g. qwen3') : 'default';
  $('ollamaUrlField').hidden = !isOllama();
  $('cwdField').hidden = isOllama();
  if (document.activeElement !== $('ollamaUrl')) $('ollamaUrl').value = settings.ollamaUrl || '';
  // First time on Ollama: pick an installed model that can use tools.
  if (isOllama() && !settings.ollamaModel && models.length) {
    settings.ollamaModel = models.find((m) => TOOL_MODELS.test(m)) || models[0];
    chrome.storage.local.set({ panelSettings: settings });
    $('model').value = settings.ollamaModel;
  }
}
const MODES = {
  ask: { name: 'Ask before acting', short: 'Ask', desc: 'Approve clicks, typing and navigation', icon: 'shield' },
  auto: { name: 'Act without asking', short: 'Auto', desc: 'Browser actions run without prompts', icon: 'bolt' },
};

function agentState(k) {
  if (available.host === false) return 'off';
  if (k === 'terminal') return terminal.listening ? 'on' : '';
  if (!(k in available)) return '';
  if (k === 'ollama') return available.ollama?.models?.length ? 'on' : 'off';
  return available[k] ? 'on' : 'off';
}

function renderAgentUI() {
  const a = AGENTS[settings.agent] || AGENTS.claude;
  $('agentName').textContent = a.name;
  $('agentDot').className = `dot ${agentState(settings.agent)}`;
  $('agentMenu').innerHTML = Object.entries(AGENTS).map(([k, v]) => `<button class="item${k === settings.agent ? ' cur' : ''}" data-k="${k}" role="menuitem">
    <span class="ico">${icon(v.icon)}</span><span><span class="t">${esc(v.name)} <span class="dot ${agentState(k)}"></span></span><span class="d">${esc(v.desc)}</span></span><span class="check">${icon('check')}</span></button>`).join('');
  $('agentMenu').querySelectorAll('.item').forEach((b) => b.addEventListener('click', () => {
    setSetting('agent', b.dataset.k);
    closeMenus();
  }));
  $('agentCards').innerHTML = Object.entries(AGENTS).map(([k, v]) => `<button class="card${k === settings.agent ? ' cur' : ''}" data-k="${k}">
    <span class="ico">${icon(v.icon)}</span><div><div class="t">${esc(v.name)}</div><div class="d">${esc(v.desc)}</div></div><span class="dot ${agentState(k)}"></span></button>`).join('');
  $('agentCards').querySelectorAll('.card').forEach((b) => b.addEventListener('click', () => setSetting('agent', b.dataset.k)));

  const m = MODES[settings.mode] || MODES.ask;
  $('modeName').textContent = m.short;
  $('modeIcon').innerHTML = P[m.icon];
  $('modeBtn').classList.toggle('auto', settings.mode === 'auto');
  $('modeBtn').title = m.name;
  $('modeMenu').innerHTML = Object.entries(MODES).map(([k, v]) => `<button class="item${k === settings.mode ? ' cur' : ''}" data-k="${k}" role="menuitem">
    <span class="ico">${icon(v.icon)}</span><span><span class="t">${esc(v.name)}</span><span class="d">${esc(v.desc)}</span></span><span class="check">${icon('check')}</span></button>`).join('');
  $('modeMenu').querySelectorAll('.item').forEach((b) => b.addEventListener('click', () => {
    setSetting('mode', b.dataset.k);
    closeMenus();
  }));
  $('modeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('cur', b.dataset.v === settings.mode));
  $('themeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('cur', b.dataset.v === settings.theme));
  $('voiceFixSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('cur', b.dataset.v === String(settings.voiceFix !== false)));

  const h = $('agentHint');
  if (settings.agent === 'terminal') h.innerHTML = 'In any terminal AI connected to the <code>ai-in-chrome</code> MCP server, say: <code>listen to the AI in Chrome side panel</code>.';
  else if (isOllama()) {
    const o = available.ollama;
    h.innerHTML = !o
      ? 'Ollama isn\'t running. Install it from <code>ollama.com</code>, open it, then pull a model: <code>ollama pull qwen3</code>.'
      : !o.models.length
        ? `Ollama is running at <code>${esc(o.url)}</code> but has no models. Run <code>ollama pull qwen3</code>.`
        : `Local models at <code>${esc(o.url)}</code>. Pick one that supports tools (qwen3, llama3.1, gpt-oss…) so it can control the browser.`;
  } else if (settings.agent === 'claude') h.innerHTML = available.claude ? `Uses <code>${esc(available.claude)}</code>.` : 'Claude Code not found yet. Install it, then run <code>aichrome install</code> again.';
  else h.innerHTML = available.codex ? `Uses <code>${esc(available.codex)}</code>.` : 'Codex not found yet. Install it, then run <code>aichrome install</code> again.';
  renderModelField();
  $('hostStatus').innerHTML = available.host === false
    ? '<span class="dot off"></span> Native host not connected. Run <code>aichrome install</code>, then click the extension icon.'
    : '<span class="dot on"></span> Native host connected.';
  updateStatus();
}

function applyTheme() {
  if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme;
  else delete document.documentElement.dataset.theme;
}

function setSetting(key, value) {
  settings[key] = value;
  chrome.storage.local.set({ panelSettings: settings });
  if (key === 'theme') applyTheme();
  if (key === 'mode') port?.postMessage({ type: 'set_mode', mode: value });
  if ((key === 'agent' && value === 'ollama') || key === 'ollamaUrl') port?.postMessage({ type: 'refresh_agents', sid });
  renderAgentUI();
}

// ---------- menus & drawers ----------

function closeMenus() {
  for (const id of ['agentMenu', 'modeMenu', 'slash']) $(id).hidden = true;
  $('agentBtn').setAttribute('aria-expanded', 'false');
}

function toggleMenu(id, btn) {
  const open = $(id).hidden;
  closeMenus();
  $(id).hidden = !open;
  btn?.setAttribute('aria-expanded', String(open));
}

function openDrawer(id) {
  closeDrawers();
  $(id).hidden = false;
  $('scrim').hidden = false;
  if (id === 'historyDrawer') {
    port?.postMessage({ type: 'list_chats' });
    renderHistory();
    $('historySearch').focus();
  } else {
    renderShortcuts();
    renderWorkflows();
  }
}

function closeDrawers() {
  $('historyDrawer').hidden = true;
  $('settingsDrawer').hidden = true;
  $('scrim').hidden = true;
}

function renderHistory() {
  const q = $('historySearch').value.trim().toLowerCase();
  const list = $('historyList');
  const rows = chatList.filter((c) => !q || String(c.title || '').toLowerCase().includes(q));
  if (!rows.length) {
    list.innerHTML = `<div class="none">${q ? 'No matching chats' : 'No chats yet'}</div>`;
    return;
  }
  const day = 864e5;
  const today = new Date().setHours(0, 0, 0, 0);
  const group = (t) => (t >= today ? 'Today' : t >= today - day ? 'Yesterday' : t >= today - 7 * day ? 'This week' : 'Earlier');
  list.textContent = '';
  let last = '';
  for (const c of rows) {
    const g = group(c.updated || 0);
    if (g !== last) list.appendChild(el('div', 'grp', g));
    last = g;
    const r = el('div', `hrow${c.sid === sid ? ' cur' : ''}`, `<span class="ht"></span><span class="hm"></span><button class="mini" title="Delete">${icon('trash')}</button>`);
    r.querySelector('.ht').textContent = c.title || 'Untitled chat';
    const time = new Date(c.updated || 0);
    r.querySelector('.hm').textContent = `${AGENTS[c.kind]?.name || ''}${c.kind ? ' · ' : ''}${g === 'Today' || g === 'Yesterday' ? time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : time.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    r.addEventListener('click', () => {
      closeDrawers();
      if (c.sid !== sid) openChat(c.sid);
    });
    r.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      port?.postMessage({ type: 'delete_chat', sid: c.sid });
      chatList = chatList.filter((x) => x.sid !== c.sid);
      renderHistory();
      if (c.sid === sid) newChat();
      setTimeout(() => port?.postMessage({ type: 'list_chats' }), 150);
    });
    list.appendChild(r);
  }
}

function renderShortcuts() {
  const box = $('shortcutList');
  box.textContent = '';
  for (const [i, s] of (settings.shortcuts || []).entries()) {
    const r = el('div', 'shortcut', `<code></code><div></div><button class="mini" title="Remove">${icon('trash')}</button>`);
    r.querySelector('code').textContent = `/${s.name}`;
    r.querySelector('div').textContent = s.prompt;
    r.querySelector('button').addEventListener('click', () => {
      settings.shortcuts.splice(i, 1);
      setSetting('shortcuts', settings.shortcuts);
      renderShortcuts();
    });
    box.appendChild(r);
  }
}

// ---------- slash commands ----------

function commands() {
  const builtins = [
    { name: 'new', desc: 'Start a new chat', icon: 'plus', run: newChat },
    { name: 'history', desc: 'Open chat history', icon: 'history', run: () => openDrawer('historyDrawer') },
    { name: 'settings', desc: 'Open settings', icon: 'settings', run: () => openDrawer('settingsDrawer') },
    { name: 'screenshot', desc: 'Attach a screenshot of this tab', icon: 'camera', run: attachScreenshot },
    { name: 'voice', desc: 'Speak your message instead of typing', icon: 'mic', run: toggleVoice },
    { name: 'summarize', desc: 'Summarize this page', icon: 'doc', run: () => send('Summarize this page') },
    { name: 'mode', desc: `Switch to "${settings.mode === 'ask' ? MODES.auto.name : MODES.ask.name}"`, icon: 'shield', run: () => setSetting('mode', settings.mode === 'ask' ? 'auto' : 'ask') },
  ];
  builtins.push(
    { name: 'save', desc: 'Save this chat’s browser steps as a workflow: /save name', icon: 'bookmark', run: () => fill('/save ') },
    { name: 'skill', desc: 'Have the AI write a reusable skill for this task: /skill name', icon: 'spark', run: () => fill('/skill ') },
  );
  const user = (settings.shortcuts || []).map((s) => ({ name: s.name, desc: s.prompt, icon: 'wand', run: () => send(s.prompt) }));
  const flows = workflows.map((w) => ({ name: w.name, desc: `Replay ${w.steps.length} steps, no AI${w.title ? ` · ${w.title}` : ''}`, icon: 'play', run: () => runWorkflow(w.name) }));
  return [...flows, ...user, ...builtins];
}

let slashSel = 0;
let slashItems = [];

// @name: the AIs you can run a background task on, and your Claude Code subagents.
function agentChoices() {
  const kinds = ['claude', 'codex', 'ollama'].filter((k) => agentState(k) === 'on')
    .map((k) => ({ name: k, desc: `Run a task on ${AGENTS[k].name} in the background`, icon: AGENTS[k].icon }));
  const subs = available.claude ? (available.subagents || []).map((a) => ({ name: a.name, desc: a.description || 'Claude Code subagent', icon: 'bot' })) : [];
  return [...subs, ...kinds].map((a) => ({ ...a, at: true, run: () => fill(`@${a.name} `) }));
}

function updateSlash() {
  const m = /^([/@])(\S*)$/.exec(input.value);
  const menu = $('slash');
  if (!m) {
    menu.hidden = true;
    return;
  }
  const q = m[2].toLowerCase();
  slashItems = (m[1] === '@' ? agentChoices() : commands()).filter((c) => c.name.toLowerCase().startsWith(q) || (q && c.desc.toLowerCase().includes(q)));
  if (!slashItems.length) {
    menu.hidden = true;
    return;
  }
  slashSel = Math.min(slashSel, slashItems.length - 1);
  menu.innerHTML = slashItems.map((c, i) => `<button class="item${i === slashSel ? ' sel' : ''}" data-i="${i}" role="option"><span class="ico">${icon(c.icon)}</span><span><span class="t"><code>${c.at ? '@' : '/'}${esc(c.name)}</code></span><span class="d">${esc(clip(c.desc, 70))}</span></span></button>`).join('');
  menu.querySelectorAll('.item').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    runSlash(+b.dataset.i);
  }));
  menu.hidden = false;
}

function fill(text) {
  input.value = text;
  autosize();
  input.focus();
}

async function runWorkflow(name) {
  if (busy) return toast('Still working. Press Esc to stop first.');
  const tab = await activeTab();
  port?.postMessage({ type: 'run_workflow', sid, name, tabId: tab?.id });
}

const skillPrompt = (name) => `Turn the task you did in this chat into a reusable skill named "${name}" so next time it can be done quickly, without exploring the page again. ` +
  `Write it to ~/.claude/skills/${name}/SKILL.md with frontmatter (name, and a description of when to use it). ` +
  'In the body, list the exact steps: the URLs to open, the elements to use by their visible names, what to type, and how to check it worked. ' +
  'Mention anything that changes between runs as an input to ask for. Keep it short.';

function renderWorkflows() {
  const box = $('workflowList');
  box.textContent = '';
  if (!workflows.length) box.innerHTML = '<p class="hint">None yet. After the AI finishes a task, click the bookmark under its reply.</p>';
  for (const w of workflows) {
    const r = el('div', 'shortcut', `<code></code><div></div><button class="mini" title="Run">${icon('play')}</button><button class="mini" title="Delete">${icon('trash')}</button>`);
    r.querySelector('code').textContent = `/${w.name}`;
    r.querySelector('div').textContent = `${w.steps.length} steps${w.title ? ` · ${w.title}` : ''}`;
    const [run, del] = r.querySelectorAll('button');
    run.addEventListener('click', () => {
      closeDrawers();
      runWorkflow(w.name);
    });
    del.addEventListener('click', () => chrome.storage.local.set({ workflows: workflows.filter((x) => x.name !== w.name) }));
    box.appendChild(r);
  }
}

// ---------- @agent background tasks ----------

const bgCards = new Map(); // bg sid -> card

function startBgTask(agent, text) {
  if (!agentChoices().some((a) => a.name === agent)) return toast(`No agent called @${agent}. Type @ to see them.`, 2500);
  activeTab().then((tab) => port?.postMessage({ type: 'bg_task', sid, agent, text, tabId: tab?.id, kind: settings.agent, cwd: settings.cwd || '~', mode: settings.mode, model: currentModel(), ollamaUrl: settings.ollamaUrl }));
  fill('');
}

function renderBgTask(ev) {
  const card = el('div', 'bgcard run', `<div class="bh"><span class="si">${icon('bot')}</span><div class="bt"><b>@${esc(ev.agent)}</b><span class="task"></span></div><button class="mini" title="Open this task’s full chat">${icon('chev')}</button></div>
    <div class="bl"><span class="spin"></span><span class="now">Starting…</span></div>`);
  card.querySelector('.task').textContent = ev.text;
  card.querySelector('button').addEventListener('click', () => openChat(ev.bg));
  card.querySelector('.bh').addEventListener('click', (e) => !e.target.closest('button') && openChat(ev.bg));
  bgCards.set(ev.bg, card);
  add(card);
}

function updateBgTask(msg) {
  const card = bgCards.get(msg.bg);
  if (!card || !card.classList.contains('run')) return;
  if (msg.tool) card.querySelector('.now').innerHTML = `<span class="shimmer">${describe(msg.tool.name, msg.tool.input).label}</span>`;
  card.querySelector('.bl').dataset.n = msg.steps ? `${msg.steps} step${msg.steps === 1 ? '' : 's'}` : '';
}

function finishBgTask(ev) {
  const card = bgCards.get(ev.bg);
  if (!card) return;
  card.classList.remove('run');
  card.classList.add(ev.ok ? 'ok' : 'bad');
  const meta = [ev.steps && `${ev.steps} step${ev.steps === 1 ? '' : 's'}`, ev.ms && fmtMs(ev.ms), ev.tokens && `${fmtTokens(ev.tokens)} tokens`].filter(Boolean).join(' · ');
  const bl = card.querySelector('.bl');
  bl.innerHTML = `<span class="st">${icon(ev.ok ? 'check' : 'x')}</span><span class="now">${ev.ok ? 'Done' : 'Didn’t finish'}${meta ? ` · ${esc(meta)}` : ''}</span>`;
  delete bl.dataset.n;
  if (ev.text) {
    const res = el('div', 'md bres', markdown(ev.text));
    res.raw = ev.text;
    card.appendChild(res);
    if (ev.text.length > 500) {
      res.classList.add('clamped');
      const more = el('button', 'more', 'Show all');
      more.addEventListener('click', () => {
        res.classList.toggle('clamped');
        more.textContent = res.classList.contains('clamped') ? 'Show all' : 'Show less';
      });
      card.appendChild(more);
    }
  }
  if (!replaying && nearBottom()) scrollDown();
  if (!replaying && ev.ok && !busy) setSuggestion(`Use what @${ev.agent} found`);
}

function runSlash(i) {
  const c = slashItems[i];
  $('slash').hidden = true;
  if (!c?.at) {
    input.value = '';
    autosize();
  }
  c?.run();
}

// ---------- attachments ----------

async function prepareImage(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
  const big = canvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  big.getContext('2d').drawImage(bmp, 0, 0, big.width, big.height);
  const keepPng = blob.type === 'image/png' && scale === 1 && blob.size < 1.5e6;
  const url = keepPng ? await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); }) : big.toDataURL('image/jpeg', 0.85);
  const ts = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
  const small = canvas(Math.max(1, Math.round(bmp.width * ts)), Math.max(1, Math.round(bmp.height * ts)));
  small.getContext('2d').drawImage(bmp, 0, 0, small.width, small.height);
  bmp.close?.();
  const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(url);
  return { mediaType, data, thumb: small.toDataURL('image/jpeg', 0.7) };
}

async function addImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (attachments.length >= 5) return toast('Up to 5 images');
    try {
      attachments.push(await prepareImage(f));
    } catch {
      toast('Could not read that image');
    }
  }
  renderAttachments();
}

async function attachScreenshot() {
  try {
    const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
    await addImages([await (await fetch(url)).blob()]);
    input.focus();
  } catch (e) {
    toast(`Can't capture this tab${e?.message ? `: ${clip(e.message, 40)}` : ''}`);
  }
}

function renderAttachments() {
  const box = $('attachments');
  box.hidden = !attachments.length;
  box.textContent = '';
  attachments.forEach((a, i) => {
    const d = el('div', 'att', `<img alt="" data-zoom /><button title="Remove">${icon('x')}</button>`);
    d.querySelector('img').src = a.thumb;
    d.querySelector('button').addEventListener('click', () => {
      attachments.splice(i, 1);
      renderAttachments();
    });
    box.appendChild(d);
  });
  updateSendState();
}

// ---------- voice ----------

// Chrome's speech recognition. A side panel can't show the microphone prompt, so the first time we ask from a tab (mic.html).
const Recognition = self.SpeechRecognition || self.webkitSpeechRecognition;
let voice = null; // { rec, base, heard, interim, send, timer }

async function micState() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'prompt';
  }
}

async function toggleVoice() {
  if (voice) return stopVoice(true);
  if (!Recognition) return toast('Voice input isn\'t supported in this browser');
  const state = await micState();
  if (state === 'denied') return toast('Microphone is blocked for AI in Chrome. Allow it in Chrome’s site settings.');
  if (state !== 'granted') return askMic();
  startVoice();
}

function askMic() {
  chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
  toast('Allow the microphone in the new tab');
}

function startVoice() {
  if (voice) return;
  const rec = new Recognition();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  const base = input.value.trim();
  voice = { rec, base: base ? `${base} ` : '', heard: '', interim: '', send: true };
  const v = voice;
  rec.onresult = (e) => {
    v.interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) v.heard += e.results[i][0].transcript;
      else v.interim += e.results[i][0].transcript;
    }
    input.value = v.base + v.heard + v.interim;
    autosize();
    updateStatus();
    // A pause after speaking sends the message.
    clearTimeout(v.timer);
    v.timer = setTimeout(() => stopVoice(true), v.interim ? 2500 : 1400);
  };
  rec.onerror = (e) => {
    v.send = false;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') askMic();
    else if (e.error === 'no-speech') toast('Didn’t hear anything');
    else if (e.error === 'network') toast('Voice input needs an internet connection');
    else if (e.error === 'audio-capture') toast('No microphone found');
    else if (e.error !== 'aborted') toast(`Voice input stopped: ${e.error}`);
  };
  rec.onend = () => {
    clearTimeout(v.timer);
    if (voice === v) voice = null;
    const text = (v.base + v.heard).trim();
    if (!v.typed) input.value = text;
    autosize();
    setVoiceUI();
    if (v.send && v.heard.trim()) polishAndSend(text);
  };
  try {
    rec.start();
  } catch {
    voice = null;
    return toast('Couldn’t start the microphone');
  }
  setVoiceUI();
}

// send: keep what was heard and send it; otherwise drop it and put the box back how it was.
function stopVoice(sendIt) {
  if (!voice) return;
  clearTimeout(voice.timer);
  voice.send = sendIt;
  if (sendIt) voice.rec.stop();
  else {
    voice.heard = '';
    voice.rec.abort();
  }
}

function setVoiceUI() {
  const on = !!voice;
  $('micBtn').classList.toggle('on', on);
  $('micBtn').title = on ? 'Stop and send' : 'Speak your message';
  $('composer').classList.toggle('listening', on);
  input.placeholder = on ? 'Listening…' : PLACEHOLDER;
  updateSendState();
  updateStatus();
}

const PLACEHOLDER = input.placeholder;

// ---------- voice clean-up: a separate small model fixes what speech recognition misheard ----------

const VOICE_FIX_PROMPT = 'You fix speech-to-text transcripts. The user dictated a message to an AI assistant that controls their web browser. ' +
  'Correct words the speech recognizer most likely misheard: names, product and technical terms, words from the page they are on, homophones, split or merged words. ' +
  'Fix punctuation and capitalization. Keep their meaning, wording and language. Do not answer, explain, translate, or add anything. ' +
  'If it is already right, return it unchanged. Reply with only the corrected message text.';

// What the fixer gets to go on: the page, and the last thing said in the chat.
function voiceContext() {
  const lastUser = [...log.querySelectorAll('.msg-user .bubble')].pop()?.textContent || '';
  const lastAi = visible([...log.querySelectorAll('.md')].pop()?.raw || '');
  return [
    currentTab && `Page: ${clip(currentTab.title, 80)} (${hostOf(currentTab.url || '')})`,
    lastUser && `Their last message: ${clip(lastUser, 160)}`,
    lastAi && `Assistant's last reply: ${clip(lastAi, 240)}`,
  ].filter(Boolean).join('\n');
}

// Chrome's built-in model (Gemini Nano) runs on this computer: fast and free. Otherwise the native host
// asks Ollama or a one-shot Claude Haiku.
// undefined when Chrome's model isn't available here.
const nano = new Map(); // system prompt -> session
async function chromeModel(system, prompt) {
  if (!self.LanguageModel || (await LanguageModel.availability().catch(() => 'unavailable')) !== 'available') return undefined;
  if (!nano.has(system)) nano.set(system, LanguageModel.create({ initialPrompts: [{ role: 'system', content: system }] }));
  const s = await (await nano.get(system)).clone();
  try {
    return await s.prompt(prompt);
  } finally {
    s.destroy();
  }
}

const fixWithChrome = (text, context) => chromeModel(VOICE_FIX_PROMPT, `${context ? `${context}\n\n` : ''}Transcript: ${text}`);

// A quick side call through the native host (Ollama or one-shot Claude Haiku); resolves null on failure.
const hostWaits = new Map(); // id -> resolve
function hostQuick(type, payload) {
  const id = `${type}${Date.now()}`;
  port?.postMessage({ type, sid, id, ...payload, kind: settings.agent, model: currentModel(), ollamaUrl: settings.ollamaUrl });
  return new Promise((resolve) => {
    hostWaits.set(id, resolve);
    setTimeout(() => hostWaits.delete(id) && resolve(null), 16000);
  });
}
const fixWithHost = (text, context) => hostQuick('voice_fix', { text, context });

// Model output that is clearly not a corrected transcript (an answer, a refusal, an essay) is ignored.
function sane(original, fixed) {
  fixed = String(fixed || '').trim().replace(/^transcript:\s*/i, '').replace(/^["“](.*)["”]$/s, '$1').trim();
  if (!fixed || fixed.length > original.length * 1.6 + 30 || fixed.split('\n').length > original.split('\n').length + 1) return original;
  return fixed;
}

async function fixTranscript(text) {
  const context = voiceContext();
  try {
    const local = await fixWithChrome(text, context);
    if (local !== undefined) return sane(text, local);
  } catch {}
  return sane(text, await fixWithHost(text, context));
}

// Word-level diff (LCS), for the animation: [{ w, op: '=' | '-' | '+' }]
function wordDiff(a, b) {
  const x = a.split(/\s+/).filter(Boolean);
  const y = b.split(/\s+/).filter(Boolean);
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push({ w: x[i++], op: '=' });
      j++;
    }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push({ w: y[j++], op: '+' });
    else out.push({ w: x[i++], op: '-' });
  }
  return out;
}

let polish = null; // { card, original, fixed, timer }

async function polishAndSend(text) {
  if (!settings.voiceFix) return send(text);
  cancelPolish();
  fill('');
  const card = el('div', 'vfix', `<div class="vh"><span class="spark">${icon('spark')}</span><span class="vl shimmer">Making sure I heard you right…</span><span class="spacer"></span><button class="mini" data-a="undo" title="Use exactly what was heard">${icon('x')}</button></div><div class="vt"></div>`);
  card.querySelector('.vt').textContent = text;
  card.querySelector('[data-a="undo"]').addEventListener('click', () => cancelPolish(true));
  $('composer').before(card);
  const p = (polish = { card, original: text });
  const fixed = await fixTranscript(text);
  if (polish !== p) return; // cancelled
  p.fixed = fixed;
  const diff = wordDiff(text, fixed);
  const changed = diff.filter((d) => d.op === '+').length;
  const label = card.querySelector('.vl');
  label.classList.remove('shimmer');
  if (!changed && fixed === text) {
    label.textContent = 'Got it';
    p.timer = setTimeout(() => finishPolish(fixed), 250);
    return;
  }
  // Removed words strike through and fold away; corrected words fade in, one after another.
  const vt = card.querySelector('.vt');
  vt.textContent = '';
  let k = 0;
  for (const d of diff) {
    const w = el('span', d.op === '=' ? 'same' : d.op === '+' ? 'in' : 'out');
    w.textContent = `${d.w} `; // the space folds away with a removed word
    if (d.op !== '=') w.style.animationDelay = `${(k++ * 70)}ms`;
    vt.append(w);
  }
  label.innerHTML = `Fixed ${changed || 'a few'} word${changed === 1 ? '' : 's'} · <button class="link" data-a="orig">use original</button> · <button class="link" data-a="edit">edit</button>`;
  label.querySelector('[data-a="orig"]').addEventListener('click', () => cancelPolish(true));
  label.querySelector('[data-a="edit"]').addEventListener('click', () => {
    cancelPolish();
    fill(fixed);
  });
  card.classList.add('done');
  p.timer = setTimeout(() => finishPolish(fixed), 1600 + k * 70);
}

function finishPolish(text) {
  const p = polish;
  if (!p) return;
  polish = null;
  p.card.classList.add('leaving');
  setTimeout(() => p.card.remove(), 180);
  send(text);
}

// restore: put what was actually heard back in the box instead of sending.
function cancelPolish(restore = false) {
  const p = polish;
  if (!p) return false;
  polish = null;
  clearTimeout(p.timer);
  p.card.remove();
  if (restore) fill(p.original);
  return true;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'aichrome-mic-granted') return;
  toast('Microphone ready, listening…');
  startVoice();
});

// ---------- current tab ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab;
}

async function showTab() {
  currentTab = await activeTab();
  currentHost = currentTab?.url ? hostOf(currentTab.url).split('/')[0] : '';
  $('tabTitle').textContent = currentTab ? currentTab.title || currentTab.url : 'No tab';
  $('tabIcon').src = favicon(currentTab);
  $('tabChip').title = currentTab ? `Working on: ${currentTab.title || ''}\n${currentTab.url || ''}` : 'No tab';
  updatePageCard();
}

chrome.tabs.onActivated.addListener((i) => i.windowId === windowId && showTab());
chrome.tabs.onUpdated.addListener((id, info, tab) => tab.windowId === windowId && tab.active && (info.title || info.favIconUrl || info.url) && showTab());

// ---------- connection ----------

function connect() {
  port = chrome.runtime.connect({ name: 'panel' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'history') {
      resetLog();
      terminal = msg.terminal || terminal;
      replaying = true;
      try {
        for (const ev of msg.events || []) render(ev);
      } finally {
        replaying = false;
      }
      if (!msg.busy) {
        // Steps that never got a result (stopped, or the worker restarted) shouldn't spin forever.
        log.querySelectorAll('.step.run').forEach((s) => {
          s.classList.remove('run');
          s.querySelector('.st').textContent = '–';
        });
        log.querySelectorAll('.steps').forEach(updateSteps);
        closeTurn();
      }
      if (msg.busy && !busySince) busySince = [...(msg.events || [])].reverse().find((e) => e.t === 'user')?.ts || Date.now();
      setBusy(!!msg.busy);
      const lastEv = (msg.events || []).filter((e) => e.t !== 'notice').pop();
      if (!msg.busy && lastEv?.t === 'done' && !lastEv.replay) setSuggestion(suggestionIn([...(msg.events || [])].reverse().find((e) => e.t === 'text')?.text));
      if (!msg.events?.length) renderEmpty();
      if (msg.parent) {
        const back = el('button', 'backbar', `${icon('chev')}<span>Back to the chat that started this</span><small>@${esc(msg.agent || 'agent')} · background task</small>`);
        back.addEventListener('click', () => openChat(msg.parent));
        log.prepend(back);
      }
      scrollDown();
    } else if (msg.type === 'event') render(msg.ev);
    else if (msg.type === 'terminal') {
      terminal = msg;
      renderAgentUI();
    } else if (msg.type === 'bg_update') {
      updateBgTask(msg);
    } else if (msg.type === 'voice_fixed' || msg.type === 'suggested') {
      hostWaits.get(msg.id)?.(msg.text);
      hostWaits.delete(msg.id);
    } else if (msg.type === 'queue') {
      if (msg.sid !== sid) return;
      renderQueue(msg.items || []);
      if (msg.restore && !input.value.trim()) fill(msg.restore);
    } else if (msg.type === 'workflow_saved') {
      toast(msg.error || `Saved /${msg.name} (${msg.count} steps). Type /${msg.name} to replay it`, 3500);
    } else if (msg.type === 'chats') {
      chatList = msg.chats || [];
      if (!$('historyDrawer').hidden) renderHistory();
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 300); // service worker restarted
  });
  port.postMessage({ type: 'hello', sid });
}

async function openChat(next) {
  sid = next;
  await chrome.storage.local.set({ [`panelChat:${windowId}`]: sid });
  resetLog();
  setBusy(false);
  renderQueue([]);
  renderEmpty();
  port?.postMessage({ type: 'hello', sid });
  input.focus();
}

function newChat() {
  if (busy) port?.postMessage({ type: 'stop', sid });
  attachments = [];
  renderAttachments();
  openChat(crypto.randomUUID());
}

async function send(text) {
  text = String(text || '').trim();
  if (!text && !attachments.length) return;
  let m;
  if ((m = /^@([\w-]+)\s+([\s\S]+)$/.exec(text))) return startBgTask(m[1], m[2].trim());
  if ((m = /^\/save\s+(\S+)$/.exec(text))) {
    port?.postMessage({ type: 'save_workflow', sid, name: m[1], since: 0 });
    return fill('');
  }
  if ((m = /^\/skill\s+([\w-]+)$/.exec(text))) text = skillPrompt(m[1]);
  else if ((m = /^\/([\w-]+)$/.exec(text)) && workflows.some((w) => w.name === m[1])) {
    fill('');
    return runWorkflow(m[1]);
  }
  if (!text) text = 'What do you see in this image?';
  const tab = await activeTab();
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  const thumbs = attachments.map((a) => a.thumb);
  if (images.length && settings.agent === 'terminal') toast('Images are not sent to a terminal AI');
  port?.postMessage({ type: 'send', sid, kind: settings.agent, text, tabId: tab?.id, cwd: settings.cwd || '~', mode: settings.mode, model: currentModel(), ollamaUrl: settings.ollamaUrl, images, thumbs });
  input.value = '';
  attachments = [];
  renderAttachments();
  autosize();
  closeMenus();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  updateSendState();
}

// ---------- suggested reply: shown in the empty box, Tab puts it in ----------

const SUGGEST_PROMPT = 'Given the last exchange in a chat with an AI that controls the user\'s web browser, write the message the user is most likely to send next, ' +
  'as the user, under 12 words. Reply with only that message, no quotes. If nothing useful fits, reply with nothing.';

// The chat's AI was asked to end its answer with a suggestion; when it doesn't, a small side model writes one.
async function suggestNext(answer) {
  const at = lastUserTs;
  const question = [...log.querySelectorAll('.msg-user .bubble')].pop()?.textContent || '';
  const prompt = `User: ${clip(question, 1500)}\n\nAssistant: ${answer.slice(-3000)}`;
  let text;
  try {
    text = await chromeModel(SUGGEST_PROMPT, prompt);
  } catch {}
  if (text === undefined) text = await hostQuick('suggest', { question, answer });
  text = String(text || '').split('\n')[0].replace(/^["“']|["”']$/g, '').trim();
  if (at !== lastUserTs || !text || text.length > 140) return; // the chat moved on, or not a usable reply
  setSuggestion(text);
}

let suggestion = '';

function setSuggestion(text) {
  suggestion = text || '';
  const g = $('ghost');
  g.querySelector('.gt').textContent = suggestion;
  showGhost();
}

function showGhost() {
  const on = !!suggestion && !input.value && !attachments.length && !busy && !voice && !polish;
  $('ghost').hidden = !on;
  $('composer').classList.toggle('has-ghost', on);
}

function takeSuggestion() {
  if (!suggestion) return false;
  fill(suggestion);
  input.setSelectionRange(input.value.length, input.value.length);
  showGhost();
  return true;
}

// While the AI works, the button stops it, or queues what you typed as a follow-up.
function updateSendState() {
  const has = !!(input.value.trim() || attachments.length);
  sendBtn.disabled = !busy && !has;
  sendBtn.classList.toggle('queue', busy && has);
  sendBtn.title = busy ? (has ? 'Send when this finishes (Enter)' : 'Stop (Esc)') : 'Send (Enter)';
  if (!voice) input.placeholder = busy ? 'Add a follow-up… it’s sent when this finishes' : PLACEHOLDER;
  showGhost();
}

function renderQueue(items) {
  const box = $('queue');
  box.hidden = !items.length;
  box.textContent = '';
  for (const q of items) {
    const r = el('div', 'qitem', `<span class="ql">Queued</span><span class="qt"></span><button class="mini" title="Remove">${icon('x')}</button>`);
    r.querySelector('.qt').textContent = `${q.images ? `🖼 ${q.images} · ` : ''}${q.text}`;
    r.querySelector('button').addEventListener('click', () => port?.postMessage({ type: 'unqueue', sid, id: q.id }));
    box.appendChild(r);
  }
  if (items.length) {
    const now = el('button', 'qnow', `${icon('bolt')}Send now`);
    now.title = 'Stop the current task and send the queued message';
    now.addEventListener('click', () => port?.postMessage({ type: 'send_now', sid }));
    box.appendChild(now);
  }
}

// ---------- init ----------

async function init() {
  windowId = (await chrome.windows.getCurrent()).id;
  const stored = await chrome.storage.local.get(['panelSettings', `panelChat:${windowId}`]);
  settings = { ...settings, ...stored.panelSettings };
  if (!Array.isArray(settings.shortcuts)) settings.shortcuts = [];
  sid = stored[`panelChat:${windowId}`];
  if (!sid) {
    sid = crypto.randomUUID();
    await chrome.storage.local.set({ [`panelChat:${windowId}`]: sid });
  }
  applyTheme();

  // header
  $('agentBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu('agentMenu', $('agentBtn'));
  });
  $('modeBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu('modeMenu');
  });
  $('historyBtn').addEventListener('click', () => openDrawer('historyDrawer'));
  $('settingsBtn').addEventListener('click', () => openDrawer('settingsDrawer'));
  $('newChat').addEventListener('click', newChat);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) closeMenus();
  });

  // drawers
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDrawers));
  $('scrim').addEventListener('click', closeDrawers);
  $('historySearch').addEventListener('input', renderHistory);
  $('modeSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setSetting('mode', b.dataset.v)));
  $('themeSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setSetting('theme', b.dataset.v)));
  $('voiceFixSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setSetting('voiceFix', b.dataset.v === 'true')));
  $('cwd').value = settings.cwd;
  $('model').addEventListener('change', () => setSetting(isOllama() ? 'ollamaModel' : 'model', $('model').value.trim()));
  for (const id of ['cwd', 'ollamaUrl']) $(id).addEventListener('change', () => setSetting(id, $(id).value.trim()));
  $('shortcutForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('scName').value.trim().replace(/^\//, '');
    const prompt = $('scPrompt').value.trim();
    if (!name || !prompt) return;
    settings.shortcuts = [...settings.shortcuts.filter((s) => s.name !== name), { name, prompt }];
    setSetting('shortcuts', settings.shortcuts);
    $('scName').value = '';
    $('scPrompt').value = '';
    renderShortcuts();
    toast(`Saved /${name}`);
  });

  // composer
  sendBtn.addEventListener('click', () => (busy && sendBtn.classList.contains('queue') === false ? port?.postMessage({ type: 'stop', sid }) : send(input.value)));
  input.addEventListener('input', (e) => {
    if (voice && e.isTrusted) {
      // Typing takes over from the microphone; keep what's in the box.
      voice.typed = true;
      stopVoice(false);
    }
    autosize();
    slashSel = 0;
    updateSlash();
  });
  input.addEventListener('keydown', (e) => {
    const slashOpen = !$('slash').hidden;
    if (slashOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      slashSel = (slashSel + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length;
      updateSlash();
    } else if (slashOpen && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      e.preventDefault();
      runSlash(slashSel);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    } else if (e.key === 'Tab' && !e.shiftKey && !input.value && takeSuggestion()) {
      e.preventDefault();
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addImages(files);
    }
  });
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    addImages([...e.target.files]);
    e.target.value = '';
  });
  $('shotBtn').addEventListener('click', attachScreenshot);
  $('micBtn').addEventListener('click', toggleVoice);
  $('ghost').addEventListener('mousedown', (e) => {
    e.preventDefault();
    takeSuggestion();
    input.focus();
  });
  $('micBtn').hidden = !Recognition;

  // drag & drop
  let drag = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => hasFiles(e) && ++drag && ($('dropzone').hidden = false));
  document.addEventListener('dragleave', () => --drag <= 0 && ((drag = 0), ($('dropzone').hidden = true)));
  document.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    drag = 0;
    $('dropzone').hidden = true;
    addImages([...e.dataTransfer.files]);
  });

  // copy buttons, lightbox
  document.addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) return copy(cp.closest('.code').querySelector('pre').textContent);
    const img = e.target.closest('img[data-zoom]');
    if (img) {
      $('lightbox').querySelector('img').src = img.src;
      $('lightbox').hidden = false;
    }
  });
  $('lightbox').addEventListener('click', () => ($('lightbox').hidden = true));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (voice) stopVoice(false);
    else if (polish) cancelPolish(true);
    else if (!$('lightbox').hidden) $('lightbox').hidden = true;
    else if (!$('slash').hidden || !$('agentMenu').hidden || !$('modeMenu').hidden) closeMenus();
    else if (!$('historyDrawer').hidden || !$('settingsDrawer').hidden) closeDrawers();
    else if (busy) port?.postMessage({ type: 'stop', sid });
    else return;
    e.preventDefault();
  });

  workflows = (await chrome.storage.local.get('workflows')).workflows || [];
  chrome.storage.onChanged.addListener((ch) => {
    if (!ch.workflows) return;
    workflows = ch.workflows.newValue || [];
    if (!$('settingsDrawer').hidden) renderWorkflows();
  });

  renderAgentUI();
  await showTab();
  renderEmpty();
  autosize();
  connect();
  input.focus();
}

init();
