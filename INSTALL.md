# Installing AI in Chrome

About 3 minutes. You need **macOS, Linux or Windows 10/11**, **Node.js 20+**, and a Chromium browser: Chrome, Brave, Edge, Arc or Chromium. On Windows, run the commands below in PowerShell or Windows Terminal.

## 1. Get the code and the `aichrome` command

```bash
git clone https://github.com/AfsalMadathingal/ai-in-chrome.git
cd ai-in-chrome
npm link            # adds `aichrome` to your PATH; there are no dependencies to install
aichrome help       # check it works
```

Don't want a global command? Use `node /path/to/ai-in-chrome/bin/aichrome.js` anywhere this guide says `aichrome`.

## 2. Register the native host

```bash
aichrome install
```

On macOS and Linux this writes `com.ai_in_chrome.bridge.json` into each installed browser's `NativeMessagingHosts` folder, plus a small launcher at `~/.ai-in-chrome/native-host.sh`.

On Windows it writes the manifest and a launcher (`native-host.bat`) to `%USERPROFILE%\.ai-in-chrome`, and registers the manifest under `HKCU\Software\<browser>\NativeMessagingHosts\com.ai_in_chrome.bridge` for Chrome, Chromium, Edge and Brave. No admin rights are needed. The bridge uses a per-user named pipe (`\\.\pipe\ai-in-chrome-<username>`) instead of a socket file. Chrome uses these to start the bridge when the extension loads. Only the extension ID `nknkkmpocjbicnfhkgkgiiemkddajodl` may use it.

Run `aichrome install` again if you move the folder or change Node versions.

## 3. Load the extension (manual, one time)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder inside the repo.
4. Check that the ID is `nknkkmpocjbicnfhkgkgiiemkddajodl`.

The ID is fixed by the manifest key, so it is the same on every machine. Browsers don't let scripts install unpacked extensions, so this step is always done by hand.

## 4. Check the connection

```bash
aichrome status          # "Connected to Chrome." plus your open tabs
aichrome open example.com
aichrome read interactive
```

## 5. Connect an AI (optional)

AI in Chrome is a standard **stdio MCP server**: `node /path/to/ai-in-chrome/bin/aichrome.js mcp`. Use absolute paths: apps started from the Dock often don't have Homebrew's `node` on their PATH. Get the right values with `which node` and `pwd`, run from inside the repo.

**Claude Code**
```bash
claude mcp add --scope user ai-in-chrome -- "$(which node)" "$(pwd)/bin/aichrome.js" mcp
aichrome install-skill   # optional: installs the usage guide as a Claude Code skill
```

**Codex CLI**: `~/.codex/config.toml`
```toml
[mcp_servers.ai-in-chrome]
command = "/opt/homebrew/bin/node"
args = ["/path/to/ai-in-chrome/bin/aichrome.js", "mcp"]
```

**Cursor** (`~/.cursor/mcp.json`), **Gemini CLI** (`~/.gemini/settings.json`), **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "ai-in-chrome": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/path/to/ai-in-chrome/bin/aichrome.js", "mcp"]
    }
  }
}
```

On Windows, use paths like `"C:\\Program Files\\nodejs\\node.exe"` and `"C:\\Users\\you\\ai-in-chrome\\bin\\aichrome.js"` (find them with `where node`).

Restart the client afterwards; MCP servers load at startup.

**Any agent with a shell** can skip MCP and run `aichrome …` commands directly. Point it at [`skills/ai-in-chrome/SKILL.md`](skills/ai-in-chrome/SKILL.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `aichrome: AI in Chrome is not connected` | Make sure Chrome is open and the extension is loaded and enabled. Click the extension icon to force a reconnect. |
| Extension icon shows **off** | The bridge isn't registered or can't start. Run `aichrome install`, then click the icon. Details are in `~/.ai-in-chrome/host.log`. |
| Worked before, broke after moving the folder or upgrading Node | Run `aichrome install` again, then reload the extension in `chrome://extensions`. |
| Wrong extension ID | You loaded a different folder. Load the repo's `extension/` folder. |
| `Cannot access a chrome:// URL` | Browser pages (`chrome://`, the Web Store) can't be automated. Open a normal tab with `aichrome open <url>`. |
| MCP client can't start the server | Use absolute paths for both `node` and `aichrome.js` in its config. |
| Windows: icon shows **off** after install | Check the key exists: `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ai_in_chrome.bridge`. Run `aichrome install` again, then restart Chrome. Logs are in `%USERPROFILE%\.ai-in-chrome\host.log`. |
| Windows: side panel says Claude Code / Codex not found | Install it so `where claude` (or `where codex`) finds it in the same terminal, then run `aichrome install` again so the launcher saves that PATH. |

## Uninstall

```bash
aichrome uninstall   # removes the native host registration (files or registry keys) and ~/.ai-in-chrome
npm rm -g ai-in-chrome
```

Or by hand on macOS / Linux:

```bash
rm -rf ~/.ai-in-chrome
rm ~/Library/Application\ Support/*/NativeMessagingHosts/com.ai_in_chrome.bridge.json \
   ~/Library/Application\ Support/*/*/NativeMessagingHosts/com.ai_in_chrome.bridge.json   # macOS
rm ~/.config/*/NativeMessagingHosts/com.ai_in_chrome.bridge.json \
   ~/.config/*/*/NativeMessagingHosts/com.ai_in_chrome.bridge.json                       # Linux
```

Then remove the extension in `chrome://extensions`, and the MCP entry from your AI client, for example `claude mcp remove ai-in-chrome --scope user`.
