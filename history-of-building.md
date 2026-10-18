# History of building AI in Chrome

A record of how AI in Chrome was built, from the first idea to the side panel redesign. Dates are 2026-10-16 to 2026-10-18.

## The goal

You liked how the **Claude in Chrome** extension controls the browser and wanted your own version:

- no separate login for the extension;
- controlled from the terminal, with or without an AI;
- usable by any AI, including Claude.

You wanted it to work **exactly** like Claude in Chrome does.

## 1. Setting up the reverse-engineering tool

- Checked whether REA (`rea-agents`, an MCP server for reverse engineering) was installed. It wasn't registered.
- Registered it with Claude Code: `claude mcp add --scope user rea -- npx -y rea-agents@6.5.0 mcp`.

## 2. Studying the original extension

We analyzed the installed Claude in Chrome extension to learn *how* it works. The rule was to rebuild its behavior in our own code, without copying its source.

| Area | How the original works |
|---|---|
| Connection | Chrome native messaging to a local host (`claude --chrome-native-host`) |
| Browser control | The Chrome DevTools Protocol through `chrome.debugger`: real mouse and keyboard events, JPEG screenshots (max 1568 px), dialog handling |
| Page reading | An accessibility tree with `ref_N` element references |
| Visual cues | An agent tab group, plus an on-page indicator showing where the AI acts |
| GIF recording | Frames after each action with per-action delays, encoded with gif.js |
| Uploads | Files placed straight into `<input type=file>`; images dropped onto drop zones |
| Side panel | A chat panel bound to each tab, opened from the toolbar icon or Cmd+E |

## 3. First build

The working name was "Chrome Pilot". It had three parts:

1. **Extension** (Manifest V3): runs tools through the DevTools Protocol, builds the ref tree and draws the indicator.
2. **Native host:** Chrome starts it, and it relays requests between the extension and a local Unix socket that only your user account can use.
3. **CLI and MCP server:** the same tools from the terminal, or from any MCP-capable AI.

Fixes from real-world testing:

- Pages that hide content with `display: contents` (LinkedIn) were missing from the tree; fixed.
- Hidden duplicate message boxes are now marked `(offscreen)`.
- Cmd+A and Cmd+Z now work, run inside the page.
- The current tab is remembered across reloads.
- A test message was sent on LinkedIn only after you confirmed the right person.

## 4. Speed

We studied why the original feels fast and removed unnecessary waits:

- **Navigation** returns once the page's DOM is ready instead of waiting for the full load: ~2 s down to ~0.2 s.
- **Clicks** went from ~160 ms to ~15 ms, by not sleeping after the click, injecting scripts immediately and attaching the debugger early.
- **Screenshots** check their own size and recapture if the scale was wrong.

## 5. GIF recording and file upload

- `gif_creator` records actions into an annotated GIF with click markers, action labels, a progress bar and a watermark, and saves it with the right file name.
- `file_upload` and `upload_image` put local files or screenshots into file inputs or drop zones, up to 10 MB. Large requests are split into chunks to get past Chrome's 1 MB message limit.

## 6. Publishing and naming

- Published to GitHub as **AI in Chrome**: https://github.com/AfsalMadathingal/ai-in-chrome. A screenshot of the repo was saved to the Desktop.
- The command is **`aichrome`**, not `cpilot`, which clashes with Copilot.
- Internal names were renamed to match:
  - native host: `com.ai_in_chrome.bridge`;
  - data folder: `~/.ai-in-chrome`;
  - the local project folder.
- The extension ID is fixed: `nknkkmpocjbicnfhkgkgiiemkddajodl`.

## 7. Documentation

- **README.md:** quick start, using it by hand, AI setup, the tools table, security notes.
- **INSTALL.md:** step-by-step setup, configs for Claude Code, Codex, Cursor, Gemini CLI and Claude Desktop, troubleshooting, and uninstalling.
- **skills/ai-in-chrome/SKILL.md:** a guide that teaches any AI how to install, connect and use the tools safely. `aichrome install-skill` installs it for Claude Code.

## 8. Network tools for developers (v0.2.0)

So an AI can debug web apps without a person copying things out of DevTools:

- **Capture:** every request with its real headers, cookies, auth tokens, bodies and timing, plus WebSocket messages.
- **Reproduce:** copy any request as curl or fetch, or replay it with edits.
- **Send:** new requests as the logged-in user. They can go from inside the page, from the extension (no CORS limits), or from Node (any header, with the browser's cookies attached).
- **Cookies:** read, set and delete them, including HttpOnly ones. Also dump the page's localStorage and sessionStorage.
- **Intercept live:** block requests, mock responses, rewrite requests and responses, and add delays.
- **Export:** save captured traffic as a HAR file.

All of it was tested end to end on httpbin.org.

## 9. Similar projects

A search of GitHub turned up related work:

| Project | What it is |
|---|---|
| `noemica-io/open-claude-in-chrome` | The closest twin: a reverse-engineered clone with the same design |
| `S-Trespassing/claw-in-chrome` and `cocodem/claude-for-chrome` | The original extension with its login and limits removed |
| `hangwin/mcp-chrome`, `epiral/bb-browser`, `browser-use/browser-harness` | Larger projects built on the same idea |

How people received them:

- The official extension has millions of users but low store ratings (about 2–2.8 out of 5). The main complaints are security and its limits: a paid login, 58 blocked sites, and support for Chrome and Edge only.
- That demand is what the clones serve, and what AI in Chrome serves too.

## 10. Side panel

A chat panel in Chrome that talks to the AI you already use in the terminal, with no extra login:

- **Claude Code mode** (tested):
  - The host runs your logged-in `claude` in the background and streams its answers into the panel.
  - It controls the tab through the same tools.
  - In "Ask before acting" mode, the panel asks before clicks, typing and navigation (Allow once / Always allow / Deny).
- **Codex mode:** runs your logged-in `codex`. Untested, because Codex needs to be signed in again on this Mac.
- **Terminal AI mode:** an AI already open in your terminal answers the panel through the `sidepanel_wait` and `sidepanel_reply` tools. Untested.
- **Opening it:** the toolbar icon or Cmd/Ctrl+Shift+E.
- **Look:** a warm, orange accent color.

## 11. Side panel redesign

The panel was rebuilt to feel like Claude in Chrome, Codex and Antigravity:

- **Header:** an AI picker that shows which AIs are installed, plus buttons for history, a new chat and settings.
- **Chat history:** past chats are kept, grouped by day, and can be searched, reopened or deleted.
- **Thinking:** the AI's reasoning streams into a block you can expand ("Thought for 4s").
- **Step timeline:** browser actions are listed in plain words ("Navigate to example.com", "Click ref_12", "Take screenshot"), with an icon, status and time. Screenshots show as thumbnails that open full size.
- **Plans:** Claude's TodoWrite and Codex's to-do list appear as a live checklist.
- **Answers:** richer Markdown (tables, quotes, task lists) and copy buttons on code blocks and answers.
- **Permission cards:** each request says what the AI wants to do and on which site.
- **Images in messages:** paste, drop, attach, or capture the current tab.
- **Slash commands and saved shortcuts:** `/new`, `/history`, `/settings`, `/screenshot`, plus your own prompts.
- **Themes:** system, light or dark.

To support this, the host now sends the AI's thinking text, screenshots from tool results (up to about 500 KB, to stay under Chrome's 1 MB message limit), to-do lists, token counts, and images from your messages to Claude Code or Codex.

## 12. MIT license and Windows support

- **License:** the project is now MIT licensed (`LICENSE`), so anyone can use, change and share it.
- **Windows 10/11:**
  - The bridge uses a per-user named pipe instead of a Unix socket file.
  - `aichrome install` writes a `.bat` launcher and registers the host in the registry (`HKCU`) for Chrome, Chromium, Edge and Brave. No admin rights are needed.
  - The side panel finds `claude` / `codex` as `.exe` or npm `.cmd` shims, and runs the JavaScript behind a shim directly with Node to avoid `cmd.exe` quoting problems.
  - Paths accept `~\` as well as `~/`.
- **`aichrome uninstall`:** removes the host registration (files or registry keys) and the data folder on every platform.
- Tested on macOS; the Windows code paths are untested on a real Windows machine.

## Where things stand

- **On GitHub:** everything through the network tools (v0.2.0).
- **On this Mac, not pushed:** the side panel and the orange color, in two commits, plus the side panel redesign (not yet committed).
- **Next ideas:**
  - tab-aware chats, so each tab keeps its own conversation;
  - test the Codex and Terminal AI modes;
  - add a license;
  - an AI-powered `find`;
  - shortcuts.
