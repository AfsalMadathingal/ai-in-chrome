# Installing AI in Chrome

About 3 minutes. You need **macOS or Linux**, **Node.js 20+**, and a Chromium browser: Chrome, Brave, Edge, Arc or Chromium. Windows isn't supported yet.

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

This writes `com.ai_in_chrome.bridge.json` into each installed browser's `NativeMessagingHosts` folder, plus a small launcher at `~/.ai-in-chrome/native-host.sh`. Chrome uses these to start the bridge when the extension loads. Only the extension ID `nknkkmpocjbicnfhkgkgiiemkddajodl` may use it.

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

## Uninstall

```bash
npm rm -g ai-in-chrome
rm -rf ~/.ai-in-chrome
rm ~/Library/Application\ Support/*/NativeMessagingHosts/com.ai_in_chrome.bridge.json \
   ~/Library/Application\ Support/*/*/NativeMessagingHosts/com.ai_in_chrome.bridge.json   # macOS
rm ~/.config/*/NativeMessagingHosts/com.ai_in_chrome.bridge.json \
   ~/.config/*/*/NativeMessagingHosts/com.ai_in_chrome.bridge.json                       # Linux
```

Then remove the extension in `chrome://extensions`, and the MCP entry from your AI client, for example `claude mcp remove ai-in-chrome --scope user`.
