import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.chrome_pilot.bridge';
export const HOME = process.env.CPILOT_HOME || path.join(os.homedir(), '.chrome-pilot');
export const SOCKET = path.join(HOME, 'bridge.sock');
export const LOG_FILE = path.join(HOME, 'host.log');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_DIR = path.join(ROOT, 'extension');
export const CLI = path.join(ROOT, 'bin', 'cpilot.js');

// Where Chromium-family browsers look for per-user native messaging host manifests.
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
