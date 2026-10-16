// AI in Chrome offscreen document: renders recorded frames with action overlays and encodes a GIF (gif.js).
/* global GIF */

const ACCENT = 'rgb(124, 92, 255)';

function loadImage(base64, format) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode a recorded frame'));
    img.src = `data:image/${format || 'jpeg'};base64,${base64}`;
  });
}

function drawClick(ctx, x, y, s) {
  ctx.save();
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = 'rgba(124, 92, 255, 0.25)';
  for (const r of [10, 20]) {
    ctx.beginPath();
    ctx.arc(x, y, r * s, 0, Math.PI * 2);
    r === 10 ? ctx.fill() : ctx.stroke();
  }
  ctx.restore();
}

function drawDrag(ctx, x0, y0, x1, y1, s) {
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = 3 * s;
  ctx.setLineDash([8 * s, 6 * s]);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
  const a = Math.atan2(y1 - y0, x1 - x0);
  const h = 14 * s;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - h * Math.cos(a - 0.4), y1 - h * Math.sin(a - 0.4));
  ctx.lineTo(x1 - h * Math.cos(a + 0.4), y1 - h * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  drawClick(ctx, x0, y0, s * 0.7);
}

function drawLabel(ctx, text, s) {
  if (!text) return;
  const label = text.length > 70 ? text.slice(0, 67) + '…' : text;
  ctx.save();
  ctx.font = `600 ${Math.round(15 * s)}px system-ui, -apple-system, sans-serif`;
  const padX = 12 * s;
  const w = ctx.measureText(label).width + padX * 2;
  const h = 30 * s;
  const x = (ctx.canvas.width - w) / 2;
  const y = 14 * s;
  ctx.fillStyle = 'rgba(20, 16, 40, 0.82)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + padX, y + h / 2);
  ctx.restore();
}

function drawProgress(ctx, progress, s) {
  const h = Math.max(3, 4 * s);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(0, ctx.canvas.height - h, ctx.canvas.width, h);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, ctx.canvas.height - h, ctx.canvas.width * progress, h);
}

function drawWatermark(ctx, s) {
  ctx.save();
  ctx.font = `600 ${Math.round(12 * s)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 3 * s;
  const x = ctx.canvas.width - 10 * s;
  const y = ctx.canvas.height - 10 * s;
  ctx.strokeText('AI in Chrome', x, y);
  ctx.fillText('AI in Chrome', x, y);
  ctx.restore();
}

async function renderGif(frames, opts) {
  const images = await Promise.all(frames.map((f) => loadImage(f.base64, f.format)));
  // gif.js needs one canvas size for the whole animation. Use the most common frame size;
  // other frames (zooms, a different window size) are scaled to fit and centered.
  const sizes = new Map();
  for (const i of images) sizes.set(`${i.width}x${i.height}`, (sizes.get(`${i.width}x${i.height}`) || 0) + 1);
  const [width, height] = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0].split('x').map(Number);

  const gif = new GIF({
    workers: 2,
    quality: opts.quality || 10,
    width,
    height,
    repeat: 0,
    workerScript: chrome.runtime.getURL('vendor/gif.worker.js'),
  });

  images.forEach((img, i) => {
    const f = frames[i];
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    const fit = Math.min(width / img.width, height / img.height);
    const dw = img.width * fit;
    const dh = img.height * fit;
    const ox = (width - dw) / 2;
    const oy = (height - dh) / 2;
    ctx.drawImage(img, ox, oy, dw, dh);
    // Action coordinates are CSS px; map them onto the drawn frame.
    const s = f.viewportWidth ? dw / f.viewportWidth : 1;
    ctx.save();
    ctx.translate(ox, oy);
    const a = f.action;
    if (a) {
      if (opts.showClickIndicators && a.marker && a.coordinate) drawClick(ctx, a.coordinate[0] * s, a.coordinate[1] * s, Math.max(s, 0.6));
      if (opts.showDragPaths && a.marker && a.start_coordinate && a.coordinate) {
        drawDrag(ctx, a.start_coordinate[0] * s, a.start_coordinate[1] * s, a.coordinate[0] * s, a.coordinate[1] * s, Math.max(s, 0.6));
      }
    }
    ctx.restore();
    if (a && opts.showActionLabels) drawLabel(ctx, a.description, Math.max(s, 0.7));
    if (opts.showProgressBar) drawProgress(ctx, (i + 1) / images.length, Math.max(s, 0.7));
    if (opts.showWatermark) drawWatermark(ctx, Math.max(s, 0.7));
    const last = i === images.length - 1;
    gif.addFrame(canvas, { delay: (f.delay || 800) + (last ? 2000 : 0), copy: true });
  });

  const blob = await new Promise((resolve, reject) => {
    gif.on('finished', resolve);
    gif.on('abort', () => reject(new Error('GIF encoding aborted')));
    gif.render();
  });
  const base64 = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
  // A blob URL lets the service worker download with a proper filename (data: URLs lose it).
  return { base64, blobUrl: URL.createObjectURL(blob), size: blob.size, width, height };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pilot-revoke-url') {
    URL.revokeObjectURL(msg.url);
    return;
  }
  if (msg?.type !== 'pilot-render-gif') return;
  renderGif(msg.frames, msg.options || {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
