// AI in Chrome service worker.
// Connects to the local native-messaging host (launched by Chrome) and executes tool requests
// with the Chrome DevTools Protocol, the same way Claude in Chrome does — minus login/pairing.

const HOST_NAME = 'com.chrome_pilot.bridge';
const GROUP_TITLE = 'AI';
const MAX_SHOT_PX = 1568;
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
const attached = new Set();
const shotScale = new Map(); // tabId -> { sx, sy } CSS px per screenshot px
const consoleLogs = new Map(); // tabId -> [{ level, text, url, ts }]
const networkLogs = new Map(); // tabId -> Map<requestId, entry>

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
    console.warn('[pilot] host disconnected:', chrome.runtime.lastError?.message);
    port = null;
    setBadge(false);
  });
  port.postMessage({ type: 'hello', version: chrome.runtime.getManifest().version });
  setBadge(true);
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? '' : 'off' });
  chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  chrome.action.setTitle({ title: on ? 'AI in Chrome: connected' : 'AI in Chrome: host not connected (run `cpilot install`)' });
}

const chunks = new Map(); // request id -> string[]

async function onHostMessage(msg) {
  if (msg?.type === 'ping') return port?.postMessage({ type: 'pong' });
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
chrome.alarms.create('pilot-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'pilot-reconnect' && connect());
chrome.action.onClicked.addListener(() => { port?.disconnect(); port = null; connect(); });
connect();

// ---------- tools ----------

const TOOLS = {
  tabs_context, tabs_create, tabs_close, tabs_select, navigate, computer, read_page, find,
  form_input, get_page_text, javascript_tool, read_console_messages, read_network_requests, resize_window, cdp_command, extension_reload,
  gif_creator, file_upload, upload_image,
};

async function runTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}`);
  if (name !== 'computer' && name !== 'navigate') return fn(args);
  const tabId = await resolveTab(args.tabId).catch(() => null);
  const result = await fn(args);
  if (tabId != null) await recordAction(tabId, name, args, result).catch((e) => console.warn('[pilot] record', e));
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
  return `Tabs (tabId, title, url). Commands without tabId use the current tab, else the active tab.\n${lines.join('\n')}`;
}

async function tabs_create({ url }) {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true, ...(win && { windowId: win.id }) });
  await addToGroup(tab.id);
  setCurrentTab(tab.id);
  ensureAttached(tab.id).catch(() => {});
  if (url) await waitForLoad(tab.id, () => chrome.tabs.update(tab.id, { url: normalizeUrl(url) }));
  const t = await chrome.tabs.get(tab.id);
  return `Created tab ${t.id}: ${t.title || ''} ${t.url || t.pendingUrl || ''}`;
}

async function tabs_close({ tabId }) {
  if (tabId == null) throw new Error('tabId is required');
  await chrome.tabs.remove(Number(tabId));
  if (currentTab === Number(tabId)) setCurrentTab(null);
  return `Closed tab ${tabId}`;
}

async function tabs_select({ tabId }) {
  if (tabId == null) throw new Error('tabId is required');
  const tab = await chrome.tabs.update(Number(tabId), { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  setCurrentTab(tab.id);
  return `Selected tab ${tab.id}: ${tab.title}`;
}

async function navigate({ tabId, url }) {
  if (!url) throw new Error('url is required');
  const id = await resolveTab(tabId);
  ensureAttached(id).catch(() => {});
  indicate(id, 'show');
  await waitForLoad(id, () => {
    if (url === 'back') return chrome.tabs.goBack(id);
    if (url === 'forward') return chrome.tabs.goForward(id);
    if (url === 'reload') return chrome.tabs.reload(id);
    return chrome.tabs.update(id, { url: normalizeUrl(url) });
  });
  const t = await chrome.tabs.get(id);
  return `Navigated tab ${id} to ${t.url}\nTitle: ${t.title}`;
}

async function computer(args) {
  const id = await resolveTab(args.tabId);
  const action = args.action;
  switch (action) {
    case 'screenshot':
      return screenshot(id);
    case 'zoom':
      return zoom(id, args.region);
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      const [x, y] = await target(id, args);
      const button = action === 'right_click' ? 'right' : 'left';
      const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
      await click(id, x, y, button, count, modifierMask(args.modifiers || args.text));
      return `${action} at (${Math.round(x)}, ${Math.round(y)})`;
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
      if (args.ref) await click(id, ...(await target(id, args)));
      await indicate(id, 'show');
      await cdp(id, 'Input.insertText', { text: String(args.text) });
      return `Typed ${String(args.text).length} characters`;
    }
    case 'key': {
      if (!args.text) throw new Error('text is required (e.g. "Enter", "ctrl+a", "Tab Tab Enter")');
      await indicate(id, 'show');
      const repeat = Math.max(1, Math.min(100, Number(args.repeat) || 1));
      for (let i = 0; i < repeat; i++) for (const combo of String(args.text).trim().split(/\s+/)) await pressKey(id, combo);
      return `Pressed ${args.text}${repeat > 1 ? ` x${repeat}` : ''}`;
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
      if (!args.ref) throw new Error('ref is required');
      await inPage(id, (ref) => {
        const el = window.__pilotRef(ref);
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
      throw new Error(`Unknown computer action "${action}". Use: screenshot, left_click, right_click, double_click, triple_click, type, key, scroll, scroll_to, hover, left_click_drag, wait, zoom`);
  }
}

async function read_page({ tabId, filter = 'all', depth = 15, ref_id }) {
  const id = await resolveTab(tabId);
  const res = await inPage(id, (f, d, r) => window.__pilotTree(f, d, r), [filter, Number(depth) || 15, ref_id || null]);
  if (res.error && !res.pageContent) throw new Error(res.error);
  const t = await chrome.tabs.get(id);
  const vp = res.viewport;
  return `Tab ${id}: ${t.title}\nURL: ${t.url}\nViewport: ${vp.width}x${vp.height} (scroll ${vp.scrollX},${vp.scrollY})\n${res.error ? 'Warning: ' + res.error + '\n' : ''}\n${res.pageContent}`;
}

async function find({ tabId, query }) {
  if (!query) throw new Error('query is required');
  const id = await resolveTab(tabId);
  const res = await inPage(id, () => window.__pilotTree('all', 40, null), []);
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = res.pageContent.split('\n')
    .map((line) => ({ line: line.trim(), score: words.filter((w) => line.toLowerCase().includes(w)).length }))
    .filter((m) => m.score > 0 && /\[ref_\d+\]/.test(m.line))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  if (!scored.length) return `No elements matching "${query}"`;
  return `Elements matching "${query}":\n${scored.map((m) => m.line).join('\n')}`;
}

async function form_input({ tabId, ref, value }) {
  if (!ref) throw new Error('ref is required');
  const id = await resolveTab(tabId);
  await indicate(id, 'show');
  return inPage(id, (ref, value) => {
    const el = window.__pilotRef(ref);
    if (!el) throw new Error(`ref ${ref} not found; call read_page again`);
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

async function javascript_tool({ tabId, text, code }) {
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
  return typeof v.value === 'string' ? v.value : JSON.stringify(v.value ?? v.description, null, 2);
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

async function read_network_requests({ tabId, urlPattern, limit = 100, clear = false }) {
  const id = await resolveTab(tabId);
  await ensureAttached(id);
  let reqs = [...(networkLogs.get(id)?.values() || [])];
  if (urlPattern) reqs = reqs.filter((r) => r.url.includes(urlPattern));
  reqs = reqs.slice(-limit);
  if (clear) networkLogs.set(id, new Map());
  if (!reqs.length) return 'No network requests captured (capture starts when AI in Chrome first attaches to the tab).';
  return reqs.map((r) => `${r.method} ${r.status ?? (r.failed ? 'FAILED ' + r.failed : '…')} ${r.type || ''} ${r.url}`).join('\n');
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
          chrome.runtime.sendMessage({ type: 'pilot-revoke-url', url: gif.blobUrl }).catch(() => {});
        }
      }
      chrome.runtime.sendMessage({ type: 'pilot-revoke-url', url: gif.blobUrl }).catch(() => {});
      if (coordinate) {
        const [x, y] = toCss(id, coordinate);
        const out = await dropFile(id, { x, y }, gif.base64, name, 'image/gif');
        return `${summary}. ${out} Recording cleared.`;
      }
      // Default: hand the file back to cpilot, which saves it locally.
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
  const res = await chrome.runtime.sendMessage({ type: 'pilot-render-gif', frames, options });
  if (!res?.ok) throw new Error(res?.error || 'GIF encoding failed');
  return res.result;
}

// ---------- uploads ----------
// Same technique as Claude in Chrome: build File objects with DataTransfer, then set input.files
// (file inputs) or dispatch dragenter/dragover/drop (drop zones like Google Docs).

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const base64Bytes = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

async function file_upload({ tabId, ref, files }) {
  if (!ref) throw new Error('ref of the <input type="file"> is required (find it with read_page or find)');
  if (!Array.isArray(files) || !files.length) throw new Error('files is required (cpilot fills it from `paths`)');
  let total = 0;
  for (const f of files) {
    if (typeof f.data !== 'string' || !f.name) throw new Error('each file needs `data` (base64) and `name`');
    total += base64Bytes(f.data);
  }
  if (total > MAX_UPLOAD_BYTES) throw new Error('Total upload size exceeds 10 MB');
  const id = await resolveTab(tabId);
  indicate(id, 'show');
  const res = await inPage(id, (ref, files) => {
    const el = window.__pilotRef(ref);
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
  const target = ref ? { ref } : (() => { const [x, y] = toCss(id, coordinate); return { x, y }; })();
  indicate(id, 'show');
  return dropFile(id, target, image.data, name, image.mimeType);
}

// Put a file into a file input (by ref) or drop it on the element at a point / ref.
async function dropFile(tabId, target, base64, name, mimeType) {
  const res = await inPage(tabId, (target, base64, name, mimeType) => {
    let el = null;
    if (target.ref) {
      el = window.__pilotRef(target.ref);
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
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY }));
    }
    return { ok: `Dropped "${name}" (${Math.round(file.size / 1024)} KB) on <${el.tagName.toLowerCase()}> at (${Math.round(x)}, ${Math.round(y)}).` };
  }, [target, base64, name, mimeType]);
  if (res.error) throw new Error(res.error);
  return res.ok;
}

// ---------- screenshots ----------

// Capture the visible viewport, scaled to fit MAX_SHOT_PX.
async function grabViewport(tabId) {
  const { cssVisualViewport: vv } = await cdp(tabId, 'Page.getLayoutMetrics');
  const w = vv.clientWidth;
  const h = vv.clientHeight;
  const fit = Math.min(1, MAX_SHOT_PX / Math.max(w, h));
  const data = await capture(tabId, { x: vv.pageX, y: vv.pageY, width: w, height: h }, fit);
  const dims = jpegSize(data) || { width: Math.round(w * fit), height: Math.round(h * fit) };
  return { data, w, h, dims };
}

// Recent screenshots, addressable by ID (upload_image).
const SHOT_CACHE = 20;
const shots = new Map();
let shotSeq = 0;

async function screenshot(tabId) {
  const { data, w, h, dims } = await grabViewport(tabId);
  shotScale.set(tabId, { sx: w / dims.width, sy: h / dims.height });
  const imageId = `shot_${++shotSeq}`;
  shots.set(imageId, { data, mimeType: 'image/jpeg' });
  if (shots.size > SHOT_CACHE) shots.delete(shots.keys().next().value);
  await recordFrame(tabId, { data, w, h }, null);
  return {
    text: `Screenshot of tab ${tabId} (image ID: ${imageId}): ${dims.width}x${dims.height}px (viewport ${Math.round(w)}x${Math.round(h)} CSS px). Use screenshot pixel coordinates for clicks.`,
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
async function capture(tabId, rect, scale) {
  const shoot = async (factor) => {
    const { data } = await cdp(tabId, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 80, captureBeyondViewport: false, fromSurface: true,
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

async function target(tabId, args) {
  if (args.ref) {
    const r = await inPage(tabId, (ref) => {
      const el = window.__pilotRef(ref);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    }, [args.ref]);
    if (!r) throw new Error(`ref ${args.ref} not found; call read_page again`);
    return r;
  }
  if (args.coordinate) return toCss(tabId, args.coordinate);
  throw new Error('coordinate [x, y] or ref is required');
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
    send('Page.enable'), send('Runtime.enable'), send('Network.enable'),
    send('Emulation.setFocusEmulationEnabled', { enabled: true }),
  ]);
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
  } else if (method === 'Network.requestWillBeSent') {
    const map = networkLogs.get(tabId) || new Map();
    map.set(params.requestId, { url: params.request.url, method: params.request.method, type: params.type });
    if (map.size > LOG_LIMIT) map.delete(map.keys().next().value);
    networkLogs.set(tabId, map);
  } else if (method === 'Network.responseReceived') {
    const entry = networkLogs.get(tabId)?.get(params.requestId);
    if (entry) entry.status = params.response.status;
  } else if (method === 'Network.loadingFailed') {
    const entry = networkLogs.get(tabId)?.get(params.requestId);
    if (entry) entry.failed = params.errorText;
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
  networkLogs.delete(tabId);
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
    if (!/__pilot(Tree|Ref) is not a function/.test(msg)) throw new Error(msg.replace(/^Error: /, ''));
  }
  // Our content scripts are missing (page opened before the extension loaded, or orphaned by a reload).
  const [{ result: ready } = {}] = await exec({ func: () => typeof window.__pilotTree === 'function' });
  if (ready) return result;
  await exec({ files: ['tree.js', 'indicator.js'] });
  return run();
}

function indicate(tabId, action, extra = {}) {
  const msg = chrome.tabs.sendMessage(tabId, { type: 'pilot-indicator', action, ...extra }).catch(() => {});
  return action === 'hide' ? Promise.race([msg, sleep(50)]) : Promise.resolve();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
