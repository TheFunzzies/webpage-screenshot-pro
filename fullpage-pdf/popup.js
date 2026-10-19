// DEFAULTS, FORMAT_NAMES, loadSettings, saveSettings, cleanFolder and
// fileBaseName come from settings.js.
const $ = (id) => document.getElementById(id);
const COMPRESSION_HINTS = {
  off: 'Images stay exactly as the site sent them.',
  light: 'Trims oversized images. No visible difference.',
  medium: 'Balanced: much smaller, still sharp when zoomed in.',
  high: 'Smallest file. Images at on-screen sharpness.',
};
let settings = { ...DEFAULTS };
let tabId;
let windowId;
let tab = { title: 'Page title', url: 'https://example.com/' };
let batchRunning = false;
const EXT = { pdf: 'pdf', jpeg: 'jpg', png: 'png' };

function readControls() {
  settings = {
    ...settings,
    mode: $('mode').value,
    format: $('format').value,
    layout: $('layout').value,
    compression: $('compression').value,
    stamp: $('stamp').checked,
    nameFormat: $('nameFormat').value,
    loadLazy: $('loadLazy').checked,
    hideFloating: $('hideFloating').checked,
    sideways: $('sideways').checked,
    debugLog: $('debugLog').checked,
  };
  return settings;
}

function render() {
  $('mode').value = settings.mode;
  $('format').value = settings.format;
  $('debugLog').checked = settings.debugLog;
  $('layout').value = settings.layout;
  $('compression').value = settings.compression;
  $('stamp').checked = settings.stamp;
  $('nameFormat').value = settings.nameFormat;
  $('nameExample').textContent = `${fileBaseName(tab.title, tab.url, settings.nameFormat)}.${EXT[settings.format]}`;
  $('nameExample').title = $('nameExample').textContent;
  $('loadLazy').checked = settings.loadLazy;
  $('hideFloating').checked = settings.hideFloating;
  $('sideways').checked = settings.sideways;
  $('compressionHint').textContent = COMPRESSION_HINTS[settings.compression] || '';
  // Show only what applies: data-show="pdf full" means PDF and full page.
  const applies = { pdf: settings.format === 'pdf', full: settings.mode === 'full' };
  for (const el of document.querySelectorAll('[data-show]')) {
    el.hidden = !el.dataset.show.split(' ').every((need) => applies[need]);
  }
  $('go').textContent = settings.mode === 'region' ? `Select region (${FORMAT_NAMES[settings.format]})` : `Save as ${FORMAT_NAMES[settings.format]}`;
  $('copy').title = { full: 'Copy the full page', visible: 'Copy the visible area', region: 'Select a region and copy it' }[settings.mode] + ' to the clipboard as an image';
  $('folderText').textContent = settings.folder ? `Downloads › ${settings.folder.split('/').join(' › ')}` : 'Downloads';
  $('folderText').title = $('folderText').textContent;
}

// Switch between the idle view (Save button) and the running view
// (progress bar and Stop button).
function showRunning(running) {
  document.querySelector('.actions').hidden = running;
  $('saveAll').disabled = running;
  $('progress').hidden = !running;
  $('stop').disabled = false;
  if (!running) $('batchLine').hidden = true;
  for (const el of document.querySelectorAll('select, input, .folder button')) el.disabled = running;
}

function showProgress(text, pct) {
  $('ptext').textContent = text;
  $('progress').classList.toggle('busy', pct == null);
  $('ppct').textContent = pct == null ? '' : `${Math.round(pct)}%`;
  if (pct != null) $('bar').style.width = `${Math.round(pct)}%`;
}

function showStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

(async () => {
  settings = await loadSettings();
  render();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const active = tabs.find((t) => t.active);
  tabId = active?.id;
  windowId = active?.windowId;
  if (active?.title || active?.url) tab = { title: active.title, url: active.url };
  $('saveAll').textContent = `Save all ${tabs.length} tab${tabs.length === 1 ? '' : 's'}`;
  render();
  showTipIfPending();
  showLogCount();
  // Reopening the popup mid-capture picks the progress back up.
  const state = await chrome.runtime.sendMessage({ type: 'state', tabId });
  if (state?.batch) showBatch(state.batch);
  if (state?.running || state?.batch) {
    showRunning(true);
    showProgress(state.text || 'Working…', state.pct ?? null);
  }
})();

for (const id of ['mode', 'format', 'layout', 'stamp', 'nameFormat', 'loadLazy', 'hideFloating', 'sideways', 'debugLog']) {
  $(id).addEventListener('change', () => {
    readControls();
    render();
    saveSettings(settings);
  });
}

function setCompression(level) {
  $('compression').value = level;
  readControls();
  render();
  saveSettings(settings);
  if (level !== 'off') finishTip();
}

$('compression').addEventListener('change', (e) => setCompression(e.target.value));

// ---------- Save folder ----------

function editFolder(editing) {
  $('folderView').hidden = editing;
  $('folderEdit').hidden = !editing;
  $('folderHint').hidden = !editing;
  if (editing) {
    $('folderInput').value = settings.folder;
    $('folderInput').focus();
    $('folderInput').select();
  }
}

function commitFolder() {
  settings.folder = cleanFolder($('folderInput').value);
  saveSettings(settings);
  render();
  editFolder(false);
}

$('folderChange').addEventListener('click', () => editFolder(true));
$('folderDone').addEventListener('click', commitFolder);
$('folderInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') commitFolder();
  if (e.key === 'Escape') editFolder(false);
});

// ---------- One-time compression tip ----------

// Set by the background after a big, photo-heavy PDF. It stays until answered.
async function showTipIfPending() {
  const { smallerTip } = await chrome.storage.local.get('smallerTip');
  $('tip').hidden = smallerTip !== 'pending' || settings.compression !== 'off';
}

function finishTip() {
  $('tip').hidden = true;
  chrome.storage.local.set({ smallerTip: 'done' });
}

$('tipYes').addEventListener('click', () => setCompression('medium'));
$('tipNo').addEventListener('click', finishTip);

// ---------- Capture ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'batch') {
    showBatch(msg);
    return;
  }
  if (msg?.type === 'batchDone') {
    batchRunning = false;
    showRunning(false);
    showStatus(msg.summary, msg.ok && !msg.cancelled ? 'ok' : msg.cancelled ? '' : 'err');
    showLogCount();
    return;
  }
  // During "Save all tabs" the progress comes from whichever tab is busy.
  if (msg?.tabId !== tabId && !(batchRunning && msg?.type === 'progress')) return;
  if (msg.type === 'progress') {
    showRunning(true);
    showProgress(msg.text, msg.pct);
  } else if (msg.type === 'done') {
    if (batchRunning) return;
    showRunning(false);
    showLogCount();
    if (msg.tip) showTipIfPending();
    if (msg.ok && msg.copied) showStatus('Copied to the clipboard. Paste it with Ctrl+V.', 'ok');
    else if (msg.ok && msg.note) showStatus(msg.note);
    else if (msg.ok) showStatus(msg.files > 1 ? `Saved ${msg.files} images (${formatSize(msg.size)})` : `Saved (${formatSize(msg.size)})`, 'ok');
    else if (msg.cancelled) showStatus('Stopped. Nothing was saved.');
    else showStatus(msg.error || 'Something went wrong.', 'err');
  }
});

function start(action) {
  if (tabId == null) return;
  if (!$('folderEdit').hidden) commitFolder();
  showStatus('');
  showRunning(true);
  showProgress('Starting…', 0);
  const started = chrome.runtime.sendMessage({ type: 'capture', tabId, opts: { ...readControls(), action } });
  // Get out of the way so the area can be drawn on the page.
  if (settings.mode === 'region') window.close();
  started.then((res) => {
    if (res?.started) return;
    showRunning(false);
    showStatus(res?.error || 'Something went wrong.', 'err');
  }, () => {});
}

// ---------- Save all tabs ----------

function showBatch({ index, total, title }) {
  batchRunning = true;
  showRunning(true);
  $('batchLine').hidden = false;
  $('batchLine').textContent = `Tab ${index} of ${total} · ${title}`;
  $('batchLine').title = title;
}

$('saveAll').addEventListener('click', async () => {
  // Other tabs can only be read with the all-sites permission. Ask now,
  // during the click (Chrome requires that), and start only once it's given.
  const granted = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
  if (!granted) {
    showStatus('Saving all tabs needs permission to read your open tabs. Click "Save all tabs" again and choose Allow.', 'err');
    return;
  }
  if (!$('folderEdit').hidden) commitFolder();
  showStatus('');
  batchRunning = true;
  showRunning(true);
  showProgress('Starting…', null);
  chrome.runtime.sendMessage({ type: 'saveAll', windowId, opts: readControls() });
});

// ---------- Developer: debug logs ----------

async function showLogCount() {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const errors = logs.filter((l) => l.level === 'error').length;
  $('viewLogs').textContent = errors ? `View logs (${errors} error${errors === 1 ? '' : 's'})` : 'View logs';
}

$('viewLogs').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') }));

$('go').addEventListener('click', () => start('save'));
$('copy').addEventListener('click', () => start('copy'));

// ---------- Clipboard ----------

// The background can't write to the clipboard; the popup can while it has
// focus. The image arrives through IndexedDB (messages can't carry binary).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'clipboard-write' || !document.hasFocus()) return;
  readFile(msg.key)
    .then((blob) => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]))
    .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

function readFile(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fpp-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('files').objectStore('files').get(key);
      get.onsuccess = () => {
        db.close();
        get.result ? resolve(get.result) : reject(new Error('image not found'));
      };
      get.onerror = () => reject(get.error);
    };
  });
}

$('stop').addEventListener('click', () => {
  $('stop').disabled = true;
  showProgress('Stopping…', null);
  if (batchRunning) chrome.runtime.sendMessage({ type: 'cancelBatch' });
  else chrome.runtime.sendMessage({ type: 'cancel', tabId });
});
