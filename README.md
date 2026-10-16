# AI in Chrome

Control your real Chrome from the terminal, or hand it to any AI over MCP. It works the same way Claude in Chrome does (CDP via `chrome.debugger`, accessibility tree with `ref_N` element refs, a native-messaging bridge, a tab group and an on-page indicator), but with no login and no cloud.

```
cpilot CLI / any MCP client ──► ~/.chrome-pilot/bridge.sock ──► native host (launched by Chrome) ──► extension ──► CDP ──► tab
```

## Setup (once)

Requires Node.js 20+ and macOS or Linux, with Chrome, Brave, Edge, Arc or Chromium.

```bash
git clone https://github.com/AfsalMadathingal/ai-in-chrome.git
cd ai-in-chrome
npm link                # puts `cpilot` on PATH (no dependencies to install)
cpilot install          # registers the native host with Chrome/Brave/Edge/Arc/Chromium
```

Then go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder. Check with `cpilot status`.

If the extension icon shows an **off** badge, the host isn't connected. Click the icon to retry.

## Terminal use (no AI)

```bash
cpilot open example.com          # new tab in the "AI" group
cpilot read interactive          # elements with refs
cpilot click ref_3               # click by ref …
cpilot shot -o page.jpg          # … or take a screenshot
cpilot click 640 300             # and click by screenshot pixel
cpilot type "hello"; cpilot key Enter
cpilot fill ref_5 "me@example.com"
cpilot js "document.title"
cpilot computer --json '{"action":"scroll","scroll_direction":"down","scroll_amount":5}'
cpilot upload ref_7 ~/cv.pdf ~/photo.jpg      # files into an <input type=file> (no file picker)
cpilot upload-image shot_3 ref_7               # a screenshot (by image ID) or image file into an input / drop zone
cpilot record start; …actions…; cpilot record stop; cpilot record export -o demo.gif
cpilot tools                     # every tool and argument
```

Fast mode: one process, so no ~60 ms Node startup per command:

```bash
cpilot run "open example.com; read interactive; click ref_3; type hello; key Enter"
cpilot shell                     # interactive prompt (or pipe commands in)
```

## Any AI (MCP)

```bash
claude mcp add --scope user ai-in-chrome -- node /path/to/ai-in-chrome/bin/cpilot.js mcp
```

Other clients (Codex, Cursor, Gemini CLI, …): use the same command, `node …/bin/cpilot.js mcp`, as a stdio MCP server. Any agent that can run shell commands can also just call `cpilot`.

## Tools

`tabs_context`, `tabs_create`, `tabs_select`, `tabs_close`, `navigate`, `computer` (screenshot, left/right/double/triple_click, hover, left_click_drag, type, key, scroll, scroll_to, wait, zoom), `read_page`, `find`, `form_input`, `get_page_text`, `javascript_tool`, `read_console_messages`, `read_network_requests`, `resize_window`, `cdp_command` (raw CDP escape hatch), `extension_reload`, `gif_creator` (start_recording / stop_recording / export / clear), `file_upload` (local `paths` or base64 `files`, 10 MB max), `upload_image` (screenshot `imageId` or local `path`, to a `ref` or a drop `coordinate`).

## Notes

- Security: the socket is `0600` in a `0700` directory, so only your user can drive the browser. Chrome only lets the extension ID in the host manifest (`nknkkmpocjbicnfhkgkgiiemkddajodl`, fixed by the manifest `key`) talk to the host.
- Chrome shows a "AI in Chrome started debugging this browser" bar while it controls a tab. That's the `chrome.debugger` API, same as the original.
- Console and network capture start when AI in Chrome first attaches to a tab.
- Host log: `~/.chrome-pilot/host.log`.
- GIF exports are saved by `cpilot` (default `~/Downloads`, or `-o` / `save_path`); `download: true` uses Chrome's downloads instead. gif.js (MIT) is vendored in `extension/vendor/`.
- Uploads are read from disk by `cpilot` on your machine; requests over 1 MB are chunked (Chrome's native-messaging limit).
- After editing extension code: `cpilot reload-extension`.
- Paste (`cmd+v`) may not work: Chrome restricts clipboard access from synthetic input. Use `type` instead.
