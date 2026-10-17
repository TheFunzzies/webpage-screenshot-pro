// Settings shared by the background and the popup.
const DEFAULTS = {
  mode: 'full', // full | visible | region
  format: 'pdf', // pdf | jpeg | png
  layout: 'single', // single | letter | a4 (PDF only)
  compression: 'off', // off | light | medium | high (PDF only)
  stamp: false, // PDF only: page address and date in a header and footer
  loadLazy: true,
  hideFloating: true,
  sideways: true, // full page: unroll areas that scroll sideways and capture the full width
  folder: 'Webpage Screenshot Pro', // inside Downloads; '' saves to Downloads itself
  nameFormat: 'title-date', // see fileBaseName()
  debugLog: false, // record every step in the debug log, not just errors
};

// Where "Submit logs" sends people. Empty: the report is saved to Downloads
// and the person is told to attach it to a message to the developer.
const SUPPORT_EMAIL = 'stoneforestdesign@gmail.com';

const FORMAT_NAMES = { pdf: 'PDF', jpeg: 'JPEG', png: 'PNG' };

// File name without extension, e.g. "Double Apple Pie 2026-10-08".
// nameFormat: title-date | title-datetime | site-title-date | title
function fileBaseName(title, url, nameFormat, when = new Date()) {
  const clean = (s) => String(s || '')
    .replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  let site = '';
  try { site = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  let name = clean(title) || site || 'page';
  if (name.length > 100) name = name.slice(0, 100).trim();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const time = `${pad(when.getHours())}.${pad(when.getMinutes())}`;
  switch (nameFormat) {
    case 'title': return name;
    case 'title-datetime': return `${name} ${date} ${time}`;
    case 'site-title-date': return site && name !== site ? `${clean(site)} - ${name} ${date}` : `${name} ${date}`;
    default: return `${name} ${date}`;
  }
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(null);
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) settings[key] = stored[key] ?? DEFAULTS[key];
  // Up to 0.4 there was a "Smaller file" checkbox instead of levels.
  if (stored.compression === undefined && stored.smaller) settings.compression = 'medium';
  // The extension was called Full Page PDF up to 0.5.0; follow the rename
  // unless the folder was changed by hand.
  if (stored.folder === 'Full Page PDF') settings.folder = DEFAULTS.folder;
  return settings;
}

function saveSettings(settings) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = settings[key];
  return chrome.storage.sync.set(out);
}

// Chrome only lets extensions save inside Downloads, so the folder is a
// relative path. Strip anything that isn't allowed in a Windows/Mac name.
function cleanFolder(text) {
  return String(text || '')
    .split(/[\\/]+/)
    .map((part) => part.replace(/[:*?"<>|~\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, ''))
    .filter((part) => part && part !== '..')
    .join('/')
    .slice(0, 150);
}
