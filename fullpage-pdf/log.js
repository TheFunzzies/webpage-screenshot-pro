// Debug log for the background, kept in chrome.storage.local so it survives
// restarts and the logs page (logs.html) can show it. Errors and the start
// and end of each capture are always recorded, with only the site's domain.
// With "Debug logging" on, every step is recorded too, with full addresses.
const LOG_KEY = 'logs';
const LOG_MAX = 500;
let logQueue = [];
let logTimer = null;
let verboseLog = false;

loadSettings().then((s) => { verboseLog = !!s.debugLog; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.debugLog) verboseLog = !!changes.debugLog.newValue;
});

function log(level, event, details = {}) {
  if (level === 'debug' && !verboseLog) return;
  const entry = { t: Date.now(), level, event, ...details };
  if (entry.url && !verboseLog) entry.url = siteOf(entry.url);
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out('[Webpage Screenshot Pro]', event, details);
  logQueue.push(entry);
  logTimer ??= setTimeout(flushLog, 500);
}

// One write at a time: two overlapping read-then-write flushes would each
// keep only their own new entries.
let logWriting = Promise.resolve();

function flushLog() {
  logTimer = null;
  logWriting = logWriting.then(async () => {
    const batch = logQueue;
    logQueue = [];
    if (!batch.length) return;
    const { [LOG_KEY]: old = [] } = await chrome.storage.local.get(LOG_KEY);
    await chrome.storage.local.set({ [LOG_KEY]: [...old, ...batch].slice(-LOG_MAX) });
  }).catch(() => {});
  return logWriting;
}

function siteOf(url) {
  try {
    const u = new URL(url);
    return u.host || u.protocol;
  } catch {
    return '';
  }
}

function errorDetails(e) {
  return {
    message: String(e?.message || e),
    ...(e?.stack ? { stack: String(e.stack).split('\n').slice(0, 8).join('\n') } : {}),
  };
}

self.addEventListener('error', (e) => log('error', 'Unhandled error', errorDetails(e.error || e.message)));
self.addEventListener('unhandledrejection', (e) => log('error', 'Unhandled promise rejection', errorDetails(e.reason)));
