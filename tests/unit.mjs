// Fast checks of the extension's helpers; no browser needed.
// Run: npm run unit
import assert from 'node:assert/strict';
import { loadBackground, loadMarkdown } from './lib/extension.mjs';
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

await test('log: error messages keep only the site of addresses', () => {
  const { error } = console;
  console.error = () => {};
  try {
    bg('log')('error', 'Capture failed', { message: 'Cannot access contents of url "https://example.com/reset?token=abc". Extension manifest must request permission to access this host.' });
  } finally {
    console.error = error;
  }
  const entry = bg('logQueue').at(-1);
  assert.equal(entry.message, 'Cannot access contents of url "example.com". Extension manifest must request permission to access this host.');
});

await test('page count', () => assert.equal(bg('countPdfPages')(makeMinimalPdf()), 1));

// ---------- Markdown (markdown.js) ----------

const md = loadMarkdown();
await test('markdown: escapes only what breaks Markdown', () => assert.equal(md.escapeText('a*b_c [d] <e> |f| `g` 1.5 (h) #i!'), 'a\\*b\\_c \\[d\\] \\<e\\> \\|f\\| \\`g\\` 1.5 (h) #i!'));
await test('markdown: lines that look like markup are escaped', () => {
  assert.equal(md.escapeLineStarts('1. not a list\n# not a heading\n- not an item\n#tag stays\n-5 stays'), '1\\. not a list\n\\# not a heading\n\\- not an item\n#tag stays\n-5 stays');
});
await test('markdown: bold and italic markers keep spaces outside', () => {
  assert.equal(md.wrapInline('Note: ', '**'), '**Note:** ');
  assert.equal(md.wrapInline(md.wrapInline('both', '*'), '**'), '***both***');
  assert.equal(md.wrapInline('  ', '*'), '  ');
});
await test('markdown: inline code and fences outlast backticks inside', () => {
  assert.equal(md.inlineCode('a `b` c'), '``a `b` c``');
  assert.equal(md.inlineCode('`x'), '`` `x ``');
  assert.equal(md.codeBlock('x\n```\ny\n', 'js'), '````js\nx\n```\ny\n````');
});
await test('markdown: table with header, escaped pipes and number columns right-aligned', () => {
  const cells = [['Item', 'Price'], ['Apples', '$4.50'], ['Pears | figs', '(3)'], ['Butter', '12%']];
  assert.equal(md.renderTable(cells), [
    '| Item | Price |',
    '| :--- | ---: |',
    '| Apples | $4.50 |',
    '| Pears \\| figs | (3) |',
    '| Butter | 12% |',
  ].join('\n'));
});
await test('markdown: short rows padded, already-escaped pipes left alone', () => {
  assert.equal(md.renderTable([['a', 'b', 'c'], ['x \\| y'], ['|', '2', '3']]), [
    '| a | b | c |', '| :--- | ---: | ---: |', '| x \\| y |  |  |', '|  | 2 | 3 |',
  ].join('\n'));
});
await test('markdown: list item lines indented under the marker', () => assert.equal(md.prefixLines('one\n\ntwo', '10. ', '    '), '10. one\n\n    two'));
await test('markdown: inline runs tidied, hard breaks kept', () => assert.equal(md.tidyInline('  a \n  b  \\\n  c \\\n'), 'a b\\\nc'));
await test('markdown: front matter', () => {
  assert.equal(md.frontMatter('Pie: "best"', 'https://example.com/a', when), '---\ntitle: "Pie: \\"best\\""\nsource: "https://example.com/a"\nsaved: 2026-10-08 14:05\n---\n\n');
});

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
