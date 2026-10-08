// Loads the extension's background.js (and settings.js) into Node with a
// do-nothing `chrome` object, so its helpers can be tested directly.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fullpage-pdf');

export function loadBackground() {
  const stub = () => new Proxy(function () {}, {
    get: (_t, key) => (key === 'then' ? undefined : stub()),
    apply: () => Promise.resolve(undefined),
  });
  const ctx = vm.createContext({
    chrome: stub(), console, setTimeout, clearTimeout, setInterval, clearInterval,
    TextDecoder, TextEncoder, atob, btoa, crypto, Blob, URL,
  });
  ctx.self = ctx;
  ctx.addEventListener = () => {};
  ctx.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(EXT_DIR, file), 'utf8'), ctx, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  // Top-level functions and consts, by name.
  return (name) => vm.runInContext(name, ctx);
}
