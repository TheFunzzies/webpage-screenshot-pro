importScripts('settings.js', 'log.js');

// Loading stops here even if the page keeps growing (infinite feeds);
// "Save now" ends it sooner.
const MAX_LOAD_MS = 30000;
// While loading, the viewport is made this many screens tall so lazy
// loaders see several screens at once.
const TALL_VIEWPORT_SCREENS = 10;
const TALL_VIEWPORT_MAX_PX = 10000;
// Acrobat and most viewers reject pages taller than 200 inches; longer
// pages are split into several tall pages.
const MAX_PAGE_PX = 200 * 96;
// Areas that scroll sideways widen the capture up to this many CSS pixels;
// anything wider is left scrolling as it is.
const MAX_WIDTH_PX = 8000;
const PAPER = { letter: { w: 8.5, h: 11 }, a4: { w: 8.27, h: 11.69 } };
const MARGIN_IN = 0.4;
// Images taller than this (in device pixels) are saved in several parts:
// Chrome's screenshots get unreliable beyond it, and JPEG tops out at 65,535.
const MAX_IMAGE_PX = 16000;
const IMAGE_JPEG_QUALITY = 90;

// How hard each compression level squeezes images. `factor` is the image
// resolution relative to its on-screen size; `resizeBelow` skips resizing
// when the saving would be small.
const COMPRESSION = {
  light: { factor: 2, quality: 0.9, resizeBelow: 0.8, reencodeJpeg: false, flatten: false, backgrounds: true },
  medium: { factor: 2, quality: 0.82, resizeBelow: 0.8, reencodeJpeg: false, flatten: false, backgrounds: true },
  high: { factor: 1, quality: 0.65, resizeBelow: 0.95, reencodeJpeg: true, flatten: true, backgrounds: true },
};

const MIME = { pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png' };
const EXT = { pdf: 'pdf', jpeg: 'jpg', png: 'png' };

// Progress ranges for each step, in percent.
const STEPS = { load: [0, 60], prepare: 62, shrink: [64, 78], render: 80, save: 95 };

// tabId -> { pct, text, cancelled, debugging }
const jobs = new Map();

class Cancelled extends Error {}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = msg?.tabId ?? sender.tab?.id;
  switch (msg?.type) {
    case 'capture':
      run(tabId, msg.opts);
      sendResponse({ started: true });
      break;
    case 'cancel':
      cancel(tabId);
      break;
    case 'saveAll':
      saveAllTabs(msg.windowId, msg.opts);
      sendResponse({ started: true });
      break;
    case 'cancelBatch':
      cancelBatch();
      break;
    case 'state': {
      const job = jobs.get(tabId);
      sendResponse({
        ...(job ? { running: true, pct: job.pct, text: job.text } : { running: false }),
        batch: batch && { index: batch.index, total: batch.total, title: batch.title },
      });
      break;
    }
    case 'progress':
      // From the page during loading; relay to the popup.
      if (sender.tab) report(sender.tab.id, msg.text, msg.pct, { fromPage: true });
      break;
  }
});

const COMMAND_MODES = { capture: undefined, 'capture-visible': 'visible', 'capture-region': 'region' };

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!(command in COMMAND_MODES) || !tab?.id) return;
  const settings = await loadSettings();
  run(tab.id, { ...settings, mode: COMMAND_MODES[command] || settings.mode });
});

// ---------- Right-click menu ----------

const menuTitle = (format) => `Save full page as ${FORMAT_NAMES[format] || 'PDF'}`;
const MENU_CONTEXTS = ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio'];

chrome.runtime.onInstalled.addListener(async () => {
  const { format } = await loadSettings();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'capture', title: menuTitle(format), contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: 'visible', title: 'Save visible area', contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: 'region', title: 'Capture a region…', contexts: MENU_CONTEXTS });
    chrome.contextMenus.create({ id: 'copy', title: 'Copy full page as image', contexts: MENU_CONTEXTS });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const settings = await loadSettings();
  if (info.menuItemId === 'capture') run(tab.id, { ...settings, mode: 'full' });
  if (info.menuItemId === 'visible') run(tab.id, { ...settings, mode: 'visible' });
  if (info.menuItemId === 'region') run(tab.id, { ...settings, mode: 'region' });
  if (info.menuItemId === 'copy') run(tab.id, { ...settings, mode: 'full', action: 'copy' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.format) {
    chrome.contextMenus.update('capture', { title: menuTitle(changes.format.newValue) }, () => void chrome.runtime.lastError);
  }
});

// Chrome's own "Cancel" on the debugging bar also stops the job.
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (reason === 'canceled_by_user' && jobs.has(tabId)) cancel(tabId);
});

async function cancel(tabId) {
  const job = jobs.get(tabId);
  if (!job || job.cancelled) return;
  job.cancelled = true;
  report(tabId, 'Stopping…', null);
  chrome.tabs.sendMessage(tabId, { type: 'fpp-cancel' }).catch(() => {});
  // Detaching aborts a render that's in progress.
  if (job.debugging) chrome.debugger.detach({ tabId }).catch(() => {});
}

async function run(tabId, opts) {
  if (tabId == null) return { ok: false, error: 'No tab to capture.' };
  if (jobs.has(tabId)) return { ok: false, error: 'Already capturing this tab.' };
  const job = { pct: 0, text: 'Starting…', cancelled: false, debugging: false };
  jobs.set(tabId, job);
  setBadge(tabId, '…', '#5f6368');
  let result;
  let tip;
  const started = Date.now();
  opts = { ...DEFAULTS, action: 'save', ...opts };
  const { mode, format, layout, compression, action, stamp, loadLazy, hideFloating, sideways } = opts;
  try {
    const url = (await chrome.tabs.get(tabId).catch(() => null))?.url;
    log('info', 'Capture started', { url, mode, format, layout, compression, action, stamp, loadLazy, hideFloating, sideways });
    const { size, photos, files, copied, note } = await capture(tabId, opts, job);
    result = { ok: true, size, files, copied, note };
    log('info', 'Capture finished', { ms: Date.now() - started, size, files, copied: !!copied, ...(note ? { note } : {}) });
    tip = await compressionTip(opts, size, photos);
    setBadge(tabId, '✓', '#188038');
    setTimeout(() => setBadge(tabId, ''), 4000);
  } catch (e) {
    if (job.cancelled) {
      result = { ok: false, cancelled: true };
      log('info', 'Capture stopped', { ms: Date.now() - started, step: job.text });
      setBadge(tabId, '');
    } else {
      result = { ok: false, error: friendlyError(e) };
      log('error', 'Capture failed', { ...errorDetails(e), step: job.text, ms: Date.now() - started, mode, format });
      setBadge(tabId, '!', '#d93025');
    }
  } finally {
    jobs.delete(tabId);
  }
  const done = !result.ok
    ? (result.cancelled ? 'Stopped' : 'Failed')
    : result.copied ? 'Copied to clipboard'
    : result.files > 1 ? `Saved ${result.files} images · ${formatSize(result.size)}` : `Saved · ${formatSize(result.size)}`;
  const text = !result.ok ? result.error || 'Nothing was saved.'
    : result.copied ? 'Paste it anywhere with Ctrl+V.'
    : result.note || 'Check your downloads.';
  pageProgress(tabId, { text, pct: result.ok ? 100 : undefined, done, tip });
  chrome.runtime.sendMessage({ type: 'done', tabId, ...result, tip: !!tip }).catch(() => {});
  return result;
}

// One time only: after a big, photo-heavy PDF saved without compression,
// suggest it. The popup then offers a "Use Medium" button until the person
// answers.
const TIP_MIN_BYTES = 2 * 1024 * 1024;
const TIP_MIN_PHOTOS = 3;

async function compressionTip(opts, size, photos) {
  if (opts.format !== 'pdf' || opts.compression !== 'off') return undefined;
  if (size < TIP_MIN_BYTES || photos < TIP_MIN_PHOTOS) return undefined;
  const { smallerTip } = await chrome.storage.local.get('smallerTip');
  if (smallerTip) return undefined;
  await chrome.storage.local.set({ smallerTip: 'pending' });
  return `Tip: this PDF is ${formatSize(size)}, mostly photos. Set Compression to Medium in the Webpage Screenshot Pro menu to make files like this up to 90% smaller.`;
}

async function capture(tabId, opts, job) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^(https?|file):/i.test(tab.url || '')) {
    throw new Error('Chrome does not let extensions capture this kind of page. Try a regular website.');
  }

  const target = { tabId };
  const call = async (func, ...args) => (await chrome.scripting.executeScript({ target, func, args }))[0]?.result;
  const check = () => { if (job.cancelled) throw new Cancelled(); };
  const send = async (method, params) => {
    try {
      return await chrome.debugger.sendCommand(target, method, params);
    } catch (e) {
      if (!job.cancelled) log('debug', 'Debugger command failed', { method, message: String(e?.message || e) });
      throw e;
    }
  };
  // Copying always captures a PNG: it's the image type the clipboard takes.
  const copying = opts.action === 'copy';
  const format = copying ? 'png' : opts.format;
  const isPdf = format === 'pdf';

  if (opts.mode === 'visible' || opts.mode === 'region') {
    return captureView({ tab, opts, job, target, call, check, send, format, copying });
  }

  await chrome.scripting.executeScript({ target, files: ['content.js'] });
  await call(() => window.__fpp.begin());

  try {
    await chrome.debugger.attach(target, '1.3');
    job.debugging = true;
    check();

    if (opts.loadLazy) {
      report(tabId, 'Loading the whole page…', STEPS.load[0]);
      const screenH = await call(() => innerHeight);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 0,
        height: Math.min(screenH * TALL_VIEWPORT_SCREENS, TALL_VIEWPORT_MAX_PX),
        deviceScaleFactor: 0,
        mobile: false,
      });
      try {
        await call((o) => window.__fpp.loadAll(o), { maxMs: MAX_LOAD_MS, from: STEPS.load[0], to: STEPS.load[1], sideways: opts.sideways });
      } finally {
        await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      }
      check();
    }

    report(tabId, 'Preparing the page…', STEPS.prepare);
    const { photos, width } = await call((o) => window.__fpp.prepare(o), {
      hideFloating: opts.hideFloating,
      paged: isPdf && opts.layout !== 'single',
      image: !isPdf,
      waitImagesMs: opts.loadLazy ? 4000 : 1500,
      sideways: opts.sideways,
      maxWidth: MAX_WIDTH_PX,
    });
    if (width) log('debug', 'Capturing wider than the window', { width });
    check();

    const level = isPdf && COMPRESSION[opts.compression];
    if (level) await compressImages({ tabId, call, send, job, level });

    // The progress card must not end up in the output.
    await call(() => window.__fpp.overlayVisible(false));
    let outputs;
    try {
      if (isPdf) {
        report(tabId, 'Rendering PDF…', STEPS.render, { busy: true });
        // Rendering gives no progress of its own; count seconds so a big
        // page doesn't look frozen.
        const started = Date.now();
        const ticker = setInterval(() => {
          const s = Math.round((Date.now() - started) / 1000);
          report(tabId, `Rendering PDF… ${s} s`, STEPS.render, { busy: true });
        }, 1000);
        try {
          const pdf = await printToPdf(send, opts.layout, opts.stamp, width);
          outputs = [addPdfInfo(pdf, { title: tab.title, url: tab.url })];
        } finally {
          clearInterval(ticker);
        }
      } else {
        report(tabId, 'Capturing image…', STEPS.render);
        outputs = await captureImages(send, format, width, (i, n) => {
          if (n > 1) report(tabId, `Capturing image… part ${i + 1} of ${n}`, STEPS.render + ((STEPS.save - STEPS.render) * i) / n);
        });
      }
    } finally {
      await call(() => window.__fpp.overlayVisible(true)).catch(() => {});
    }
    check();

    return await deliver({ tab, opts, format, copying, outputs, photos });
  } finally {
    job.debugging = false;
    await chrome.debugger.detach(target).catch(() => {});
    await call(() => window.__fpp.restore()).catch(() => {});
  }
}

// Saves the finished files (or copies the image), named per the settings.
async function deliver({ tab, opts, format, copying, outputs, photos }) {
  const tabId = tab.id;
  let note;
  if (copying) {
    if (outputs.length === 1) {
      report(tabId, 'Copying…', STEPS.save);
      if (await copyToClipboard(tabId, outputs[0])) return { size: outputs[0].length, photos, files: 1, copied: true };
      note = "Couldn't copy to the clipboard, so it was saved instead.";
      log('warn', 'Clipboard copy failed; saved instead');
    } else {
      note = `Too tall to copy in one piece, so it was saved as ${outputs.length} images.`;
    }
  }

  report(tabId, 'Saving…', STEPS.save);
  const base = fileBaseName(tab.title, tab.url, opts.nameFormat);
  let size = 0;
  for (let i = 0; i < outputs.length; i++) {
    const part = outputs.length > 1 ? ` (part ${i + 1} of ${outputs.length})` : '';
    const name = `${base}${part}.${EXT[format]}`;
    await saveFile(outputs[i], MIME[format], opts.folder ? `${cleanFolder(opts.folder)}/${name}` : name);
    size += outputs[i].length;
  }
  return { size, photos, files: outputs.length, note };
}

// ---------- Visible area and region ----------

// Images come from Chrome's ordinary screenshot of the tab: exactly what's
// on screen, and no debugging bar. PDFs print just that part of the page,
// so the text stays real, searchable text.
async function captureView({ tab, opts, job, target, call, check, send, format, copying }) {
  const tabId = tab.id;
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
  await call(() => window.__fpp.begin({ card: false }));
  try {
    // Tests pass a region in; otherwise the person draws one.
    let region = opts.region || null;
    if (opts.mode === 'region' && !region) {
      report(tabId, 'Drag to select an area on the page…', null, { busy: true });
      region = await call(() => window.__fpp.selectRegion());
      if (!region) {
        job.cancelled = true;
        throw new Cancelled();
      }
    }
    check();
    const view = await call(() => window.__fpp.viewInfo());
    region ??= { x: 0, y: 0, w: view.vw, h: view.vh };
    log('debug', 'Capture area', { region, view });

    let outputs;
    if (format === 'pdf') {
      // Prepare before attaching the debugger: its "started debugging" bar
      // takes some of the window, which would move pinned elements.
      report(tabId, 'Preparing the page…', STEPS.prepare);
      await call((o) => window.__fpp.prepareView(o), { y: view.sy + region.y });
      check();
      await chrome.debugger.attach(target, '1.3');
      job.debugging = true;
      try {
        const level = COMPRESSION[opts.compression];
        if (level) {
          // The page is now shifted so the area starts at its top.
          const within = { x: view.sx + region.x, y: 0, w: region.w, h: region.h };
          await compressImages({ tabId, call, send, job, level, within });
        }
        check();
        report(tabId, 'Rendering PDF…', STEPS.render, { busy: true });
        const pdf = await printView(send, view, region);
        outputs = [addPdfInfo(pdf, { title: tab.title, url: tab.url })];
      } finally {
        job.debugging = false;
        await chrome.debugger.detach(target).catch(() => {});
      }
    } else {
      // Let the page repaint without the selection box first.
      await call(() => window.__fpp.nextFrames());
      report(tabId, 'Capturing image…', STEPS.render);
      outputs = [await cropVisibleTab(tab.windowId, format, view, opts.mode === 'region' ? region : null)];
    }
    check();
    return await deliver({ tab, opts, format, copying, outputs, photos: 0 });
  } finally {
    await call(() => window.__fpp.restore()).catch(() => {});
  }
}

// The page has been shifted so the area starts at the top; print one page
// as tall as the area at the page's normal width, then trim it to the area.
async function printView(send, view, region) {
  await send('Emulation.setEmulatedMedia', { media: 'screen' });
  const { w } = await measurePage(send);
  const { stream } = await send('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: false,
    displayHeaderFooter: false,
    generateTaggedPDF: false,
    transferMode: 'ReturnAsStream',
    paperWidth: w / 96,
    paperHeight: region.h / 96,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    scale: 1,
    pageRanges: '1',
  });
  const pdf = await readStream(send, stream);
  return trimPdfPage(pdf, { left: view.sx + region.x, width: region.w, height: region.h });
}

// Screenshot of what's on screen, cropped to the region if there is one.
async function cropVisibleTab(windowId, format, view, region) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format,
    ...(format === 'jpeg' ? { quality: IMAGE_JPEG_QUALITY } : {}),
  });
  const bytes = fromBase64(dataUrl.slice(dataUrl.indexOf(',') + 1));
  if (!region) return bytes;
  const bitmap = await createImageBitmap(new Blob([bytes]));
  // The screenshot is in device pixels; the region is in CSS pixels.
  const scale = bitmap.width / view.innerWidth;
  const sx = Math.round(region.x * scale);
  const sy = Math.round(region.y * scale);
  const w = Math.max(1, Math.min(bitmap.width - sx, Math.round(region.w * scale)));
  const h = Math.max(1, Math.min(bitmap.height - sy, Math.round(region.h * scale)));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
  bitmap.close();
  const blob = await canvas.convertToBlob(format === 'jpeg'
    ? { type: 'image/jpeg', quality: IMAGE_JPEG_QUALITY / 100 }
    : { type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------- Save all tabs ----------

// One batch at a time: { windowId, index, total, title, cancelled }
let batch = null;

// Saves every normal web page tab in the window, one after another, with
// the current settings (always the full page). Each tab is brought to the
// front while it's saved: Chrome doesn't fully draw background tabs, which
// can stall lazy loading and screenshots.
async function saveAllTabs(windowId, opts) {
  if (batch) return;
  batch = { windowId, index: 0, total: 0, title: '', cancelled: false };
  const results = [];
  let original;
  try {
    // Reading other tabs needs the all-sites permission; the popup asks for
    // it on the click, and Chrome's prompt may still be open.
    if (!(await waitForAllSites(60000))) {
      throw new Error('Saving all tabs needs permission to read your open tabs. Click "Save all tabs" again and choose Allow.');
    }
    const tabs = await chrome.tabs.query({ windowId });
    original = tabs.find((t) => t.active)?.id;
    const pages = tabs.filter((t) => /^(https?|file):/i.test(t.url || ''));
    const skipped = tabs.length - pages.length;
    batch.total = pages.length;
    log('info', 'Save all tabs started', { tabs: pages.length, skipped });
    for (const [i, t] of pages.entries()) {
      if (batch.cancelled) break;
      Object.assign(batch, { index: i + 1, title: t.title || t.url });
      sendBatch();
      await chrome.tabs.update(t.id, { active: true });
      if (t.discarded || t.status === 'unloaded') {
        // Memory Saver unloaded it; load it again first.
        await chrome.tabs.reload(t.id);
        await waitForTabLoad(t.id, 30000);
      }
      await sleep(400);
      const r = await run(t.id, { ...opts, mode: 'full', action: 'save' });
      results.push({ title: t.title, ...r });
    }
    const saved = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok && !r.cancelled);
    log('info', 'Save all tabs finished', { saved, failed: failed.length, cancelled: batch.cancelled });
    const summary = `Saved ${saved} of ${pages.length} tab${pages.length === 1 ? '' : 's'}` +
      (failed.length ? `; ${failed.length} failed (${failed.map((f) => f.title).slice(0, 3).join(', ')})` : '') +
      (skipped ? `. Skipped ${skipped} that can't be captured (like chrome:// pages).` : '.');
    chrome.runtime.sendMessage({ type: 'batchDone', windowId, ok: !failed.length, cancelled: batch.cancelled, summary }).catch(() => {});
  } catch (e) {
    log('error', 'Save all tabs failed', errorDetails(e));
    chrome.runtime.sendMessage({ type: 'batchDone', windowId, ok: false, summary: friendlyError(e) }).catch(() => {});
  } finally {
    batch = null;
    if (original) chrome.tabs.update(original, { active: true }).catch(() => {});
  }
}

function cancelBatch() {
  if (!batch) return;
  batch.cancelled = true;
  for (const tabId of jobs.keys()) cancel(tabId);
}

function sendBatch() {
  const { windowId, index, total, title } = batch;
  chrome.runtime.sendMessage({ type: 'batch', windowId, index, total, title }).catch(() => {});
}

async function waitForAllSites(timeout) {
  const has = () => chrome.permissions.contains({ origins: ['<all_urls>'] });
  if (await has()) return true;
  return new Promise((resolve) => {
    const done = (ok) => {
      chrome.permissions.onAdded.removeListener(onAdded);
      clearTimeout(timer);
      resolve(ok);
    };
    const onAdded = async () => { if (await has()) done(true); };
    chrome.permissions.onAdded.addListener(onAdded);
    const timer = setTimeout(() => done(false), timeout);
  });
}

function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(done, timeout);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measurePage(send) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(() => {
      const d = document.documentElement, b = document.body;
      return { w: d.clientWidth, h: Math.max(d.scrollHeight, b ? b.scrollHeight : 0), dpr: devicePixelRatio };
    })()`,
    returnByValue: true,
  });
  return result.value;
}

// Header (page title, date) and footer (address, page number) for the
// optional stamp. Chrome fills in the spans with those classes.
const STAMP_BAND_IN = 0.35;
const stampTemplate = (left, right) =>
  `<div style="box-sizing:border-box;width:100%;padding:0 0.3in;font:13px system-ui,-apple-system,'Segoe UI',sans-serif;color:#666;display:flex;justify-content:space-between;gap:16px;">` +
  `<span style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${left}</span><span style="white-space:nowrap;">${right}</span></div>`;

// wide: the width to capture when the page or areas in it scroll sideways
// (0: the window's width).
async function printToPdf(send, layout, stamp = false, wide = 0) {
  // Use the on-screen styles, not the site's print stylesheet.
  await send('Emulation.setEmulatedMedia', { media: 'screen' });
  const page = await measurePage(send);
  const w = Math.max(page.w, wide || 0);
  const { h } = page;

  const params = {
    printBackground: true,
    preferCSSPageSize: false,
    displayHeaderFooter: false,
    generateTaggedPDF: false,
    transferMode: 'ReturnAsStream',
  };
  const single = layout === 'single';
  if (single) {
    // One page exactly as wide as the viewport (or the sideways-scrolling
    // content) and as tall as the content, so it reads like a full-page
    // screenshot.
    Object.assign(params, {
      paperWidth: w / 96,
      paperHeight: Math.min(h + 2 + (stamp ? 2 * STAMP_BAND_IN * 96 : 0), MAX_PAGE_PX) / 96,
      marginTop: stamp ? STAMP_BAND_IN : 0, marginBottom: stamp ? STAMP_BAND_IN : 0, marginLeft: 0, marginRight: 0,
      scale: 1,
    });
  } else {
    const paper = PAPER[layout] || PAPER.letter;
    Object.assign(params, {
      paperWidth: paper.w,
      paperHeight: paper.h,
      marginTop: MARGIN_IN, marginBottom: MARGIN_IN, marginLeft: MARGIN_IN, marginRight: MARGIN_IN,
      // Lay the page out at its on-screen width, scaled to fit the paper.
      scale: Math.min(2, Math.max(0.1, ((paper.w - 2 * MARGIN_IN) * 96) / w)),
    });
  }

  if (stamp) {
    // Paper pages already have margins for it; one long page gets bands
    // added above and below.
    Object.assign(params, {
      displayHeaderFooter: true,
      headerTemplate: stampTemplate('<span class="title"></span>', '<span class="date"></span>'),
      footerTemplate: stampTemplate('<span class="url"></span>', 'Page <span class="pageNumber"></span> of <span class="totalPages"></span>'),
    });
  }

  const print = async (extra) => {
    const { stream } = await send('Page.printToPDF', { ...params, ...extra });
    return readStream(send, stream);
  };
  const pdf = await print();
  if (!single || params.paperHeight * 96 >= MAX_PAGE_PX || countPdfPages(pdf) === 1) return pdf;

  // Printing laid the page out taller than it measured on screen, so a bit
  // spilled onto a second page. Try once with more room; if it still
  // spills, the page is sizing itself to the paper and the extra page is
  // empty, so keep just the first.
  const roomier = await print({ paperHeight: Math.min(params.paperHeight * 1.25, MAX_PAGE_PX / 96) });
  if (countPdfPages(roomier) === 1) return roomier;
  return print({ pageRanges: '1' });
}

function countPdfPages(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  return (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
}

// ---------- Editing finished PDFs ----------
// Small changes are appended as a standard "incremental update": new
// versions of objects plus a new cross-reference section, leaving Chrome's
// bytes untouched. Chrome writes a classic xref table; anything unexpected
// leaves the file as it is.

function pdfTrailer(bytes) {
  const tail = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
  const trailerAt = tail.lastIndexOf('trailer');
  const startxrefAt = tail.lastIndexOf('startxref');
  if (trailerAt < 0 || startxrefAt < trailerAt) return null;
  const trailer = tail.slice(trailerAt, startxrefAt);
  const size = Number(trailer.match(/\/Size\s+(\d+)/)?.[1]);
  const root = trailer.match(/\/Root\s+(\d+\s+\d+\s+R)/)?.[1];
  const prev = Number(tail.slice(startxrefAt).match(/startxref\s+(\d+)/)?.[1]);
  if (!size || !root || !Number.isFinite(prev)) return null;
  return {
    size, root, prev,
    info: trailer.match(/\/Info\s+(\d+\s+\d+\s+R)/)?.[1],
    id: trailer.match(/\/ID\s*(\[[^\]]*\])/)?.[1],
  };
}

// objects: [{ num, body }]; info: a new /Info reference, if any.
function appendPdfUpdate(bytes, objects, info) {
  const t = pdfTrailer(bytes);
  if (!t) return null;
  // Everything appended is ASCII, so string length equals byte length.
  let text = '\n';
  const offsets = [];
  for (const { num, body } of objects) {
    offsets.push([num, bytes.length + text.length]);
    text += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = bytes.length + text.length;
  text += 'xref\n';
  // Each entry is exactly 20 bytes: 10-digit offset, generation, "n", space, newline.
  for (const [num, off] of offsets.sort((a, b) => a[0] - b[0])) text += `${num} 1\n${String(off).padStart(10, '0')} 00000 n \n`;
  const size = Math.max(t.size, ...objects.map((o) => o.num + 1));
  const infoRef = info || t.info;
  text += `trailer\n<< /Size ${size} /Root ${t.root}${infoRef ? ` /Info ${infoRef}` : ''} /Prev ${t.prev}${t.id ? ` /ID ${t.id}` : ''} >>\n`;
  text += `startxref\n${xrefOffset}\n%%EOF\n`;
  const extra = new TextEncoder().encode(text);
  const out = new Uint8Array(bytes.length + extra.length);
  out.set(bytes);
  out.set(extra, bytes.length);
  return out;
}

// Records the page's title, address and capture time in the PDF's
// properties (File > Properties in a PDF reader).
function addPdfInfo(bytes, { title, url }, when = new Date()) {
  try {
    const t = pdfTrailer(bytes);
    if (!t) return bytes;
    const pad = (n) => String(n).padStart(2, '0');
    const tz = -when.getTimezoneOffset();
    const pdfDate = `D:${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
      `${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}` +
      `${tz >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(tz) / 60))}'${pad(Math.abs(tz) % 60)}'`;
    const info = [
      `/Title ${pdfString(title || url)}`,
      `/Subject ${pdfString(`Saved from ${url} on ${when.toLocaleString()}`)}`,
      `/Keywords ${pdfString(url)}`,
      `/SourceURL ${pdfString(url)}`,
      '/Creator (Webpage Screenshot Pro)',
      '/Producer (Chrome via Webpage Screenshot Pro)',
      `/CreationDate (${pdfDate})`,
      `/ModDate (${pdfDate})`,
    ].join(' ');
    return appendPdfUpdate(bytes, [{ num: t.size, body: `<< ${info} >>` }], `${t.size} 0 R`) || bytes;
  } catch (e) {
    log('warn', 'Could not add PDF properties', errorDetails(e));
    return bytes;
  }
}

// Trims the first page to an area given in CSS pixels from its top-left
// corner ({ left, width, height }); what lies outside is cut off. Measured
// against the page's actual size, since Chrome may make the paper taller
// than asked for.
function trimPdfPage(bytes, { left, width, height }) {
  try {
    const text = new TextDecoder('latin1').decode(bytes);
    const at = text.search(/\/Type\s*\/Page(?![A-Za-z])/);
    if (at < 0) return bytes;
    const objAt = text.lastIndexOf(' 0 obj', at);
    const num = Number(text.slice(text.lastIndexOf('\n', objAt) + 1, objAt).trim());
    const dictStart = text.indexOf('<<', objAt);
    if (!num || dictStart < 0 || dictStart > at) return bytes;
    const dictEnd = dictEndAt(text, dictStart);
    if (dictEnd < 0) return bytes;
    let dict = text.slice(dictStart, dictEnd);
    const media = dict.match(/\/MediaBox\s*\[([^\]]*)\]/);
    if (!media) return bytes;
    // PDF coordinates run up from the bottom-left corner.
    const top = Number(media[1].trim().split(/\s+/)[3]);
    const pt = (px) => (px * 72) / 96;
    const box = [pt(left), top - pt(height), pt(left + width), top].map((n) => +n.toFixed(2));
    dict = dict.replace(media[0], `/MediaBox [${box.join(' ')}]`).replace(/\/CropBox\s*\[[^\]]*\]/, '');
    return appendPdfUpdate(bytes, [{ num, body: dict }]) || bytes;
  } catch (e) {
    log('warn', 'Could not trim the PDF page', errorDetails(e));
    return bytes;
  }
}

// Index just past the ">>" that closes the dictionary opening at `start`.
function dictEndAt(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '(') {
      // Skip strings, which may contain unbalanced brackets.
      let nest = 0;
      for (let j = i; j < text.length; j++) {
        if (text[j] === '\\') { j++; continue; }
        if (text[j] === '(') nest++;
        if (text[j] === ')' && --nest === 0) { i = j; break; }
      }
      continue;
    }
    if (text[i] === '<' && text[i + 1] === '<') { depth++; i++; continue; }
    if (text[i] === '>' && text[i + 1] === '>') {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// A PDF text string: plain ASCII in (...), anything else as UTF-16 hex.
function pdfString(str) {
  str = String(str ?? '');
  if (/^[\x20-\x7e]*$/.test(str)) return `(${str.replace(/[\\()]/g, (c) => '\\' + c)})`;
  let hex = 'FEFF';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    const units = code > 0xffff ? [0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff)] : [code];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

async function readStream(send, handle) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const { data, base64Encoded, eof } = await send('IO.read', { handle, size: 16 << 20 });
    const bytes = base64Encoded ? fromBase64(data) : Uint8Array.from(data, (c) => c.charCodeAt(0));
    chunks.push(bytes);
    total += bytes.length;
    if (eof) break;
  }
  await send('IO.close', { handle }).catch(() => {});
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Full-page screenshot, split into parts when the page is very tall.
async function captureImages(send, format, wide, onPart) {
  const page = await measurePage(send);
  const { h, dpr } = page;
  const w = Math.max(page.w, wide || 0);
  const partH = Math.floor(MAX_IMAGE_PX / (dpr || 1));
  const parts = Math.max(1, Math.ceil(h / partH));
  const out = [];
  for (let i = 0; i < parts; i++) {
    onPart(i, parts);
    const y = i * partH;
    const { data } = await send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: IMAGE_JPEG_QUALITY } : {}),
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: 0, y, width: w, height: Math.min(partH, h - y), scale: 1 },
    });
    out.push(fromBase64(data));
  }
  return out;
}

// ---------- Compression ----------

// Where compression gets each image's bytes: straight from what the page
// already loaded, through the debugger connection. No second download, and
// no permission to read other sites is needed. Images Chrome no longer
// holds (rare) are left as they are.
async function imageSource(send) {
  await send('Page.enable').catch(() => {});
  const { frameTree } = await send('Page.getFrameTree');
  const frameId = frameTree.frame.id;
  return async (url) => {
    try {
      const { content, base64Encoded } = await send('Page.getResourceContent', { frameId, url });
      return content ? new Blob([base64Encoded ? fromBase64(content) : new TextEncoder().encode(content)]) : null;
    } catch {
      return null; // not in the page's resources (evicted, or loaded by a frame)
    }
  };
}

// Re-encodes the page's images per the compression level. `within` (page
// pixels) limits it to images touching that area, for visible area and
// region captures.
async function compressImages({ tabId, call, send, job, level, within }) {
  const [from, to] = STEPS.shrink;
  report(tabId, 'Compressing images…', from);
  let list = (await call((o) => window.__fpp.collectImages(o), { backgrounds: level.backgrounds })) || [];
  if (within) {
    list = list.filter((i) => i.pageLeft < within.x + within.w && i.pageLeft + i.dispW > within.x &&
      i.pageTop < within.y + within.h && i.pageTop + i.dispH > within.y);
  }
  const source = await imageSource(send);
  const shrunk = await shrinkImages(list, level, source, job, (done) =>
    report(tabId, `Compressing images… ${done}/${list.length}`, from + ((to - from) * done) / Math.max(1, list.length)));
  if (job.cancelled) throw new Cancelled();
  if (shrunk.length) await call((r) => window.__fpp.applyImages(r), shrunk);
}

async function shrinkImages(list, level, source, job, onProgress) {
  const out = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < list.length && !job.cancelled) {
      const item = list[next++];
      try {
        const result = await shrinkImage(item, level, source);
        if (result) out.push({ id: item.id, ...result });
      } catch {
        // Unfetchable or undecodable image: leave it as it is.
      }
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

async function shrinkImage(item, level, source) {
  const blob = await source(item.src);
  if (!blob) return null;
  // Go by the file's first bytes; servers don't always label JPEGs right.
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const original = await createImageBitmap(blob);
  const nw = original.width;
  const nh = original.height;

  const scale = Math.min(1, level.factor * Math.max(item.dispW / nw, item.dispH / nh));
  const resize = scale < level.resizeBelow;
  // A JPEG at the right size already goes into the PDF as is.
  if (isJpeg && !resize && !level.reencodeJpeg) {
    original.close();
    return null;
  }

  const w = resize ? Math.max(1, Math.round(nw * scale)) : nw;
  const h = resize ? Math.max(1, Math.round(nh * scale)) : nh;
  const bitmap = resize ? await createImageBitmap(original, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }) : original;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  original.close();

  let transparent = !isJpeg && hasTransparency(ctx, w, h);
  if (transparent && level.flatten && item.flatten) {
    // High: put transparent images on the solid colour behind them so they
    // can be stored as JPEG too.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = item.flatten;
    ctx.fillRect(0, 0, w, h);
    transparent = false;
  }
  // Transparent images have to stay lossless; only worth it when smaller.
  if (transparent && !resize) return null;

  const type = transparent ? 'image/png' : 'image/jpeg';
  const encoded = await canvas.convertToBlob(type === 'image/jpeg' ? { type, quality: level.quality } : { type });
  // Non-JPEG sources are stored nearly uncompressed in the PDF, so any JPEG
  // beats them; JPEG and transparent sources only get swapped if smaller.
  if ((isJpeg || transparent) && encoded.size >= blob.size) return null;
  return { dataUrl: `data:${type};base64,${toBase64(new Uint8Array(await encoded.arrayBuffer()))}`, nw, nh };
}

function hasTransparency(ctx, width, height) {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

// ---------- Saving ----------

// Hands the file to Chrome's downloader as a blob: URL made by the hidden
// offscreen page, which avoids building a huge base64 data: URL. Falls back
// to a data: URL if that route isn't available.
async function saveFile(bytes, mime, filename) {
  let key = null;
  let url;
  try {
    key = crypto.randomUUID();
    await putFile(key, new Blob([bytes], { type: mime }));
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ type: 'offscreen-blob-url', key });
    if (!res?.url) throw new Error(res?.error || 'no blob URL');
    url = res.url;
  } catch (e) {
    log('warn', 'Saving through a data URL instead of a blob URL', errorDetails(e));
    if (key) deleteFile(key).catch(() => {});
    key = null;
    url = `data:${mime};base64,${toBase64(bytes)}`;
  }
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  if (key) revokeWhenDone(id, key);
}

// Puts a PNG on the clipboard. Writing needs a focused page: the popup when
// it's open (it started the copy), otherwise the tab itself (right-click
// menu or keyboard shortcut).
async function copyToClipboard(tabId, png) {
  const key = crypto.randomUUID();
  try {
    await putFile(key, new Blob([png], { type: 'image/png' }));
    const res = await chrome.runtime.sendMessage({ type: 'clipboard-write', key }).catch(() => null);
    if (res?.ok) return true;
  } catch {
    // Fall through to the tab.
  } finally {
    deleteFile(key).catch(() => {});
  }
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [toBase64(png)],
      func: async (b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        try {
          window.focus();
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
          return true;
        } catch {
          return false;
        }
      },
    });
    return !!r?.result;
  } catch {
    return false;
  }
}

function revokeWhenDone(downloadId, key) {
  const finish = () => {
    chrome.downloads.onChanged.removeListener(onChanged);
    clearTimeout(timer);
    chrome.runtime.sendMessage({ type: 'offscreen-revoke', key }).then((res) => {
      if (res?.left === 0) chrome.offscreen.closeDocument().catch(() => {});
    }).catch(() => {});
  };
  const onChanged = (delta) => {
    if (delta.id === downloadId && ['complete', 'interrupted'].includes(delta.state?.current)) finish();
  };
  chrome.downloads.onChanged.addListener(onChanged);
  // A Save As dialog left open shouldn't pin the file in memory forever.
  const timer = setTimeout(finish, 10 * 60 * 1000);
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Create blob URLs for saving finished files.' })
    .finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

function fileDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fpp-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putFile(key, blob) {
  const db = await fileDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function deleteFile(key) {
  const db = await fileDb();
  await new Promise((resolve) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
  db.close();
}

// ---------- Progress ----------

function report(tabId, text, pct, { busy = false, fromPage = false } = {}) {
  const job = jobs.get(tabId);
  if (!job || (job.cancelled && text !== 'Stopping…')) return;
  // Debug log: each new step once, not every percent or second.
  const step = text.replace(/ part \d+ of \d+$/, '').replace(/[\d/]+( s)?$/, '');
  if (step !== job.step) {
    job.step = step;
    log('debug', 'Step: ' + text, { pct });
  }
  job.text = text;
  job.pct = busy ? null : pct;
  chrome.runtime.sendMessage({ type: 'progress', tabId, text, pct: job.pct }).catch(() => {});
  // The page updates its own card while loading.
  if (!fromPage) pageProgress(tabId, { text, pct: job.pct, canSkip: false });
}

function pageProgress(tabId, msg) {
  chrome.tabs.sendMessage(tabId, { type: 'fpp-progress', ...msg }).catch(() => {});
}

// ---------- Helpers ----------

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/Cannot access|cannot be scripted|chrome-extension:|chrome:\/\//i.test(msg)) {
    return 'Chrome does not let extensions capture this page. For local files, turn on "Allow access to file URLs" for this extension.';
  }
  if (/already attached/i.test(msg)) return 'Another debugger is attached to this tab. Close it and try again.';
  if (/Invalid filename/i.test(msg)) return 'Chrome rejected the save folder name. Pick a different folder in the menu.';
  return msg;
}

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}
