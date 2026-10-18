#!/usr/bin/env node
// aichrome: drive Chrome from the terminal, or serve it to any AI over MCP.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOST_NAME, HOME, CLI, ROOT, EXTENSION_DIR, nativeHostDirs } from '../src/paths.js';
import { TOOLS } from '../src/tools.js';

const HELP = `aichrome: control Chrome from your terminal (AI in Chrome)

Setup
  aichrome install               register the native host with Chrome (run once)
  aichrome status                check the connection to Chrome
  aichrome mcp                   run as an MCP server (stdio) for any AI client
  aichrome install-skill [dir]   install the AI usage guide as a skill (default ~/.claude/skills)

Shortcuts
  aichrome tabs                  list tabs                        (tabs_context)
  aichrome open <url>            open a new tab in the AI group (tabs_create)
  aichrome select <tabId>        make a tab current               (tabs_select)
  aichrome go <url|back|forward|reload>                           (navigate)
  aichrome shot [-o file.jpg]    screenshot                       (computer screenshot)
  aichrome read [interactive]    accessibility tree with refs     (read_page)
  aichrome find <words>          find elements                    (find)
  aichrome text                  page text                        (get_page_text)
  aichrome click <ref_N | x y>   left click                       (computer left_click)
  aichrome type <text>           type text into focused element   (computer type)
  aichrome key <keys>            e.g. Enter, cmd+a, "Tab Tab Enter" (computer key)
  aichrome scroll [up|down|left|right] [ticks]
  aichrome fill <ref_N> <value>  set a form field                 (form_input)
  aichrome js <code>             evaluate JavaScript              (javascript_tool)
  aichrome console               captured console logs and errors
  aichrome upload <ref> <file>…  put local files into a file input (file_upload)
  aichrome upload-image <shot_N|file> <ref>   image into a file input or drop zone (upload_image)
  aichrome record start|stop|clear            GIF recording (gif_creator)
  aichrome record export [-o file.gif]        save the GIF (default ~/Downloads)
  aichrome reload-extension      reload the extension after code changes

Network (developer / debugging)
  aichrome network [filter]      captured requests with #ids        (read_network_requests)
  aichrome request <#>           full headers, cookies, tokens, bodies (network_request)
  aichrome curl <#>              the request as a curl command
  aichrome replay <#> [key=value]   send it again, optionally edited (http_request from=#)
  aichrome http [METHOD] <url> [body] [-H "Name: value"]   send as the logged-in user (http_request)
  aichrome cookies [domain|url]  cookies incl. HttpOnly             (cookies)
  aichrome storage               localStorage + sessionStorage of the page
  aichrome intercept add <pattern> block|mock|modify [key=value…]   (network_intercept)
  aichrome intercept list | remove <rN> | clear
  aichrome har [-o file.har]     export captured traffic as HAR     (network_export)

Fast mode (one process, no startup cost per command)
  aichrome run "click ref_3; type hello; key Enter"
  aichrome shell                 interactive prompt; also reads commands from a pipe

Any tool, with raw arguments
  aichrome <tool> key=value ...  values are parsed as JSON when possible
  aichrome <tool> --json '{"action":"left_click","coordinate":[100,200]}'
  aichrome tools                 list tools and their arguments

Global options
  --tab <id>                   target a specific tab
  -o <file>                    where to save images, GIFs, HAR files and response bodies
  -H "Name: value"             add a request header (http, replay, intercept)
`;

function parseValue(v) {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// Turn shortcut commands into [tool, args].
function resolveCommand(cmd, pos) {
  const rest = pos.join(' ');
  switch (cmd) {
    case 'tabs': return ['tabs_context', {}];
    case 'open': return ['tabs_create', pos[0] ? { url: pos[0] } : {}];
    case 'select': return ['tabs_select', { tabId: Number(pos[0]) }];
    case 'close': return ['tabs_close', { tabId: Number(pos[0]) }];
    case 'go': return ['navigate', { url: pos[0] }];
    case 'shot':
    case 'screenshot': return ['computer', { action: 'screenshot' }];
    case 'read': return ['read_page', pos[0] ? { filter: pos[0] } : {}];
    case 'find': return ['find', { query: rest }];
    case 'text': return ['get_page_text', {}];
    case 'click':
    case 'right_click':
    case 'double_click':
    case 'hover': {
      const action = cmd === 'click' ? 'left_click' : cmd;
      if (pos.length >= 2) return ['computer', { action, coordinate: [Number(pos[0]), Number(pos[1])] }];
      return ['computer', { action, ref: pos[0] }];
    }
    case 'type': return ['computer', { action: 'type', text: rest }];
    case 'key': return ['computer', { action: 'key', text: rest }];
    case 'scroll': return ['computer', { action: 'scroll', scroll_direction: pos[0] || 'down', scroll_amount: Number(pos[1]) || 3 }];
    case 'wait': return ['computer', { action: 'wait', duration: Number(pos[0]) || 1 }];
    case 'fill': return ['form_input', { ref: pos[0], value: pos.slice(1).join(' ') }];
    case 'js': return ['javascript_tool', { text: rest }];
    case 'console': return ['read_console_messages', {}];
    case 'network': return ['read_network_requests', pos[0] ? { urlPattern: pos[0] } : {}];
    case 'request': return ['network_request', { requestId: pos[0] }];
    case 'curl': return ['network_request', { requestId: pos[0], format: 'curl' }];
    case 'replay': return ['http_request', { from: pos[0] }];
    case 'http': {
      const method = /^[A-Z]+$/.test(pos[0]) ? pos.shift() : undefined;
      const args = { url: pos[0] };
      if (method) args.method = method;
      if (pos.length > 1) args.body = pos.slice(1).join(' ');
      return ['http_request', args];
    }
    case 'cookies':
      if (!pos[0]) return ['cookies', {}];
      return ['cookies', /^https?:/.test(pos[0]) ? { url: pos[0] } : { domain: pos[0] }];
    case 'storage':
      return ['javascript_tool', { text: 'JSON.stringify({ localStorage: { ...localStorage }, sessionStorage: { ...sessionStorage } }, null, 2)' }];
    case 'intercept':
      if (pos[0] === 'add') return ['network_intercept', { action: 'add', pattern: pos[1], type: pos[2] || 'modify' }];
      if (pos[0] === 'remove') return ['network_intercept', { action: 'remove', ruleId: pos[1] }];
      return ['network_intercept', { action: pos[0] || 'list' }];
    case 'har': return ['network_export', {}];
    case 'reload-extension': return ['extension_reload', {}];
    case 'upload': return ['file_upload', { ref: pos[0], paths: pos.slice(1) }];
    case 'upload-image': return ['upload_image', /^shot_\d+$/.test(pos[0]) ? { imageId: pos[0], ref: pos[1] } : { path: pos[0], ref: pos[1] }];
    case 'record': {
      const map = { start: 'start_recording', stop: 'stop_recording', export: 'export', clear: 'clear' };
      return ['gif_creator', { action: map[pos[0]] || pos[0] }];
    }
    default: return [cmd, null];
  }
}

// Prefer a stable node path over a versioned Homebrew Cellar path that breaks on upgrade.
function stableNode() {
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    if (process.execPath.includes('/Cellar/') && fs.existsSync(p)) return p;
  }
  return process.execPath;
}

function install() {
  const node = stableNode();
  const extId = fs.readFileSync(path.join(EXTENSION_DIR, 'EXTENSION_ID'), 'utf8').trim();
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  // Chrome launches this wrapper; it pins the node binary used at install time.
  const wrapper = path.join(HOME, 'native-host.sh');
  // Chrome starts native hosts with a minimal PATH; keep the user's so the side panel can find `claude` / `codex`.
  const pathLine = `export PATH=${JSON.stringify(process.env.PATH || '/usr/bin:/bin')}`;
  fs.writeFileSync(wrapper, `#!/bin/sh\n# AI in Chrome native host (generated by aichrome install)\n${pathLine}\nexec "${node}" "${CLI}" host "$@"\n`, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);

  const manifest = {
    name: HOST_NAME,
    description: 'AI in Chrome native host',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`],
  };
  const written = [];
  for (const { browser, dir } of nativeHostDirs()) {
    if (!fs.existsSync(path.dirname(dir))) continue; // browser not installed
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + '\n');
    written.push(browser);
  }
  console.log(`Native host registered for: ${written.join(', ') || '(no Chromium browsers found)'}`);
  console.log(`Extension ID: ${extId}`);
  console.log(`\nNext:\n  1. chrome://extensions → enable Developer mode → Load unpacked → ${EXTENSION_DIR}`);
  console.log(`  2. aichrome status`);
  console.log(`  3. (optional) claude mcp add --scope user ai-in-chrome -- "${node}" "${CLI}" mcp`);
  console.log(`  4. (optional) aichrome install-skill   # AI usage guide as a Claude Code skill`);
}

// Copy the AI usage guide (SKILL.md) into a skills folder, e.g. Claude Code's ~/.claude/skills.
function installSkill(dir) {
  const src = path.join(ROOT, 'skills', 'ai-in-chrome', 'SKILL.md');
  const base = dir ? path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), '.claude', 'skills');
  const dest = path.join(base, 'ai-in-chrome', 'SKILL.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Installed skill: ${dest}`);
}

function printTools() {
  for (const t of TOOLS) {
    const props = Object.entries(t.inputSchema.properties || {})
      .map(([k, v]) => `${k}${(t.inputSchema.required || []).includes(k) ? '' : '?'}${v.enum ? '=' + v.enum.join('|') : ''}`)
      .join(' ');
    console.log(`${t.name}  ${props}\n    ${t.description}\n`);
  }
}

// Shell-like split: respects "double" and 'single' quotes.
function splitArgs(line) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}

// Split "a; b; c" on semicolons outside quotes.
function splitCommands(script) {
  const cmds = [];
  let cur = '';
  let quote = null;
  for (const ch of script) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ';' || ch === '\n') {
      if (cur.trim()) cmds.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) cmds.push(cur.trim());
  return cmds;
}

// Run one tool command (argv without the program name).
async function execute(argv, callTool) {
  const cmd = argv[0];
  if (cmd === 'status') {
    await callTool('__status');
    const res = await callTool('tabs_context');
    return console.log(`Connected to Chrome.\n${res.text}`);
  }

  // Split options from positional args.
  const pos = [];
  const opts = {};
  let outFile = null;
  let tab = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') outFile = argv[++i];
    else if (a === '--tab') tab = Number(argv[++i]);
    else if (a === '--json') Object.assign(opts, JSON.parse(argv[++i]));
    else if (a === '-H' || a === '--header') {
      const h = argv[++i];
      const c = h.indexOf(':');
      opts.headers = { ...opts.headers, [h.slice(0, c).trim()]: h.slice(c + 1).trim() };
    }
    else if (/^[a-zA-Z_]+=/.test(a)) {
      const eq = a.indexOf('=');
      opts[a.slice(0, eq)] = parseValue(a.slice(eq + 1));
    } else pos.push(a);
  }

  let [tool, args] = resolveCommand(cmd, pos);
  if (!args) {
    if (!TOOLS.some((t) => t.name === tool)) throw new Error(`Unknown command "${cmd}". Run \`aichrome help\`.`);
    args = {};
  }
  Object.assign(args, opts);
  if (tab != null) args.tabId = tab;
  if (outFile && ['gif_creator', 'network_export', 'network_request', 'http_request'].includes(tool)) args.save_path = outFile;

  const res = await callTool(tool, args);
  if (res.text) console.log(res.text);
  if (res.image) {
    const file = path.resolve(outFile || `aichrome-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
    fs.writeFileSync(file, Buffer.from(res.image.data, 'base64'));
    console.log(`Saved ${file}`);
  }
}

// Many commands, one process: no Node startup per command.
async function runScript(commands, callTool, { stopOnError = true } = {}) {
  for (const line of commands) {
    try {
      await execute(splitArgs(line), callTool);
    } catch (e) {
      console.error(`aichrome: ${line}: ${e.message}`);
      if (stopOnError) process.exit(1);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === 'host') return (await import('../src/host.js')).runHost();
  if (cmd === 'mcp') return (await import('../src/mcp.js')).runMcp();
  if (cmd === 'install') return install();
  if (cmd === 'tools') return printTools();
  if (cmd === 'install-skill') return installSkill(argv[1]);

  const { callTool } = await import('../src/client.js');
  if (cmd === 'run') return runScript(splitCommands(argv.slice(1).join(' ')), callTool);
  if (cmd === 'shell') {
    const readline = await import('node:readline');
    const tty = process.stdin.isTTY;
    const rl = readline.createInterface({ input: process.stdin, output: tty ? process.stdout : undefined, prompt: 'aichrome> ' });
    if (tty) rl.prompt();
    for await (const line of rl) {
      if (line.trim() === 'exit' || line.trim() === 'quit') break;
      await runScript(splitCommands(line), callTool, { stopOnError: false });
      if (tty) rl.prompt();
    }
    return;
  }
  return execute(argv, callTool);
}

main().catch((e) => {
  console.error(`aichrome: ${e.message}`);
  process.exit(1);
});
