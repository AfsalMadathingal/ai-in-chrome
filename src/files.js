// Local-file handling done on this side of the bridge: the extension can't read your disk,
// and aichrome runs on your machine, so it reads upload paths and saves exported files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.md': 'text/markdown', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const expand = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));

function readLocal(p) {
  const file = expand(p);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`Not a file: ${file}`);
  return {
    name: path.basename(file),
    mimeType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    data: fs.readFileSync(file).toString('base64'),
  };
}

// Rewrite arguments that refer to local files before they go to the extension.
export function prepareArgs(tool, args) {
  const out = { ...args };
  if (tool === 'file_upload' && out.paths) {
    const paths = Array.isArray(out.paths) ? out.paths : [out.paths];
    out.files = [...(out.files || []), ...paths.map(readLocal)];
    delete out.paths;
  }
  if (tool === 'upload_image' && out.path) {
    const f = readLocal(out.path);
    out.data = f.data;
    out.mimeType = f.mimeType;
    out.filename ??= f.name;
    delete out.path;
  }
  return out;
}

// Save a file returned by the extension (e.g. an exported GIF). `target` may be a file or a folder.
export function saveFile(file, target) {
  let dest = expand(target || path.join(os.homedir(), 'Downloads'));
  if (fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory()) dest = path.join(dest, file.name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(file.data, 'base64'));
  return dest;
}
