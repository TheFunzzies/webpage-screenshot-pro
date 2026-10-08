// Fast checks of the extension's helpers; no browser needed.
// Run: npm run unit
import assert from 'node:assert/strict';
import { loadBackground } from './lib/extension.mjs';
import { pdfInfo } from './lib/pdf.mjs';

const bg = loadBackground();
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
  }
};

const when = new Date(2026, 9, 8, 14, 5);
const fileBaseName = bg('fileBaseName');
const title = 'Double Apple Pie: Recipe | NYT';
const url = 'https://cooking.nytimes.com/recipes/1016924-double-apple-pie';

await test('file name: title + date', () => assert.equal(fileBaseName(title, url, 'title-date', when), 'Double Apple Pie Recipe NYT 2026-10-08'));
await test('file name: title + date + time', () => assert.equal(fileBaseName(title, url, 'title-datetime', when), 'Double Apple Pie Recipe NYT 2026-10-08 14.05'));
await test('file name: site + title + date', () => assert.equal(fileBaseName(title, url, 'site-title-date', when), 'cooking.nytimes.com - Double Apple Pie Recipe NYT 2026-10-08'));
await test('file name: title only', () => assert.equal(fileBaseName(title, url, 'title', when), 'Double Apple Pie Recipe NYT'));
await test('file name: no title falls back to the site', () => assert.equal(fileBaseName('', 'https://www.example.com/x', 'title-date', when), 'example.com 2026-10-08'));

const cleanFolder = bg('cleanFolder');
await test('folder: subfolders and bad characters', () => assert.equal(cleanFolder(' Web/..\\Clips: 2026 /  '), 'Web/Clips 2026'));
await test('folder: empty means Downloads', () => assert.equal(cleanFolder('  '), ''));

const pdfString = bg('pdfString');
await test('pdf string: escapes ASCII', () => assert.equal(pdfString('a (b) c\\'), '(a \\(b\\) c\\\\)'));
await test('pdf string: non-ASCII as UTF-16', () => assert.equal(pdfString('é😀'), '<FEFF00E9D83DDE00>'));

await test('PDF properties: title, address and date readable afterwards', async () => {
  const minimal = makeMinimalPdf();
  const out = bg('addPdfInfo')(minimal, { title: 'Crème brûlée', url: 'https://example.com/a?b=1' }, when);
  assert.ok(out.length > minimal.length, 'nothing appended');
  const info = await pdfInfo(out);
  assert.equal(info.Title, 'Crème brûlée');
  assert.match(info.Subject, /^Saved from https:\/\/example\.com\/a\?b=1 on /);
  assert.equal(info.Creator, 'Webpage Screenshot Pro');
  assert.equal(info.pages, 1);
});

await test('PDF properties: unknown layout left untouched', () => {
  const junk = new TextEncoder().encode('%PDF-1.7\nnot really a pdf');
  assert.equal(bg('addPdfInfo')(junk, { title: 't', url: 'u' }), junk);
});

await test('page count', () => assert.equal(bg('countPdfPages')(makeMinimalPdf()), 1));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

// A tiny valid one-page PDF with a classic xref table, like Chrome writes.
function makeMinimalPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    '<< /Producer (test) >>',
  ];
  let s = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) s += `${String(off).padStart(10, '0')} 00000 n \n`;
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(s);
}
