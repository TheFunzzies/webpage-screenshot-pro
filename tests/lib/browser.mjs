// Launches Chrome for Testing with the extension loaded and drives captures
// through the extension's own service worker, exactly as a click would.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { EXT_DIR } from './extension.mjs';

// In real use, clicking the button (or menu, or shortcut) gives the extension
// access to that one tab ("activeTab"). Tests can't click Chrome's toolbar, so
// they load a copy whose manifest grants that access up front.
function extensionUnderTest(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(EXT_DIR, dir, { recursive: true });
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.permissions.push('tabs');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ downloadDir, headless = true }) {
  fs.rmSync(downloadDir, { recursive: true, force: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  const extDir = extensionUnderTest(path.join(path.dirname(downloadDir), 'extension-under-test'));
  // A fresh profile whose download folder is set the normal way, so the
  // extension's file names and subfolders are kept as they would be.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-test-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: downloadDir },
  }));
  const browser = await puppeteer.launch({
    headless,
    userDataDir: profile,
    pipe: true,
    enableExtensions: [extDir],
    protocolTimeout: 300000,
    defaultViewport: null,
    args: ['--window-size=1280,900'],
  });
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'),
    { timeout: 20000 },
  );
  const worker = await swTarget.worker();
  const extensionId = new URL(swTarget.url()).host;
  // Some sites turn away Chrome that calls itself headless.
  const userAgent = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
  return new Session(browser, worker, extensionId, downloadDir, profile, userAgent);
}

class Session {
  constructor(browser, worker, extensionId, downloadDir, profile, userAgent) {
    Object.assign(this, { browser, worker, extensionId, downloadDir, profile, userAgent });
  }

  async open(url, { settle = 500 } = {}) {
    const page = await this.browser.newPage();
    await page.setUserAgent(this.userAgent);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.bringToFront();
    await sleep(settle);
    const tabId = await this.worker.evaluate(
      async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id,
      page.url(),
    );
    return { page, tabId };
  }

  // Starts a capture without waiting for it (for tests that interact with
  // the page meanwhile, like drawing a region). Finish with finish().
  async start(url, opts = {}, { before: beforeOpen } = {}) {
    const { page, tabId } = await this.open(url);
    if (beforeOpen) await beforeOpen(page);
    const before = new Set(listFiles(this.downloadDir));
    const started = Date.now();
    const running = this.worker.evaluate((id, o) => run(id, o), tabId, opts);
    return { page, tabId, before, started, running };
  }

  async finish({ page, before, started, running }) {
    const result = await running;
    const ms = Date.now() - started;
    let files = [];
    if (result?.ok && !result.copied) files = await this.waitForFiles(before, result.files);
    return { result, files, ms, page };
  }

  // Runs one capture with the given settings; returns the extension's
  // result plus the files it saved.
  async capture(url, opts = {}, { cancelAfterMs, before: beforeOpen } = {}) {
    const { page, tabId } = await this.open(url);
    if (beforeOpen) await beforeOpen(page);
    const before = new Set(listFiles(this.downloadDir));
    const started = Date.now();
    const running = this.worker.evaluate((id, o) => run(id, o), tabId, opts);
    if (cancelAfterMs != null) {
      await sleep(cancelAfterMs);
      await this.worker.evaluate((id) => cancel(id), tabId);
    }
    // If a capture runs long, say which step it's on.
    const watchdog = setInterval(async () => {
      const job = await this.worker.evaluate((id) => jobs.get(id) && { ...jobs.get(id) }, tabId).catch(() => null);
      if (job) console.log(`        … ${Math.round((Date.now() - started) / 1000)} s, step: ${job.text}`);
    }, 15000);
    const result = await running.finally(() => clearInterval(watchdog));
    const ms = Date.now() - started;
    let files = [];
    if (result?.ok && !result.copied) files = await this.waitForFiles(before, result.files);
    return { result, files, ms, page };
  }

  async waitForFiles(before, count, timeout = 30000) {
    const end = Date.now() + timeout;
    for (;;) {
      const fresh = listFiles(this.downloadDir).filter((f) => !before.has(f));
      // Chrome writes to a temporary name first, then renames when done.
      const done = fresh.filter((f) => !/\.(crdownload|tmp)$/.test(f));
      if (done.length >= count && done.length === fresh.length) return done.sort();
      if (Date.now() > end) throw new Error(`expected ${count} downloaded file(s), found ${done.length}`);
      await sleep(200);
    }
  }

  async close() {
    await this.browser.close();
    fs.rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}
