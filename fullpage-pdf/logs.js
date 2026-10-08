// The debug logs page. Entries are written by log.js in the background and
// kept in chrome.storage.local under "logs".
const $ = (id) => document.getElementById(id);
const VERSION = chrome.runtime.getManifest().version;
const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
let logs = [];

function render() {
  const min = { all: 0, warn: 2, error: 3 }[$('filter').value];
  const shown = logs.filter((l) => (RANK[l.level] ?? 1) >= min).reverse();
  const list = $('list');
  list.replaceChildren(...shown.map(row));
  list.hidden = !shown.length;
  $('empty').hidden = !!shown.length;
  $('empty').textContent = logs.length ? 'Nothing matches this filter.' : 'Nothing logged yet.';
}

function row(entry) {
  const { t, level, event, ...details } = entry;
  const li = document.createElement('li');
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date(t).toLocaleString();
  const lvl = document.createElement('div');
  lvl.className = `level ${level}`;
  lvl.textContent = level;
  const body = document.createElement('div');
  body.className = 'entry';
  const ev = document.createElement('div');
  ev.className = 'event';
  ev.textContent = event;
  body.append(ev);
  if (Object.keys(details).length) {
    const pre = document.createElement('div');
    pre.className = 'details';
    pre.textContent = Object.entries(details)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');
    body.append(pre);
  }
  li.append(time, lvl, body);
  return li;
}

async function load() {
  ({ logs = [] } = await chrome.storage.local.get('logs'));
  render();
}

// Everything someone helping with a problem needs, in one file.
async function report() {
  const settings = await loadSettings();
  return {
    app: 'Webpage Screenshot Pro',
    version: VERSION,
    generated: new Date().toISOString(),
    browser: navigator.userAgent,
    language: navigator.language,
    settings,
    logs,
  };
}

function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

function saveJson(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

$('filter').addEventListener('change', render);

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(await report(), null, 2));
  notice('Copied the logs, with version and settings, to the clipboard.');
});

$('download').addEventListener('click', async () => {
  saveJson(await report(), `webpage-screenshot-pro-logs-${stamp()}.json`);
  notice('Saved the logs to your Downloads folder.');
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete all logged entries?')) return;
  await chrome.storage.local.set({ logs: [] });
  notice('Logs cleared.');
});

$('submit').addEventListener('click', async () => {
  const data = await report();
  const name = `webpage-screenshot-pro-report-${stamp()}.json`;
  saveJson(data, name);
  const errors = data.logs.filter((l) => l.level === 'error');
  if (!SUPPORT_EMAIL) {
    notice(`Saved ${name} to your Downloads folder. Attach it to your message to the developer.`);
    return;
  }
  const last = errors.at(-1);
  const body = [
    'Please attach the report file that was just saved to your Downloads folder:',
    name,
    '',
    'What were you doing when the problem happened?',
    '',
    '',
    `Version ${VERSION}, ${errors.length} error(s) logged.`,
    last ? `Last error: ${last.event}: ${last.message || ''}` : '',
  ].join('\n');
  location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Webpage Screenshot Pro ${VERSION} problem report`)}&body=${encodeURIComponent(body)}`;
  notice(`Saved ${name} to your Downloads folder and opened an email to the developer. Attach the file before sending.`);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.logs) {
    logs = changes.logs.newValue || [];
    render();
  }
});

(async () => {
  const s = await loadSettings();
  $('about').textContent = `Version ${VERSION} · Debug logging is ${s.debugLog ? 'on: every step is recorded' : 'off: only errors and capture start/finish are recorded'}. Logs stay on this computer until you download or submit them; the last 500 entries are kept.`;
  load();
})();
