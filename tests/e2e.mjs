// End-to-end tests: the real extension in Chrome for Testing, capturing the
// local pages in fixtures/ (and, with --live, a few real websites).
// Run: npm test            (fixtures; about a minute)
//      npm run test:live   (real sites; needs internet, a few minutes)
// Saved files are kept in tests/output/downloads for a look afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImage } from '@napi-rs/canvas';
import { launch } from './lib/browser.mjs';
import { serveFixtures, generateImages } from './lib/fixtures.mjs';
import { readPdf } from './lib/pdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'output');
const live = process.argv.includes('--live');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

generateImages();
const { server, base } = await serveFixtures();
const session = await launch({ downloadDir: path.join(OUT, 'downloads'), headless: !process.argv.includes('--headed') });
const today = fileDate(new Date());

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const px = (pt) => Math.round((pt * 96) / 72);
const flateBytes = (pdf) => Object.entries(pdf.images).filter(([k]) => k.startsWith('Flate')).reduce((a, [, v]) => a + v.bytes, 0);
const kb = (n) => `${Math.round(n / 1024)} KB`;
const listDownloads = (dir = path.join(OUT, 'downloads')) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((d) => (d.isDirectory() ? listDownloads(path.join(dir, d.name)) : [path.join(dir, d.name)]));

async function pdfOf(url, opts) {
  const run = await session.capture(url, { format: 'pdf', ...opts });
  assert.ok(run.result?.ok, `capture failed: ${run.result?.error}`);
  assert.equal(run.files.length, 1, 'expected one PDF');
  const pdf = await readPdf(run.files[0]);
  await run.page.close();
  return { ...run, pdf, note: `${run.ms} ms, ${kb(pdf.bytes)}, ${pdf.pages.length} page(s)` };
}

// ---------- Fixture pages ----------

if (!live) {
  test('scrolling sidebar is captured in full', async () => {
    const { pdf, note } = await pdfOf(`${base}/sidebar.html`);
    assert.equal(pdf.pages.length, 1);
    // 100 entries x 30px: the page must be at least that tall.
    assert.ok(px(pdf.pages[0].height) >= 3000, `page only ${px(pdf.pages[0].height)}px tall; sidebar was cut`);
    assert.match(pdf.text, /TOC-100/);
    assert.match(pdf.text, /MAIN-END/);
    return note;
  });

  test('lazy images all load; full-screen hero stays screen-sized', async () => {
    const { pdf, note } = await pdfOf(`${base}/lazy.html`);
    const jpegs = pdf.images.DCTDecode?.count || 0;
    assert.ok(jpegs >= 40, `only ${jpegs} of 40 photos in the PDF`);
    assert.match(pdf.text, /HERO-MARKER/);
    assert.match(pdf.text, /FOOTER-MARKER/);
    const height = pdf.pages.reduce((a, p) => a + px(p.height), 0);
    assert.ok(height < 40000, `page is ${height}px tall; the 100vh hero probably blew up`);
    return note;
  });

  test('Letter pages', async () => {
    const { pdf, note } = await pdfOf(`${base}/lazy.html`, { layout: 'letter' });
    // ~37,000px of page at Letter width is about 23 pages.
    assert.ok(pdf.pages.length >= 20, `only ${pdf.pages.length} pages`);
    assert.ok(pdf.pages.every((p) => p.width === 612 && p.height === 792), 'not Letter size');
    assert.match(pdf.text, /FOOTER-MARKER/);
    return note;
  });

  test('floating elements hidden, header kept', async () => {
    const { pdf, note } = await pdfOf(`${base}/floating.html`);
    assert.match(pdf.text, /HEADER-MARKER/);
    assert.match(pdf.text, /FOOTER-MARKER/);
    for (const m of ['CHAT-MARKER', 'COOKIE-MARKER', 'POPUP-MARKER']) assert.doesNotMatch(pdf.text, new RegExp(m));
    return note;
  });

  test('floating elements kept when the option is off', async () => {
    const { pdf, note } = await pdfOf(`${base}/floating.html`, { hideFloating: false });
    assert.match(pdf.text, /CHAT-MARKER/);
    return note;
  });

  test('heavy text shadows render quickly', async () => {
    const { pdf, ms, note } = await pdfOf(`${base}/shadows.html`);
    assert.ok(ms < 30000, `took ${ms} ms`);
    assert.match(pdf.text, /block 120/);
    assert.match(pdf.text, /SHADOWS-END/);
    return note;
  });

  const sizes = {};
  for (const level of ['off', 'light', 'medium', 'high']) {
    test(`compression ${level}`, async () => {
      const { pdf, note } = await pdfOf(`${base}/images.html`, { compression: level });
      assert.match(pdf.text, /IMAGES-END/);
      sizes[level] = { total: pdf.bytes, flate: flateBytes(pdf) };
      // The page's WebP photos, CSS background included, should all be JPEG from Light up.
      if (level !== 'off') assert.ok(sizes[level].flate < 1024 * 1024, `still ${kb(sizes[level].flate)} of lossless images`);
      if (level === 'medium' && sizes.off) assert.ok(pdf.bytes < sizes.off.total * 0.5, `medium ${kb(pdf.bytes)} vs off ${kb(sizes.off.total)}`);
      if (level === 'high') {
        if (sizes.medium) assert.ok(pdf.bytes < sizes.medium.total, `high ${kb(pdf.bytes)} not below medium ${kb(sizes.medium.total)}`);
        // Everything photographic, including the transparent product shot,
        // should now be JPEG.
        assert.ok(sizes.high.flate < 150 * 1024, `still ${kb(sizes.high.flate)} of lossless images`);
      }
      return `${note}, lossless images ${kb(flateBytes(pdf))}`;
    });
  }

  test('address and date stamp', async () => {
    const { pdf, note } = await pdfOf(`${base}/floating.html`, { stamp: true });
    assert.match(pdf.text, /127\.0\.0\.1:\d+\/floating\.html/);
    assert.match(pdf.text, /Page 1 of 1/);
    assert.match(pdf.text, /Floating Fixture/);
    return note;
  });

  test('PDF properties record title, address and date', async () => {
    const { pdf, note } = await pdfOf(`${base}/floating.html`);
    assert.equal(pdf.info.Title, 'Floating Fixture');
    assert.match(pdf.info.Subject || '', /^Saved from http:\/\/127\.0\.0\.1:\d+\/floating\.html on /);
    assert.equal(pdf.info.Creator, 'Webpage Screenshot Pro');
    return note;
  });

  test('file name style and save folder', async () => {
    const run = await session.capture(`${base}/floating.html`, { nameFormat: 'site-title-date', folder: 'Tests/Sub folder' });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const rel = path.relative(path.join(OUT, 'downloads'), run.files[0]).split(path.sep).join('/');
    assert.equal(rel, `Tests/Sub folder/127.0.0.1 - Floating Fixture ${today}.pdf`);
    return rel;
  });

  test('JPEG export, split into parts when very tall', async () => {
    const run = await session.capture(`${base}/lazy.html`, { format: 'jpeg' });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    assert.ok(run.files.length >= 2, `expected parts, got ${run.files.length} file(s)`);
    assert.ok(run.files.every((f) => /\(part \d+ of \d+\)\.jpg$/.test(f)), 'part names');
    let total = 0;
    for (const f of run.files) total += (await loadImage(fs.readFileSync(f))).height;
    assert.ok(total > 36000, `images add up to only ${total}px`);
    return `${run.ms} ms, ${run.files.length} parts, ${total}px tall`;
  });

  test('PNG export of the sidebar page', async () => {
    const run = await session.capture(`${base}/sidebar.html`, { format: 'png' });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    assert.equal(run.files.length, 1);
    const img = await loadImage(fs.readFileSync(run.files[0]));
    assert.ok(img.height >= 3000, `image only ${img.height}px tall; sidebar cut`);
    return `${run.ms} ms, ${img.width}x${img.height}`;
  });

  test('copy to clipboard', async () => {
    const context = session.browser.defaultBrowserContext();
    await context.overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const run = await session.capture(`${base}/floating.html`, { action: 'copy' });
    try {
      assert.ok(run.result.ok, run.result.error);
      assert.ok(run.result.copied, `not copied: ${run.result.note}`);
      const size = await run.page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        return (await item.getType('image/png')).size;
      });
      assert.ok(size > 1000, 'clipboard image is empty');
      return `${run.ms} ms, ${kb(size)} PNG on the clipboard`;
    } finally {
      await run.page.close();
    }
  });

  test('Stop cancels without saving', async () => {
    const run = await session.capture(`${base}/lazy.html`, {}, { cancelAfterMs: 300 });
    await run.page.close();
    assert.equal(run.result.cancelled, true, JSON.stringify(run.result));
    return `${run.ms} ms`;
  });

  // ---------- Visible area and region ----------

  const imageSize = async (file) => {
    const img = await loadImage(fs.readFileSync(file));
    return { w: img.width, h: img.height };
  };

  test('visible area as PNG is the size of the window', async () => {
    let view;
    const run = await session.capture(`${base}/lazy.html`, { mode: 'visible', format: 'png' }, {
      before: async (page) => { view = await page.evaluate(() => ({ w: innerWidth * devicePixelRatio, h: innerHeight * devicePixelRatio })); },
    });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const size = await imageSize(run.files[0]);
    assert.ok(Math.abs(size.w - view.w) <= 2 && Math.abs(size.h - view.h) <= 2, `image ${size.w}x${size.h}, window ${view.w}x${view.h}`);
    return `${run.ms} ms, ${size.w}x${size.h}`;
  });

  test('region as PNG is cropped to the box', async () => {
    const run = await session.capture(`${base}/lazy.html`, { mode: 'region', format: 'png', region: { x: 100, y: 50, w: 300, h: 200 } });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const size = await imageSize(run.files[0]);
    assert.ok(Math.abs(size.w - 300) <= 2 && Math.abs(size.h - 200) <= 2, `image ${size.w}x${size.h}`);
    return `${run.ms} ms, ${size.w}x${size.h}`;
  });

  test('region drawn with the mouse', async () => {
    const job = await session.start(`${base}/lazy.html`, { mode: 'region', format: 'png' });
    await job.page.waitForSelector('[data-fpp-overlay]', { timeout: 10000 });
    await job.page.mouse.move(200, 150);
    await job.page.mouse.down();
    await job.page.mouse.move(350, 250, { steps: 5 });
    await job.page.mouse.move(500, 350, { steps: 5 });
    await job.page.screenshot({ path: path.join(OUT, 'region-select.png') });
    await job.page.mouse.up();
    const run = await session.finish(job);
    const leftover = await run.page.evaluate(() => !!document.querySelector('[data-fpp-overlay]'));
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const size = await imageSize(run.files[0]);
    assert.ok(Math.abs(size.w - 300) <= 2 && Math.abs(size.h - 200) <= 2, `image ${size.w}x${size.h}`);
    assert.equal(leftover, false, 'selection overlay left on the page');
    return `${size.w}x${size.h}`;
  });

  test('Esc cancels region selection', async () => {
    const job = await session.start(`${base}/lazy.html`, { mode: 'region', format: 'png' });
    await job.page.waitForSelector('[data-fpp-overlay]', { timeout: 10000 });
    await job.page.keyboard.press('Escape');
    const run = await session.finish(job);
    await run.page.close();
    assert.equal(run.result.cancelled, true, JSON.stringify(run.result));
  });

  test('visible area as PDF: what is on screen, as real text', async () => {
    // Measured beforehand: Chrome's "started debugging" bar takes some of the
    // window for a few seconds after a PDF capture.
    let view;
    const scrollTo = async (page) => {
      view = await page.evaluate(() => {
        const p = [...document.querySelectorAll('main p')][2];
        scrollTo(0, p.getBoundingClientRect().top + scrollY - 100);
        return { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight };
      });
    };
    const run = await session.capture(`${base}/floating.html`, { mode: 'visible', format: 'pdf' }, { before: scrollTo });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const pdf = await readPdf(run.files[0]);
    assert.equal(pdf.pages.length, 1);
    assert.ok(Math.abs(px(pdf.pages[0].height) - view.h) <= 3, `page ${px(pdf.pages[0].height)}px tall, window ${view.h}px`);
    assert.match(pdf.text, /Paragraph three/);
    assert.doesNotMatch(pdf.text, /Paragraph one/);
    // The pinned header and the chat bubble were on screen, so they're in.
    assert.match(pdf.text, /HEADER-MARKER/);
    assert.match(pdf.text, /CHAT-MARKER/);
    return `${run.ms} ms, ${kb(pdf.bytes)}`;
  });

  test('region as PDF is trimmed to the box', async () => {
    const run = await session.capture(`${base}/lazy.html`, { mode: 'region', format: 'pdf', region: { x: 40, y: 120, w: 500, h: 300 } });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const pdf = await readPdf(run.files[0]);
    assert.equal(pdf.pages.length, 1);
    const { width, height } = pdf.pages[0];
    assert.ok(Math.abs(px(width) - 500) <= 2 && Math.abs(px(height) - 300) <= 2, `page ${px(width)}x${px(height)}px`);
    assert.match(pdf.info.Subject || '', /Saved from/);
    return `${run.ms} ms, ${px(width)}x${px(height)}px`;
  });

  test('region PDF is compressed too', async () => {
    // The top-left of the images page: the three big WebP photos.
    const region = { x: 0, y: 0, w: 1000, h: 300 };
    const off = await session.capture(`${base}/images.html`, { mode: 'region', format: 'pdf', region, compression: 'off' });
    const high = await session.capture(`${base}/images.html`, { mode: 'region', format: 'pdf', region, compression: 'high' });
    await off.page.close();
    await high.page.close();
    assert.ok(off.result.ok && high.result.ok, off.result.error || high.result.error);
    const [a, b] = [await readPdf(off.files[0]), await readPdf(high.files[0])];
    assert.ok(b.bytes < a.bytes * 0.2, `high ${kb(b.bytes)} vs off ${kb(a.bytes)}`);
    return `off ${kb(a.bytes)} → high ${kb(b.bytes)}`;
  });

  // ---------- Save all tabs ----------

  test('save all tabs', async () => {
    const pages = [];
    for (const name of ['sidebar', 'floating', 'shadows']) pages.push((await session.open(`${base}/${name}.html`)).page);
    const before = new Set(listDownloads());
    const windowId = await session.worker.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].windowId);
    const started = Date.now();
    await session.worker.evaluate((w) => saveAllTabs(w, { format: 'pdf' }), windowId);
    const files = await session.waitForFiles(before, 3);
    for (const p of pages) await p.close();
    // Earlier tests may have saved files with the same names, so Chrome may add "(1)".
    const names = files.map((f) => path.basename(f).replace(/ \(\d+\)(?=\.pdf$)/, '')).sort();
    assert.deepEqual(names, [`Floating Fixture ${today}.pdf`, `Shadows Fixture ${today}.pdf`, `Sidebar Fixture ${today}.pdf`]);
    return `${Date.now() - started} ms, ${files.length} PDFs`;
  });

  // ---------- Debug logs ----------

  const readLogs = async () => {
    await new Promise((r) => setTimeout(r, 800)); // log writes are batched
    return session.worker.evaluate(async () => (await chrome.storage.local.get('logs')).logs || []);
  };

  test('errors are logged, with only the site recorded', async () => {
    await session.worker.evaluate(() => chrome.storage.local.set({ logs: [] }));
    const run = await session.capture('chrome://version', {});
    await run.page.close();
    assert.equal(run.result.ok, false);
    const logs = await readLogs();
    const failed = logs.find((l) => l.event === 'Capture failed');
    assert.ok(failed, `no error entry in ${JSON.stringify(logs)}`);
    assert.match(failed.message, /can't capture|does not let/i);
    const okRun = await session.capture(`${base}/floating.html?secret=1`, {});
    await okRun.page.close();
    const started = (await readLogs()).filter((l) => l.event === 'Capture started').at(-1);
    assert.equal(started.url, new URL(base).host, 'full address logged while debug logging is off');
    assert.ok(!(await readLogs()).some((l) => l.level === 'debug'), 'step details logged while debug logging is off');
    return `${logs.length} entries`;
  });

  test('debug logging records each step and the full address', async () => {
    await session.worker.evaluate(() => chrome.storage.sync.set({ debugLog: true }));
    await new Promise((r) => setTimeout(r, 200));
    const run = await session.capture(`${base}/floating.html?secret=1`, {});
    await run.page.close();
    await session.worker.evaluate(() => chrome.storage.sync.set({ debugLog: false }));
    const logs = await readLogs();
    const steps = logs.filter((l) => l.event.startsWith('Step: '));
    assert.ok(steps.length >= 3, `only ${steps.length} step entries`);
    assert.match(logs.filter((l) => l.event === 'Capture started').at(-1).url, /floating\.html\?secret=1$/);
    return `${steps.length} steps: ${steps.map((s) => s.event.slice(6)).join(' → ')}`;
  });

  test('logs page shows entries', async () => {
    const page = await session.browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${session.extensionId}/logs.html`);
    await page.waitForSelector('#list li');
    const count = await page.$$eval('#list li', (li) => li.length);
    await page.select('#filter', 'error');
    const errorRows = await page.$$eval('#list li', (li) => li.length);
    await page.select('#filter', 'all');
    await page.screenshot({ path: path.join(OUT, 'logs.png'), fullPage: true });
    await page.close();
    assert.deepEqual(errors, []);
    assert.ok(count >= 3 && errorRows >= 1, `${count} rows, ${errorRows} errors`);
    return `${count} rows (${errorRows} errors), screenshot in output/logs.png`;
  });

  test('popup loads and switches formats', async () => {
    const page = await session.browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`chrome-extension://${session.extensionId}/popup.html`);
    await page.waitForFunction(() => document.getElementById('go').textContent === 'Save as PDF');
    await page.select('#format', 'png');
    assert.equal(await page.$eval('#go', (b) => b.textContent), 'Save as PNG');
    assert.equal(await page.$eval('#compression', (s) => s.closest('[data-show]').hidden), true);
    await page.select('#mode', 'region');
    assert.equal(await page.$eval('#go', (b) => b.textContent), 'Select region (PNG)');
    assert.equal(await page.$eval('#loadLazy', (c) => c.closest('label').hidden), true);
    await page.select('#mode', 'full');
    await page.click('#more summary');
    await page.select('#nameFormat', 'title-datetime');
    assert.match(await page.$eval('#nameExample', (e) => e.textContent), /\d{4}-\d\d-\d\d \d\d\.\d\d\.png$/);
    await page.screenshot({ path: path.join(OUT, 'popup.png') });
    await page.close();
    // Put the settings back for the next run.
    await session.worker.evaluate(() => chrome.storage.sync.clear());
    assert.deepEqual(errors, []);
    return 'screenshot in output/popup.png';
  });
}

// ---------- Real websites (--live) ----------

if (live) {
  test('live: Alpha Vantage docs (huge, heavy text shadows, scrolling sidebar)', async () => {
    const { pdf, ms, note } = await pdfOf('https://www.alphavantage.co/documentation/');
    assert.ok(ms < 90000, `took ${ms} ms`);
    for (const t of ['function=TIME_SERIES_INTRADAY', 'function=REAL_GDP', 'function=HT_PHASOR']) assert.ok(pdf.text.includes(t), `missing ${t}`);
    return note;
  });

  test('live: SumatraPDF docs fit on one page', async () => {
    const { pdf, note } = await pdfOf('https://www.sumatrapdfreader.org/docs/SumatraPDF-portable');
    assert.equal(pdf.pages.length, 1);
    return note;
  });

  test('live: Wikipedia long article', async () => {
    const { pdf, note } = await pdfOf('https://en.wikipedia.org/wiki/United_States');
    assert.match(pdf.text, /External links/);
    return note;
  });

  test('live: TotalBoat High is much smaller than Off', async () => {
    const url = 'https://www.totalboat.com/products/lust-marine-spar-varnish';
    const off = await pdfOf(url, { compression: 'off' });
    const high = await pdfOf(url, { compression: 'high' });
    assert.ok(high.pdf.bytes < off.pdf.bytes * 0.7, `high ${kb(high.pdf.bytes)} vs off ${kb(off.pdf.bytes)}`);
    return `off ${kb(off.pdf.bytes)} → high ${kb(high.pdf.bytes)}`;
  });
}

// ---------- Run ----------

let failed = 0;
console.log(`Webpage Screenshot Pro ${JSON.parse(fs.readFileSync(path.join(HERE, '../fullpage-pdf/manifest.json'))).version}${live ? ' (live sites)' : ''}\n`);
for (const { name, fn } of tests) {
  if (only && !name.includes(only)) continue;
  try {
    const note = await fn();
    console.log(`  ok    ${name}${note ? `  (${note})` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').join('\n        ')}`);
  }
}
await session.close();
server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

function fileDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
