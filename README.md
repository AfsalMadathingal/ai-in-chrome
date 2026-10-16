# AI in Chrome

Control your **real, logged-in Chrome** from the terminal, or hand it to **any AI** over MCP (Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop…). No login, no cloud, no API key.

It controls the browser the same way Claude in Chrome does:
- the Chrome DevTools Protocol through `chrome.debugger`;
- an accessibility tree with `ref_N` element refs;
- a native-messaging bridge;
- an agent tab group and an on-page indicator.

```
aichrome CLI / any MCP client ──► ~/.ai-in-chrome/bridge.sock ──► native host (started by Chrome) ──► extension ──► DevTools Protocol ──► tab
```

## Quick start

```bash
git clone https://github.com/AfsalMadathingal/ai-in-chrome.git && cd ai-in-chrome
npm link            # `aichrome` command, zero dependencies
aichrome install    # register the bridge with Chrome / Brave / Edge / Arc / Chromium
```

Then go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `extension/`. Check with:

```bash
aichrome status
```

Full guide, AI client setup and troubleshooting: **[INSTALL.md](INSTALL.md)**.

## Use it yourself (no AI)

```bash
aichrome open example.com            # new tab in the purple "AI" group
aichrome read interactive            # elements with refs:  button "More information…" [ref_1]
aichrome click ref_1                 # click by ref…
aichrome shot -o page.jpg            # …or take a screenshot
aichrome click 640 300               # and click by screenshot pixel
aichrome type "hello"; aichrome key Enter
aichrome fill ref_5 "me@example.com" # inputs, selects, checkboxes
aichrome upload ref_7 ~/cv.pdf       # into <input type=file>, no file picker
aichrome js "document.title"
aichrome record start … aichrome record export -o demo.gif
```

Several steps in one process (fastest):

```bash
aichrome run "open example.com; read interactive; click ref_1"
aichrome shell                       # interactive prompt, or pipe commands in
```

Run `aichrome help` for every shortcut, and `aichrome tools` for every tool and argument.

## Use it with AI

**Claude Code**
```bash
claude mcp add --scope user ai-in-chrome -- "$(which node)" "$(pwd)/bin/aichrome.js" mcp
aichrome install-skill               # teaches Claude how to use it well
```

**Other MCP clients:** add a stdio server with command `node` and args `["/path/to/ai-in-chrome/bin/aichrome.js", "mcp"]`. Config snippets for Codex, Cursor, Gemini CLI and Claude Desktop are in [INSTALL.md](INSTALL.md#5-connect-an-ai-optional).

**Any agent with a shell:** it can call `aichrome …` directly.

**AI guide:** [`skills/ai-in-chrome/SKILL.md`](skills/ai-in-chrome/SKILL.md) tells an AI how to install, connect, and drive the browser reliably: refs, uploads, safety with real accounts, and speed tips. Give it to any agent, or install it as a Claude Code skill with `aichrome install-skill`.

## Tools

| Tool | What it does |
|---|---|
| `tabs_context`, `tabs_create`, `tabs_select`, `tabs_close` | List, open (in the AI group), switch and close tabs |
| `navigate` | Go to a URL, or `back` / `forward` / `reload` |
| `computer` | `screenshot`, `left_click`, `right_click`, `double_click`, `triple_click`, `hover`, `left_click_drag`, `type`, `key`, `scroll`, `scroll_to`, `wait`, `zoom` |
| `read_page`, `find` | Accessibility tree with `ref_N` refs; find elements by words |
| `form_input` | Set text fields, selects, checkboxes and radios by ref |
| `get_page_text`, `javascript_tool` | Readable page text; run JavaScript in the page |
| `read_console_messages`, `read_network_requests` | Captured console output, errors, dialogs and requests |
| `file_upload`, `upload_image` | Local files or screenshots into file inputs or drop zones (10 MB max) |
| `gif_creator` | Record actions and export an annotated GIF |
| `resize_window`, `cdp_command`, `extension_reload` | Window size, raw DevTools Protocol, reload the extension |

## How it works

- **Extension** (`extension/`): an MV3 service worker. It runs tools through `chrome.debugger` (CDP): input events, screenshots, JS, console and network. Content scripts build the ref tree and draw the on-page indicator. An offscreen page encodes GIFs with [gif.js](https://github.com/jnordberg/gif.js) (MIT, in `extension/vendor/`).
- **Native host** (`src/host.js`): Chrome starts it via native messaging when the extension loads. It relays requests between the extension and a Unix socket, splitting large ones into chunks to fit Chrome's 1 MB message limit.
- **`aichrome`** (`bin/`, `src/`): the CLI, the MCP server, and the local file handling (it reads upload paths and saves GIFs).

## Security

- The socket `~/.ai-in-chrome/bridge.sock` is `0600` inside a `0700` folder, so only your user account can drive the browser.
- Chrome only allows the extension ID in the host manifest (`nknkkmpocjbicnfhkgkgiiemkddajodl`, fixed by the manifest `key`) to start the bridge.
- Nothing leaves your machine. The AI you connect sees what the tools return (page text, screenshots), so only connect AIs you trust with your browser.

## Notes

- While AI in Chrome controls a tab, Chrome shows a "started debugging this browser" bar. That's the `chrome.debugger` API at work.
- Console and network capture start when it first attaches to a tab.
- `chrome://` pages and the Chrome Web Store can't be automated.
- Paste (`cmd+v`) may not work from synthetic input. Use `type` instead.
- After editing extension code: `aichrome reload-extension`. After moving the folder or changing Node: `aichrome install`.
- Logs: `~/.ai-in-chrome/host.log`.
- Platforms: macOS and Linux. Windows isn't supported yet.
