// http_request: send an HTTP request with the browser's identity: from inside the page (same cookies,
// same origin), from the extension (no CORS), or from Node here (any header, browser cookies attached).
import { saveFile } from './files.js';

const PSEUDO = /^:/;
// Headers Node's fetch manages itself or rejects.
const NODE_SKIP = /^(:|host$|connection$|content-length$|keep-alive$|transfer-encoding$|upgrade$|te$|expect$|trailer$|accept-encoding$)/i;
const TEXT = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|svg|csv/i;

function mergeHeaders(base = {}, edits = {}) {
  const out = { ...base };
  for (const [name, value] of Object.entries(edits || {})) {
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k];
    if (value != null && value !== false) out[name] = String(value);
  }
  return out;
}
const getHeader = (h, name) => Object.entries(h || {}).find(([k]) => k.toLowerCase() === name)?.[1];
const strip = (h, re) => Object.fromEntries(Object.entries(h).filter(([k]) => !re.test(k)));

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function nodeFetch({ url, method, headers, body, redirect }) {
  const t0 = performance.now();
  // Chrome joins repeated headers with \n; HTTP wants them comma-joined.
  const flat = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v).split('\n').join(k.toLowerCase() === 'cookie' ? '; ' : ', ')]));
  const res = await fetch(url, { method, headers: { 'accept-encoding': 'gzip, deflate, br', ...flat }, body, redirect });
  const buf = Buffer.from(await res.arrayBuffer());
  const hdrs = {};
  for (const [k, v] of res.headers) hdrs[k] = hdrs[k] ? `${hdrs[k]}\n${v}` : v;
  const setCookie = res.headers.getSetCookie?.();
  if (setCookie?.length) hdrs['set-cookie'] = setCookie.join('\n');
  const out = { status: res.status, statusText: res.statusText, url: res.url, redirected: res.redirected, headers: hdrs, ms: Math.round(performance.now() - t0) };
  if (TEXT.test(res.headers.get('content-type') || '') || !buf.length) out.body = buf.toString('utf8');
  else out.bodyBase64 = buf.toString('base64');
  return out;
}

function pretty(text, type, max) {
  let t = text;
  if (/json/i.test(type) || /^\s*[[{]/.test(t)) {
    try {
      t = JSON.stringify(JSON.parse(t), null, 2);
    } catch {}
  }
  return t.length > max ? `${t.slice(0, max)}\n… [${t.length - max} more chars; raise maxBodyChars or use save_path]` : t;
}

export async function httpRequest(args, send) {
  const { tabId, from, via = 'auto', cookies = true, follow = true, maxBodyChars = 20000, save_path, format = 'text' } = args;
  let base = {};
  if (from != null) {
    const raw = JSON.parse((await send('network_request', { requestId: from, format: 'json', includeBody: false })).text);
    base = { url: raw.url, method: raw.method, headers: raw.requestHeaders, body: raw.postData };
  }
  const url = args.url ?? base.url;
  if (!url) throw new Error('url is required (or from=<request #> to replay a captured request)');
  let body = args.body !== undefined ? args.body : base.body;
  let headers = mergeHeaders(strip(base.headers || {}, PSEUDO), args.headers);
  if (body != null && typeof body !== 'string') body = JSON.stringify(body);
  if (body != null && args.body !== undefined && /^\s*[[{]/.test(body) && !getHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
  const method = (args.method ?? base.method ?? (body != null ? 'POST' : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD') body = undefined;

  let mode = via;
  if (mode === 'auto') mode = sameOrigin((await send('__tab_url', { tabId })).text, url) ? 'page' : 'node';
  const redirect = follow ? 'follow' : 'manual';

  let res;
  let note = '';
  if (mode === 'node') {
    headers = strip(headers, NODE_SKIP);
    if (cookies && !getHeader(headers, 'cookie')) {
      const jar = (await send('cookies', { tabId, action: 'get', url, format: 'header' })).text;
      if (jar) {
        headers.cookie = jar;
        note = ' (browser cookies attached)';
      }
    } else if (getHeader(headers, 'cookie')) note = ' (cookie header sent as given)';
    res = await nodeFetch({ url, method, headers, body, redirect });
  } else if (mode === 'page' || mode === 'extension') {
    // The browser adds cookies itself (credentials: include) and drops headers it forbids (Cookie, Origin, Sec-*, …).
    headers = strip(headers, /^(:|cookie$|host$|content-length$|connection$|accept-encoding$)/i);
    res = JSON.parse((await send('__http', { tabId, via: mode, url, method, headers, body, redirect })).text);
    note = mode === 'page' ? ' (inside the page: its cookies, origin and CSRF context)' : ' (from the extension: no CORS, browser cookies)';
  } else throw new Error('via must be auto, page, extension or node');

  if (format === 'json') return { text: JSON.stringify({ request: { url, method, headers, body }, via: mode, response: res }, null, 2) };

  const type = getHeader(res.headers, 'content-type') || '';
  const out = [
    `HTTP ${res.status} ${res.statusText || ''}`.trim() + ` · ${res.ms} ms · via ${mode}${note}`,
    `${method} ${url}${res.redirected ? `\nFinal URL: ${res.url}` : ''}`,
    '',
    'Response headers:',
    ...Object.entries(res.headers).flatMap(([k, v]) => String(v).split('\n').map((line) => `  ${k}: ${line}`)),
  ];
  if (save_path) {
    const name = (() => {
      try {
        return new URL(res.url || url).pathname.split('/').pop() || 'response';
      } catch {
        return 'response';
      }
    })();
    const data = res.bodyBase64 ?? Buffer.from(res.body ?? '', 'utf8').toString('base64');
    out.push('', `Body saved to ${saveFile({ name, data }, save_path)}`);
  } else if (res.bodyBase64) out.push('', `Body: [binary, ${Math.floor(res.bodyBase64.length * 0.75)} bytes; use save_path to save it]`);
  else out.push('', `Body (${type || 'unknown type'}):`, res.body ? pretty(res.body, type, maxBodyChars) : '(empty)');
  return { text: out.join('\n') };
}
