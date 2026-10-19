// Injected into the page's isolated world. Gets the page ready for capture
// (lazy content loaded, viewport units pinned, inner scroll panels expanded),
// shows the progress card, and records every change so restore() puts the
// page back exactly as it was.
(() => {
  // Injected again for every capture: put back whatever the previous copy
  // changed and take its card down, so nothing of it is in this capture.
  if (window.__fpp) {
    try {
      window.__fpp.restore();
      window.__fpp.removeOverlay();
    } catch {}
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // rAF stalls in background tabs, so never wait on it alone.
  const frame = () => Promise.race([new Promise((r) => requestAnimationFrame(r)), sleep(50)]);
  const nextFrames = async () => { await frame(); await frame(); };
  // While loading, a frame of the very tall viewport can take far longer than
  // 50 ms, and lazy loaders only notice what's on screen when one is drawn.
  const drawnFrames = async () => {
    for (let i = 0; i < 2; i++) await Promise.race([new Promise((r) => requestAnimationFrame(r)), sleep(500)]);
  };
  // A number followed by a viewport unit, e.g. "100vh", "calc(100dvh - 4rem)", "50vmin".
  const VIEWPORT_UNIT = /\d\s*(?:[sld]?vh|[sld]?vmin|[sld]?vmax)\b/i;
  const VIEWPORT_WIDTH_UNIT = /\d\s*(?:[sld]?vw|[sld]?vmin|[sld]?vmax)\b/i;

  let undo = [];
  const images = new Map();
  const flags = { cancel: false, skip: false };
  let overlay = null;

  function setStyle(el, props) {
    const prev = el.getAttribute('style');
    undo.push(() => {
      // Setting the attribute first: just removing it can leave Chrome to
      // write the changed inline style back later as an empty style="".
      el.setAttribute('style', prev ?? '');
      if (prev === null) el.removeAttribute('style');
    });
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important');
  }

  function setAttr(el, name, value) {
    const prev = el.getAttribute(name);
    undo.push(() => (prev === null ? el.removeAttribute(name) : el.setAttribute(name, prev)));
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }

  const scrollTo = (el, top) => el.scrollTo({ top, behavior: 'instant' });
  const rootScroller = () => document.scrollingElement || document.documentElement;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  // ---------- Progress card ----------

  function showOverlay() {
    if (overlay) return;
    const host = document.createElement('div');
    host.setAttribute('data-fpp-overlay', '');
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { --bg:#fff; --fg:#1f1f1f; --muted:#5f6368; --track:#e8eaed; --bar:#c5221f; --line:#dadce0; }
        @media (prefers-color-scheme: dark) {
          :host { --bg:#2d2e31; --fg:#e8eaed; --muted:#9aa0a6; --track:#3c4043; --bar:#f28b82; --line:#5f6368; }
        }
        .card { width: 280px; box-sizing: border-box; padding: 12px 14px; border-radius: 10px;
                background: var(--bg); color: var(--fg); border: 1px solid var(--line);
                box-shadow: 0 6px 24px rgba(0,0,0,.18); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .top { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; }
        .pct { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums; }
        .text { margin: 2px 0 8px; color: var(--muted); font-size: 12px; min-height: 1.4em; }
        .track { height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
        .bar { height: 100%; width: 0; background: var(--bar); border-radius: 3px; transition: width .2s; }
        .busy .bar { width: 35% !important; animation: slide 1.1s ease-in-out infinite; }
        @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
        .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
        button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
                 border: 1px solid var(--line); background: transparent; color: var(--fg); }
        button:hover { background: var(--track); }
        button[hidden] { display: none; }
        .tip { margin-top: 10px; padding: 8px 10px; border-radius: 6px; background: var(--track); font-size: 12px; }
        .tip[hidden], .buttons[hidden] { display: none; }
      </style>
      <div class="card" role="status">
        <div class="top"><span>Webpage Screenshot Pro</span><span class="pct"></span></div>
        <div class="text">Starting…</div>
        <div class="track"><div class="bar"></div></div>
        <div class="tip" hidden></div>
        <div class="buttons">
          <button class="skip" hidden title="Stop loading more of the page and save what's loaded">Save now</button>
          <button class="stop">Stop</button>
          <button class="gotit" hidden>Got it</button>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    $('.skip').addEventListener('click', () => {
      flags.skip = true;
      $('.skip').hidden = true;
    });
    $('.gotit').addEventListener('click', removeOverlay);
    $('.stop').addEventListener('click', () => {
      flags.cancel = true;
      setProgress({ text: 'Stopping…', pct: null });
      send({ type: 'cancel' });
    });
    document.documentElement.appendChild(host);
    overlay = { host, $ };
  }

  function setProgress({ text, pct, canSkip, done, tip }) {
    if (!overlay) return;
    const { $ } = overlay;
    if (text != null) $('.text').textContent = text;
    $('.card').classList.toggle('busy', pct === null);
    if (pct != null) $('.bar').style.width = `${Math.round(pct)}%`;
    $('.pct').textContent = pct == null ? '' : `${Math.round(pct)}%`;
    if (canSkip !== undefined) $('.skip').hidden = !canSkip;
    if (done) {
      $('.top span').textContent = done;
      if (tip) {
        // Leave the tip up long enough to read; "Got it" closes it sooner.
        $('.tip').textContent = tip;
        $('.tip').hidden = false;
        $('.skip').hidden = true;
        $('.stop').hidden = true;
        $('.gotit').hidden = false;
        setTimeout(removeOverlay, 15000);
      } else {
        $('.buttons').hidden = true;
        setTimeout(removeOverlay, 2500);
      }
    }
  }

  // The card must not end up in the PDF, so it hides while Chrome renders.
  function overlayVisible(show) {
    if (overlay) overlay.host.style.display = show ? '' : 'none';
  }

  function removeOverlay() {
    overlay?.host.remove();
    overlay = null;
  }

  // ---------- Loading the whole page ----------

  // Tell native lazy images and iframes to load now, without being scrolled to.
  // Includes images inside web components (review widgets and the like).
  function forceEager() {
    for (const el of deepElements()) {
      if ((el.tagName === 'IMG' || el.tagName === 'IFRAME') && el.loading === 'lazy') el.loading = 'eager';
    }
  }

  // App-style pages (mail, chat, docs) keep the document at viewport height
  // and scroll an inner panel instead. Find the biggest such panel.
  function findInnerScroller(root) {
    if (root.scrollHeight > root.clientHeight + 5) return null;
    let best = null;
    let bestExtra = 50;
    for (const el of document.body.querySelectorAll('*')) {
      const extra = el.scrollHeight - el.clientHeight;
      if (extra <= bestExtra || el.clientWidth < innerWidth * 0.4) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      best = el;
      bestExtra = extra;
    }
    return best;
  }

  // Step through a scroller a full screen at a time so JavaScript lazy
  // loaders fire. The background makes the viewport several screens tall
  // while this runs, so each step covers a lot of page.
  async function scrollThrough(el, deadline, from, to) {
    const report = () => {
      const done = Math.min(1, (el.scrollTop + el.clientHeight) / el.scrollHeight);
      const pct = from + (to - from) * done;
      if (!flags.skip) setProgress({ text: 'Loading the whole page…', pct, canSkip: true });
      send({ type: 'progress', text: 'Loading the whole page…', pct });
    };
    // Let lazy loaders see the first (now much taller) screen before moving on.
    await drawnFrames();
    let y = 0;
    while (Date.now() < deadline && !flags.cancel && !flags.skip) {
      y += el.clientHeight;
      scrollTo(el, y);
      await drawnFrames();
      await sleep(40);
      report();
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
        // Give infinite-scroll and lazy loaders a moment to append more.
        await sleep(400);
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) break;
      }
    }
    scrollTo(el, 0);
  }

  async function loadAll({ maxMs, from = 0, to = 60, sideways = false }) {
    forceEager();
    const deadline = Date.now() + maxMs;
    const root = rootScroller();
    const inner = findInnerScroller(root);
    await scrollThrough(inner || root, deadline, from, to);
    if (sideways) {
      // Lazy cells and images in wide areas load when scrolled into view too.
      const els = sidewaysScrollers();
      if (pageScrollsSideways()) els.unshift(root);
      for (const el of els) await scrollAcross(el, deadline);
    }
    return { cancelled: flags.cancel };
  }

  async function scrollAcross(el, deadline) {
    const start = el.scrollLeft;
    for (let x = el.clientWidth; Date.now() < deadline && !flags.cancel && !flags.skip; x += el.clientWidth) {
      el.scrollTo({ left: x, behavior: 'instant' });
      await drawnFrames();
      if (x >= el.scrollWidth - el.clientWidth) break;
    }
    el.scrollTo({ left: start, behavior: 'instant' });
  }

  async function settleImages(timeout) {
    forceEager();
    const pending = [...document.images]
      .filter((img) => !img.complete)
      .map((img) => new Promise((r) => {
        img.addEventListener('load', r, { once: true });
        img.addEventListener('error', r, { once: true });
      }));
    await Promise.race([Promise.all(pending), sleep(timeout)]);
    if (document.fonts) await Promise.race([document.fonts.ready, sleep(timeout)]);
  }

  // ---------- Making the layout print like the screen ----------

  // Let the panel and everything above it grow to full height.
  function expand(el) {
    for (let n = el; n; n = n.parentElement) {
      const props = { height: 'auto', 'max-height': 'none', overflow: 'visible' };
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'absolute') Object.assign(props, { position: 'absolute', bottom: 'auto' });
      setStyle(n, props);
    }
  }

  // In print, 100vh means the height of the paper. On one tall page that
  // would blow full-screen sections up to the size of the whole document,
  // so freeze any viewport-unit heights at their current on-screen size.
  // (Widths too, when the paper is wider than the window.)
  function pinViewportUnits(props = ['height', 'min-height', 'max-height'], unit = VIEWPORT_UNIT) {
    const hits = new Map();
    const mark = (els, ps) => {
      if (!ps.length) return;
      for (const el of els) {
        let set = hits.get(el);
        if (!set) hits.set(el, (set = new Set()));
        ps.forEach((p) => set.add(p));
      }
    };
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.style && rule.selectorText) {
          const ps = props.filter((p) => unit.test(rule.style.getPropertyValue(p)));
          if (ps.length) {
            try { mark(document.querySelectorAll(rule.selectorText), ps); } catch {}
          }
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    };
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      try { visit(sheet.cssRules); } catch {} // cross-origin sheets can't be read
    }
    for (const el of document.querySelectorAll('[style*="vh"],[style*="vw"],[style*="vmin"],[style*="vmax"]')) {
      mark([el], props.filter((p) => unit.test(el.style.getPropertyValue(p))));
    }
    for (const [el, ps] of hits) {
      const cs = getComputedStyle(el);
      const pinned = {};
      for (const p of ps) pinned[p] = cs.getPropertyValue(p);
      setStyle(el, pinned);
    }
  }

  // Unroll scroll areas inside a pinned sidebar (a long table of contents
  // usually scrolls on its own) so everything in them gets captured, not
  // just the part that fit on screen. Returns whether anything grew.
  function expandScrollAreas(root) {
    let grew = false;
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.scrollHeight <= el.clientHeight + 5) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      for (let n = el; n && n !== root.parentElement; n = n.parentElement) {
        setStyle(n, { height: 'auto', 'max-height': 'none', overflow: 'visible' });
      }
      grew = true;
    }
    return grew;
  }

  // ---------- Sideways scrolling ----------

  // Names that give away a carousel or slider.
  const SLIDER = /carousel|slider|swiper|slick|splide|glide|flickity|owl-|marquee|ticker|slideshow/i;
  const CLIPS = /^(?:hidden|clip)$/;

  // Whether the page itself scrolls sideways. (overflow: hidden can make it
  // wider than the window without letting anyone see the rest.)
  function pageScrollsSideways() {
    const root = rootScroller();
    if (root.scrollWidth <= root.clientWidth + 1) return false;
    const x = scrollX;
    window.scrollTo({ left: root.scrollWidth, behavior: 'instant' });
    const scrolls = scrollX > 0;
    window.scrollTo({ left: x, behavior: 'instant' });
    return scrolls;
  }

  // Wide tables and the like that scroll sideways inside the page. Carousels
  // scroll sideways too, but unrolling one would lay all its slides out in a
  // row, so anything that snaps, is named like a slider or holds slides as
  // wide as itself is left alone, as are thin strips (custom scrollbars,
  // rows of tabs) other than code.
  function sidewaysScrollers() {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.scrollWidth <= el.clientWidth + 5 || el.clientWidth < 100 || el.clientHeight < 20) continue;
      const cs = getComputedStyle(el);
      if (!/^(?:auto|scroll|overlay)$/.test(cs.overflowX) || cs.visibility === 'hidden') continue;
      if (el.clientHeight < 60 && !/^pre/.test(cs.whiteSpace)) continue;
      if (!isSlider(el, cs)) out.push(el);
    }
    return out;
  }

  function isSlider(el, cs) {
    if (cs.scrollSnapType && cs.scrollSnapType !== 'none') return true;
    for (let n = el, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      const name = [n.id, typeof n.className === 'string' ? n.className : '', n.getAttribute('role'), n.getAttribute('aria-roledescription')].join(' ');
      if (SLIDER.test(name)) return true;
    }
    if (el.querySelector('table')) return false;
    // Slides: children (or the children of a single track) side by side,
    // each about as wide as the box. (Rows of a wide chart are wider.)
    let kids = [...el.children];
    if (kids.length === 1) kids = [...kids[0].children];
    const rects = kids.map((k) => k.getBoundingClientRect()).filter((r) => r.width > 0);
    return rects.length >= 2 && rects[1].left >= rects[0].right - 1 &&
      rects.every((r) => r.width >= el.clientWidth * 0.8 && r.width <= el.clientWidth * 1.05);
  }

  // Lets each sideways scroller show everything: code wraps its long lines,
  // anything else is made as wide as its contents, and whatever would clip
  // it stops clipping sideways. Areas that would end past maxWidth stay as
  // they are. Returns the right edge of the widest one in page pixels (0 if
  // none grew).
  function unrollSideways(maxWidth) {
    let right = 0;
    for (const el of sidewaysScrollers()) {
      // Unrolling an outer area can leave nothing for an inner one to do.
      const extra = el.scrollWidth - el.clientWidth;
      if (extra <= 5) continue;
      const cs = getComputedStyle(el);
      if (/^pre/.test(cs.whiteSpace) && !el.querySelector('table, img, svg, canvas, video')) {
        setStyle(el, { 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere' });
        continue;
      }
      const r = el.getBoundingClientRect();
      const edge = r.right + scrollX + extra;
      if (edge > maxWidth) continue;
      const left = el.scrollLeft;
      undo.push(() => el.scrollTo({ left, behavior: 'instant' }));
      el.scrollTo({ left: 0, behavior: 'instant' });
      const width = `${parseFloat(cs.width) + extra}px`;
      setStyle(el, {
        width, 'min-width': width, 'max-width': 'none', 'flex-shrink': '0', overflow: 'visible',
        ...(el.scrollHeight > el.clientHeight + 5 ? { height: 'auto', 'max-height': 'none' } : {}),
      });
      for (let n = el.parentElement; n; n = n.parentElement) {
        const ns = getComputedStyle(n);
        if (!CLIPS.test(ns.overflowX) || n.getBoundingClientRect().right + scrollX >= edge - 1) continue;
        if (n === document.documentElement || n === document.body) {
          setStyle(n, { 'overflow-x': 'visible', ...(CLIPS.test(ns.overflowY) ? {} : { 'overflow-y': 'visible' }) });
        } else if (CLIPS.test(ns.overflowY)) {
          // Still clip above and below; clip (unlike hidden) allows that.
          setStyle(n, { 'overflow-x': 'visible', 'overflow-y': 'clip', ...(ns.display === 'block' ? { display: 'flow-root' } : {}) });
        }
      }
      right = Math.max(right, edge);
    }
    return right;
  }

  // Width to capture, in CSS pixels, when the page or areas in it scroll
  // sideways; 0 when the window's width will do.
  function widenForSideways(maxWidth) {
    const root = rootScroller();
    const vw = root.clientWidth;
    const pageWidth = pageScrollsSideways() ? Math.min(root.scrollWidth, maxWidth) : 0;
    const width = Math.ceil(Math.max(pageWidth, unrollSideways(maxWidth)));
    if (width <= vw + 1) return 0;
    // Paper wider than the window would lay the page out wider; keep it at
    // the window's width, with the extra drawn beside it. Elements placed
    // against the page itself (like an off-screen menu at left: 100%) would
    // otherwise follow the paper's edge, and anything past that edge makes
    // Chrome shrink the whole print.
    const html = document.documentElement;
    const hs = getComputedStyle(html);
    setStyle(html, { width: hs.width, ...(hs.position === 'static' ? { position: 'relative' } : {}) });
    pinViewportUnits(['width', 'min-width', 'max-width'], VIEWPORT_WIDTH_UNIT);
    return width;
  }

  // ---------- Page breaks ----------

  // Chrome never splits an inline-block (or inline-flex, -grid, -table)
  // across pages: one that doesn't fit is pushed to the next page, leaving
  // the rest of this one blank, and then cut through wherever the page ends.
  // Grid frameworks often lay the whole article out as one, so on long
  // pages a row of such boxes is turned into a wrapping flex row, which
  // looks the same but breaks between lines like normal text.
  const ATOMIC_INLINE = /^inline-(?:block|flex|grid|table)$/;
  const FLEX_ALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end', 'text-top': 'flex-start', 'text-bottom': 'flex-end' };

  // The parent's in-flow children, if they are all such boxes with nothing
  // but white space between them; otherwise null.
  function rowOfBoxes(parent) {
    if (!/^(?:block|flow-root|list-item)$/.test(getComputedStyle(parent).display)) return null;
    const boxes = [];
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.data.trim()) return null;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
      if (!ATOMIC_INLINE.test(cs.display) || cs.float !== 'none') return null;
      boxes.push(node);
    }
    return boxes.length ? boxes : null;
  }

  function flexAlign(textAlign, rtl) {
    if (/center/.test(textAlign)) return 'center';
    if (textAlign === 'end' || textAlign === (rtl ? 'left' : 'right')) return 'flex-end';
    return 'flex-start';
  }

  // pageHeight: the height of one PDF page in CSS pixels. Returns how many
  // rows were changed.
  function letPagesBreak({ pageHeight }) {
    if (rootScroller().scrollHeight <= pageHeight) return 0;
    const tall = pageHeight / 3;
    const seen = new Set();
    let rows = 0;
    for (const el of document.body.querySelectorAll('*')) {
      const parent = el.parentElement;
      if (!parent || seen.has(parent) || !ATOMIC_INLINE.test(getComputedStyle(el).display)) continue;
      if (el.getBoundingClientRect().height < tall) continue;
      seen.add(parent);
      const boxes = rowOfBoxes(parent);
      if (!boxes) continue;
      const ps = getComputedStyle(parent);
      // Pin margins first: an auto margin does nothing on an inline-block
      // but would push a flex item around.
      const styles = boxes.map((b) => {
        const cs = getComputedStyle(b);
        return {
          'margin-left': cs.marginLeft, 'margin-right': cs.marginRight,
          'align-self': FLEX_ALIGN[cs.verticalAlign] || 'baseline',
        };
      });
      boxes.forEach((b, i) => setStyle(b, styles[i]));
      setStyle(parent, {
        display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'baseline',
        'justify-content': flexAlign(ps.textAlign, ps.direction === 'rtl'),
      });
      rows++;
    }
    return rows;
  }

  // Fixed-position elements either belong to the layout (a header bar or a
  // sidebar) or float over it (chat bubbles, cookie banners, popups).
  // Floating ones are hidden. Layout ones are left alone on one long page,
  // where they draw once; on paper pages Chrome would repeat them on every
  // page, so they become absolute and appear only at the top.
  // For image exports, pinned sidebars are stretched to the page's full
  // height: screenshots draw them only as tall as the window, while a
  // one-page PDF stretches them to the paper.
  function handleFloating(paged, keep, image) {
    const docH = rootScroller().scrollHeight;
    const vw = innerWidth;
    const vh = innerHeight;
    const bodyText = document.body.innerText.length || 1;
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      // Sticky sidebars (a common table-of-contents pattern) scroll too.
      if (cs.position === 'sticky') {
        if (el.getBoundingClientRect().height >= vh * 0.5) expandScrollAreas(el);
        continue;
      }
      if (cs.position !== 'fixed') continue;
      if (keep && el.contains(keep)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const header = r.top <= 1 && r.width >= vw * 0.6 && r.height < vh * 0.35;
      const sidebar = (r.left <= 1 || r.right >= vw - 1) && r.height >= vh * 0.6 && r.width < vw * 0.4;
      const cover = r.width >= vw * 0.9 && r.height >= vh * 0.9;
      if (sidebar) {
        const fullHeight = `${docH - r.top}px`;
        if (expandScrollAreas(el)) {
          // Let it grow with its contents, but still run the page's length.
          setStyle(el, {
            position: 'absolute', top: `${r.top}px`, bottom: 'auto',
            height: 'auto', 'max-height': 'none', overflow: 'visible',
            ...(paged ? {} : { 'min-height': fullHeight }),
          });
        } else if (paged) {
          setStyle(el, { position: 'absolute' });
        } else if (image) {
          setStyle(el, { position: 'absolute', top: `${r.top}px`, bottom: 'auto', height: fullHeight });
        }
      } else if (header) {
        if (paged) setStyle(el, { position: 'absolute' });
      } else if (cover && el.innerText.length > bodyText * 0.3) {
        // A full-screen shell that holds the page's content: keep it.
      } else {
        setStyle(el, { display: 'none' });
      }
    }
  }

  // Chrome's PDF engine is extremely slow at drawing text shadows: a page
  // with a few hundred thousand shadowed characters (code-heavy docs often
  // shadow every <code>) can take many minutes to render. A few shadowed
  // headlines are fine, so only drop shadows when there's a lot of them.
  function tameTextShadows(limit = 20000) {
    const shadowed = new Map();
    let total = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el) continue;
      let has = shadowed.get(el);
      if (has === undefined) shadowed.set(el, (has = getComputedStyle(el).textShadow !== 'none'));
      if (has) total += node.length;
    }
    if (total < limit) return 0;
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{text-shadow:none!important}';
    document.documentElement.appendChild(style);
    undo.push(() => style.remove());
    return total;
  }

  // Drop work that costs file size and render time but changes nothing you
  // can see. A no-op filter like blur(0px) (a common GPU trick) makes Chrome
  // flatten everything inside it into an uncompressed bitmap, and images
  // inside fully transparent elements (hidden carousel slides, hover-swap
  // pictures) still get stored in the PDF.
  const NOOP_FILTER = /^(?:(?:blur\(0px\)|brightness\(1\)|contrast\(1\)|saturate\(1\)|grayscale\(0\)|sepia\(0\)|invert\(0\)|opacity\(1\)|hue-rotate\(0deg\))\s*)+$/;

  function skipInvisibleWork() {
    let filters = 0;
    let hidden = 0;
    for (const el of deepElements()) {
      const f = getComputedStyle(el).filter;
      if (f !== 'none' && NOOP_FILTER.test(f)) {
        setStyle(el, { filter: 'none' });
        filters++;
      }
    }
    for (const img of deepImages()) {
      for (let n = img; n; n = n.parentElement) {
        if (getComputedStyle(n).opacity === '0') {
          setStyle(img, { visibility: 'hidden' });
          hidden++;
          break;
        }
      }
    }
    return { filters, hidden };
  }

  // Jump animations and transitions to their end state so nothing is
  // captured half-faded.
  function freezeMotion() {
    const style = document.createElement('style');
    style.textContent =
      '*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}';
    document.documentElement.appendChild(style);
    undo.push(() => style.remove());
  }

  // Runs at normal viewport size, after loadAll().
  async function prepare({ hideFloating, paged, image, waitImagesMs, sideways, maxWidth }) {
    const root = rootScroller();
    await settleImages(waitImagesMs);
    pinViewportUnits();
    const inner = findInnerScroller(root);
    if (inner) expand(inner);
    const width = sideways ? widenForSideways(maxWidth) : 0;
    if (hideFloating) handleFloating(paged, inner, image);
    freezeMotion();
    await nextFrames(); // let animations settle at their end state first
    const skipped = skipInvisibleWork();
    const shadowedChars = tameTextShadows();
    scrollTo(root, 0);
    await nextFrames();
    return { expanded: !!inner, width, shadowedChars, skipped, photos: countPhotos() };
  }

  // ---------- Smaller file ----------

  // Loaded raster images shown at least 150px on both sides; used to decide
  // whether to suggest Smaller file.
  function countPhotos() {
    let n = 0;
    for (const img of deepImages()) {
      if (!img.complete || !img.naturalWidth) continue;
      if (/\.svg(?:[?#]|$)/i.test(img.currentSrc || img.src)) continue;
      const r = img.getBoundingClientRect();
      if (r.width >= 150 && r.height >= 150) n++;
    }
    return n;
  }

  // The solid colour showing behind an element, so High compression can
  // put transparent images on it and store them as JPEG. null when what's
  // behind isn't one solid colour (a photo, a gradient, see-through layers).
  function backdropColor(el, includeSelf) {
    for (let n = includeSelf ? el : el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (n !== el && cs.backgroundImage !== 'none') return null;
      const m = cs.backgroundColor.match(/[\d.]+/g);
      const alpha = m && m.length === 4 ? +m[3] : 1;
      if (!m || alpha === 0) continue;
      if (alpha < 1) return null;
      return cs.backgroundColor;
    }
    return '#ffffff'; // nothing painted: the page is white
  }

  // Every element, including those inside open shadow roots: widgets like
  // review carousels are web components that document.images can't see.
  function* deepElements(root = document) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* deepElements(el.shadowRoot);
    }
  }

  const deepImages = () => [...deepElements()].filter((el) => el.tagName === 'IMG');

  const isRasterUrl = (src) => /^https?:/i.test(src) && !/\.svg(?:[?#]|$)/i.test(src);

  // Raster images (and, for High, CSS background images) to re-encode. The
  // background decides how much to shrink each one from its on-screen size.
  function collectImages({ backgrounds = false, limit = 400 } = {}) {
    images.clear();
    const list = [];
    const add = (kind, el, src, rect, flatten) => {
      const id = String(images.size);
      images.set(id, { kind, el });
      list.push({ id, kind, src, dispW: rect.width, dispH: rect.height, pageLeft: rect.left + scrollX, pageTop: rect.top + scrollY, flatten });
    };
    for (const img of deepImages()) {
      if (list.length >= limit) break;
      // Broken images are skipped. Ones still loading are included: the
      // background fetches its own copy, and they'd otherwise finish just in
      // time to go into the PDF uncompressed.
      if (img.complete && !img.naturalWidth) continue;
      const src = img.currentSrc || img.src;
      if (!isRasterUrl(src)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 24) continue;
      add('img', img, src, rect, backdropColor(img, false));
    }
    if (backgrounds) {
      for (const el of deepElements()) {
        if (list.length >= limit) break;
        const bg = getComputedStyle(el).backgroundImage;
        if (bg === 'none') continue;
        // Only a single plain url(); gradients and layered backgrounds stay.
        const m = bg.match(/^url\("?(.*?)"?\)$/);
        if (!m || !isRasterUrl(m[1])) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) continue;
        add('bg', el, m[1], rect, backdropColor(el, true));
      }
    }
    return list;
  }

  async function applyImages(results) {
    const loads = [];
    for (const { id, dataUrl, nw, nh } of results) {
      const entry = images.get(id);
      if (!entry) continue;
      const { kind, el } = entry;
      const cs = getComputedStyle(el);
      if (kind === 'bg') {
        const props = { 'background-image': `url("${dataUrl}")` };
        // "auto" sizes a background by its pixel size, which just shrank.
        if (/^auto( auto)?$/.test(cs.backgroundSize)) props['background-size'] = `${nw}px ${nh}px`;
        setStyle(el, props);
        continue;
      }
      setStyle(el, { width: cs.width, height: cs.height });
      const picture = el.parentElement?.tagName === 'PICTURE' ? el.parentElement : null;
      if (picture) for (const s of picture.querySelectorAll('source')) setAttr(s, 'srcset', null);
      // A lazy image that's off-screen would never load its new source.
      if (el.loading === 'lazy') setAttr(el, 'loading', 'eager');
      setAttr(el, 'srcset', null);
      setAttr(el, 'src', dataUrl);
      loads.push(el.decode().catch(() => {}));
    }
    // Never wait forever on an image that won't decode (hidden, detached…).
    await Promise.race([Promise.all(loads), sleep(3000)]);
    return results.length;
  }

  // ---------- Visible area and region ----------

  let stopSelecting = null;

  // Lets the person drag out a box over the page. Resolves with the box in
  // viewport CSS pixels, or null for Esc, Stop or a plain click.
  function selectRegion() {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.setAttribute('data-fpp-overlay', '');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .shade { position: fixed; inset: 0; background: rgba(0,0,0,.35); }
          .box { position: fixed; display: none; outline: 2px solid #fff;
                 box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 0 100vmax rgba(0,0,0,.35); }
          .label { position: fixed; font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff;
                   background: rgba(0,0,0,.78); padding: 6px 10px; border-radius: 6px; pointer-events: none; white-space: nowrap; }
          .hint { top: 16px; left: 50%; transform: translateX(-50%); }
          .size { display: none; font-size: 12px; padding: 3px 7px; }
        </style>
        <div class="shade"></div><div class="box"></div>
        <div class="label hint">Drag to select an area · Esc to cancel</div><div class="label size"></div>`;
      const [shade, box, size] = ['.shade', '.box', '.size'].map((q) => root.querySelector(q));
      let start = null;
      const rectFrom = (e) => ({
        x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY),
        w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y),
      });
      const draw = (r) => {
        Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
        size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
        Object.assign(size.style, { left: `${r.x}px`, top: `${Math.min(r.y + r.h + 6, innerHeight - 28)}px` });
      };
      const onDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start = { x: e.clientX, y: e.clientY };
        shade.style.display = 'none';
        box.style.display = size.style.display = 'block';
        draw(rectFrom(e));
      };
      const onMove = (e) => { if (start) draw(rectFrom(e)); };
      const onUp = (e) => {
        if (!start) return;
        const r = rectFrom(e);
        finish(r.w >= 5 && r.h >= 5 ? r : null);
      };
      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      };
      // Scrolling mid-drag would move the page under the box.
      const noScroll = (e) => e.preventDefault();
      function finish(r) {
        stopSelecting = null;
        host.remove();
        removeEventListener('keydown', onKey, true);
        resolve(r);
      }
      host.addEventListener('mousedown', onDown);
      host.addEventListener('mousemove', onMove);
      host.addEventListener('mouseup', onUp);
      host.addEventListener('wheel', noScroll, { passive: false });
      addEventListener('keydown', onKey, true);
      stopSelecting = () => finish(null);
      document.documentElement.appendChild(host);
    });
  }

  // What the visible area or a region needs to be cropped from.
  function viewInfo() {
    const d = document.documentElement;
    return { sx: scrollX, sy: scrollY, vw: d.clientWidth, vh: d.clientHeight, innerWidth, dpr: devicePixelRatio };
  }

  // Gets the page ready to print just the part that's on screen (y and
  // height in page pixels): pinned elements are put where they appear right
  // now rather than at the top of the document, and the page is shifted up
  // so that part starts at the top of the paper. Text stays real text.
  async function prepareView({ y }) {
    freezeMotion();
    await nextFrames();
    pinViewportUnits();
    const sx = scrollX;
    const sy = scrollY;
    const pinned = [];
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none') continue;
      pinned.push({ el, r: el.getBoundingClientRect() });
    }
    // Shift the page up; html becomes the anchor for the moved elements so
    // they shift with it.
    setStyle(document.documentElement, { position: 'relative', 'margin-top': `${-y}px` });
    for (const { el, r } of pinned) {
      setStyle(el, {
        position: 'absolute', left: `${r.left + sx}px`, top: `${r.top + sy - y}px`, right: 'auto', bottom: 'auto',
        width: `${r.width}px`, height: `${r.height}px`, margin: '0', transform: 'none',
      });
    }
    // Absolute positions count from the nearest positioned ancestor, not
    // always the page; nudge each element to where it should be.
    for (const { el, r } of pinned) {
      const now = el.getBoundingClientRect();
      const wantLeft = r.left + sx - scrollX;
      const wantTop = r.top + sy - y - scrollY;
      const dx = wantLeft - now.left;
      const dy = wantTop - now.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.style.setProperty('left', `${parseFloat(el.style.left) + dx}px`, 'important');
        el.style.setProperty('top', `${parseFloat(el.style.top) + dy}px`, 'important');
      }
    }
    skipInvisibleWork();
    tameTextShadows();
    await nextFrames();
  }

  // ---------- Lifecycle ----------

  // card: false skips the progress card (visible area and region captures,
  // where it would be in the picture or in the way).
  function begin({ card = true } = {}) {
    restore();
    // Cards and selection boxes left by an earlier copy of this script (a
    // reloaded extension, say) would otherwise be captured too.
    removeOverlay();
    for (const el of document.querySelectorAll('[data-fpp-overlay]')) el.remove();
    flags.cancel = false;
    flags.skip = false;
    const root = rootScroller();
    const startY = root.scrollTop;
    undo.push(() => scrollTo(root, startY));
    if (card) showOverlay();
  }

  function restore() {
    const fns = undo.reverse();
    undo = [];
    images.clear();
    for (const fn of fns) {
      try { fn(); } catch {}
    }
  }

  function cancel() {
    flags.cancel = true;
    stopSelecting?.();
  }

  // Messages from the background (the popup's Stop button arrives this way).
  // Registered once; it always talks to the latest copy of this script.
  if (!chrome.runtime.__fppListening) {
    chrome.runtime.__fppListening = true;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'fpp-cancel') window.__fpp?.cancel();
      if (msg?.type === 'fpp-progress') window.__fpp?.setProgress(msg);
    });
  }

  window.__fpp = {
    begin, loadAll, prepare, letPagesBreak, collectImages, applyImages, restore,
    selectRegion, viewInfo, prepareView, nextFrames, cancel,
    setProgress, overlayVisible, removeOverlay, flags,
  };
})();
