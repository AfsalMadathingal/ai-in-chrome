// AI in Chrome service worker.
// Connects to the local native-messaging host (launched by Chrome) and executes tool requests
// with the Chrome DevTools Protocol, the same way Claude in Chrome does — minus login/pairing.

import {
  initNetwork, onNetworkEvent, onNetworkAttach, onNetworkTabRemoved,
  read_network_requests, network_request, network_intercept, network_export, cookies, __http, __tab_url,
} from './network.js';
import { initPanel, onAgentEvent, onToolCall, approve_action, sidepanel_wait, sidepanel_reply, bgInfo } from './panel.js';

const HOST_NAME = 'com.ai_in_chrome.bridge';
const GROUP_TITLE = 'AI';
const MAX_SHOT_PX = 1568; // full: true
const SHOT_PX = 1280; // default: plenty to read a page, ~35% fewer image tokens
const SHOT_QUALITY = 70;
const NAV_TIMEOUT_MS = 30000;
const LOG_LIMIT = 500;

let port = null;
let currentTab = null;
// Survive service-worker restarts and extension reloads.
chrome.storage.local.get('currentTab').then((v) => { if (currentTab == null && v.currentTab != null) currentTab = v.currentTab; });
function setCurrentTab(id) {
  currentTab = id;
  chrome.storage.local.set({ currentTab: id });
}

// Where the AI works. 'group' (default): its own tabs in the AI group, opened in the background, so the tabs
// you're using never switch, lose focus or get navigated away. 'mine': it may take over your tabs.
let tabMode = 'group';
chrome.storage.local.get('panelSettings').then((v) => (tabMode = v.panelSettings?.tabs || 'group'));
chrome.storage.onChanged.addListener((ch) => {
  if (ch.panelSettings) tabMode = ch.panelSettings.newValue?.tabs || 'group';
});
const ownTabs = () => tabMode !== 'mine';
const attached = new Set();
const shotScale = new Map(); // tabId -> { sx, sy } CSS px per screenshot px
const consoleLogs = new Map(); // tabId -> [{ level, text, url, ts }]

// ---------- native host connection ----------

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    port = null;
    setBadge(false);
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    console.warn('[aichrome] host disconnected:', chrome.runtime.lastError?.message);
    port = null;
    setBadge(false);
  });
  port.postMessage({ type: 'hello', version: chrome.runtime.getManifest().version });
  setBadge(true);
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  chrome.action.setTitle({ title: on ? 'AI in Chrome: connected' : 'AI in Chrome: host not connected (run `aichrome install`)' });
}

const chunks = new Map(); // request id -> string[]

async function onHostMessage(msg) {
  if (msg?.type === 'ping') return port?.postMessage({ type: 'pong' });
  if (msg?.type === 'agent_event') return onAgentEvent(msg.sid, msg.ev);
  if (msg?.type === 'chunk') {
    const parts = chunks.get(msg.id) || [];
    parts[msg.index] = msg.data;
    chunks.set(msg.id, parts);
    if (parts.filter((p) => p !== undefined).length < msg.total) return;
    chunks.delete(msg.id);
    msg = JSON.parse(parts.join(''));
  }
  if (msg?.type !== 'tool_request') return;
  let reply;
  try {
    const result = await runTool(msg.tool, msg.args || {});
    reply = { type: 'tool_response', id: msg.id, result: normalize(result) };
  } catch (e) {
    reply = { type: 'tool_response', id: msg.id, error: String(e?.message || e) };
  }
  port?.postMessage(reply);
}

function normalize(result) {
  if (typeof result === 'string') return { text: result };
  if (result && typeof result === 'object' && ('text' in result || 'image' in result)) return result;
  return { text: JSON.stringify(result, null, 2) };
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create('aichrome-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'aichrome-reconnect' && connect());
chrome.action.onClicked.addListener(() => { port?.disconnect(); port = null; connect(); });
connect();

// ---------- tools ----------

const TOOLS = {
  tabs_context, tabs_create, tabs_close, tabs_select, navigate, computer, read_page, find,
  form_input, get_page_text, javascript_tool, read_console_messages, read_network_requests, resize_window, cdp_command, extension_reload,
  gif_creator, file_upload, upload_image, save_image,
  network_request, network_intercept, network_export, cookies, __http, __tab_url,
  approve_action, sidepanel_wait, sidepanel_reply,
};

initNetwork({ cdp, resolveTab, ensureAttached });
initPanel({
  hostSend(msg) {
    if (!port) connect();
    if (!port) return false;
    port.postMessage(msg);
    return true;
  },
  setCurrentTab,
  runTool,
  refAt,
  async locate(target) {
    const id = await resolveTab();
    return inPage(id, (d) => window.__aichromeLocate(d), [target]);
  },
  async settle() {
    const id = await resolveTab().catch(() => null);
    if (id == null) return;
    for (let i = 0; i < 40 && (await chrome.tabs.get(id).catch(() => null))?.status === 'loading'; i++) await sleep(250);
  },
});

// Which element each ref pointed at when the AI used it, so a saved workflow can find it again later.
const REF_TOOLS = new Set(['computer', 'form_input', 'file_upload']);
const refLog = []; // { ref, target, ts }

async function noteRef(name, args) {
  if (!REF_TOOLS.has(name) || !args?.ref) return;
  const id = await resolveTab(args.tabId).catch(() => null);
  const target = id == null ? null : await inPage(id, (r) => window.__aichromeDescribe(r), [args.ref]).catch(() => null);
  if (!target) return;
  refLog.push({ ref: args.ref, target, ts: Date.now() });
  if (refLog.length > 500) refLog.splice(0, refLog.length - 500);
}

// The target behind `ref` for a tool call shown in the chat at `ts` (the call runs a moment after it is shown).
function refAt(ref, ts) {
  const same = refLog.filter((e) => e.ref === ref);
  return (same.find((e) => e.ts >= ts - 5000) || same.filter((e) => e.ts < ts).pop())?.target || null;
}

// Background @agent tasks each get their own tab, so they never take over the tab you are using.
const bgTabs = new Map(); // chat sid -> tab id

async function bgTab(sid) {
  const known = bgTabs.get(sid);
  if (known != null && (await chrome.tabs.get(known).catch(() => null))) return known;
  const tab = await chrome.tabs.create({ url: bgInfo(sid)?.url || 'about:blank', active: false });
  await addToGroup(tab.id);
  bgTabs.set(sid, tab.id);
  for (let i = 0; i < 60 && (await chrome.tabs.get(tab.id).catch(() => null))?.status === 'loading'; i++) await sleep(250);
  return tab.id;
}

async function runTool(name, args) {
  const { __sid: sid, ...rest } = args || {};
  if (bgInfo(sid)) return runBackgroundTool(sid, name, rest);
  return runToolNow(name, rest);
}

async function runBackgroundTool(sid, name, args) {
  if (args.tabId == null && name !== 'tabs_context' && name !== 'tabs_create') args.tabId = await bgTab(sid);
  if (name !== 'tabs_create' && name !== 'tabs_select') return runToolNow(name, args);
  // These move the "current tab"; keep that with the background task, not the panel's tab.
  const before = currentTab;
  try {
    return await runToolNow(name, args);
  } finally {
    if (currentTab !== before) {
      bgTabs.set(sid, currentTab);
      setCurrentTab(before);
    }
  }
}

async function runToolNow(name, args) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}`);
  await noteRef(name, args);
  const mirror = onToolCall(name, args); // shows a terminal AI's activity in the side panel
  if (!mirror) return runRecorded(name, fn, args);
  try {
    const result = await runRecorded(name, fn, args);
    mirror(true, typeof result === 'string' ? result : result?.text);
    return result;
  } catch (e) {
    mirror(false, e.message);
    throw e;
  }
}

async function runRecorded(name, fn, args) {
  if (name !== 'computer' && name !== 'navigate') return fn(args);
  const tabId = await resolveTab(args.tabId).catch(() => null);
  const result = await fn(args);
  if (tabId != null) await recordAction(tabId, name, args, result).catch((e) => console.warn('[aichrome] record', e));
  return result;
}

async function tabs_context() {
  const group = await findGroup();
  const tabs = await chrome.tabs.query({});
  const active = await activeTabId().catch(() => null);
  const lines = tabs.map((t) => {
    const flags = [
      t.id === currentTab ? 'current' : null,
      t.id === active ? 'active' : null,
      group && t.groupId === group.id ? GROUP_TITLE : null,
    ].filter(Boolean);
    return `${t.id}\t${flags.length ? '[' + flags.join(',') + '] ' : ''}${t.title || ''}\n\t${t.url || ''}`;
  });
  const how = ownTabs()
    ? 'Tabs you open go in the AI group in the background; navigate on one of the user\'s tabs opens a new AI tab instead.'
    : 'You may use and switch the user\'s tabs.';
  return `Tabs (tabId, title, url). Commands without tabId use the current tab, else the active tab. ${how}\n${lines.join('\n')}`;
}

async function tabs_create({ url, snapshot: snap = true }) {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  const tab = await chrome.tabs.create({ url: 'about:blank', active: !ownTabs(), ...(win && { windowId: win.id }) });
  await addToGroup(tab.id);
  setCurrentTab(tab.id);
  ensureAttached(tab.id).catch(() => {});
  if (url) await waitForLoad(tab.id, () => chrome.tabs.update(tab.id, { url: normalizeUrl(url) }));
  const t = await chrome.tabs.get(tab.id);
  const extra = url && snap ? await snapshot(t.id).catch((e) => `(snapshot failed: ${e.message})`) : '';
  return `Created tab ${t.id}: ${t.title || ''} ${t.url || t.pendingUrl || ''}${extra ? '\n' + extra : ''}`;
}

const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

// A same-site page opened from the user's tab: duplicate that tab so sessionStorage logins (common in admin apps)
// come along, then navigate the copy. A plain new tab would land on a login screen.
async function duplicateForAI(userTabId, url) {
  const user = await chrome.tabs.get(userTabId);
  const dest = normalizeUrl(url);
  const origin = originOf(user.url);
  if (!origin || origin === 'null' || originOf(dest) !== origin) return null;
  const copy = await chrome.tabs.duplicate(userTabId).catch(() => null);
  if (!copy) return null;
  if (user.active) await chrome.tabs.update(userTabId, { active: true }).catch(() => {});
  await addToGroup(copy.id);
  setCurrentTab(copy.id);
  ensureAttached(copy.id).catch(() => {});
  await waitForLoad(copy.id, () => chrome.tabs.update(copy.id, { url: dest }));
  return chrome.tabs.get(copy.id);
}

async function tabs_close({ tabId }) {
  if (tabId == null) throw new Error('tabId is required');
  await chrome.tabs.remove(Number(tabId));
  if (currentTab === Number(tabId)) setCurrentTab(null);
  return `Closed tab ${tabId}`;
}

async function tabs_select({ tabId }) {
  if (tabId == null) throw new Error('tabId is required');
  if (ownTabs()) {
    // Work on it without bringing it to the front.
    const tab = await chrome.tabs.get(Number(tabId));
    setCurrentTab(tab.id);
    return `Now working on tab ${tab.id}: ${tab.title} (in the background; the user's view is unchanged)`;
  }
  const tab = await chrome.tabs.update(Number(tabId), { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  setCurrentTab(tab.id);
  return `Selected tab ${tab.id}: ${tab.title}`;
}

async function navigate({ tabId, url, snapshot: snap = true }) {
  if (!url) throw new Error('url is required');
  const id = await resolveTab(tabId);
  if (ownTabs() && !['back', 'forward', 'reload'].includes(url) && !(await inGroup(id))) {
    // Leave the user's tab where it is: go there in a new AI tab instead.
    const dup = await duplicateForAI(id, url).catch(() => null);
    if (dup) {
      const extra = snap ? await snapshot(dup.id).catch((e) => `(snapshot failed: ${e.message})`) : '';
      return `Opened ${dup.url} in tab ${dup.id} (a background copy of the user's tab ${id}, so its login/session carries over). Use this tab from now on.\nTitle: ${dup.title}${extra ? '\n' + extra : ''}`;
    }
    const made = await tabs_create({ url, snapshot: snap });
    return `${made}\nOpened in a new background tab in the AI group, so the user's tab ${id} stays as it was. Use this tab from now on.`;
  }
  ensureAttached(id).catch(() => {});
  indicate(id, 'show');
  await waitForLoad(id, () => {
    if (url === 'back') return chrome.tabs.goBack(id);
    if (url === 'forward') return chrome.tabs.goForward(id);
    if (url === 'reload') return chrome.tabs.reload(id);
    return chrome.tabs.update(id, { url: normalizeUrl(url) });
  });
  const t = await chrome.tabs.get(id);
  const extra = snap ? await snapshot(id).catch((e) => `(snapshot failed: ${e.message})`) : '';
  return `Navigated tab ${id} to ${t.url}\nTitle: ${t.title}${extra ? '\n' + extra : ''}`;
}

async function computer(args) {
  const id = await resolveTab(args.tabId);
  const action = args.action;
  switch (action) {
    case 'screenshot':
      return screenshot(id, args);
    case 'zoom':
      return zoom(id, args.region);
    case 'wait_for':
      return waitFor(id, args);
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      const [x, y] = await target(id, args);
      const button = action === 'right_click' ? 'right' : 'left';
      const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
      const before = await pageState(id, x, y);
      await click(id, x, y, button, count, modifierMask(args.modifiers || args.text));
      const on = before?.target ? ` on ${before.target}` : '';
      return `${action} at (${Math.round(x)}, ${Math.round(y)})${on}${await reactionReport(id, before)}`;
    }
    case 'hover':
    case 'mouse_move': {
      const [x, y] = await target(id, args);
      await indicate(id, 'move', { x, y });
      await mouseEvent(id, 'mouseMoved', x, y);
      return `Moved mouse to (${Math.round(x)}, ${Math.round(y)})`;
    }
    case 'left_click_drag': {
      if (!args.start_coordinate) throw new Error('start_coordinate is required');
      const [sx, sy] = toCss(id, args.start_coordinate);
      const [ex, ey] = await target(id, args);
      await drag(id, sx, sy, ex, ey);
      return `Dragged from (${Math.round(sx)}, ${Math.round(sy)}) to (${Math.round(ex)}, ${Math.round(ey)})`;
    }
    case 'type': {
      if (args.text == null) throw new Error('text is required');
      if (args.ref || args.selector || args.label) await click(id, ...(await target(id, args)));
      await indicate(id, 'show');
      await cdp(id, 'Input.insertText', { text: String(args.text) });
      if (!args.submit) return `Typed ${String(args.text).length} characters`;
      // submit: press Enter too, and report what happened (one call instead of type + key + screenshot).
      const before = await pageState(id);
      await pressKey(id, 'Enter');
      return `Typed ${String(args.text).length} characters and pressed Enter${await reactionReport(id, before)}`;
    }
    case 'key': {
      if (!args.text) throw new Error('text is required (e.g. "Enter", "ctrl+a", "Tab Tab Enter")');
      await indicate(id, 'show');
      const repeat = Math.max(1, Math.min(100, Number(args.repeat) || 1));
      const report = /(^|\s)(Enter|Return|Escape|Esc)$/i.test(String(args.text).trim());
      const before = report ? await pageState(id) : null;
      for (let i = 0; i < repeat; i++) for (const combo of String(args.text).trim().split(/\s+/)) await pressKey(id, combo);
      return `Pressed ${args.text}${repeat > 1 ? ` x${repeat}` : ''}${report ? await reactionReport(id, before) : ''}`;
    }
    case 'scroll': {
      const [x, y] = args.coordinate || args.ref ? await target(id, args) : await viewportCenter(id);
      const amount = (Number(args.scroll_amount) || 3) * 100;
      const dir = args.scroll_direction || 'down';
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
      const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
      await indicate(id, 'move', { x, y });
      await cdp(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
      await sleep(80);
      return `Scrolled ${dir} by ${amount}px at (${Math.round(x)}, ${Math.round(y)})`;
    }
    case 'scroll_to': {
      args = await resolveRef(id, args);
      if (!args.ref) throw new Error('ref, selector or label is required');
      await inPage(id, (ref) => {
        const el = window.__aichromeRef(ref);
        if (!el) throw new Error(`ref ${ref} not found; call read_page again`);
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }, [args.ref]);
      return `Scrolled ${args.ref} into view`;
    }
    case 'wait': {
      const secs = Math.min(30, Math.max(0, Number(args.duration) || 1));
      await sleep(secs * 1000);
      return `Waited ${secs}s`;
    }
    default:
      throw new Error(`Unknown computer action "${action}". Use: screenshot, left_click, right_click, double_click, triple_click, type, key, scroll, scroll_to, hover, left_click_drag, wait, wait_for, zoom`);
  }
}

async function read_page({ tabId, filter = 'all', depth = 15, ref_id, scope = 'all' }) {
  const id = await resolveTab(tabId);
  const res = await inPage(id, (f, d, r, s) => window.__aichromeTree(f, d, r, s), [filter, Number(depth) || 15, ref_id || null, scope]);
  if (res.error && !res.pageContent) throw new Error(res.error);
  const t = await chrome.tabs.get(id);
  const vp = res.viewport;
  return `Tab ${id}: ${t.title}\nURL: ${t.url}\nViewport: ${vp.width}x${vp.height} (scroll ${vp.scrollX},${vp.scrollY})\n${res.error ? 'Warning: ' + res.error + '\n' : ''}\n${res.pageContent}`;
}

async function find({ tabId, query }) {
  if (!query) throw new Error('query is required');
  const id = await resolveTab(tabId);
  const res = await inPage(id, () => window.__aichromeTree('all', 40, null), []);
  const lines = res.pageContent.split('\n').map((l) => l.trim()).filter((l) => /\[ref_\d+\]/.test(l));
  // Several lookups in one call: "Save button | cover image | Draft".
  const queries = String(query).split(/\s*[|;]\s*/).filter(Boolean);
  const blocks = queries.map((q) => {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));
    if (!words.length) return `"${q}": (no search words)`;
    const scored = lines.map((line) => {
      const lower = line.toLowerCase();
      const name = (/"([^"]*)"/.exec(lower) || [])[1] || '';
      const role = lower.split(/[\s"]/)[0];
      let score = 0;
      for (const w of words) {
        if (name.includes(w)) score += 3; // the element's own name counts most
        else if (role === w || (ROLE_WORDS[w] || []).includes(role)) score += 1.5;
        else if (lower.includes(w)) score += 1; // href, placeholder, row text…
      }
      if (name && name === q.toLowerCase()) score += 3;
      if (lower.includes('(offscreen)')) score -= 0.25;
      return { line, score };
    }).filter((m) => m.score >= 1.5);
    if (!scored.length) return `"${q}": no matches`;
    const top = Math.max(...scored.map((m) => m.score));
    // Drop weak matches when there are strong ones.
    const keep = scored.filter((m) => m.score >= top * 0.6).sort((a, b) => b.score - a.score);
    const shown = keep.slice(0, 10);
    const more = keep.length > shown.length ? `\n  …${keep.length - shown.length} more` : '';
    return `"${q}":\n${shown.map((m) => '  ' + m.line).join('\n')}${more}`;
  });
  return blocks.join('\n');
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'for', 'of', 'to', 'in', 'on', 'and', 'or', 'with', 'this', 'that', 'first', 'element']);
// Words agents use for roles that the tree names differently.
const ROLE_WORDS = {
  input: ['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'button'],
  field: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  toggle: ['checkbox', 'switch'],
  dropdown: ['combobox', 'listbox'],
  select: ['combobox', 'listbox'],
  menu: ['menu', 'menuitem', 'combobox'],
  box: ['textbox', 'searchbox', 'checkbox'],
  textarea: ['textbox'],
  search: ['searchbox', 'textbox'],
  tab: ['tab'],
  file: ['button'],
};

async function form_input(args) {
  const { tabId, value } = args;
  const id = await resolveTab(tabId);
  const { ref } = await resolveRef(id, args);
  if (!ref) throw new Error('ref, selector or label is required');
  await indicate(id, 'show');
  return inPage(id, (ref, value) => {
    let el = window.__aichromeRef(ref);
    if (!el) throw new Error(`ref ${ref} not found; call read_page again`);
    // A <label> (or a styled switch wrapping a hidden checkbox) stands for its control.
    if (el.tagName === 'LABEL' && el.control) el = el.control;
    else if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) {
      const inner = el.querySelector('input, select, textarea') || el.closest('label')?.control;
      if (inner) el = inner;
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const fire = () => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (el.tagName === 'SELECT') {
      const opt = [...el.options].find((o) => o.value === String(value) || o.text.trim() === String(value));
      if (!opt) throw new Error(`No option "${value}". Options: ${[...el.options].map((o) => o.text.trim()).join(', ')}`);
      el.value = opt.value;
      fire();
      return `Selected "${opt.text.trim()}" in ${ref}`;
    }
    if (el.type === 'checkbox' || el.type === 'radio') {
      const want = value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
      if (el.checked !== want) el.click();
      return `${ref} is now ${el.checked ? 'checked' : 'unchecked'}`;
    }
    if (el.isContentEditable) {
      el.focus();
      el.textContent = String(value);
      fire();
      return `Set ${ref} text`;
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
    el.focus();
    fire();
    return `Set ${ref} value to "${String(value).substring(0, 80)}"`;
  }, [ref, value]);
}

async function get_page_text({ tabId, max_chars = 50000 }) {
  const id = await resolveTab(tabId);
  const res = await inPage(id, () => {
    const root = document.querySelector('article') || document.querySelector('main') || document.body;
    return { title: document.title, url: location.href, text: root ? root.innerText : '' };
  }, []);
  const text = res.text.length > max_chars ? res.text.substring(0, max_chars) + '\n…[truncated]' : res.text;
  return `Title: ${res.title}\nURL: ${res.url}\n\n${text}`;
}

async function javascript_tool({ tabId, text, code, save_path, max_chars = 20000 }) {
  const expression = text ?? code;
  if (!expression) throw new Error('text (JavaScript code) is required');
  const id = await resolveTab(tabId);
  await indicate(id, 'show');
  const res = await cdp(id, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, replMode: true });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'JavaScript error');
  }
  const v = res.result;
  if (v.type === 'undefined') return 'undefined';
  const out = typeof v.value === 'string' ? v.value : JSON.stringify(v.value ?? v.description, null, 2);
  if (save_path) {
    // A data: URL is saved as the binary file it encodes (e.g. a canvas image); anything else as text.
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(;base64)?,/.exec(out);
    if (m) {
      const mime = m[1] || 'application/octet-stream';
      const body = out.slice(m[0].length);
      const data = m[2] ? body : utf8ToBase64(decodeURIComponent(body));
      return { text: `Saved ${mime} (${Math.round(base64Bytes(data) / 1024)} KB)`, file: { name: `result.${extFor(mime)}`, data } };
    }
    return { text: `Saved result (${out.length} chars)`, file: { name: typeof v.value === 'string' ? 'result.txt' : 'result.json', data: utf8ToBase64(out) } };
  }
  const max = Math.max(1000, Number(max_chars) || 20000);
  if (out.length > max) return `${out.substring(0, max)}\n…[${out.length - max} more chars cut. Return less, or pass save_path to write the whole result to a file]`;
  return out;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const extFor = (mime) => ({ 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'text/plain': 'txt' }[mime] || mime.split('/')[1] || 'bin');

// Save an image shown on the page (img, canvas, video frame, CSS background) as an image ID for upload_image in
// any tab, and optionally to a file. Works for blob: URLs and generated images without passing base64 around.
async function save_image(args) {
  const id = await resolveTab(args.tabId);
  let { ref } = await resolveRef(id, args.ref || args.selector || args.label ? args : { ...args, selector: 'img' });
  if (!ref) throw new Error('ref, selector or label of the image is required');
  const token = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  if (!(await inPage(id, (r, t) => window.__aichromeMark(r, t), [ref, token]))) throw new Error(`ref ${ref} not found; call read_page again`);
  // Main world: blob: URLs and page canvases are reachable there exactly as the page sees them.
  const expression = `(async () => {
    const el = document.querySelector('[data-aichrome-pick="${token}"]');
    el.removeAttribute('data-aichrome-pick');
    const toB64 = (blob) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(blob); });
    const fromCanvas = (draw, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); return c.toDataURL('image/png'); };
    let img = el.tagName === 'IMG' ? el : el.tagName === 'PICTURE' ? el.querySelector('img') : null;
    if (!img && !['CANVAS', 'VIDEO'].includes(el.tagName)) img = el.querySelector('img, canvas, video') || null;
    const node = img || el;
    try {
      if (node.tagName === 'CANVAS') return { url: node.toDataURL('image/png'), w: node.width, h: node.height };
      if (node.tagName === 'VIDEO') return { url: fromCanvas((g) => g.drawImage(node, 0, 0), node.videoWidth, node.videoHeight), w: node.videoWidth, h: node.videoHeight };
      let src = node.tagName === 'IMG' ? (node.currentSrc || node.src) : null;
      if (!src) { const bg = getComputedStyle(node).backgroundImage.match(/url\(["']?(.*?)["']?\)/); src = bg && bg[1]; }
      if (!src) return { error: 'No image found at that element' };
      try {
        const res = await fetch(src);
        if (res.ok) { const blob = await res.blob(); if (blob.type.startsWith('image/')) return { url: await toB64(blob), w: node.naturalWidth || 0, h: node.naturalHeight || 0 }; }
      } catch {}
      if (node.tagName === 'IMG' && node.complete) return { url: fromCanvas((g) => g.drawImage(node, 0, 0), node.naturalWidth, node.naturalHeight), w: node.naturalWidth, h: node.naturalHeight };
    } catch (e) {}
    const r = node.getBoundingClientRect();
    return { rect: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height } };
  })()`;
  const res = (await cdp(id, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  if (!res || res.error) throw new Error(res?.error || 'Could not read the image');
  let data;
  let mimeType;
  let how = 'original file';
  if (res.url) {
    const m = /^data:([^;,]+)?;base64,/.exec(res.url);
    mimeType = m?.[1] || 'image/png';
    data = res.url.slice(res.url.indexOf(',') + 1);
  } else {
    // Cross-origin image without CORS: capture it from the screen instead.
    const rect = await inPage(id, (r) => {
      const el = window.__aichromeRef(r);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    }, [ref]);
    const { cssVisualViewport: vv } = await cdp(id, 'Page.getLayoutMetrics');
    data = await capture(id, { x: vv.pageX + rect.x, y: vv.pageY + rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }, await devicePixelRatio(id));
    mimeType = 'image/jpeg';
    how = 'screen capture (the image is cross-origin)';
  }
  const imageId = `shot_${++shotSeq}`;
  shots.set(imageId, { data, mimeType });
  if (shots.size > SHOT_CACHE) shots.delete(shots.keys().next().value);
  const text = `Saved image ${imageId} (${res.w && res.h ? `${res.w}x${res.h}, ` : ''}${mimeType}, ${Math.round(base64Bytes(data) / 1024)} KB, ${how}). ` +
    'Pass it to upload_image with imageId (works in any tab).';
  if (args.save_path) return { text, file: { name: `${args.filename || 'image'}.${extFor(mimeType)}`, data } };
  return text;
}

async function read_console_messages({ tabId, pattern, limit = 100, onlyErrors = false, clear = false }) {
  const id = await resolveTab(tabId);
  await ensureAttached(id);
  let logs = consoleLogs.get(id) || [];
  if (onlyErrors) logs = logs.filter((l) => l.level === 'error' || l.level === 'exception');
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    logs = logs.filter((l) => re.test(l.text));
  }
  logs = logs.slice(-limit);
  if (clear) consoleLogs.set(id, []);
  if (!logs.length) return 'No console messages captured (capture starts when AI in Chrome first attaches to the tab).';
  return logs.map((l) => `[${l.level}] ${l.text}${l.url ? `  (${l.url})` : ''}`).join('\n');
}

async function resize_window({ tabId, width, height }) {
  const id = await resolveTab(tabId);
  const tab = await chrome.tabs.get(id);
  await chrome.windows.update(tab.windowId, { state: 'normal', width: Number(width), height: Number(height) });
  return `Resized window ${tab.windowId} to ${width}x${height}`;
}

// Reload the extension itself (picks up code changes from disk).
async function extension_reload() {
  setTimeout(() => chrome.runtime.reload(), 100);
  return 'Reloading AI in Chrome extension…';
}

// Raw Chrome DevTools Protocol escape hatch.
async function cdp_command({ tabId, method, params }) {
  if (!method) throw new Error('method is required, e.g. "Page.reload"');
  const id = await resolveTab(tabId);
  return (await cdp(id, method, params || {})) ?? {};
}

// ---------- GIF recording ----------
// Like Claude in Chrome: per tab group, max 50 frames, a frame after every computer/navigate action,
// and for clicks/drags an extra copy of the previous frame with the pointer marked.

const MAX_FRAMES = 50;
const ACTION_DELAYS = {
  wait: 300, screenshot: 300, navigate: 800, scroll: 800, scroll_to: 800, type: 800, key: 800, zoom: 800,
  left_click: 1500, right_click: 1500, double_click: 1500, triple_click: 1500, left_click_drag: 1500,
};
const recordings = new Map(); // key -> { active, frames }

async function recordingKey(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return tab.groupId > -1 ? `group:${tab.groupId}` : `tab:${tabId}`;
}

async function activeRecording(tabId) {
  const rec = recordings.get(await recordingKey(tabId));
  return rec?.active ? rec : null;
}

function pushFrame(rec, frame) {
  rec.frames.push(frame);
  if (rec.frames.length > MAX_FRAMES) rec.frames.shift();
}

async function recordFrame(tabId, shot, action) {
  const rec = await activeRecording(tabId);
  if (!rec) return;
  pushFrame(rec, { base64: shot.data, format: 'jpeg', viewportWidth: shot.w, viewportHeight: shot.h, action, delay: ACTION_DELAYS[action?.type] ?? 800 });
}

async function recordAction(tabId, tool, args, result) {
  const rec = await activeRecording(tabId);
  if (!rec) return;
  let action;
  if (tool === 'computer') {
    const type = args.action;
    if (type === 'screenshot') return; // screenshot() records its own frame
    if (type === 'zoom') {
      if (result?.image) pushFrame(rec, { base64: result.image.data, format: 'jpeg', action: { type, description: 'Zoomed in' }, delay: 800 });
      return;
    }
    const pointer = /click|drag/.test(type) ? lastPointer.get(tabId) : null;
    const description = type.includes('click') ? 'Clicked'
      : type === 'type' ? `Typed: "${args.text}"`
      : type === 'key' ? `Pressed key: ${args.text}`
      : type === 'scroll' ? 'Scrolled'
      : type === 'left_click_drag' ? 'Dragged'
      : type;
    action = { type, description, ...pointer };
    // Show where the click/drag happened on the frame from just before it.
    const prev = rec.frames[rec.frames.length - 1];
    if (pointer && prev) pushFrame(rec, { ...prev, action: { ...action, marker: true }, delay: ACTION_DELAYS[type] ?? 800 });
  } else {
    action = { type: 'navigate', description: `Navigated to ${args.url}` };
  }
  await sleep(100);
  const shot = await grabViewport(tabId).catch(() => null);
  if (shot) pushFrame(rec, { base64: shot.data, format: 'jpeg', viewportWidth: shot.w, viewportHeight: shot.h, action, delay: ACTION_DELAYS[action.type] ?? 800 });
}

async function gif_creator({ action, tabId, download, coordinate, filename, options = {} }) {
  const id = await resolveTab(tabId);
  const key = await recordingKey(id);
  const rec = recordings.get(key) || { active: false, frames: [] };
  recordings.set(key, rec);
  switch (action) {
    case 'start_recording':
      if (rec.active) return 'Already recording this tab group. Use stop_recording, then export.';
      rec.active = true;
      rec.frames = [];
      return 'Recording started (max 50 frames). computer and navigate actions are captured. Take a screenshot now to capture the first frame.';
    case 'stop_recording': {
      if (!rec.active) return 'Not recording. Use start_recording first.';
      rec.active = false;
      return `Recording stopped with ${rec.frames.length} frame(s). Use export to create the GIF, or clear to discard.`;
    }
    case 'clear': {
      const n = rec.frames.length;
      recordings.delete(key);
      return `Cleared ${n} frame(s); recording stopped.`;
    }
    case 'export': {
      if (!rec.frames.length) throw new Error('No frames recorded. Use start_recording, then act in the tab.');
      const name = filename || `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.gif`;
      const gif = await renderGif(rec.frames, {
        showClickIndicators: options.showClickIndicators ?? true,
        showDragPaths: options.showDragPaths ?? true,
        showActionLabels: options.showActionLabels ?? true,
        showProgressBar: options.showProgressBar ?? true,
        showWatermark: options.showWatermark ?? true,
        quality: options.quality ?? 10,
      });
      const frames = rec.frames.length;
      recordings.delete(key);
      const summary = `GIF with ${frames} frames, ${gif.width}x${gif.height}, ${Math.round(gif.size / 1024)} KB`;
      if (download) {
        try {
          const where = await downloadFile(gif.blobUrl, name);
          return `${summary}. Downloaded to ${where}. Recording cleared.`;
        } finally {
          chrome.runtime.sendMessage({ type: 'aichrome-revoke-url', url: gif.blobUrl }).catch(() => {});
        }
      }
      chrome.runtime.sendMessage({ type: 'aichrome-revoke-url', url: gif.blobUrl }).catch(() => {});
      if (coordinate) {
        const [x, y] = toCss(id, coordinate);
        const out = await dropFile(id, { x, y }, gif.base64, name, 'image/gif');
        return `${summary}. ${out} Recording cleared.`;
      }
      // Default: hand the file back to aichrome, which saves it locally.
      return { text: `${summary}. Recording cleared.`, file: { name, mimeType: 'image/gif', data: gif.base64 } };
    }
    default:
      throw new Error('action must be start_recording, stop_recording, export or clear');
  }
}

// Claim our own downloads' filenames (other extensions may otherwise rename them).
const downloadNames = new Map(); // url -> filename
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = downloadNames.get(item.finalUrl) || downloadNames.get(item.url);
  if (!filename) return;
  suggest({ filename, conflictAction: 'uniquify' });
});

// Start a Chrome download and wait until it really finishes (or fails).
async function downloadFile(url, filename) {
  downloadNames.set(url, filename);
  const id = await chrome.downloads.download({ url, filename, saveAs: false }).catch((e) => {
    downloadNames.delete(url);
    throw e;
  });
  return new Promise((resolve, reject) => {
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item || item.state === 'in_progress') return false;
      chrome.downloads.onChanged.removeListener(onChange);
      clearTimeout(timer);
      downloadNames.delete(url);
      if (item.state === 'complete') resolve(item.filename);
      else reject(new Error(`Download failed: ${item.error || item.state}`));
      return true;
    };
    const onChange = (delta) => delta.id === id && delta.state && check();
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChange);
      reject(new Error('Download did not finish within 30s'));
    }, 30000);
    chrome.downloads.onChanged.addListener(onChange);
    check();
  });
}

async function renderGif(frames, options) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Encode GIF recordings' });
  }
  const res = await chrome.runtime.sendMessage({ type: 'aichrome-render-gif', frames, options });
  if (!res?.ok) throw new Error(res?.error || 'GIF encoding failed');
  return res.result;
}

// ---------- uploads ----------
// Same technique as Claude in Chrome: build File objects with DataTransfer, then set input.files
// (file inputs) or dispatch dragenter/dragover/drop (drop zones like Google Docs).

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const base64Bytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

// A ref to an "Upload" button or label means its file input: use that instead of failing or opening a picker.
async function fileInputRef(tabId, ref) {
  return (await inPage(tabId, (r) => window.__aichromeFileInput(r), [ref]).catch(() => null)) || null;
}

async function file_upload(args) {
  const { tabId, files } = args;
  if (!Array.isArray(files) || !files.length) throw new Error('files is required (aichrome fills it from `paths`)');
  const tid = await resolveTab(tabId);
  let { ref } = await resolveRef(tid, args.ref || args.selector || args.label ? args : { ...args, selector: 'input[type=file]' });
  if (!ref) throw new Error('ref of the <input type="file"> is required (find it with read_page or find)');
  ref = (await fileInputRef(tid, ref)) || ref;
  let total = 0;
  for (const f of files) {
    if (typeof f.data !== 'string' || !f.name) throw new Error('each file needs `data` (base64) and `name`');
    total += base64Bytes(f.data);
  }
  if (total > MAX_UPLOAD_BYTES) throw new Error('Total upload size exceeds 10 MB');
  const id = await resolveTab(tabId);
  indicate(id, 'show');
  const res = await inPage(id, (ref, files) => {
    const el = window.__aichromeRef(ref);
    if (!el || !el.isConnected) return { error: `ref ${ref} not found; call read_page again` };
    if (el.tagName !== 'INPUT' || el.type !== 'file') {
      return { error: `${ref} is <${el.tagName.toLowerCase()}${el.type ? ` type="${el.type}"` : ''}>, not a file input. Look for an input[type=file] (often hidden) with read_page filter "all".` };
    }
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mimeType || 'application/octet-stream', lastModified: Date.now() }));
    }
    el.files = dt.files;
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: `Uploaded ${files.length} file(s) to ${ref}: ${files.map((f) => f.name).join(', ')}` };
  }, [ref, files]);
  if (res.error) throw new Error(res.error);
  return `${res.ok} (${Math.round(total / 1024)} KB total)`;
}

async function upload_image({ tabId, imageId, data, mimeType, ref, coordinate, filename }) {
  if (!ref === !coordinate) throw new Error('Provide either ref (file input or element) or coordinate (drop point), not both');
  let image;
  if (data) image = { data, mimeType: mimeType || 'image/png' };
  else if (imageId) image = shots.get(imageId);
  else throw new Error('imageId (from a screenshot) or path is required');
  if (!image) throw new Error(`Image ${imageId} not found; take a new screenshot and use its image ID`);
  if (base64Bytes(image.data) > MAX_UPLOAD_BYTES) throw new Error('Image exceeds 10 MB');
  const id = await resolveTab(tabId);
  const ext = image.mimeType === 'image/jpeg' ? 'jpg' : (image.mimeType.split('/')[1] || 'png');
  const name = filename || `image.${ext}`;
  // An "Upload" button's ref means its file input; a drop zone keeps the drop.
  if (ref) ref = (await inPage(id, (r) => {
    const el = window.__aichromeRef(r);
    if (!el) return null;
    const pickerish = el.matches('button, label, a, [role="button"], input[type="file"]') || el.closest('button, label, [role="button"]');
    return pickerish ? window.__aichromeFileInput(r) : null;
  }, [ref]).catch(() => null)) || ref;
  const target = ref ? { ref } : (() => { const [x, y] = toCss(id, coordinate); return { x, y }; })();
  indicate(id, 'show');
  return dropFile(id, target, image.data, name, image.mimeType);
}

// Put a file into a file input (by ref) or drop it on the element at a point / ref.
async function dropFile(tabId, target, base64, name, mimeType) {
  const res = await inPage(tabId, (target, base64, name, mimeType) => {
    let el = null;
    if (target.ref) {
      el = window.__aichromeRef(target.ref);
      if (!el || !el.isConnected) return { error: `ref ${target.ref} not found; call read_page again` };
    } else {
      el = document.elementFromPoint(target.x, target.y);
      if (el?.tagName === 'IFRAME') {
        try {
          const r = el.getBoundingClientRect();
          el = el.contentDocument?.elementFromPoint(target.x - r.left, target.y - r.top) || el;
        } catch {}
      }
      if (!el) return { error: `No element at (${Math.round(target.x)}, ${Math.round(target.y)})` };
    }
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type: mimeType, lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);
    if (el.tagName === 'INPUT' && el.type === 'file') {
      el.files = dt.files;
      el.focus();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: `Put "${name}" (${Math.round(file.size / 1024)} KB) into the file input.` };
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    let x = target.x;
    let y = target.y;
    if (x == null) {
      const b = el.getBoundingClientRect();
      x = b.left + b.width / 2;
      y = b.top + b.height / 2;
    }
    let accepted = false;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY });
      el.dispatchEvent(ev);
      if (type === 'drop') accepted = ev.defaultPrevented;
    }
    const where = `<${el.tagName.toLowerCase()}> at (${Math.round(x)}, ${Math.round(y)})`;
    if (!accepted) {
      return { ok: `Dropped "${name}" on ${where}, but no drop handler accepted it, so it probably did nothing. Use the page's <input type="file"> ref instead (read_page lists it, even when hidden).` };
    }
    return { ok: `Dropped "${name}" (${Math.round(file.size / 1024)} KB) on ${where}; the page accepted the drop.` };
  }, [target, base64, name, mimeType]);
  if (res.error) throw new Error(res.error);
  return res.ok;
}

// ---------- screenshots ----------

// Capture the visible viewport, scaled to fit MAX_SHOT_PX.
async function grabViewport(tabId, { full = true } = {}) {
  const { cssVisualViewport: vv } = await cdp(tabId, 'Page.getLayoutMetrics');
  const w = vv.clientWidth;
  const h = vv.clientHeight;
  const fit = Math.min(1, (full ? MAX_SHOT_PX : SHOT_PX) / Math.max(w, h));
  const data = await capture(tabId, { x: vv.pageX, y: vv.pageY, width: w, height: h }, fit, full ? 80 : SHOT_QUALITY);
  const dims = jpegSize(data) || { width: Math.round(w * fit), height: Math.round(h * fit) };
  return { data, w, h, dims };
}

// Recent screenshots, addressable by ID (upload_image).
const SHOT_CACHE = 20;
const shots = new Map();
let shotSeq = 0;

async function screenshot(tabId, { full = false, annotate = false } = {}) {
  let legend = [];
  if (annotate) legend = (await inPage(tabId, () => window.__aichromeAnnotate(true), []).catch(() => [])) || [];
  let grabbed;
  try {
    grabbed = await grabViewport(tabId, { full });
  } finally {
    if (annotate) await inPage(tabId, () => window.__aichromeAnnotate(false), []).catch(() => {});
  }
  const { data, w, h, dims } = grabbed;
  shotScale.set(tabId, { sx: w / dims.width, sy: h / dims.height });
  const imageId = `shot_${++shotSeq}`;
  shots.set(imageId, { data, mimeType: 'image/jpeg' });
  if (shots.size > SHOT_CACHE) shots.delete(shots.keys().next().value);
  await recordFrame(tabId, { data, w, h }, null);
  return {
    text: `Screenshot of tab ${tabId} (image ID: ${imageId}): ${dims.width}x${dims.height}px (viewport ${Math.round(w)}x${Math.round(h)} CSS px). Use screenshot pixel coordinates for clicks.` +
      (annotate ? `\nLabels are refs (12 = ref_12), usable as ref in computer/form_input:\n${legend.join('\n')}` : ''),
    image: { data, mimeType: 'image/jpeg' },
  };
}

async function zoom(tabId, region) {
  if (!Array.isArray(region) || region.length !== 4) throw new Error('region [x0, y0, x1, y1] (screenshot pixels) is required');
  const [x0, y0] = toCss(tabId, [region[0], region[1]]);
  const [x1, y1] = toCss(tabId, [region[2], region[3]]);
  const { cssVisualViewport: vv } = await cdp(tabId, 'Page.getLayoutMetrics');
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const dpr = await devicePixelRatio(tabId);
  const fit = Math.min(dpr, MAX_SHOT_PX / Math.max(w, h));
  const data = await capture(tabId, { x: vv.pageX + x0, y: vv.pageY + y0, width: w, height: h }, fit);
  return { text: `Zoomed region (${region.join(', ')})`, image: { data, mimeType: 'image/jpeg' } };
}

// `scale` = desired output pixels per CSS pixel.
// Like Claude in Chrome, verify the decoded image size instead of trusting devicePixelRatio
// (it can be stale mid-navigation or across displays); on a mismatch, learn the real factor and recapture.
async function capture(tabId, rect, scale, quality = 80) {
  const shoot = async (factor) => {
    const { data } = await cdp(tabId, 'Page.captureScreenshot', {
      format: 'jpeg', quality, captureBeyondViewport: false, fromSurface: true,
      clip: { ...rect, scale: scale / factor },
    });
    if (!data) throw new Error('Failed to capture screenshot via CDP');
    return data;
  };
  const factor = await devicePixelRatio(tabId);
  await indicate(tabId, 'hide');
  try {
    let data = await shoot(factor);
    const want = Math.round(rect.width * scale);
    const got = jpegSize(data)?.width;
    if (got && Math.abs(got - want) > 1) {
      const real = (factor * got) / want;
      dprCache.set(tabId, real);
      data = await shoot(real);
    }
    return data;
  } finally {
    indicate(tabId, 'show');
  }
}

const dprCache = new Map();
async function devicePixelRatio(tabId) {
  if (dprCache.has(tabId)) return dprCache.get(tabId);
  const res = await cdp(tabId, 'Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true });
  const dpr = Number(res.result?.value) || 1;
  dprCache.set(tabId, dpr);
  return dpr;
}

// Read width/height from a base64 JPEG's SOF marker.
function jpegSize(b64) {
  const bin = atob(b64.substring(0, 80000));
  let i = 2;
  while (i < bin.length) {
    if (bin.charCodeAt(i) !== 0xff) return null;
    const marker = bin.charCodeAt(i + 1);
    const len = (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: (bin.charCodeAt(i + 5) << 8) | bin.charCodeAt(i + 6), width: (bin.charCodeAt(i + 7) << 8) | bin.charCodeAt(i + 8) };
    }
    i += 2 + len;
  }
  return null;
}

// ---------- input ----------

function toCss(tabId, coord) {
  if (!Array.isArray(coord) || coord.length !== 2) throw new Error('coordinate must be [x, y]');
  const s = shotScale.get(tabId) || { sx: 1, sy: 1 };
  return [Number(coord[0]) * s.sx, Number(coord[1]) * s.sy];
}

// Turn `selector` / `label` (visible text) into a ref, so tools can act without a find/read_page call first.
async function resolveRef(tabId, args) {
  if (args.ref || (!args.selector && !args.label)) return args;
  const res = await inPage(tabId, (q) => window.__aichromeQuery(q), [{ selector: args.selector, label: args.label }]);
  if (!res?.ref) throw new Error(res?.error || 'Element not found');
  return { ...args, ref: res.ref, _desc: res.desc };
}

async function target(tabId, args) {
  args = await resolveRef(tabId, args);
  if (args.ref) {
    const r = await inPage(tabId, (ref) => {
      const el = window.__aichromeRef(ref);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    }, [args.ref]);
    if (!r) throw new Error(`ref ${args.ref} not found; call read_page again`);
    return r;
  }
  if (args.coordinate) return toCss(tabId, args.coordinate);
  throw new Error('coordinate [x, y], ref, selector or label is required');
}

const pageState = (tabId, x, y) => inPage(tabId, (x, y) => window.__aichromeState(x, y), [x ?? null, y ?? null]).catch(() => null);

// After a click/key: wait for the page to settle, then say what changed, so no screenshot is needed to check.
async function reactionReport(tabId, before) {
  if (!before) return '';
  await sleep(120);
  // A navigation may have started: wait for it.
  for (let i = 0; i < 60 && (await chrome.tabs.get(tabId).catch(() => null))?.status === 'loading'; i++) await sleep(250);
  let after = await settle(tabId);
  if (!after) return '\n→ Page is reloading or navigating.';
  const out = [];
  if (after.url !== before.url) {
    after = (await settle(tabId, { needControls: true })) || after; // SPA routes render after the URL changes
    out.push(`→ Navigated to ${after.url} (${after.title})`);
    const snap = await snapshot(tabId).catch((e) => `(snapshot failed: ${e.message})`);
    if (snap) out.push(snap);
    return '\n' + out.join('\n');
  }
  if (after.title !== before.title) out.push(`→ Title is now "${after.title}"`);
  const oldDialogs = new Set(before.dialogs.map((d) => d.ref));
  for (const d of after.dialogs.filter((d) => !oldDialogs.has(d.ref))) {
    out.push(`→ Dialog opened: "${d.name}" [${d.ref}]`);
    const tree = await inPage(tabId, (r) => window.__aichromeTree('interactive', 20, r), [d.ref]).catch(() => null);
    if (tree?.pageContent) out.push(clip(tree.pageContent, 2000));
  }
  const newDialogs = new Set(after.dialogs.map((d) => d.ref));
  if (before.dialogs.some((d) => !newDialogs.has(d.ref))) out.push('→ A dialog closed');
  const oldToasts = new Set(before.toasts);
  for (const t of after.toasts.filter((t) => !oldToasts.has(t))) out.push(`→ Message: "${t}"`);
  if (before.control && after.targetRef === before.targetRef) {
    const now = await inPage(tabId, (r) => window.__aichromeControlState(r), [before.targetRef]).catch(() => null);
    const changed = Object.keys({ ...before.control, ...(now || {}) }).filter((k) => String(before.control[k]) !== String(now?.[k]));
    if (changed.length) out.push(`→ ${changed.map((k) => `${k}: ${before.control[k]} → ${now?.[k]}`).join(', ')}`);
    else if ('checked' in before.control) out.push(`→ Still ${before.control.checked ? 'checked' : 'unchecked'}: the click did not toggle it (try form_input with its checkbox ref)`);
  }
  if (after.focus && after.focus !== before.focus) out.push(`→ Focus: ${after.focus}`);
  const delta = after.mutations - before.mutations;
  if (!out.length) out.push(delta > 0 ? `→ Page updated (${delta} DOM changes)` : '→ No visible change');
  return '\n' + out.join('\n');
}

// Wait until the DOM stops changing (~250ms quiet, max ~2.5s). needControls: also wait (up to ~4s) for the main
// content to have controls, since SPAs show a spinner first and fill the page from an API call.
async function settle(tabId, { needControls = false } = {}) {
  let state = await pageState(tabId);
  const start = Date.now();
  for (let quiet = 0; state && quiet < 2 && Date.now() - start < 2500;) {
    await sleep(125);
    const next = await pageState(tabId);
    quiet = next && next.mutations === state.mutations && next.url === state.url ? quiet + 1 : 0;
    state = next || state;
  }
  while (needControls && Date.now() - start < 4000) {
    const n = await inPage(tabId, () => window.__aichromeTree('interactive', 30, null, 'main').pageContent.split('\n').filter(Boolean).length, []).catch(() => 0);
    if (n >= 3) break;
    await sleep(250);
  }
  return state;
}

const clip = (s, max) => (s.length > max ? `${s.substring(0, max)}\n…[${s.length - max} more chars: use read_page or find]` : s);

// Compact list of the main content's controls, returned with navigations so a read_page call isn't needed.
async function snapshot(tabId, max = 3000) {
  await settle(tabId);
  const res = await inPage(tabId, () => window.__aichromeTree('interactive', 30, null, 'main'), []);
  if (!res?.pageContent) return '';
  return `Controls (main content; read_page for everything):\n${clip(res.pageContent, max)}`;
}

// Poll until text/selector appears (or is gone), or the URL contains a string.
async function waitFor(tabId, { text, selector, url, gone = false, duration = 10 }) {
  if (!text && !selector && !url) throw new Error('wait_for needs text, selector or url');
  const limit = Math.min(60, Math.max(0.5, Number(duration) || 10)) * 1000;
  const start = Date.now();
  while (true) {
    let hit = false;
    if (url) hit = ((await chrome.tabs.get(tabId).catch(() => null))?.url || '').includes(url);
    else {
      hit = await inPage(tabId, (text, selector) => {
        const visible = (el) => el && (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);
        if (selector) {
          try { return [...document.querySelectorAll(selector)].some(visible); } catch (e) { throw new Error(`Bad selector: ${e.message}`); }
        }
        return (document.body?.innerText || '').toLowerCase().includes(String(text).toLowerCase());
      }, [text || null, selector || null]).catch((e) => { if (/Bad selector/.test(e.message)) throw e; return false; });
    }
    if (hit !== gone) return `Condition met after ${((Date.now() - start) / 1000).toFixed(1)}s: ${url ? `URL contains "${url}"` : `${selector ? `selector "${selector}"` : `text "${text}"`} ${gone ? 'is gone' : 'is present'}`}`;
    if (Date.now() - start > limit) throw new Error(`Timed out after ${limit / 1000}s waiting for ${url || selector || `"${text}"`}${gone ? ' to disappear' : ''}`);
    await sleep(250);
  }
}

async function viewportCenter(tabId) {
  const { cssVisualViewport: vv } = await cdp(tabId, 'Page.getLayoutMetrics');
  return [vv.clientWidth / 2, vv.clientHeight / 2];
}

function mouseEvent(tabId, type, x, y, extra = {}) {
  return cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, ...extra });
}

const lastPointer = new Map(); // tabId -> { coordinate, start_coordinate } in CSS px

async function click(tabId, x, y, button = 'left', count = 1, modifiers = 0) {
  lastPointer.set(tabId, { coordinate: [x, y] });
  await indicate(tabId, 'move', { x, y, click: true });
  await mouseEvent(tabId, 'mouseMoved', x, y, { modifiers });
  for (let i = 1; i <= count; i++) {
    await mouseEvent(tabId, 'mousePressed', x, y, { button, clickCount: i, modifiers });
    await mouseEvent(tabId, 'mouseReleased', x, y, { button, clickCount: i, modifiers });
  }
}

async function drag(tabId, sx, sy, ex, ey) {
  lastPointer.set(tabId, { coordinate: [ex, ey], start_coordinate: [sx, sy] });
  await indicate(tabId, 'move', { x: sx, y: sy });
  await mouseEvent(tabId, 'mouseMoved', sx, sy);
  await mouseEvent(tabId, 'mousePressed', sx, sy, { button: 'left', clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = sx + ((ex - sx) * i) / steps;
    const y = sy + ((ey - sy) * i) / steps;
    await mouseEvent(tabId, 'mouseMoved', x, y, { button: 'left', buttons: 1 });
    await indicate(tabId, 'move', { x, y });
  }
  await mouseEvent(tabId, 'mouseReleased', ex, ey, { button: 'left', clickCount: 1 });
}

const MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 };
const KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9],
  backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27], space: [' ', 'Space', 32, ' '], arrowup: ['ArrowUp', 'ArrowUp', 38],
  up: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40], down: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], left: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39], right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
};
for (let i = 1; i <= 12; i++) KEYS['f' + i] = ['F' + i, 'F' + i, 111 + i];
// Editing shortcuts need explicit commands; synthetic key events don't trigger them on macOS.
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

function modifierMask(spec) {
  if (!spec || typeof spec !== 'string') return 0;
  return spec.toLowerCase().split(/[+\s]+/).reduce((m, k) => m | (MODIFIERS[k] || 0), 0);
}

async function pressKey(tabId, combo) {
  const parts = combo.split('+');
  const keyName = parts.pop();
  const modifiers = parts.reduce((m, k) => m | (MODIFIERS[k.toLowerCase()] || 0), 0);
  let key, code, keyCode, text;
  const named = KEYS[keyName.toLowerCase()];
  if (named) [key, code, keyCode, text] = named;
  else if (keyName.length === 1) {
    key = modifiers & 8 ? keyName.toUpperCase() : keyName;
    const upper = keyName.toUpperCase();
    code = /[A-Z]/.test(upper) ? 'Key' + upper : /[0-9]/.test(keyName) ? 'Digit' + keyName : undefined;
    keyCode = upper.charCodeAt(0);
    text = key;
  } else throw new Error(`Unknown key "${keyName}"`);
  const shortcut = modifiers & (2 | 4);
  if (shortcut) text = undefined;
  const command = shortcut && !(modifiers & 1) ? EDIT_COMMANDS[keyName.toLowerCase()] : undefined;
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, ...(command === 'paste' && { commands: ['paste'] }) });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  // Chrome ignores CDP editing `commands` from extensions, so run the editing command in the page.
  if (command && command !== 'paste') {
    await cdp(tabId, 'Runtime.evaluate', {
      userGesture: true,
      expression: `(() => {
        const cmd = ${JSON.stringify(command)}, el = document.activeElement;
        if (cmd === 'selectAll' && el && typeof el.select === 'function') return el.select();
        document.execCommand(cmd);
      })()`,
    });
  }
}

// ---------- CDP / debugger ----------

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(String(e?.message))) throw new Error(`Cannot control tab ${tabId}: ${e.message}`);
  }
  attached.add(tabId);
  const send = (m, p) => chrome.debugger.sendCommand({ tabId }, m, p).catch(() => {});
  await Promise.all([
    send('Page.enable'), send('Runtime.enable'),
    send('Network.enable', { maxTotalBufferSize: 100e6, maxResourceBufferSize: 10e6, maxPostDataSize: 1e6 }),
    send('Emulation.setFocusEmulationEnabled', { enabled: true }),
  ]);
  onNetworkAttach(tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.webNavigation.onCommitted.addListener((d) => d.frameId === 0 && dprCache.delete(d.tabId));

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    pushLog(tabId, { level: 'dialog', text: `${params.type}: ${params.message} (auto-accepted)` });
    chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  } else if (method === 'Runtime.consoleAPICalled') {
    const text = params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    pushLog(tabId, { level: params.type, text, url: params.stackTrace?.callFrames?.[0]?.url });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails;
    pushLog(tabId, { level: 'exception', text: d.exception?.description || d.text, url: d.url });
  } else if (method.startsWith('Network.') || method.startsWith('Fetch.')) {
    onNetworkEvent(tabId, method, params);
  }
});

function pushLog(tabId, entry) {
  const logs = consoleLogs.get(tabId) || [];
  logs.push({ ...entry, ts: Date.now() });
  if (logs.length > LOG_LIMIT) logs.shift();
  consoleLogs.set(tabId, logs);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  shotScale.delete(tabId);
  dprCache.delete(tabId);
  consoleLogs.delete(tabId);
  onNetworkTabRemoved(tabId);
  if (currentTab === tabId) setCurrentTab(null);
});

// ---------- helpers ----------

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('No active tab');
  return tab.id;
}

async function resolveTab(tabId) {
  if (tabId != null && tabId !== '') {
    const t = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!t) throw new Error(`Tab ${tabId} does not exist; use tabs_context to list tabs`);
    return t.id;
  }
  if (currentTab == null) currentTab = (await chrome.storage.local.get('currentTab')).currentTab ?? null;
  if (currentTab != null && (await chrome.tabs.get(currentTab).catch(() => null))) return currentTab;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isControllable(active.url)) return active.id;
  // Active tab is a browser page (chrome://, extension store…): fall back to an AI group tab.
  const group = await findGroup();
  if (group) {
    const [t] = await chrome.tabs.query({ groupId: group.id });
    if (t) return t.id;
  }
  if (active) throw new Error(`The active tab (${active.url}) can't be controlled. Open a page with tabs_create or pick one with tabs_select.`);
  throw new Error('No active tab');
}

function isControllable(url = '') {
  return !/^(chrome|edge|brave|about|devtools|chrome-extension):/.test(url) && !url.startsWith('https://chromewebstore.google.com');
}

async function inGroup(tabId) {
  const group = await findGroup();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return !!(group && tab && tab.groupId === group.id);
}

async function findGroup() {
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return group || null;
}

async function addToGroup(tabId) {
  const group = await findGroup();
  if (group) {
    await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] }).catch(() => {});
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'purple', collapsed: false });
}

function normalizeUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url;
}

// Resolve once the main frame's DOM is ready (like Claude in Chrome, don't wait for every image/ad).
// `trigger` starts the navigation only after the listeners are attached, so fast pages can't slip past.
let lastNavReason = '';
function waitForLoad(tabId, trigger, timeoutMs = NAV_TIMEOUT_MS) {
  const nav = chrome.webNavigation;
  return new Promise((resolve, reject) => {
    let started = false;
    let committed = false;
    let documentId = null;
    let poll = null;
    const done = (why = 'event') => {
      lastNavReason = why;
      clearTimeout(timer);
      clearTimeout(idle);
      clearInterval(poll);
      for (const [ev, fn] of events) ev.removeListener(fn);
      resolve();
    };
    const main = (fn) => (d) => d.tabId === tabId && d.frameId === 0 && fn(d);
    const events = [
      [nav.onBeforeNavigate, main(() => { started = true; })],
      // New document committed: it's the right page now, so poll its readyState. This also covers
      // back/forward-cache restores, which fire no DOMContentLoaded.
      [nav.onCommitted, main((d) => {
        started = committed = true;
        documentId = d.documentId;
        clearInterval(poll);
        poll = setInterval(async () => {
          const state = await chrome.scripting
            .executeScript({ target: { tabId, documentIds: [documentId] }, func: () => document.readyState, injectImmediately: true })
            .then(([r]) => r?.result)
            .catch(() => null);
          if (state && state !== 'loading') done('poll:' + state);
        }, 50);
      })],
      // Only trust load events after *our* navigation committed; the previous page may still be
      // finishing (late onCompleted, pushState) while the new one is in flight.
      [nav.onDOMContentLoaded, main((d) => committed && d.documentId === documentId && done('dcl'))],
      [nav.onCompleted, main((d) => committed && d.documentId === documentId && done('completed'))],
      // ERR_ABORTED = a navigation was superseded (often the old page's own); real failures commit an error page.
      [nav.onErrorOccurred, main((d) => started && d.error !== 'net::ERR_ABORTED' && done('error:' + d.error))],
      // Same-document navigations (SPA routes, #hash) don't start a new document load.
      [nav.onHistoryStateUpdated, main(() => !started && done('history'))],
      [nav.onReferenceFragmentUpdated, main(() => !started && done('fragment'))],
    ];
    for (const [ev, fn] of events) ev.addListener(fn);
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    // Nothing navigated at all (e.g. "back" with no history): stop waiting.
    const idle = setTimeout(() => !started && done('idle'), 1000);
    Promise.resolve(trigger?.()).catch((e) => {
      done();
      reject(e);
    });
  });
}

// Run a function in the page's isolated world, injecting the tree script if it isn't there yet.
async function inPage(tabId, func, args) {
  const exec = (opts) => chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, ...opts });
  const run = async () => (await exec({ func, args }))[0]?.result;
  let result;
  try {
    result = await run();
    if (result !== undefined && result !== null) return result;
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/__aichrome\w* is not a function/.test(msg)) throw new Error(msg.replace(/^Error: /, ''));
  }
  // Our content scripts are missing or outdated (page opened before the extension loaded, or orphaned by a reload).
  const [{ result: ready } = {}] = await exec({ func: () => typeof window.__aichromeAnnotate === 'function' });
  if (ready) return result;
  await exec({ files: ['tree.js', 'indicator.js'] });
  return run();
}

function indicate(tabId, action, extra = {}) {
  const msg = chrome.tabs.sendMessage(tabId, { type: 'aichrome-indicator', action, ...extra }).catch(() => {});
  return action === 'hide' ? Promise.race([msg, sleep(50)]) : Promise.resolve();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
