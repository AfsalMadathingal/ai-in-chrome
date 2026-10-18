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
let settings = { agent: 'claude', mode: 'ask', cwd: '~', model: '', theme: 'system', shortcuts: [] };

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

const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 120;
const scrollDown = () => (log.scrollTop = log.scrollHeight);

function add(node, parent = log) {
  log.querySelector('.empty')?.remove();
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

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 1400);
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

function markdown(src) {
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

const COMPUTER = {
  left_click: ['Click', 'Clicking', 'cursor'], click: ['Click', 'Clicking', 'cursor'],
  right_click: ['Right-click', 'Clicking', 'cursor'], double_click: ['Double-click', 'Clicking', 'cursor'],
  triple_click: ['Triple-click', 'Clicking', 'cursor'], left_click_drag: ['Drag', 'Dragging', 'cursor'],
  hover: ['Hover', 'Hovering', 'cursor'], mouse_move: ['Move mouse', 'Moving', 'cursor'],
  type: ['Type', 'Typing', 'keyboard'], key: ['Press', 'Pressing keys', 'keyboard'],
  screenshot: ['Take screenshot', 'Looking at the page', 'camera'], zoom: ['Zoom into region', 'Looking closer', 'camera'],
  scroll: ['Scroll', 'Scrolling', 'scroll'], scroll_to: ['Scroll to', 'Scrolling', 'scroll'], wait: ['Wait', 'Waiting', 'clock'],
};

// -> { label (HTML), verb, icon }
function describe(name, inputStr) {
  const short = strip(name);
  const o = parseInput(inputStr) || {};
  const c = (s, n) => `<code>${esc(clip(s, n || 48))}</code>`;
  const q = (s, n) => `“${esc(clip(s, n || 40))}”`;
  const target = o.ref || (o.coordinate ? `(${[].concat(o.coordinate).join(', ')})` : '');
  switch (short) {
    case 'navigate': {
      if (o.url === 'back' || o.url === 'forward') return { label: `Go ${o.url}`, verb: 'Navigating', icon: 'globe' };
      return { label: `Navigate to ${c(hostOf(o.url || ''))}`, verb: 'Navigating', icon: 'globe' };
    }
    case 'tabs_create': return { label: o.url ? `Open tab ${c(hostOf(o.url))}` : 'Open new tab', verb: 'Opening a tab', icon: 'tabs' };
    case 'tabs_close': return { label: 'Close tab', verb: 'Closing tab', icon: 'tabs' };
    case 'tabs_select': return { label: 'Switch tab', verb: 'Switching tab', icon: 'tabs' };
    case 'tabs_context': return { label: 'Check open tabs', verb: 'Checking tabs', icon: 'tabs' };
    case 'computer': {
      const [l, verb, ic] = COMPUTER[o.action] || [o.action || 'Act', 'Acting', 'cursor'];
      let label = esc(l);
      if (o.action === 'type') label += ` ${q(o.text)}`;
      else if (o.action === 'key') label += ` ${c(o.text || o.key || '')}`;
      else if (o.action === 'scroll') label += ` ${esc(o.scroll_direction || o.direction || '')}${target ? ` at ${c(target)}` : ''}`;
      else if (o.action === 'wait') label += ` ${esc(o.duration ?? '')}s`;
      else if (target) label += ` ${c(target)}`;
      return { label, verb, icon: ic };
    }
    case 'read_page': return { label: o.ref ? `Read element ${c(o.ref)}` : 'Read page', verb: 'Reading page', icon: 'doc' };
    case 'get_page_text': return { label: 'Read page text', verb: 'Reading page', icon: 'doc' };
    case 'find': return { label: `Find ${q(o.query)}`, verb: 'Finding', icon: 'search' };
    case 'form_input': return { label: `Fill ${c(o.ref || '')}${o.value != null ? ` with ${q(o.value, 30)}` : ''}`, verb: 'Filling form', icon: 'pencil' };
    case 'javascript_tool': return { label: `Run JavaScript ${o.text || o.code ? c(o.text || o.code, 36) : ''}`, verb: 'Running JavaScript', icon: 'code' };
    case 'read_console_messages': return { label: 'Read console', verb: 'Reading console', icon: 'terminal' };
    case 'read_network_requests': return { label: 'Read network requests', verb: 'Reading network', icon: 'activity' };
    case 'network_request': return { label: `Inspect request ${o.requestId ? c(o.requestId) : ''}`, verb: 'Inspecting request', icon: 'activity' };
    case 'http_request': return { label: `${esc(o.method || 'GET')} ${c(hostOf(o.url || ''))}`, verb: 'Sending request', icon: 'activity' };
    case 'network_intercept': return { label: `Intercept ${esc(o.action || 'network')}`, verb: 'Intercepting', icon: 'activity' };
    case 'network_export': return { label: 'Export HAR', verb: 'Exporting', icon: 'activity' };
    case 'cookies': return { label: `Cookies: ${esc(o.action || 'list')}`, verb: 'Reading cookies', icon: 'cookie' };
    case 'gif_creator': return { label: `GIF: ${esc(o.action || '')}`, verb: 'Recording', icon: 'film' };
    case 'file_upload': return { label: 'Upload file', verb: 'Uploading', icon: 'upload' };
    case 'upload_image': return { label: 'Upload image', verb: 'Uploading', icon: 'upload' };
    case 'resize_window': return { label: 'Resize window', verb: 'Resizing', icon: 'window' };
    case 'cdp_command': return { label: `CDP ${c(o.method || '')}`, verb: 'Running CDP', icon: 'plug' };
    case 'extension_reload': return { label: 'Reload extension', verb: 'Reloading', icon: 'plug' };
    case 'Bash': case 'shell': case 'command_execution': {
      const cmd = typeof inputStr === 'string' && !parseInput(inputStr) ? inputStr : Array.isArray(o.command) ? o.command.join(' ') : o.command || '';
      return { label: `Run ${c(cmd, 50)}`, verb: 'Running command', icon: 'terminal' };
    }
    case 'Read': return { label: `Read ${c(String(o.file_path || '').split('/').pop())}`, verb: 'Reading file', icon: 'doc' };
    case 'Write': return { label: `Write ${c(String(o.file_path || '').split('/').pop())}`, verb: 'Writing file', icon: 'pencil' };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { label: `Edit ${c(String(o.file_path || o.notebook_path || '').split('/').pop())}`, verb: 'Editing file', icon: 'pencil' };
    case 'file_change': return { label: 'Edit files', verb: 'Editing files', icon: 'pencil' };
    case 'Grep': return { label: `Search ${q(o.pattern)}`, verb: 'Searching', icon: 'search' };
    case 'Glob': return { label: `Find files ${c(o.pattern || '')}`, verb: 'Searching', icon: 'folder' };
    case 'LS': return { label: `List ${c(o.path || '')}`, verb: 'Listing', icon: 'folder' };
    case 'WebFetch': return { label: `Fetch ${c(hostOf(o.url || ''))}`, verb: 'Fetching', icon: 'link' };
    case 'WebSearch': case 'web_search': return { label: `Search the web ${q(o.query || (typeof inputStr === 'string' && !parseInput(inputStr) ? inputStr : ''))}`, verb: 'Searching the web', icon: 'search' };
    case 'Task': case 'Agent': return { label: `Subagent: ${esc(clip(o.description || o.prompt || '', 50))}`, verb: 'Running a subagent', icon: 'bot' };
    case 'sidepanel_reply': return { label: 'Reply', verb: 'Writing', icon: 'spark' };
    default: {
      const arg = Object.values(o).find((v) => typeof v === 'string');
      return { label: `${esc(short)}${arg ? ` ${c(arg, 40)}` : ''}`, verb: `Using ${short}`, icon: 'bolt' };
    }
  }
}

function pretty(s) {
  const o = parseInput(s);
  return o ? JSON.stringify(o, null, 2) : String(s ?? '');
}

// ---------- turn building ----------

function ensureTurn() {
  if (!turn) turn = add(el('div', 'turn'));
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
  if (streamEl) streamEl.classList.remove('streaming');
  streamEl = null;
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
  const all = [...g.querySelectorAll('.step')];
  const running = all.filter((s) => s.classList.contains('run')).length;
  const failed = all.filter((s) => s.classList.contains('bad')).length;
  const last = all[all.length - 1];
  const head = g.querySelector('.sum');
  const n = `${all.length} step${all.length === 1 ? '' : 's'}`;
  head.innerHTML = running
    ? `<b class="shimmer">${esc(last?.verb || 'Working')}…</b> · ${n}`
    : `<b>${n}</b>${failed ? ` · ${failed} failed` : ''} · ${last?.querySelector('.lbl').innerHTML || ''}`;
  const first = all[0]?.start;
  const end = Math.max(...all.map((s) => s.end || s.start || 0));
  g.querySelector('.gdur').textContent = !running && first ? fmtMs(end - first) : '';
}

function addStep(ev) {
  ensureTurn();
  closeThink(ev.ts);
  closeStream();
  if (!steps) {
    steps = add(el('div', `steps${replaying ? '' : ' open'}`), turn);
    steps.innerHTML = `<button class="steps-head">${icon('chev').replace('<svg', '<svg class="chev"')}<span class="sum"></span><span class="dur gdur"></span></button><div class="steps-list"></div>`;
    const g = steps;
    g.querySelector('.steps-head').addEventListener('click', () => {
      g.toggled = true;
      g.classList.toggle('open');
    });
  }
  const d = describe(ev.name, ev.input);
  const s = el('div', 'step run');
  s.start = ev.ts;
  s.verb = d.verb;
  s.innerHTML = `<button class="step-row"><span class="si">${icon(d.icon)}</span><span class="lbl">${d.label}</span><span class="dur"></span><span class="st"><span class="spin"></span></span></button>
    <div class="step-detail"><div class="k">${esc(strip(ev.name))} input</div><pre class="in"></pre></div>`;
  s.querySelector('.in').textContent = pretty(ev.input);
  s.querySelector('.step-row').addEventListener('click', () => s.classList.toggle('open'));
  stepEls.set(ev.id, s);
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
    det.insertAdjacentHTML('beforeend', `<div class="k">${ev.ok ? 'Result' : 'Error'}</div><pre></pre>`);
    det.lastElementChild.textContent = ev.text;
  }
  if (ev.image) {
    const img = el('img', 'shot-thumb');
    img.src = ev.image;
    img.dataset.zoom = '';
    s.appendChild(img);
  }
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
    thinkEl.innerHTML = `<button>${icon('chev').replace('<svg', '<svg class="chev"')}<span class="lbl shimmer">Thinking…</span></button><div class="body"></div>`;
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
    streamEl = add(el('div', 'md'), turn);
    streamEl.raw = '';
  }
  if (final) streamEl.raw = ev.text || '';
  else streamEl.raw += ev.text || '';
  streamEl.innerHTML = markdown(streamEl.raw);
  if (final) closeStream();
  else streamEl.classList.add('streaming');
  if (!replaying && nearBottom()) scrollDown();
  updateStatus();
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
  const where = ev.key && ev.key.includes(':') && /\./.test(ev.key) ? ev.key.split(':').slice(1).join(':') : currentHost;
  const card = add(el('div', 'perm'), turn);
  card.innerHTML = `<div class="q"><span class="si">${icon('shield')}</span><div><b>Allow this action?</b><small>${d.label}${where ? ` · on ${esc(where)}` : ''}</small></div></div>
    <details><summary>Details</summary><pre></pre></details>
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
  const bits = [ev.ms && fmtMs(ev.ms), ev.turns > 1 && `${ev.turns} turns`, ev.tokens && `${fmtTokens(ev.tokens)} tokens`, ev.cost && `$${ev.cost.toFixed(4)}`, lastModel].filter(Boolean);
  const meta = el('div', 'turn-meta', `<span class="ok">${icon('check')}</span><span>${esc(bits.join(' · '))}</span><span class="acts"><button class="mini" title="Copy answer">${icon('copy')}</button></span>`);
  meta.querySelector('button').addEventListener('click', () => copy([...(t || log).querySelectorAll('.md')].map((m) => m.raw).filter(Boolean).join('\n\n')));
  add(meta, t || log);
}

function renderUser(ev) {
  closeTurn(ev.ts);
  const m = el('div', 'msg-user');
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
  b.textContent = ev.text;
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
  turn = steps = thinkEl = streamEl = null;
  stepEls.clear();
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
  sendBtn.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  clearInterval(setBusy.timer);
  if (on) setBusy.timer = setInterval(updateStatus, 1000);
  updateStatus();
}

function updateStatus() {
  const st = $('status');
  if (busy) {
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
  terminal: { name: 'Terminal AI', desc: 'An AI already open in your terminal answers', icon: 'terminal' },
};
const MODES = {
  ask: { name: 'Ask before acting', short: 'Ask', desc: 'Approve clicks, typing and navigation', icon: 'shield' },
  auto: { name: 'Act without asking', short: 'Auto', desc: 'Browser actions run without prompts', icon: 'bolt' },
};

function agentState(k) {
  if (available.host === false) return 'off';
  if (k === 'terminal') return terminal.listening ? 'on' : '';
  if (!(k in available)) return '';
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

  const h = $('agentHint');
  if (settings.agent === 'terminal') h.innerHTML = 'In any terminal AI connected to the <code>ai-in-chrome</code> MCP server, say: <code>listen to the AI in Chrome side panel</code>.';
  else if (settings.agent === 'claude') h.innerHTML = available.claude ? `Uses <code>${esc(available.claude)}</code>.` : 'Claude Code not found yet. Install it, then run <code>aichrome install</code> again.';
  else h.innerHTML = available.codex ? `Uses <code>${esc(available.codex)}</code>.` : 'Codex not found yet. Install it, then run <code>aichrome install</code> again.';
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
  } else renderShortcuts();
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
    { name: 'summarize', desc: 'Summarize this page', icon: 'doc', run: () => send('Summarize this page') },
    { name: 'mode', desc: `Switch to "${settings.mode === 'ask' ? MODES.auto.name : MODES.ask.name}"`, icon: 'shield', run: () => setSetting('mode', settings.mode === 'ask' ? 'auto' : 'ask') },
  ];
  const user = (settings.shortcuts || []).map((s) => ({ name: s.name, desc: s.prompt, icon: 'wand', run: () => send(s.prompt) }));
  return [...user, ...builtins];
}

let slashSel = 0;
let slashItems = [];

function updateSlash() {
  const m = /^\/(\S*)$/.exec(input.value);
  const menu = $('slash');
  if (!m) {
    menu.hidden = true;
    return;
  }
  const q = m[1].toLowerCase();
  slashItems = commands().filter((c) => c.name.toLowerCase().startsWith(q) || (q && c.desc.toLowerCase().includes(q)));
  if (!slashItems.length) {
    menu.hidden = true;
    return;
  }
  slashSel = Math.min(slashSel, slashItems.length - 1);
  menu.innerHTML = slashItems.map((c, i) => `<button class="item${i === slashSel ? ' sel' : ''}" data-i="${i}" role="option"><span class="ico">${icon(c.icon)}</span><span><span class="t"><code>/${esc(c.name)}</code></span><span class="d">${esc(clip(c.desc, 70))}</span></span></button>`).join('');
  menu.querySelectorAll('.item').forEach((b) => b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    runSlash(+b.dataset.i);
  }));
  menu.hidden = false;
}

function runSlash(i) {
  const c = slashItems[i];
  $('slash').hidden = true;
  input.value = '';
  autosize();
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
      if (!msg.events?.length) renderEmpty();
      scrollDown();
    } else if (msg.type === 'event') render(msg.ev);
    else if (msg.type === 'terminal') {
      terminal = msg;
      renderAgentUI();
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
  if ((!text && !attachments.length) || busy) return;
  if (!text) text = 'What do you see in this image?';
  const tab = await activeTab();
  const images = attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  const thumbs = attachments.map((a) => a.thumb);
  if (images.length && settings.agent === 'terminal') toast('Images are not sent to a terminal AI');
  port?.postMessage({ type: 'send', sid, kind: settings.agent, text, tabId: tab?.id, cwd: settings.cwd || '~', mode: settings.mode, model: settings.model, images, thumbs });
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

function updateSendState() {
  sendBtn.disabled = !busy && !input.value.trim() && !attachments.length;
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
  $('model').value = settings.model;
  $('cwd').value = settings.cwd;
  for (const id of ['model', 'cwd']) $(id).addEventListener('change', () => setSetting(id, $(id).value.trim()));
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
  sendBtn.addEventListener('click', () => (busy ? port?.postMessage({ type: 'stop', sid }) : send(input.value)));
  input.addEventListener('input', () => {
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
    if (!$('lightbox').hidden) $('lightbox').hidden = true;
    else if (!$('slash').hidden || !$('agentMenu').hidden || !$('modeMenu').hidden) closeMenus();
    else if (!$('historyDrawer').hidden || !$('settingsDrawer').hidden) closeDrawers();
    else if (busy) port?.postMessage({ type: 'stop', sid });
    else return;
    e.preventDefault();
  });

  renderAgentUI();
  await showTab();
  renderEmpty();
  autosize();
  connect();
  input.focus();
}

init();
