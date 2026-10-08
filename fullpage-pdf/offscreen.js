// Hidden page that turns a finished file into a blob: URL for
// chrome.downloads. The service worker can't make blob URLs itself, and
// messages can't carry binary data, so the file is handed over through
// IndexedDB (shared by every page of the extension).
const urls = new Map();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fpp-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function takeFile(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const get = store.get(key);
    get.onsuccess = () => {
      store.delete(key);
      resolve(get.result);
    };
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'offscreen-blob-url') {
    takeFile(msg.key)
      .then((blob) => {
        if (!blob) throw new Error('file not found');
        const url = URL.createObjectURL(blob);
        urls.set(msg.key, url);
        sendResponse({ url });
      })
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'offscreen-revoke') {
    const url = urls.get(msg.key);
    if (url) URL.revokeObjectURL(url);
    urls.delete(msg.key);
    sendResponse({ left: urls.size });
  }
});
