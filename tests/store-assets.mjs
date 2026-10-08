// Builds the store artwork from ../store: extension icons (into the
// extension's icons folder), the store icon, the promo tile and the
// screenshots. Run: npm run store:assets [-- --only=icons|promo|screens]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STORE = path.join(ROOT, 'store');
const EXT = path.join(ROOT, 'fullpage-pdf');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const svg = (name) => fs.readFileSync(path.join(STORE, name), 'utf8');
const dataUrl = (text) => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();

// Renders HTML at the given size to a PNG (transparent where nothing is drawn).
async function shot(html, width, height, file, { transparent = true, scale = 1 } = {}) {
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body>${html}</body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
}

// Icon artwork drawn at `art` px, centred on a `size` px transparent square.
const iconHtml = (size, art, file) =>
  `<div style="width:${size}px;height:${size}px;display:grid;place-items:center"><img src="${dataUrl(svg(file))}" width="${art}" height="${art}"></div>`;

if (!only || only === 'icons') {
  // Chrome's guidance: 128px icons have 96px of artwork and 16px of padding.
  const sizes = [
    [16, 16, 'icon-small.svg'],
    [32, 32, 'icon-small.svg'],
    [48, 44, 'icon.svg'],
    [128, 96, 'icon.svg'],
  ];
  for (const [size, art, file] of sizes) await shot(iconHtml(size, art, file), size, size, path.join(EXT, 'icons', `icon${size}.png`));
  fs.copyFileSync(path.join(EXT, 'icons', 'icon128.png'), path.join(STORE, 'store-icon-128.png'));

  // A preview sheet on light and dark backgrounds, at actual and 4x size.
  const cell = (bg, size, art, file, zoom) =>
    `<div style="background:${bg};padding:12px;display:grid;place-items:center"><img src="${dataUrl(svg(file))}" style="width:${art * zoom}px;height:${art * zoom}px;image-rendering:${zoom > 1 ? 'pixelated' : 'auto'}"></div>`;
  const row = (bg) => sizes.map(([s, a, f]) => cell(bg, s, a, f, 1)).join('') + cell(bg, 32, 32, 'icon-small.svg', 3) + cell(bg, 128, 96, 'icon.svg', 2);
  await shot(`<div style="display:grid;grid-template-columns:repeat(6,auto);gap:0;width:max-content">${row('#ffffff')}${row('#202124')}${row('#dee1e6')}</div>`,
    760, 700, path.join(STORE, 'icon-preview.png'), { transparent: false });
  console.log('icons done');
}

// ---------- Promo tile and screenshots ----------

const FONT = `'Segoe UI', Roboto, system-ui, sans-serif`;
const png = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
const icon = dataUrl(svg('icon.svg'));

if (!only || only === 'promo') {
  await shot(`
    <div style="width:440px;height:280px;background:#1A73E8;color:#fff;font-family:${FONT};display:flex;align-items:center;gap:22px;padding:0 30px;box-sizing:border-box;position:relative;overflow:hidden">
      <div style="position:absolute;right:-70px;top:-90px;width:260px;height:260px;border-radius:50%;background:rgba(255,255,255,.08)"></div>
      <div style="position:absolute;right:40px;bottom:-120px;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.06)"></div>
      <div style="flex:none;width:118px;height:118px;border-radius:28px;background:#fff;display:grid;place-items:center;box-shadow:0 6px 16px rgba(0,0,0,.25)">
        <img src="${icon}" width="92" height="92">
      </div>
      <div style="position:relative">
        <div style="font-size:27px;font-weight:600;line-height:1.15">Webpage<br>Screenshot Pro</div>
        <div style="font-size:14.5px;line-height:1.35;margin-top:10px;opacity:.92">Whole pages to small,<br>searchable PDFs or images</div>
      </div>
    </div>`, 440, 280, path.join(STORE, 'promo-tile-440x280.png'), { transparent: false });
  console.log('promo tile done');
}

if (!only || only === 'screens') {
  const pagePng = path.join(STORE, 'recipe-page.png');
  if (!fs.existsSync(pagePng)) throw new Error('store/recipe-page.png missing (a render of a captured recipe page)');
  const pageImg = png(pagePng);

  // The real popup, rendered with stand-in data.
  const popupPng = path.join(STORE, 'popup.png');
  await page.setViewport({ width: 280, height: 900, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.evaluateOnNewDocument(() => {
    window.chrome = {
      storage: {
        sync: { get: async () => ({ compression: 'high', format: 'pdf', mode: 'full' }), set: async () => {} },
        local: { get: async () => ({}), set: async () => {} },
      },
      tabs: { query: async () => [{ id: 1, active: true, windowId: 1, title: 'Double Apple Pie Recipe', url: 'https://cooking.nytimes.com/recipes/1016924-double-apple-pie' }, { id: 2 }, { id: 3 }, { id: 4 }] },
      runtime: { sendMessage: async () => ({ running: false }), onMessage: { addListener() {} }, getURL: (p) => p },
      permissions: { request: async () => true },
    };
  });
  await page.goto(`file:///${path.join(EXT, 'popup.html').replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 500));
  const popupH = await page.evaluate(() => Math.ceil(document.querySelector('main').getBoundingClientRect().height));
  await page.screenshot({ path: popupPng, clip: { x: 0, y: 0, width: 280, height: popupH } });
  const popupImg = png(popupPng);

  // A plain browser frame: toolbar with the address and the extension icon.
  const frame = (inner) => `
    <div style="width:1280px;height:704px;position:relative;overflow:hidden;background:#fff">
      <div style="height:44px;background:#f1f3f4;border-bottom:1px solid #dadce0;display:flex;align-items:center;gap:12px;padding:0 14px;font-family:${FONT}">
        <div style="display:flex;gap:7px"><i style="width:12px;height:12px;border-radius:50%;background:#dadce0"></i><i style="width:12px;height:12px;border-radius:50%;background:#dadce0"></i><i style="width:12px;height:12px;border-radius:50%;background:#dadce0"></i></div>
        <div style="flex:1;height:30px;border-radius:15px;background:#fff;display:flex;align-items:center;padding:0 16px;font-size:14px;color:#3c4043">cooking.nytimes.com/recipes/1016924-double-apple-pie</div>
        <div style="width:34px;height:34px;border-radius:50%;background:#d3e3fd;display:grid;place-items:center"><img src="${dataUrl(svg('icon-small.svg'))}" width="22" height="22"></div>
      </div>
      <div style="position:absolute;top:45px;left:0;right:0;bottom:0;background:url(${pageImg}) 0 -40px / 1280px auto no-repeat"></div>
      ${inner}
    </div>`;
  const caption = (title, sub) => `
    <div style="height:96px;background:#1A73E8;color:#fff;font-family:${FONT};display:flex;flex-direction:column;justify-content:center;padding:0 48px">
      <div style="font-size:30px;font-weight:600">${title}</div>
      <div style="font-size:17px;opacity:.9;margin-top:2px">${sub}</div>
    </div>`;
  const screen = (n, title, sub, inner) =>
    shot(`<div style="width:1280px;height:800px">${caption(title, sub)}${frame(inner)}</div>`, 1280, 800, path.join(STORE, `screenshot-${n}.png`), { transparent: false });

  await screen(1, 'Save the whole page as a small, searchable PDF', 'Real text you can search and copy, images compressed up to 95%, one click.',
    `<img src="${popupImg}" style="position:absolute;top:52px;right:12px;width:280px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.08)">`);

  // Region selection, drawn the way the extension draws it.
  const box = { x: 284, y: 120, w: 610, h: 300 };
  await screen(2, 'Grab just the part you need', 'Drag a box around any area, or save just what’s on screen. As PDF, JPEG or PNG.', `
    <div style="position:absolute;top:45px;left:0;right:0;bottom:0">
      <div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;outline:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.6),0 0 0 2000px rgba(0,0,0,.42)"></div>
      <div style="position:absolute;left:50%;top:14px;transform:translateX(-50%);font:14px/1.3 ${FONT};color:#fff;background:rgba(0,0,0,.78);padding:7px 12px;border-radius:7px">Drag to select an area · Esc to cancel</div>
      <div style="position:absolute;left:${box.x}px;top:${box.y + box.h + 8}px;font:13px ${FONT};color:#fff;background:rgba(0,0,0,.78);padding:3px 8px;border-radius:6px">${box.w} × ${box.h}</div>
    </div>`);

  // File sizes of the same recipe page, from real captures.
  const sizes = [['Off', 8.8, '#9aa0a6'], ['Light', 1.45, '#4285F4'], ['Medium', 1.18, '#1A73E8'], ['High', 0.48, '#188038']];
  const bars = sizes.map(([name, mb, color]) => `
    <div style="display:grid;grid-template-columns:84px 1fr 78px;align-items:center;gap:14px;margin:14px 0">
      <div style="font-size:17px;font-weight:600;color:#3c4043">${name}</div>
      <div style="height:26px;border-radius:13px;background:#e8eaed;overflow:hidden"><div style="height:100%;width:${Math.max(3, (mb / 8.8) * 100)}%;background:${color};border-radius:13px"></div></div>
      <div style="font-size:17px;color:#3c4043;text-align:right;font-variant-numeric:tabular-nums">${mb >= 1 ? `${mb} MB` : `${Math.round(mb * 1000)} KB`}</div>
    </div>`).join('');
  await screen(3, 'Smaller files, same sharp text', 'Pick a compression level. The text stays real, searchable text at every level.', `
    <div style="position:absolute;top:45px;left:0;right:0;bottom:0;background:rgba(255,255,255,.72)"></div>
    <div style="position:absolute;top:120px;left:50%;transform:translateX(-50%);width:640px;background:#fff;border-radius:16px;padding:28px 36px;box-shadow:0 10px 32px rgba(60,64,67,.28),0 0 0 1px rgba(60,64,67,.08);font-family:${FONT}">
      <div style="font-size:15px;color:#5f6368">This recipe page saved as a PDF</div>
      <div style="font-size:24px;font-weight:600;color:#202124;margin:4px 0 10px">95% smaller at High</div>
      ${bars}
      <div style="font-size:13.5px;color:#5f6368;margin-top:14px">WebP photos (which PDFs can’t hold) become JPEGs, and oversized images are scaled to how they’re shown.</div>
    </div>`);
  console.log('screenshots done');
}

await browser.close();
