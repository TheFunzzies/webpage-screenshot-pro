// Injected into the page's isolated world. Turns the page, or the part of
// it on screen, into Markdown: headings, paragraphs, lists, quotes, code,
// tables, links and images, read straight from the page as it's shown.
//
// The Markdown it writes follows pdfmd (https://github.com/M1ck4/pdfmd, MIT
// License, (c) 2025 Michael Neivandt): ***bold italic*** / **bold** /
// *italic*, "- " and "1. " list markers, pipe tables whose first row is the
// header, cells escaped so a "|" can't split a column, number columns
// right-aligned (":---" / "---:"), only the characters that break Markdown
// escaped, and math kept as $TeX$. pdfmd has to guess all of this from a
// PDF's fonts and positions; a web page says it outright, so this reads the
// page instead of a PDF of it.
(() => {
  // Never part of the text.
  const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base',
    'svg', 'canvas', 'iframe', 'frame', 'object', 'embed', 'video', 'audio', 'track', 'source', 'map',
    'button', 'select', 'option', 'optgroup', 'datalist', 'textarea', 'input', 'progress', 'meter', 'dialog',
  ]);
  // Menus, banners, page footers and sidebars, left out with "main content only".
  const CHROME_TAGS = new Set(['header', 'footer', 'aside']);
  const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menubar', 'toolbar']);
  // Block-level by meaning, whatever their CSS says.
  const BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'address', 'figure', 'figcaption',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'table', 'hr',
    'details', 'summary', 'fieldset', 'legend', 'form', 'center', 'hgroup', 'body',
  ]);
  // A table holding any of these is a layout table: its cells are read as
  // ordinary blocks rather than squeezed into a Markdown table.
  const LAYOUT_SIGNS = 'table, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, hr, dl';
  // Math as Wikipedia, KaTeX and MathJax show it, and plain MathML.
  const MATH_WRAPPERS = '.mwe-math-element, .katex, mjx-container, math';

  // ---------- Text helpers (pure; also used by the unit tests) ----------

  // pdfmd's escape_markdown: backslash, backtick, * _ { } [ ] < > and |.
  // Periods, parentheses, hyphens, # and ! are left alone.
  const escapeText = (s) => s.replace(/[\\`*_{}[\]<>|]/g, '\\$&');

  // A paragraph line that starts like a heading, list item, quote or rule
  // would turn into one; escape its first character.
  function escapeLineStarts(text) {
    return text.split('\n').map((line) => line
      .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2')
      .replace(/^([#>+-])(?=[\s#>+-]|$)/, '\\$1')
      .replace(/^(=+\s*)$/, '\\$1')).join('\n');
  }

  // pdfmd's _wrap_inline, with spaces moved outside the markers so
  // "<b>Note: </b>text" stays "**Note:** text".
  function wrapInline(text, marker) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!m[2]) return text;
    return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
  }

  // Inline code: a backtick run longer than any inside it.
  function inlineCode(code) {
    const text = code.replace(/\s+/g, ' ');
    if (!text.trim()) return '';
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map((r) => r.length));
    const ticks = '`'.repeat(longest + 1);
    const pad = /^`|`$/.test(text) ? ' ' : '';
    return `${ticks}${pad}${text}${pad}${ticks}`;
  }

  // Fenced code block, its fence longer than any backtick run in the code.
  function codeBlock(code, lang = '') {
    const body = code.replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
    if (!body) return '';
    const longest = Math.max(0, ...(body.match(/^`{3,}/gm) || []).map((r) => r.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${lang}\n${body}\n${fence}`;
  }

  // Link or image target; <…> when it has spaces or parentheses.
  const target = (url) => (/[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url);

  // pdfmd's _infer_column_alignments: a column whose body cells are more
  // than 70% numbers (commas, $, %, parentheses and a sign allowed) is
  // right-aligned; everything else left.
  function columnAlignments(grid) {
    if (grid.length < 2) return [];
    const cols = Math.max(...grid.map((r) => r.length));
    const out = [];
    for (let c = 0; c < cols; c++) {
      let numeric = 0;
      let total = 0;
      for (const row of grid.slice(1)) {
        const cell = (row[c] || '').trim();
        if (!cell) continue;
        total++;
        let clean = cell.replace(/[,$%()]/g, '').trim();
        if (/^[+-]/.test(clean)) clean = clean.slice(1).trim();
        if (clean && Number.isFinite(Number(clean))) numeric++;
      }
      out.push(total && numeric / total > 0.7 ? 'right' : 'left');
    }
    return out;
  }

  // pdfmd's _render_table_block. `cells` are finished Markdown cells,
  // `plain` the same cells as plain text (for the alignment guess). Rows
  // are padded, never truncated; the first row is the header.
  function renderTable(cells, plain = cells) {
    const cols = Math.max(0, ...cells.map((r) => r.length));
    if (!cols) return '';
    const pad = (row) => [...row, ...Array(cols - row.length).fill('')];
    // Lone pipes are border leftovers; any other | must not split a column.
    const fmt = (cell) => {
      const raw = (cell || '').trim();
      return /^(\|\|?|¦)$/.test(raw) ? '' : raw.replace(/(?<!\\)\|/g, '\\|');
    };
    const line = (row) => `| ${pad(row).map(fmt).join(' | ')} |`;
    const aligns = columnAlignments(plain.map(pad));
    const sep = `| ${Array.from({ length: cols }, (_, i) => (aligns[i] === 'right' ? '---:' : ':---')).join(' | ')} |`;
    return [line(cells[0]), sep, ...cells.slice(1).map(line)].join('\n');
  }

  // Puts `prefix` before the first line and `indent` before the rest
  // (blank lines stay blank).
  function prefixLines(text, prefix, indent = prefix) {
    return text.split('\n').map((line, i) => (i === 0 ? prefix + line : line ? indent + line : indent.trimEnd())).join('\n');
  }

  // Collapses the spaces of an inline run; keeps hard breaks ("\" + newline).
  function tidyInline(s) {
    return s.replace(/\\\n/g, '\u0001')
      .replace(/\s+/g, ' ')
      .replace(/ *\u0001 */g, '\u0001')
      .replace(/^[ \u0001]+|[ \u0001]+$/g, '')
      .replace(/\u0001/g, '\\\n');
  }

  // ---------- Reading the page ----------

  // Collects an element's content as Markdown blocks. In inline mode
  // (headings, link text, table cells) everything ends up on one line, and
  // a <br> becomes `br`.
  class Builder {
    constructor(inline = false, br = inline ? ' ' : '\\\n') {
      this.inline = inline;
      this.br = br;
      this.blocks = [];
      this.run = '';
    }

    text(s) { this.run += s; }

    flush() {
      if (this.inline) return;
      const t = escapeLineStarts(tidyInline(this.run));
      this.run = '';
      if (t) this.blocks.push({ text: t, kind: 'p' });
    }

    block(text, kind = 'block') {
      if (!text) return;
      if (this.inline) {
        this.run += ` ${text.replace(/\s*\n\s*/g, ' ')} `;
        return;
      }
      this.flush();
      this.blocks.push({ text, kind });
    }

    // Inside a list item, text followed by a nested list stays tight.
    finish({ tight = false } = {}) {
      if (this.inline) return tidyInline(this.run);
      this.flush();
      return this.blocks.map((b, i) => (i === 0 ? '' : tight && b.kind === 'list' ? '\n' : '\n\n') + b.text).join('');
    }
  }

  function makeReader({ area = null, mainOnly = true, hideFloating = false } = {}) {
    const range = document.createRange();
    const intersects = (r) => r.width + r.height > 0
      && r.right > area.x && r.left < area.x + area.w && r.bottom > area.y && r.top < area.y + area.h;
    const inArea = (node) => {
      if (!area) return true;
      if (node.nodeType === Node.ELEMENT_NODE) return intersects(node.getBoundingClientRect());
      range.selectNodeContents(node);
      return [...range.getClientRects()].some(intersects);
    };

    // Shadow DOM (open or closed) and slotted content, as the page draws it.
    function children(el) {
      if (el.localName === 'slot') {
        const assigned = el.assignedNodes({ flatten: true });
        return assigned.length ? assigned : [...el.childNodes];
      }
      let root = null;
      try { root = globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot; } catch {}
      return [...(root || el).childNodes];
    }

    function skipped(el, style) {
      const tag = el.localName;
      if (SKIP.has(tag) || el.hasAttribute('data-fpp-overlay')) return true;
      if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return true;
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
      if (style.display !== 'contents' && el.checkVisibility && !el.checkVisibility()) return true;
      if (hideFloating && style.position === 'fixed') return true;
      // Text only screen readers get ("opens in a new window").
      if (style.position === 'absolute' && /hidden|clip/.test(style.overflow)) {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 && r.height <= 1) return true;
      }
      if (mainOnly) {
        const role = el.getAttribute('role');
        if (tag === 'nav' || CHROME_ROLES.has(role)) return true;
        // Headers and footers of an article or section are part of it, and
        // so is a page header holding the page's main heading.
        if (CHROME_TAGS.has(tag) && !(tag === 'header' && el.querySelector('h1'))
          && !el.parentElement?.closest('article, main, [role="main"], section')) return true;
      }
      return false;
    }

    const isBlock = (el, style) => BLOCK_TAGS.has(el.localName)
      || !/^(inline|contents|ruby|none)/.test(style.display || 'inline');

    function walkChildren(el, b) {
      for (const child of children(el)) walk(child, b);
    }

    function walk(node, b) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.data.trim() && inArea(node)) b.text(escapeText(node.data.replace(/\s+/g, ' ')));
        else if (/\s/.test(node.data)) b.text(' ');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const style = getComputedStyle(el);
      // Math renderers show a picture or styled spans hidden from screen
      // readers, and hide the MathML with the TeX: read the wrapper whole.
      if (el.matches(MATH_WRAPPERS) && style.display !== 'none' && style.visibility !== 'hidden') return math(el, b);
      if (skipped(el, style)) return;
      const tag = el.localName;
      const block = isBlock(el, style);

      switch (tag) {
        case 'br':
          b.text(b.br);
          return;
        case 'img':
          return image(el, b, block);
        case 'math':
          return math(el, b);
        case 'a':
          return link(el, b, block);
        case 'strong': case 'b':
          if (!block) return b.text(wrapInline(inlineOf(el), '**'));
          break;
        case 'em': case 'i': case 'cite': case 'dfn':
          if (!block) return b.text(wrapInline(inlineOf(el), '*'));
          break;
        case 'del': case 's': case 'strike':
          if (!block) return b.text(wrapInline(inlineOf(el), '~~'));
          break;
        // Markdown has no superscript; the HTML tags are what renderers take.
        case 'sup': case 'sub': {
          const text = inlineOf(el);
          if (text) b.text(`<${tag}>${text}</${tag}>`);
          return;
        }
        case 'code': case 'kbd': case 'samp': case 'tt':
          if (!block && (!area || inArea(el))) return b.text(inlineCode(el.textContent));
          break;
      }
      if (!block) return walkChildren(el, b);
      // Everything below is a block; on one line it's just its text.
      if (b.inline) {
        b.text(' ');
        walkChildren(el, b);
        b.text(' ');
        return;
      }

      if (/^h[1-6]$/.test(tag)) {
        const text = inlineOf(el);
        if (text) b.block(`${'#'.repeat(Number(tag[1]))} ${text}`, 'heading');
        return;
      }
      switch (tag) {
        case 'ul': case 'ol':
          return b.block(list(el), 'list');
        case 'blockquote': {
          const inner = blocksOf(el);
          return b.block(inner && inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
        }
        case 'pre':
          if (area && !inArea(el)) return;
          return b.block(codeBlock(el.textContent, codeLanguage(el)));
        case 'table':
          return table(el, b);
        case 'hr':
          if (!area || inArea(el)) b.block('---');
          return;
        case 'dt': {
          const text = inlineOf(el);
          if (text) b.block(wrapInline(text, '**'));
          return;
        }
        case 'dd': {
          const inner = blocksOf(el);
          if (inner) b.block(prefixLines(inner, ': ', '  '));
          return;
        }
        case 'figcaption': {
          const text = inlineOf(el);
          if (text) b.block(wrapInline(text, '*'));
          return;
        }
      }
      b.flush();
      walkChildren(el, b);
      b.flush();
    }

    function inlineOf(el) {
      const b = new Builder(true);
      walkChildren(el, b);
      return b.finish();
    }

    function blocksOf(el, opts) {
      const b = new Builder();
      walkChildren(el, b);
      return b.finish(opts);
    }

    function list(el) {
      const ordered = el.localName === 'ol';
      let n = ordered ? (el.hasAttribute('start') ? el.start : 1) : 0;
      const items = []; // { text, indent }
      for (const child of children(el)) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (skipped(child, getComputedStyle(child))) continue;
        // A list straight inside a list (not in an <li>) belongs to the item before it.
        if (child.localName === 'ul' || child.localName === 'ol') {
          const nested = list(child);
          const last = items.at(-1);
          if (nested && last) last.text += `\n${prefixLines(nested, ' '.repeat(last.indent))}`;
          else if (nested) items.push({ text: nested, indent: 0 });
          continue;
        }
        if (child.localName === 'li' && child.hasAttribute('value')) n = child.value;
        let content = blocksOf(child, { tight: true });
        const box = child.querySelector(':scope > input[type="checkbox"], :scope > label > input[type="checkbox"], :scope > p > input[type="checkbox"]');
        if (box) content = `[${box.checked ? 'x' : ' '}] ${content}`;
        if (!content.trim()) {
          if (ordered) n++;
          continue;
        }
        const marker = ordered ? `${n++}.` : '-';
        const indent = marker.length + 1;
        items.push({ text: prefixLines(content, `${marker} `, ' '.repeat(indent)), indent });
      }
      return items.map((item) => item.text).join('\n');
    }

    function link(el, b, block) {
      const text = inlineOf(el);
      const href = el.href ? String(el.href) : '';
      if (!text) return;
      let md = text;
      if (href && !/^\s*javascript:/i.test(href)) {
        md = text === escapeText(href) ? `<${href}>` : `[${text}](${target(href)})`;
      }
      if (block && !b.inline) b.block(md);
      else b.text(md);
    }

    function image(el, b, block) {
      if (area && !inArea(el)) return;
      const src = el.currentSrc || el.src || '';
      const alt = (el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      // Tracking pixels and spacers.
      if (el.complete && el.naturalWidth && el.naturalWidth <= 2 && el.naturalHeight <= 2) return;
      // Inline data would bury the text under kilobytes of base64.
      if (!src || src.startsWith('data:')) {
        if (alt) b.text(escapeText(alt));
        return;
      }
      const md = `![${escapeText(alt)}](${target(src)})`;
      if (block && !b.inline) b.block(md);
      else b.text(md);
    }

    // MathML, or a renderer's wrapper around it, as $TeX$ (or $$…$$ on its
    // own line); its text when there's no TeX.
    function math(el, b) {
      if (area && !inArea(el)) return;
      const ml = el.localName === 'math' ? el : el.querySelector('math');
      const tex = ml?.getAttribute('alttext')
        || el.querySelector('annotation[encoding="application/x-tex"]')?.textContent
        || el.querySelector('img[alt]')?.getAttribute('alt')
        || '';
      // Wikipedia wraps its TeX in {\displaystyle …}.
      const clean = tex.trim().replace(/^\{\\(?:display|text)style\s*([\s\S]*)\}$/, '$1').trim();
      if (!clean) return b.text(escapeText((ml || el).textContent.replace(/\s+/g, ' ')));
      const display = ml?.getAttribute('display') === 'block'
        || el.matches('.mwe-math-element-block, .katex-display, .katex-display *, mjx-container[display="true"]');
      if (display && !b.inline) b.block(`$$\n${clean}\n$$`);
      else b.text(`$${clean}$`);
    }

    function codeLanguage(el) {
      const code = el.querySelector(':scope > code');
      for (const node of [el, code, el.parentElement]) {
        const m = /(?:^|\s)(?:lang(?:uage)?-|highlight-source-)([\w+#.-]+)/.exec(node?.className || '');
        if (m) return m[1];
      }
      return '';
    }

    function table(el, b) {
      const rows = [...el.rows].filter((r) => !skipped(r, getComputedStyle(r)));
      const layout = el.getAttribute('role') === 'presentation'
        || rows.length < 2
        || el.querySelector(LAYOUT_SIGNS);
      // Cells laid out as a grid, with spanned cells left empty.
      const grid = [];
      const plain = [];
      if (!layout) {
        rows.forEach((row, r) => {
          grid[r] ??= [];
          plain[r] ??= [];
          let c = 0;
          for (const cell of row.cells) {
            while (grid[r][c] !== undefined) c++;
            const text = skipped(cell, getComputedStyle(cell)) ? '' : cellText(cell);
            const span = Math.min(cell.colSpan || 1, 50);
            const down = Math.min(cell.rowSpan || 1, rows.length - r);
            for (let dr = 0; dr < down; dr++) {
              grid[r + dr] ??= [];
              plain[r + dr] ??= [];
              for (let dc = 0; dc < span; dc++) {
                grid[r + dr][c + dc] = dr === 0 && dc === 0 ? text : '';
                plain[r + dr][c + dc] = dr === 0 && dc === 0 && text ? cell.textContent : '';
              }
            }
            c += span;
          }
        });
      }
      const cols = Math.max(0, ...grid.map((r) => r.length));
      // Rows with something in them; in a region, the ones on screen.
      const keep = grid.map((r) => r.some((t) => t));
      // One column, or nothing in it: not really a table.
      if (layout || cols < 2 || !keep.some(Boolean)) {
        for (const row of rows) for (const cell of row.cells) { b.flush(); walkChildren(cell, b); b.flush(); }
        return;
      }
      const rect = (g) => g.filter((_, i) => keep[i]).map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? ''));
      b.block(renderTable(rect(grid), rect(plain)), 'table');
    }

    // A cell on one line; its line breaks become <br>.
    function cellText(cell) {
      const b = new Builder(true, '<br>');
      walkChildren(cell, b);
      return b.finish().replace(/^(?:<br>\s*)+|(?:\s*<br>)+$/g, '');
    }

    // With "main content only", the page's <main> or single <article> when
    // it has the bulk of the text; otherwise the whole page, without its
    // menus, banners, footers and sidebars.
    function contentRoot() {
      const body = document.body;
      if (!mainOnly || !body) return body;
      const total = body.innerText.length;
      const visible = (el) => el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null;
      const pick = (sel) => {
        const found = [...document.querySelectorAll(sel)].filter(visible);
        return found.length === 1 && found[0].innerText.length > Math.max(200, total * 0.2) ? found[0] : null;
      };
      return pick('main, [role="main"]') || pick('article') || body;
    }

    return { blocksOf, contentRoot };
  }

  // Title, address and date as YAML front matter.
  function frontMatter(title, url, when = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
    return `---\ntitle: ${JSON.stringify(title || '')}\nsource: ${JSON.stringify(url || '')}\nsaved: ${date}\n---\n\n`;
  }

  // The whole page (area: null) or what's inside `area`, a box in viewport
  // CSS pixels; `stamp` adds the title, address and date at the top.
  // Returns the Markdown text.
  function pageToMarkdown({ area = null, mainOnly = true, hideFloating = false, stamp = false } = {}) {
    const reader = makeReader({ area, mainOnly: area ? false : mainOnly, hideFloating });
    const root = area ? document.body : reader.contentRoot();
    const md = (root ? reader.blocksOf(root) : '').replace(/[ \t]+$/gm, '');
    return `${stamp ? frontMatter(document.title, location.href) : ''}${md}\n`;
  }

  globalThis.__fppMarkdown = {
    pageToMarkdown,
    // For the unit tests.
    escapeText, escapeLineStarts, wrapInline, inlineCode, codeBlock, columnAlignments, renderTable, prefixLines, tidyInline, frontMatter,
  };
})();
