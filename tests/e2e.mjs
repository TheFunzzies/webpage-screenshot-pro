// End-to-end tests: the real extension in Chrome for Testing, capturing the
// local pages in fixtures/ (and, with --live, a few real websites).
// Run: npm test            (fixtures; about a minute)
//      npm run test:live   (real sites; needs internet, a few minutes)
// Saved files are kept in tests/output/downloads for a look afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
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

async function pdfOf(url, opts, extra) {
  const run = await session.capture(url, { format: 'pdf', ...opts }, extra);
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

  // ---------- Markdown ----------

  async function markdownOf(opts, extra) {
    const run = await session.capture(`${base}/markdown.html`, { format: 'md', ...opts }, extra);
    await run.page.close();
    assert.ok(run.result?.ok, `capture failed: ${run.result?.error}`);
    assert.equal(run.files.length, 1, 'expected one Markdown file');
    assert.match(run.files[0], /\.md$/);
    return { ...run, md: fs.readFileSync(run.files[0], 'utf8') };
  }

  test('Markdown: full page', async () => {
    const { md, ms } = await markdownOf({ loadLazy: false });
    const has = (text) => assert.ok(md.includes(text), `missing ${JSON.stringify(text)} in:\n${md}`);
    const lacks = (text) => assert.ok(!md.includes(text), `unexpected ${JSON.stringify(text)} in:\n${md}`);
    has('# Apple pie\n\nA **classic** pie with *tart* apples and ***lots*** of butter.');
    has('[the old recipe](<https://example.com/pie%20(old)>)');
    has('or <https://example.com/>.');
    has('Prices use \\* and \\_ and \\| characters, and `` a|b `c` `` is code.\\\nThis line comes after a break.');
    has('1\\. This paragraph starts like a list item.');
    has('Area a<sup>2</sup> of H<sub>2</sub>O is $a+b$ and $x^2$.');
    has('## Ingredients\n\n- 6 apples\n  - Granny Smith\n  - Honeycrisp\n- [x] Butter\n\n## Steps');
    has('3. Peel the apples.\n\n   Slice them thin.\n4. Bake.');
    has('> Best pie I ever had.\n>\n> — A reader');
    has('```js\nfunction bake(pie) {\n  return pie;\n\n}\n```');
    has('| Item | Price | Note |\n| :--- | ---: | :--- |\n| Apples | $4.50 | Fresh \\| local |\n| Butter | 3 | Line one<br>line two |\n| Total |  | 7.50 |');
    has('\n\nLayout cell text.\n\n');
    has('![A \\[golden\\] pie](');
    has('*The finished pie*\n\n---\n\nDiv soup line one\n\nDiv soup line two');
    has('Far down the page.');
    for (const text of ['Home', 'Copyright footer', 'Chat with us', 'Hidden item', 'Aria hidden', 'opens in a new tab', 'title:']) lacks(text);
    return `${ms} ms, ${md.length} characters`;
  });

  test('Markdown: menus, footer and front matter kept when asked', async () => {
    const { md } = await markdownOf({ loadLazy: false, mainOnly: false, hideFloating: false, stamp: true });
    assert.match(md, /^---\ntitle: "Markdown test page"\nsource: "http[^"]+\/markdown\.html"\nsaved: \d{4}-\d\d-\d\d \d\d:\d\d\n---\n\n/);
    for (const text of ['[Home](', 'Copyright footer', 'Chat with us']) assert.ok(md.includes(text), `missing ${text}`);
  });

  test('Markdown: lazy loading still gives the text', async () => {
    const { md, ms } = await markdownOf({ loadLazy: true });
    assert.ok(md.includes('# Apple pie') && md.includes('Far down the page.'));
    return `${ms} ms`;
  });

  test('Markdown: visible area leaves out what is below the window', async () => {
    const { md } = await markdownOf({ mode: 'visible' });
    assert.ok(md.includes('# Apple pie'), md);
    assert.ok(!md.includes('Far down the page.'), md);
  });

  test('Markdown: region holds only what is in the box', async () => {
    // The box around the ingredients list, as the page first opens.
    const { page } = await session.open(`${base}/markdown.html`);
    const r = await page.$eval('h2 + ul', (ul) => ul.getBoundingClientRect().toJSON());
    await page.close();
    const { md } = await markdownOf({ mode: 'region', region: { x: r.x, y: r.y, w: r.width, h: r.height } });
    assert.ok(md.includes('- 6 apples') && md.includes('Honeycrisp'), md);
    assert.ok(!md.includes('Apple pie') && !md.includes('Steps'), md);
  });

  test('Markdown: copy puts the text on the clipboard', async () => {
    const context = session.browser.defaultBrowserContext();
    await context.overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const run = await session.capture(`${base}/markdown.html`, { format: 'md', action: 'copy', loadLazy: false });
    try {
      assert.ok(run.result.ok, run.result.error);
      assert.ok(run.result.copied, `not copied: ${run.result.note}`);
      const text = await run.page.evaluate(() => navigator.clipboard.readText());
      assert.ok(text.startsWith('# Apple pie'), text.slice(0, 200));
      return `${text.length} characters on the clipboard`;
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

  // ---------- Sideways scrolling ----------

  // Measured on the page before capturing: where the wide table ends, a
  // point inside its last column (clear of the text), where the page heading
  // sits (page pixels), and the window.
  let wide;
  const measureWide = async (page) => {
    wide = await page.evaluate(() => {
      const scroller = document.querySelector('.scroll');
      const box = scroller.getBoundingClientRect();
      const last = document.querySelector('th.last').getBoundingClientRect();
      return {
        right: Math.round(box.left + scrollX + scroller.scrollWidth),
        last: { x: Math.round(last.left + 4 + scrollX), y: Math.round(last.top + 4 + scrollY) },
        heading: Math.round(document.querySelector('h1').getBoundingClientRect().left),
        vw: document.documentElement.clientWidth,
        dpr: devicePixelRatio,
      };
    });
  };
  // Where a piece of text starts on the page, in CSS pixels (-1: not found).
  const xOf = (pdf, str) => {
    for (const p of pdf.pages) {
      const item = p.items.find((i) => i.str.includes(str));
      if (item) return px(item.x);
    }
    return -1;
  };
  const pixel = async (file, x, y) => {
    const img = await loadImage(fs.readFileSync(file));
    const ctx = createCanvas(img.width, img.height).getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { width: img.width, rgb: [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)] };
  };
  const isRed = ([r, g, b]) => r > 150 && g < 90 && b < 90;

  test("wide table: every column on one long page, at the window's layout", async () => {
    const { pdf, note } = await pdfOf(`${base}/wide-table.html`, {}, { before: measureWide });
    assert.equal(pdf.pages.length, 1);
    const width = px(pdf.pages[0].width);
    assert.ok(width >= wide.right, `page ${width}px wide, table ends at ${wide.right}px`);
    // The carousels, the code block and the off-screen menu don't widen it.
    assert.ok(width <= wide.right + 40, `page ${width}px wide, table ends at ${wide.right}px`);
    const x = xOf(pdf, 'COLUMN-LAST');
    assert.ok(x > wide.vw && x < width, `COLUMN-LAST at ${x}px on a ${width}px page`);
    // Laid out at the window's width: the centred heading hasn't moved.
    assert.ok(Math.abs(xOf(pdf, 'Ratings') - wide.heading) <= 3, `heading at ${xOf(pdf, 'Ratings')}px, on screen ${wide.heading}px`);
    for (const m of ['CODE-END', 'PAGE-END', 'TABLE-AFTER']) assert.match(pdf.text, new RegExp(m));
    return `${note}, ${width}px wide (window ${wide.vw}px)`;
  });

  test("wide table: option off keeps the window's width", async () => {
    const { pdf, note } = await pdfOf(`${base}/wide-table.html`, { sideways: false }, { before: measureWide });
    const width = px(pdf.pages[0].width);
    assert.ok(Math.abs(width - wide.vw) <= 2, `page ${width}px wide, window ${wide.vw}px`);
    return note;
  });

  test('wide table on Letter pages is scaled to fit', async () => {
    const { pdf, note } = await pdfOf(`${base}/wide-table.html`, { layout: 'letter' });
    assert.ok(pdf.pages.every((p) => p.width === 612 && p.height === 792), 'not Letter size');
    const at = pdf.pages[0].items.find((i) => i.str.includes('COLUMN-LAST'));
    assert.ok(at && at.x > 0 && at.x < 612 - 20, `COLUMN-LAST at ${at?.x}pt on a 612pt page`);
    return note;
  });

  test('wide table as PNG: the last column is in the picture', async () => {
    const run = await session.capture(`${base}/wide-table.html`, { format: 'png' }, { before: measureWide });
    // Afterwards the page is back as it was: the table scrolls again.
    const after = await run.page.evaluate(() => {
      const box = document.querySelector('.scroll');
      return { scrolls: box.scrollWidth > box.clientWidth, styled: [box, document.documentElement, document.body].some((el) => el.hasAttribute('style')) };
    });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    assert.deepEqual(after, { scrolls: true, styled: false }, 'page not restored');
    const { width, rgb } = await pixel(run.files[0], wide.last.x * wide.dpr, wide.last.y * wide.dpr);
    assert.ok(width >= wide.right * wide.dpr, `image ${width}px wide, table ends at ${wide.right}px`);
    assert.ok(isRed(rgb), `last column at ${wide.last.x},${wide.last.y} is rgb(${rgb}), not red`);
    return `${run.ms} ms, ${width}px wide`;
  });

  test('page wider than the window: PDF and JPEG are full width', async () => {
    let view;
    const before = async (page) => {
      view = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, dpr: devicePixelRatio }));
    };
    const { pdf, note } = await pdfOf(`${base}/wide-page.html`, {}, { before });
    const width = px(pdf.pages[0].width);
    assert.ok(view.sw >= 2600 && width >= view.sw, `page ${width}px wide, document ${view.sw}px`);
    assert.ok(xOf(pdf, 'PAGE-RIGHT-EDGE') > view.vw, 'right-hand box not past the window');
    const run = await session.capture(`${base}/wide-page.html`, { format: 'jpeg' });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    // The middle of the red box at the right-hand end of the strip.
    const img = await pixel(run.files[0], (2600 - 150) * view.dpr, (60 + 150) * view.dpr);
    assert.ok(img.width >= 2600 * view.dpr, `image ${img.width}px wide`);
    assert.ok(isRed(img.rgb), `right-hand box is rgb(${img.rgb}), not red`);
    return `${note}, PDF ${width}px, JPEG ${img.width}px wide`;
  });

  // ---------- Page breaks ----------

  test('long inline-block article: no blank pages, page restored', async () => {
    let h;
    const before = async (page) => { h = await page.evaluate(() => document.documentElement.scrollHeight); };
    const run = await session.capture(`${base}/inline-grid.html`, { format: 'pdf' }, { before });
    // Elements still carrying a style attribute afterwards (none expected).
    const styled = await run.page.evaluate(() => [...document.querySelectorAll('.grid, .grid__item')]
      .filter((el) => el.hasAttribute('style')).map((el) => `${el.className}: "${el.getAttribute('style')}"`).join('; ') || false);
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const pdf = await readPdf(run.files[0]);
    assert.ok(h > 19200, `fixture only ${h}px tall`);
    assert.equal(pdf.pages.length, Math.ceil((h + 2) / 19200), `${pdf.pages.length} pages for a ${h}px page`);
    // The article starts on the first page, right under its title.
    assert.match(pdf.pages[0].text, /SITE-HEADER[^]*ARTICLE-TITLE[^]*ARTICLE-START/);
    assert.match(pdf.text, /SIDEBAR-BOX/);
    assert.match(pdf.text, /ARTICLE-END/);
    assert.equal(styled, false, 'page not restored');
    return `${run.ms} ms, ${pdf.pages.length} pages for ${h}px`;
  });

  test('long inline-block article on Letter pages: starts on page 1, every page has text', async () => {
    const { pdf, note } = await pdfOf(`${base}/inline-grid.html`, { layout: 'letter' });
    assert.match(pdf.pages[0].text, /ARTICLE-START/);
    const thin = pdf.pages.findIndex((p, i) => i < pdf.pages.length - 1 && p.text.length < 300);
    assert.equal(thin, -1, `page ${thin + 1} is (nearly) blank`);
    // Lines break between paragraphs, so none is lost or doubled.
    const nums = pdf.text.match(/Paragraph \d+ /g).map((s) => +s.match(/\d+/)[0]);
    assert.deepEqual(nums, Array.from({ length: 949 }, (_, i) => i + 1));
    return note;
  });

  test('same page captured twice in a row', async () => {
    // The first capture's "Saved" card is still up when the second starts;
    // it must not end up in the second PDF.
    const { page, tabId } = await session.open(`${base}/floating.html`);
    const pdfs = [];
    for (let i = 0; i < 2; i++) {
      const before = new Set(listDownloads());
      const result = await session.worker.evaluate((id, o) => run(id, o), tabId, { format: 'pdf' });
      assert.ok(result?.ok, `capture ${i + 1} failed: ${result?.error}`);
      pdfs.push(await readPdf((await session.waitForFiles(before, 1))[0]));
    }
    const cards = await page.evaluate(() => document.querySelectorAll('[data-fpp-overlay]').length);
    await page.close();
    assert.match(pdfs[1].text, /FOOTER-MARKER/);
    assert.doesNotMatch(pdfs[1].text, /Check your downloads|Webpage Screenshot Pro/, 'the first capture\'s card is in the second PDF');
    assert.ok(cards <= 1, `${cards} progress cards on the page`);
    return `${kb(pdfs[0].bytes)}, then ${kb(pdfs[1].bytes)}`;
  });

  test('a new capture stops an earlier copy still loading the page', async () => {
    // As if the worker had died mid-load: an injected copy keeps scrolling
    // through the page while a new capture starts.
    const { page, tabId } = await session.open(`${base}/lazy.html`);
    await session.worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => { window.__fpp.begin({ card: false }); window.__fpp.loadAll({ maxMs: 30000 }); },
      });
    }, tabId);
    await new Promise((r) => setTimeout(r, 500));
    const before = new Set(listDownloads());
    const result = await session.worker.evaluate((id, o) => run(id, o), tabId, { format: 'pdf', loadLazy: false });
    assert.ok(result?.ok, `capture failed: ${result?.error}`);
    await session.waitForFiles(before, 1);
    const scrolled = [];
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 500));
      scrolled.push(await page.evaluate(() => scrollY));
    }
    await page.close();
    assert.ok(scrolled.every((y) => y === 0), `the earlier copy kept scrolling: ${scrolled.join(' → ')}`);
    return `scroll after: ${scrolled.join(', ')}`;
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
    assert.equal(await page.$eval('#sideways', (c) => c.closest('label').hidden), true);
    await page.select('#mode', 'full');
    await page.select('#format', 'md');
    assert.equal(await page.$eval('#go', (b) => b.textContent), 'Save as Markdown');
    assert.equal(await page.$eval('#mainOnly', (c) => c.closest('label').hidden), false);
    assert.equal(await page.$eval('#stamp', (c) => c.closest('label').hidden), false);
    assert.equal(await page.$eval('#sideways', (c) => c.closest('label').hidden), true);
    assert.equal(await page.$eval('#layout', (s) => s.closest('label').hidden), true);
    assert.match(await page.$eval('#copy', (b) => b.title), /Markdown text/);
    await page.select('#format', 'png');
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

  test('live: Wikipedia article as Markdown', async () => {
    const run = await session.capture('https://en.wikipedia.org/wiki/Pythagorean_theorem', { format: 'md' });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const md = fs.readFileSync(run.files[0], 'utf8');
    assert.match(md, /^# Pythagorean theorem/m);
    assert.match(md, /^## Proofs/m);
    assert.match(md, /^\$\$\na\^\{2\}\+b\^\{2\}=c\^\{2\}\.?\n\$\$$/m, 'the equation as TeX');
    assert.match(md, /\*a\*<sup>2<\/sup>/, 'superscripts');
    assert.doesNotMatch(md, /Jump to content|Main menu/, 'menus left out');
    return `${run.ms} ms, ${Math.round(md.length / 1024)} KB`;
  });

  test('live: Consumer Reports ratings chart is captured sideways', async () => {
    let chart;
    const before = async (page) => {
      // The chart is drawn by script after the page loads (there's an empty
      // one for the Customize tab too).
      const wide = () => {
        const el = [...document.querySelectorAll('.chart-ratings-wrapper')].sort((a, b) => b.scrollWidth - a.scrollWidth)[0];
        return el && el.scrollWidth > el.clientWidth + 100;
      };
      await page.waitForFunction(wide, { timeout: 30000 }).catch(() => {});
      chart = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.chart-ratings-wrapper')].sort((a, b) => b.scrollWidth - a.scrollWidth)[0];
        return el && { right: Math.round(el.getBoundingClientRect().left + scrollX + el.scrollWidth), vw: document.documentElement.clientWidth };
      });
    };
    const url = 'https://www.consumerreports.org/appliances/ranges/electric-induction-ranges/c37181/';
    const { pdf, note } = await pdfOf(url, {}, { before });
    assert.ok(chart && chart.right > chart.vw, `no sideways-scrolling ratings chart found (${JSON.stringify(chart)}); the page changed or the site blocked the test browser`);
    const width = px(pdf.pages[0].width);
    assert.ok(width >= chart.right, `page ${width}px wide, chart ends at ${chart.right}px`);
    const run = await session.capture(url, { format: 'png' }, { before });
    await run.page.close();
    assert.ok(run.result.ok, run.result.error);
    const img = await loadImage(fs.readFileSync(run.files[0]));
    assert.ok(img.width >= chart.right, `image ${img.width}px wide, chart ends at ${chart.right}px`);
    return `${note}, PDF ${width}px and PNG ${img.width}px wide (window ${chart.vw}px, chart ends at ${chart.right}px)`;
  });

  test('live: Yale Appliance article (one big inline-block) has no blank pages', async () => {
    let h;
    const before = async (page) => { h = await page.evaluate(() => document.documentElement.scrollHeight); };
    const { pdf, note } = await pdfOf('https://blog.yaleappliance.com/best-induction-ranges', {}, { before });
    assert.ok(h > 19200, `page only ${h}px tall; the article changed`);
    assert.ok(pdf.pages.length <= Math.ceil((h + 2) / 19200), `${pdf.pages.length} pages for a ${h}px page`);
    // The first page used to hold only the site's header.
    assert.ok(pdf.pages[0].text.length > 5000, `first page has only ${pdf.pages[0].text.length} characters`);
    return `${note} for ${h}px`;
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
