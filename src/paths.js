import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.ai_in_chrome.bridge';
export const HOME = process.env.AICHROME_HOME || path.join(os.homedir(), '.ai-in-chrome');
export const IS_WINDOWS = process.platform === 'win32';
// Unix: a socket file only this user can open. Windows: a per-user named pipe.
export const SOCKET = IS_WINDOWS
  ? `\\\\.\\pipe\\ai-in-chrome-${(os.userInfo().username || 'user').replace(/[^\w.-]/g, '_')}`
  : path.join(HOME, 'bridge.sock');
export const LOG_FILE = path.join(HOME, 'host.log');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_DIR = path.join(ROOT, 'extension');
export const CLI = path.join(ROOT, 'bin', 'aichrome.js');

// Windows: browsers find the host manifest through these per-user registry keys (HKCU\<key>\<host name>).
export const WINDOWS_REGISTRY_KEYS = [
  ['Google Chrome', 'Software\\Google\\Chrome\\NativeMessagingHosts'],
  ['Chromium', 'Software\\Chromium\\NativeMessagingHosts'],
  ['Microsoft Edge', 'Software\\Microsoft\\Edge\\NativeMessagingHosts'],
  ['Brave', 'Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts'],
];

// Expand a leading ~ (with / or \ after it) to the home folder.
export const expandHome = (p) => path.resolve((p || '~').replace(/^~(?=$|[\\/])/, os.homedir()));

// Where Chromium-family browsers look for per-user native messaging host manifests (macOS / Linux).
export function nativeHostDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium',
      'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data',
    ].map((b) => ({ browser: b, dir: path.join(base, b, 'NativeMessagingHosts') }));
  }
  const base = path.join(home, '.config');
  return ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge']
    .map((b) => ({ browser: b, dir: path.join(base, b, 'NativeMessagingHosts') }));
}
