// Network tools: full request/response capture (headers, cookies, bodies, WebSocket frames),
// cookies, live interception (block / mock / modify via the CDP Fetch domain) and HAR export.

const LOG_LIMIT = 500; // requests kept per tab
const BODY_CACHE_BYTES = 30e6; // XHR/fetch bodies kept after load, all tabs together
const BODY_CACHE_MAX = 1e6; // largest single body cached automatically
const WS_FRAME_LIMIT = 200;

let cdp, resolveTab, ensureAttached;
let seq = 0;
let ruleSeq = 0;
let bodyBytes = 0;

const logs = new Map(); // tabId -> { entries: Map<id, entry>, byReq: Map<requestId, id> }
const pending = new Map(); // requestId -> extra info that arrived before requestWillBeSent
const rules = new Map(); // tabId -> rule[]

export function initNetwork(deps) {
  ({ cdp, resolveTab, ensureAttached } = deps);
}

// ---------- helpers ----------

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const textToB64 = (t) => bytesToB64(utf8.encode(t));

const isTextMime = (m = '') => /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|svg|csv/i.test(m);
const headerArray = (obj = {}) => Object.entries(obj).flatMap(([name, v]) => String(v).split('\n').map((value) => ({ name, value })));
const headerObject = (arr = []) => arr.reduce((o, { name, value }) => ((o[name] = o[name] != null ? `${o[name]}\n${value}` : value), o), {});
const getHeader = (h = {}, name) => Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

// Apply { name: value } edits case-insensitively; null/false removes the header.
function mergeHeaders(base = {}, edits = {}) {
  const out = { ...base };
  for (const [name, value] of Object.entries(edits)) {
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k];
    if (value != null && value !== false) out[name] = String(value);
  }
  return out;
}

// CDP URL patterns: * and ? wildcards. A pattern without wildcards matches as a substring.
const toGlob = (p) => (/[*?]/.test(p) ? p : `*${p}*`);
const globRe = (p) => new RegExp('^' + toGlob(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

function urlFilter(pattern) {
  if (!pattern) return () => true;
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    const re = new RegExp(m[1], m[2]);
    return (u) => re.test(u);
  }
  return (u) => u.includes(pattern);
}

const kb = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function tabLog(tabId) {
  let l = logs.get(tabId);
  if (!l) logs.set(tabId, (l = { entries: new Map(), byReq: new Map() }));
  return l;
}

function dropBody(e) {
  if (e?.body) bodyBytes -= e.body.size;
  if (e) delete e.body;
}

function addEntry(tabId, entry) {
  if (/^chrome-extension:/.test(entry.url)) return null; // other extensions' own files
  const l = tabLog(tabId);
  entry.id = ++seq;
  entry.tabId = tabId;
  l.entries.set(entry.id, entry);
  l.byReq.set(entry.requestId, entry.id);
  if (l.entries.size > LOG_LIMIT) {
    const [oldId, old] = l.entries.entries().next().value;
    dropBody(old);
    l.entries.delete(oldId);
    if (l.byReq.get(old.requestId) === oldId) l.byReq.delete(old.requestId);
  }
  const extra = pending.get(entry.requestId);
  if (extra) {
    Object.assign(entry, extra);
    pending.delete(entry.requestId);
  }
  return entry;
}

const entryFor = (tabId, requestId) => {
  const l = logs.get(tabId);
  const id = l?.byReq.get(requestId);
  return id != null ? l.entries.get(id) : null;
};

function findEntry(id) {
  const n = Number(String(id).replace(/^#/, ''));
  for (const l of logs.values()) if (l.entries.has(n)) return l.entries.get(n);
  throw new Error(`No captured request #${id}. Use read_network_requests to list them.`);
}

// Extra info events can arrive before or after requestWillBeSent / responseReceived.
function setExtra(tabId, requestId, fields, done) {
  const e = entryFor(tabId, requestId);
  if (e && !done(e)) Object.assign(e, fields);
  else if (!e) pending.set(requestId, { ...pending.get(requestId), ...fields });
  if (pending.size > 1000) pending.delete(pending.keys().next().value);
}

async function cacheBody(e) {
  if (e.body || !e.finished || e.size > BODY_CACHE_MAX) return;
  try {
    const r = await cdp(e.tabId, 'Network.getResponseBody', { requestId: e.requestId });
    const size = r.base64Encoded ? Math.floor(r.body.length * 0.75) : r.body.length;
    e.body = { data: r.body, base64: r.base64Encoded, size };
    bodyBytes += size;
    // Evict the oldest cached bodies across all tabs.
    for (const l of logs.values()) {
      for (const old of l.entries.values()) {
        if (bodyBytes <= BODY_CACHE_BYTES) return;
        if (old !== e) dropBody(old);
      }
    }
  } catch {}
}

async function getBody(e) {
  if (e.body) return e.body;
  if (e.type === 'WebSocket') return null;
  const r = await cdp(e.tabId, 'Network.getResponseBody', { requestId: e.requestId });
  return { data: r.body, base64: r.base64Encoded, size: r.base64Encoded ? Math.floor(r.body.length * 0.75) : r.body.length };
}

async function getPostData(e) {
  if (e.postData != null || !e.hasPostData) return e.postData ?? null;
  try {
    e.postData = (await cdp(e.tabId, 'Network.getRequestPostData', { requestId: e.requestId })).postData;
  } catch {}
  return e.postData ?? null;
}

const bodyText = (b) => (b.base64 ? fromUtf8.decode(b64ToBytes(b.data)) : b.data);

// ---------- capture ----------

export function onNetworkAttach(tabId) {
  if (rules.get(tabId)?.length) syncFetch(tabId).catch(() => {});
}

export function onNetworkTabRemoved(tabId) {
  for (const e of logs.get(tabId)?.entries.values() || []) dropBody(e);
  logs.delete(tabId);
  rules.delete(tabId);
}

export function onNetworkEvent(tabId, method, p) {
  switch (method) {
    case 'Network.requestWillBeSent': {
      const prev = entryFor(tabId, p.requestId);
      if (p.redirectResponse && prev) {
        Object.assign(prev, {
          status: p.redirectResponse.status, statusText: p.redirectResponse.statusText,
          resHeaders: p.redirectResponse.headers, redirectedTo: p.request.url, finished: true,
          duration: Math.round((p.timestamp - prev.start) * 1000),
        });
      }
      addEntry(tabId, {
        requestId: p.requestId, url: p.request.url + (p.request.urlFragment || ''), method: p.request.method,
        type: p.type, reqHeaders: p.request.headers, postData: p.request.postData, hasPostData: p.request.hasPostData,
        initiator: p.initiator?.type, documentURL: p.documentURL, wallTime: p.wallTime * 1000, start: p.timestamp,
        redirectedFrom: p.redirectResponse && prev ? prev.id : undefined,
      });
      break;
    }
    case 'Network.requestWillBeSentExtraInfo':
      // The headers actually sent, including Cookie, which requestWillBeSent leaves out.
      setExtra(tabId, p.requestId, {
        rawReqHeaders: p.headers,
        blockedCookies: p.associatedCookies?.filter((c) => c.blockedReasons?.length).map((c) => `${c.cookie.name} (${c.blockedReasons.join(', ')})`),
      }, (e) => e.rawReqHeaders);
      break;
    case 'Network.responseReceived': {
      const e = entryFor(tabId, p.requestId);
      if (!e) break;
      const r = p.response;
      Object.assign(e, {
        status: r.status, statusText: r.statusText, mimeType: r.mimeType, resHeaders: r.headers, protocol: r.protocol,
        remote: r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : undefined,
        cache: r.fromDiskCache ? 'disk cache' : r.fromServiceWorker ? 'service worker' : r.fromPrefetchCache ? 'prefetch cache' : undefined,
      });
      break;
    }
    case 'Network.responseReceivedExtraInfo':
      // Raw response headers, including Set-Cookie.
      setExtra(tabId, p.requestId, { rawResHeaders: p.headers }, (e) => e.rawResHeaders);
      break;
    case 'Network.loadingFinished': {
      const e = entryFor(tabId, p.requestId);
      if (!e) break;
      Object.assign(e, { finished: true, size: p.encodedDataLength, duration: Math.round((p.timestamp - e.start) * 1000) });
      if (e.type === 'XHR' || e.type === 'Fetch') cacheBody(e);
      break;
    }
    case 'Network.loadingFailed': {
      const e = entryFor(tabId, p.requestId);
      if (e) Object.assign(e, { finished: true, failed: p.blockedReason ? `${p.errorText} (${p.blockedReason})` : p.errorText, duration: Math.round((p.timestamp - e.start) * 1000) });
      break;
    }
    case 'Network.webSocketCreated':
      addEntry(tabId, { requestId: p.requestId, url: p.url, method: 'GET', type: 'WebSocket', initiator: p.initiator?.type, wallTime: Date.now(), frames: [] });
      break;
    case 'Network.webSocketHandshakeResponseReceived': {
      const e = entryFor(tabId, p.requestId);
      if (e) Object.assign(e, { status: p.response.status, statusText: p.response.statusText, resHeaders: p.response.headers, rawReqHeaders: p.response.requestHeaders });
      break;
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      const e = entryFor(tabId, p.requestId);
      if (!e?.frames) break;
      const text = p.response.opcode === 1 ? p.response.payloadData : `[binary ${Math.floor(p.response.payloadData.length * 0.75)} bytes]`;
      e.frames.push({ dir: method.endsWith('Sent') ? '→' : '←', ts: Date.now(), text: text.length > 4000 ? text.slice(0, 4000) + '…' : text });
      if (e.frames.length > WS_FRAME_LIMIT) e.frames.shift();
      break;
    }
    case 'Network.webSocketClosed': {
      const e = entryFor(tabId, p.requestId);
      if (e) e.finished = true;
      break;
    }
    case 'Fetch.requestPaused':
      onPaused(tabId, p);
      break;
  }
}

// ---------- read_network_requests ----------

function statusFilter(s) {
  if (s == null || s === '') return () => true;
  const str = String(s).toLowerCase();
  if (str === 'error' || str === 'failed') return (e) => e.failed || e.status >= 400;
  if (/^\dxx$/.test(str)) return (e) => String(e.status || '')[0] === str[0];
  return (e) => String(e.status) === str;
}

export async function read_network_requests({ tabId, urlPattern, type, method, status, limit = 100, clear = false }) {
  const id = await resolveTab(tabId);
  await ensureAttached(id); // capture starts on attach
  const matchUrl = urlFilter(urlPattern);
  const matchStatus = statusFilter(status);
  const types = type ? String(type).toLowerCase().split(/[,|]/) : null;
  let list = [...(logs.get(id)?.entries.values() || [])].filter((e) =>
    matchUrl(e.url) && matchStatus(e) &&
    (!types || types.includes(String(e.type).toLowerCase())) &&
    (!method || e.method.toLowerCase() === String(method).toLowerCase()));
  list = list.slice(-limit);
  if (clear) {
    for (const e of logs.get(id)?.entries.values() || []) dropBody(e);
    logs.delete(id);
  }
  if (!list.length) return 'No matching network requests captured (capture starts when AI in Chrome first attaches to the tab; reload the page to capture it from the start).';
  const lines = list.map((e) => {
    const st = e.failed ? `FAILED(${e.failed})` : e.status ?? (e.finished ? '-' : 'pending');
    const extra = [e.type, kb(e.size), e.duration != null ? `${e.duration}ms` : '', e.cache ? `(${e.cache})` : ''].filter(Boolean).join(' ');
    return `#${e.id} ${e.method} ${st} ${extra} ${e.url.length > 300 ? e.url.slice(0, 300) + '…' : e.url}`;
  });
  return `${lines.join('\n')}\n\nFull headers, cookies and body: network_request requestId=<#>  (CLI: aichrome request <#>)`;
}

// ---------- network_request ----------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const SKIP_HEADERS = /^(:|content-length$|host$|connection$)/i;

function sentHeaders(e) {
  return Object.fromEntries(Object.entries(e.rawReqHeaders || e.reqHeaders || {}).filter(([k]) => !SKIP_HEADERS.test(k)));
}

function toCurl(e, postData) {
  const parts = [`curl ${shq(e.url)}`];
  if (e.method !== 'GET' || postData != null) parts.push(`-X ${e.method}`);
  const h = sentHeaders(e);
  for (const [k, v] of Object.entries(h)) for (const line of String(v).split('\n')) parts.push(`-H ${shq(`${k}: ${line}`)}`);
  if (postData != null) parts.push(`--data-raw ${shq(postData)}`);
  if (getHeader(h, 'accept-encoding')) parts.push('--compressed');
  return parts.join(' \\\n  ');
}

function toFetch(e, postData) {
  const h = sentHeaders(e);
  const init = { method: e.method, headers: Object.fromEntries(Object.entries(h).filter(([k]) => !/^(cookie|accept-encoding|user-agent|referer|origin|sec-|priority$)/i.test(k))) };
  if (postData != null) init.body = postData;
  init.credentials = 'include';
  return `await fetch(${JSON.stringify(e.url)}, ${JSON.stringify(init, null, 2)});`;
}

function fmtHeaders(h) {
  const entries = Object.entries(h || {});
  if (!entries.length) return '  (none)';
  return entries.flatMap(([k, v]) => String(v).split('\n').map((line) => `  ${k}: ${line}`)).join('\n');
}

function prettyBody(text, mime, max) {
  let t = text;
  if (/json/i.test(mime) || /^\s*[[{]/.test(t)) {
    try {
      t = JSON.stringify(JSON.parse(t), null, 2);
    } catch {}
  }
  return t.length > max ? `${t.slice(0, max)}\n… [${t.length - max} more chars; raise maxBodyChars or use save_path]` : t;
}

function fileName(e, mime) {
  const base = (() => {
    try {
      return decodeURIComponent(new URL(e.url).pathname.split('/').pop());
    } catch {
      return '';
    }
  })();
  if (base && /\.[a-z0-9]{1,6}$/i.test(base)) return base;
  const ext = /json/.test(mime) ? 'json' : /html/.test(mime) ? 'html' : /javascript/.test(mime) ? 'js' : /css/.test(mime) ? 'css' : /png/.test(mime) ? 'png' : /jpeg/.test(mime) ? 'jpg' : /xml/.test(mime) ? 'xml' : 'bin';
  return `response-${e.id}.${ext}`;
}

export async function network_request({ requestId, includeBody = true, maxBodyChars = 20000, format = 'text', save_path }) {
  if (requestId == null) throw new Error('requestId is required (the #number from read_network_requests)');
  const e = findEntry(requestId);
  const postData = await getPostData(e);
  if (format === 'curl') return toCurl(e, postData);
  if (format === 'fetch') return toFetch(e, postData);

  let body = null;
  let bodyErr = null;
  if (includeBody || save_path) {
    try {
      body = await getBody(e);
    } catch (err) {
      bodyErr = /No resource|No data found/i.test(err.message) ? 'not available (evicted after navigation, or the request did not finish)' : err.message;
    }
  }
  const mime = e.mimeType || getHeader(e.resHeaders, 'content-type') || '';

  if (format === 'json') {
    return JSON.stringify({
      id: e.id, url: e.url, method: e.method, type: e.type, status: e.status, statusText: e.statusText, mimeType: mime,
      requestHeaders: e.rawReqHeaders || e.reqHeaders || {}, postData, responseHeaders: e.rawResHeaders || e.resHeaders || {},
      body: body ? (body.base64 && !isTextMime(mime) ? { base64: body.data } : bodyText(body)) : null, frames: e.frames,
    });
  }

  const out = [`#${e.id} ${e.method} ${e.url}`];
  const meta = [
    e.failed ? `FAILED: ${e.failed}` : e.status != null ? `${e.status} ${e.statusText || ''}`.trim() : 'pending',
    e.type, mime, kb(e.size), e.duration != null ? `${e.duration} ms` : '', e.protocol, e.remote, e.cache,
  ].filter(Boolean);
  out.push(`Status: ${meta.join(' · ')}`);
  if (e.initiator || e.documentURL) out.push(`Initiator: ${e.initiator || '?'}  Page: ${e.documentURL || ''}`);
  if (e.redirectedFrom) out.push(`Redirected from #${e.redirectedFrom}`);
  if (e.redirectedTo) out.push(`Redirects to: ${e.redirectedTo}`);
  out.push('', `Request headers${e.rawReqHeaders ? '' : ' (provisional; cookies may be missing)'}:`, fmtHeaders(e.rawReqHeaders || e.reqHeaders));
  if (e.blockedCookies?.length) out.push(`Cookies not sent: ${e.blockedCookies.join(', ')}`);
  if (postData != null) out.push('', `Request body${getHeader(e.reqHeaders, 'content-type') ? ` (${getHeader(e.reqHeaders, 'content-type')})` : ''}:`, prettyBody(postData, getHeader(e.reqHeaders, 'content-type') || '', maxBodyChars));
  if (e.resHeaders || e.rawResHeaders) out.push('', 'Response headers:', fmtHeaders(e.rawResHeaders || e.resHeaders));
  if (e.frames) {
    out.push('', `WebSocket frames (${e.frames.length}, newest last):`);
    for (const f of e.frames.slice(-50)) out.push(`  ${f.dir} ${f.text.length > 500 ? f.text.slice(0, 500) + '…' : f.text}`);
  }

  let file;
  if (body) {
    if (save_path) {
      file = { name: fileName(e, mime), data: body.base64 ? body.data : textToB64(body.data) };
      out.push('', `Response body: ${kb(body.size)}, saving to file.`);
    } else if (includeBody) {
      if (body.base64 && !isTextMime(mime)) out.push('', `Response body: [binary, ${kb(body.size)}; use save_path to save it]`);
      else out.push('', `Response body (${mime || 'unknown type'}):`, prettyBody(bodyText(body), mime, maxBodyChars));
    }
  } else if (bodyErr && includeBody && e.type !== 'WebSocket') out.push('', `Response body: ${bodyErr}`);
  return file ? { text: out.join('\n'), file } : out.join('\n');
}

// ---------- __http: send a request from the page or the extension ----------

// Runs a fetch and returns { status, statusText, url, redirected, headers, body | bodyBase64, ms }.
async function doFetch({ url, method = 'GET', headers = {}, body, credentials = 'include', redirect = 'follow' }) {
  const t0 = performance.now();
  const res = await fetch(url, { method, headers, body: body ?? undefined, credentials, redirect });
  const buf = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  const out = { status: res.status, statusText: res.statusText, url: res.url, redirected: res.redirected, headers: Object.fromEntries(res.headers), ms: Math.round(performance.now() - t0) };
  if (/^text\/|json|xml|javascript|x-www-form-urlencoded|graphql|svg|csv/i.test(type) || !buf.length) out.body = new TextDecoder().decode(buf);
  else {
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    out.bodyBase64 = btoa(s);
  }
  return out;
}

export async function __http({ tabId, via = 'page', ...req }) {
  if (via === 'extension') return JSON.stringify(await doFetch(req));
  const id = await resolveTab(tabId);
  const r = await cdp(id, 'Runtime.evaluate', {
    expression: `(${doFetch.toString()})(${JSON.stringify(req)}).then(JSON.stringify)`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(`fetch failed in page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text} (try via=node)`);
  return r.result.value;
}

export async function __tab_url({ tabId }) {
  const id = await resolveTab(tabId);
  return (await chrome.tabs.get(id)).url || '';
}

// ---------- cookies ----------

function fmtCookie(c) {
  const flags = [c.domain, c.path, c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite && `SameSite=${c.sameSite}`,
    c.partitionKey && 'Partitioned', c.session || c.expires < 0 ? 'session' : `expires ${new Date(c.expires * 1000).toISOString()}`].filter(Boolean);
  return `${c.name}=${c.value}\n    ${flags.join(' · ')}`;
}

export async function cookies({ tabId, action = 'get', url, domain, name, value, path = '/', secure, httpOnly, sameSite, expires, format = 'text' }) {
  const id = await resolveTab(tabId);
  if (action === 'get') {
    let list;
    if (domain) {
      const d = String(domain).replace(/^\./, '');
      const all = await cdp(id, 'Storage.getCookies', {}).catch(() => cdp(id, 'Network.getAllCookies', {}));
      list = all.cookies.filter((c) => c.domain.replace(/^\./, '') === d || c.domain.endsWith('.' + d));
    } else {
      list = (await cdp(id, 'Network.getCookies', url ? { urls: [url] } : {})).cookies;
    }
    if (name) list = list.filter((c) => c.name === name);
    if (format === 'header') return list.map((c) => `${c.name}=${c.value}`).join('; ');
    if (format === 'json') return JSON.stringify(list);
    if (!list.length) return `No cookies for ${domain || url || 'this page'}.`;
    return `${list.length} cookie(s) for ${domain || url || (await chrome.tabs.get(id)).url}:\n${list.map(fmtCookie).join('\n')}`;
  }
  if (!name) throw new Error('name is required');
  const target = url ? { url } : domain ? { domain } : { url: (await chrome.tabs.get(id)).url };
  if (action === 'set') {
    const r = await cdp(id, 'Network.setCookie', {
      name, value: String(value ?? ''), path, ...target,
      ...(secure != null && { secure }), ...(httpOnly != null && { httpOnly }), ...(sameSite && { sameSite }),
      ...(expires != null && { expires: typeof expires === 'number' ? expires : Date.parse(expires) / 1000 }),
    });
    if (r.success === false) throw new Error('Chrome rejected the cookie (check domain/secure/sameSite)');
    return `Set cookie ${name} for ${target.url || target.domain}`;
  }
  if (action === 'delete') {
    await cdp(id, 'Network.deleteCookies', { name, ...target, ...(url || domain ? {} : { path }) });
    return `Deleted cookie ${name} for ${target.url || target.domain}`;
  }
  throw new Error('action must be get, set or delete');
}

// ---------- network_intercept ----------

const needsResponse = (r) => r.type === 'modify' && (r.status != null || r.responseHeaders || r.body != null || r.replace);
const needsRequest = (r) => r.type !== 'modify' || r.url || r.method || r.headers || r.postData != null || r.delayMs;

async function syncFetch(tabId) {
  const list = rules.get(tabId) || [];
  if (!list.length) return cdp(tabId, 'Fetch.disable', {}).catch(() => {});
  const patterns = [];
  for (const r of list) {
    const base = { urlPattern: toGlob(r.pattern), ...(r.resourceType && { resourceType: r.resourceType }) };
    if (needsRequest(r)) patterns.push({ ...base, requestStage: 'Request' });
    if (needsResponse(r)) patterns.push({ ...base, requestStage: 'Response' });
  }
  return cdp(tabId, 'Fetch.enable', { patterns });
}

function ruleMatches(r, p, responseStage) {
  if (responseStage ? !needsResponse(r) : !needsRequest(r)) return false;
  if (r.onlyMethod && r.onlyMethod.toUpperCase() !== p.request.method) return false;
  if (r.resourceType && r.resourceType !== p.resourceType) return false;
  return (r.re ||= globRe(r.pattern)).test(p.request.url);
}

function guessType(body) {
  return /^\s*[[{]/.test(body) ? 'application/json; charset=utf-8' : /^\s*</.test(body) ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
}

function applyReplace(text, replace) {
  for (const [find, repl] of replace) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(find);
    text = m ? text.replace(new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g'), repl) : text.split(find).join(repl);
  }
  return text;
}

async function onPaused(tabId, p) {
  const responseStage = p.responseStatusCode != null || p.responseErrorReason != null;
  const send = (m, params) => chrome.debugger.sendCommand({ tabId }, m, { requestId: p.requestId, ...params });
  const rule = (rules.get(tabId) || []).find((r) => ruleMatches(r, p, responseStage));
  try {
    if (!rule) return await send('Fetch.continueRequest', {});
    rule.hits = (rule.hits || 0) + 1;
    if (rule.times && rule.hits >= rule.times) {
      rules.set(tabId, rules.get(tabId).filter((x) => x !== rule));
      syncFetch(tabId).catch(() => {});
    }
    if (!responseStage && rule.delayMs) await new Promise((r) => setTimeout(r, Math.min(Number(rule.delayMs), 60000)));

    if (!responseStage && rule.type === 'block') return await send('Fetch.failRequest', { errorReason: rule.errorReason || 'BlockedByClient' });

    if (!responseStage && rule.type === 'mock') {
      const body = typeof rule.body === 'string' ? rule.body : rule.body == null ? '' : JSON.stringify(rule.body);
      const origin = getHeader(p.request.headers, 'origin');
      const cors = origin ? {
        'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true',
        'access-control-allow-methods': '*', 'access-control-allow-headers': getHeader(p.request.headers, 'access-control-request-headers') || '*',
      } : {};
      const headers = mergeHeaders({ 'content-type': guessType(body), ...cors }, rule.responseHeaders);
      const status = p.request.method === 'OPTIONS' && origin ? 204 : Number(rule.status) || 200;
      return await send('Fetch.fulfillRequest', { responseCode: status, responseHeaders: headerArray(headers), body: status === 204 ? '' : textToB64(body) });
    }

    if (!responseStage) {
      const params = {};
      if (rule.url) params.url = rule.url;
      if (rule.method) params.method = rule.method;
      if (rule.postData != null) params.postData = textToB64(typeof rule.postData === 'string' ? rule.postData : JSON.stringify(rule.postData));
      if (rule.headers) params.headers = headerArray(mergeHeaders(p.request.headers, rule.headers));
      return await send('Fetch.continueRequest', params);
    }

    // Response stage: rewrite status, headers and/or body before the page sees it.
    let headers = mergeHeaders(headerObject(p.responseHeaders), { 'content-length': null, 'content-encoding': null });
    headers = mergeHeaders(headers, rule.responseHeaders || {});
    let bodyB64;
    if (rule.body != null) bodyB64 = textToB64(typeof rule.body === 'string' ? rule.body : JSON.stringify(rule.body));
    else {
      const r = await send('Fetch.getResponseBody', {});
      bodyB64 = r.base64Encoded ? r.body : textToB64(r.body);
      if (rule.replace) bodyB64 = textToB64(applyReplace(fromUtf8.decode(b64ToBytes(bodyB64)), rule.replace));
    }
    return await send('Fetch.fulfillRequest', { responseCode: Number(rule.status) || p.responseStatusCode, responseHeaders: headerArray(headers), body: bodyB64 });
  } catch (err) {
    console.warn('[aichrome] intercept', err);
    send('Fetch.continueRequest', {}).catch(() => {});
  }
}

function describeRule(r) {
  const what = [];
  if (r.type === 'block') what.push(`block${r.errorReason ? ` (${r.errorReason})` : ''}`);
  if (r.type === 'mock') what.push(`mock ${r.status || 200}${r.body != null ? ` body=${JSON.stringify(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 80)}` : ''}`);
  if (r.type === 'modify') {
    if (r.url) what.push(`url→${r.url}`);
    if (r.method) what.push(`method→${r.method}`);
    if (r.headers) what.push(`headers ${JSON.stringify(r.headers)}`);
    if (r.postData != null) what.push('postData replaced');
    if (r.status != null) what.push(`status→${r.status}`);
    if (r.responseHeaders) what.push(`responseHeaders ${JSON.stringify(r.responseHeaders)}`);
    if (r.body != null) what.push('response body replaced');
    if (r.replace) what.push(`replace ${JSON.stringify(r.replace)}`);
  }
  if (r.delayMs) what.push(`delay ${r.delayMs}ms`);
  const filt = [r.onlyMethod, r.resourceType].filter(Boolean).join(' ');
  return `${r.id} ${toGlob(r.pattern)}${filt ? ` [${filt}]` : ''} → ${what.join(', ') || 'pass'}  hits=${r.hits || 0}${r.times ? `/${r.times}` : ''}`;
}

export async function network_intercept({ tabId, action = 'list', ruleId, pattern, type = 'modify', ...rest }) {
  const id = await resolveTab(tabId);
  const list = rules.get(id) || [];
  if (action === 'list') return list.length ? `Intercept rules for tab ${id} (first match wins):\n${list.map(describeRule).join('\n')}` : `No intercept rules on tab ${id}.`;
  if (action === 'clear') {
    rules.delete(id);
    await syncFetch(id);
    return `Cleared ${list.length} intercept rule(s) on tab ${id}.`;
  }
  if (action === 'remove') {
    if (!ruleId) throw new Error('ruleId is required');
    const next = list.filter((r) => r.id !== ruleId);
    if (next.length === list.length) throw new Error(`No rule ${ruleId}. Rules: ${list.map((r) => r.id).join(', ') || 'none'}`);
    rules.set(id, next);
    await syncFetch(id);
    return `Removed ${ruleId}.`;
  }
  if (action !== 'add') throw new Error('action must be add, list, remove or clear');
  if (!pattern) throw new Error('pattern is required, e.g. "*api/user*" (no wildcard = substring match)');
  if (!['block', 'mock', 'modify'].includes(type)) throw new Error('type must be block, mock or modify');
  const keys = ['onlyMethod', 'resourceType', 'errorReason', 'url', 'method', 'headers', 'postData', 'status', 'responseHeaders', 'body', 'replace', 'delayMs', 'times'];
  const rule = { id: `r${++ruleSeq}`, pattern, type };
  for (const k of keys) if (rest[k] != null) rule[k] = rest[k];
  if (rule.replace && !Array.isArray(rule.replace[0])) rule.replace = [rule.replace];
  if (rule.type === 'modify' && !needsRequest(rule) && !needsResponse(rule)) throw new Error('modify needs at least one of: url, method, headers, postData, status, responseHeaders, body, replace, delayMs');
  rules.set(id, [...list, rule]);
  await syncFetch(id);
  return `Added ${describeRule(rule)}\nActive on tab ${id} until removed. Reload the page if the request already happened.`;
}

// ---------- network_export (HAR) ----------

export async function network_export({ tabId, urlPattern, includeBodies = true }) {
  const id = await resolveTab(tabId);
  const match = urlFilter(urlPattern);
  const list = [...(logs.get(id)?.entries.values() || [])].filter((e) => match(e.url) && e.type !== 'WebSocket');
  if (!list.length) throw new Error('No captured requests to export.');
  const pairs = (h) => headerArray(h || {});
  const entries = [];
  for (const e of list) {
    const mime = e.mimeType || getHeader(e.resHeaders, 'content-type') || '';
    const content = { size: e.size ?? -1, mimeType: mime };
    if (includeBodies && e.finished && !e.failed) {
      try {
        const b = await getBody(e);
        if (b) {
          if (b.base64 && !isTextMime(mime)) Object.assign(content, { text: b.data, encoding: 'base64' });
          else content.text = bodyText(b);
        }
      } catch {}
    }
    const postData = await getPostData(e);
    let query = [];
    try {
      query = [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value }));
    } catch {}
    entries.push({
      startedDateTime: new Date(e.wallTime || Date.now()).toISOString(),
      time: e.duration ?? 0,
      request: {
        method: e.method, url: e.url, httpVersion: e.protocol || 'HTTP/1.1', headers: pairs(e.rawReqHeaders || e.reqHeaders),
        queryString: query, cookies: [], headersSize: -1, bodySize: postData?.length ?? 0,
        ...(postData != null && { postData: { mimeType: getHeader(e.reqHeaders, 'content-type') || '', text: postData } }),
      },
      response: {
        status: e.status ?? 0, statusText: e.statusText || e.failed || '', httpVersion: e.protocol || 'HTTP/1.1',
        headers: pairs(e.rawResHeaders || e.resHeaders), cookies: [], content, redirectURL: e.redirectedTo || '', headersSize: -1, bodySize: e.size ?? -1,
      },
      cache: {}, timings: { send: 0, wait: e.duration ?? 0, receive: 0 }, _resourceType: e.type,
    });
  }
  const har = { log: { version: '1.2', creator: { name: 'AI in Chrome', version: chrome.runtime.getManifest().version }, pages: [], entries } };
  const host = (() => {
    try {
      return new URL((list.find((e) => e.type === 'Document') || list[0]).url).hostname;
    } catch {
      return 'network';
    }
  })();
  return {
    text: `HAR with ${entries.length} request(s). It contains cookies and auth headers; treat the file like a password.`,
    file: { name: `${host}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.har`, data: textToB64(JSON.stringify(har, null, 2)) },
  };
}
