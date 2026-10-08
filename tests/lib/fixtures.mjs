// Serves tests/fixtures over HTTP and generates the images they use.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const GENERATED = path.join(FIXTURES, 'generated');

const TYPES = { '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export function serveFixtures() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(FIXTURES, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'max-age=3600' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Photo-like images (gradients plus noise, so they don't compress to
// nothing). Made once; delete tests/fixtures/generated to remake them.
export function generateImages() {
  if (fs.existsSync(path.join(GENERATED, 'product.png'))) return;
  fs.mkdirSync(GENERATED, { recursive: true });
  for (let i = 1; i <= 40; i++) fs.writeFileSync(path.join(GENERATED, `photo-${i}.jpg`), photo(800, 600, i).encodeSync('jpeg', 85));
  for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(GENERATED, `big-${i}.webp`), photo(1800, 1200, 100 + i).encodeSync('webp', 92));
  fs.writeFileSync(path.join(GENERATED, 'product.png'), product(1200).encodeSync('png'));
}

function photo(w, h, seed) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, `hsl(${(seed * 47) % 360} 70% 45%)`);
  g.addColorStop(1, `hsl(${(seed * 47 + 140) % 360} 60% 70%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  addNoise(ctx, w, h, seed, 40);
  return canvas;
}

// A transparent "product shot": a shape on a clear background.
function product(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1e88e5';
  ctx.beginPath();
  ctx.roundRect(size * 0.2, size * 0.1, size * 0.6, size * 0.8, size * 0.08);
  ctx.fill();
  addNoise(ctx, size, size, 7, 30);
  return canvas;
}

function addNoise(ctx, w, h, seed, amount) {
  const img = ctx.getImageData(0, 0, w, h);
  let x = seed * 9301 + 49297;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const n = (x % (amount * 2)) - amount;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}
