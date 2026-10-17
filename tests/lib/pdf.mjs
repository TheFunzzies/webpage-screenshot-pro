// Reading PDFs the way a viewer would: pages, text, properties, images.
import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

const open = (data) => getDocument({ data: new Uint8Array(data), verbosity: 0 }).promise;

export async function pdfInfo(data) {
  const doc = await open(data);
  const { info } = await doc.getMetadata();
  return { ...info, pages: doc.numPages };
}

// Pages (with sizes in points) and all text, page by page. Each page's
// `items` gives where each piece of text starts, in points from the left.
export async function readPdf(file) {
  const data = fs.readFileSync(file);
  const doc = await open(data);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { width, height } = page.getViewport({ scale: 1 });
    const items = (await page.getTextContent()).items.map((x) => ({ str: x.str, x: x.transform[4] }));
    pages.push({ width: Math.round(width), height: Math.round(height), text: items.map((x) => x.str).join(' '), items });
  }
  const { info } = await doc.getMetadata();
  return { bytes: data.length, pages, text: pages.map((p) => p.text).join('\n'), info, images: imageStats(data) };
}

// How the PDF stores its images, by encoding. "Flate" means lossless (big),
// "DCT" means JPEG.
export function imageStats(data) {
  const s = Buffer.from(data).toString('latin1');
  const re = /<<([^]*?)>>\s*stream/g;
  const stats = {};
  let m;
  while ((m = re.exec(s))) {
    const d = m[1];
    if (!/\/Subtype\s*\/Image/.test(d)) continue;
    const key = (d.match(/\/Filter\s*\/(\w+)/)?.[1] || 'none') + (/\/SMask/.test(d) ? '+alpha' : '');
    stats[key] ??= { count: 0, bytes: 0 };
    stats[key].count++;
    stats[key].bytes += +(d.match(/\/Length (\d+)/)?.[1] || 0);
  }
  return stats;
}

// Renders the top of a page to a PNG, for looking at results.
export async function renderPage(file, out, { page = 1, scale = 1, maxHeight = 2000 } = {}) {
  const doc = await open(fs.readFileSync(file));
  const p = await doc.getPage(page);
  const vp = p.getViewport({ scale });
  const canvas = createCanvas(Math.round(vp.width), Math.min(maxHeight, Math.round(vp.height)));
  await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
}
