# Webpage Screenshot Pro

Saves an entire web page, just the visible area, or a region you draw, as a
small PDF with real, searchable, selectable text, as a JPEG/PNG image, or as
Markdown text. Instead of stitching screenshots, it asks
Chrome to render the page as a vector PDF, using the page's on-screen styles.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `fullpage-pdf` folder.
4. Pin the extension, open any page, click the icon, then **Save as PDF**.
   Also: right-click anywhere on a page → **Save full page as PDF**, or press
   **Alt+Shift+P** (change it at `chrome://extensions/shortcuts`). All three
   use the settings from the popup.
5. To copy instead of save: **Copy** in the popup, or right-click →
   **Copy full page as image**. The page goes onto the clipboard as an image,
   ready to paste with Ctrl+V.
6. **Capture a region**: choose Capture → Region in the popup and click
   **Select region**, right-click → **Capture a region…**, or press
   **Alt+Shift+R**. Drag a box on the page; Esc cancels.
7. **Save all tabs**: the **Save all tabs** button saves every normal web
   page in the current window, one after another, with your settings. The
   first time, Chrome asks for permission to read your open tabs (only this
   feature needs it). Each tab comes to the front briefly while it's saved.

## Options

- **Capture**: the full page (scrolled all the way down), just the visible
  area, or a region you drag out. Visible area and region capture what's on
  screen right now, including anything floating over the page. As images
  they're an exact screenshot; as PDFs the text stays real text.
- **Save as**: PDF (searchable text), JPEG, PNG or Markdown. Images are a
  picture of the page, so their text isn't searchable. Pages taller than
  16,000 pixels are saved as several images ("part 1 of 3" and so on).
  Markdown saves the page's text as a `.md` file: headings, paragraphs, bold
  and italic, lists (nested, numbered, checkboxes), quotes, code blocks (with
  their language), tables, links, images (linked to their address on the
  web), superscripts (`<sup>`) and math (as `$TeX$`). Visible area and region
  keep only the text on
  screen or in the box. With Markdown, **Copy** puts the text on the
  clipboard instead of an image.
- **Main content only** (Markdown, full page, on by default): leaves out
  menus, banners, page footers and sidebars, and uses the page's main
  article when it has one.
- **Layout** (PDF): one long page (looks like a full-page screenshot), or
  Letter / A4 pages.
- **Compression** (PDF): how much to squeeze the page's images.
  - **Off**: images exactly as the site sent them.
  - **Light**: images kept at 2x their on-screen size, JPEG quality 90%.
  - **Medium**: 2x on-screen size, quality 82%.
  - **High**: on-screen size, quality 65%; also compresses CSS background
    images and turns transparent images on a solid background into JPEGs.

  Every level also turns WebP/AVIF/PNG photos (including CSS background
  photos) into JPEG. PDFs can't hold WebP, so without compression Chrome
  stores those photos losslessly, which can make them 10x larger. Images are
  taken from what the page already loaded, so nothing is downloaded twice and
  no extra permission is needed.
- **Add page address and date** (PDF): a small header (page title, date) and
  footer (address, page number) on every page. For Markdown: the title,
  address and save time at the top, as front matter (`title:`, `source:`,
  `saved:`) that note apps like Obsidian read.
- **Load the whole page first**: scrolls through the page so lazy images and
  scroll-triggered content load. The window is made 10x taller while it does
  this, so even very long pages load in a few seconds (up to 30 s for endless
  feeds; **Save now** on the progress card stops loading and saves what's there).
  Markdown has its own copy of this option, off by default: text is nearly
  always on the page already, and lazy images are named from the address
  they keep for later, so only pages that add text as you scroll need it.
- **Hide floating elements** (on by default): hides fixed-position widgets such
  as chat bubbles, cookie banners and popups. Fixed headers and sidebars are
  kept; in Letter/A4 mode they're drawn once instead of on every page.
- **Include sideways-scrolling areas** (full page, on by default): wide
  tables and charts that scroll sideways inside the page (like a ratings
  chart with dozens of columns) are unrolled so every column is captured,
  and a page that is itself wider than the window is captured at its full
  width. The page keeps its on-screen layout; the capture just gets wider
  (up to 8,000 px). Letter/A4 pages are scaled so the full width fits. Long
  lines in code blocks wrap instead. Carousels and sliders are left as they
  are. While loading the page, sideways areas are also scrolled once so
  their lazy content appears.
- **Save to**: a folder inside Downloads (default `Downloads/Webpage Screenshot Pro`).
  Chrome only lets extensions save inside Downloads. If Chrome's own "Ask where
  to save each file before downloading" setting is on, Chrome shows its Save
  As window anyway.
- **File name**: page title + date (default), title + date + time (so repeat
  saves don't become "(1)", "(2)"), site + title + date, or title only. The
  popup shows an example.

Every PDF also records the page title, its address and when it was saved in
the PDF's properties (File > Properties in a PDF reader).

## Progress and stopping

While it works, a card in the page's top-right corner shows progress with
**Stop** and **Save now** buttons. The popup shows the same progress bar and a
Stop button, and picks the progress back up if you close and reopen it. The
card hides while Chrome renders, so it never appears in the PDF.

## How it works

1. `content.js` prepares the page: scrolls to load lazy content, freezes
   `100vh`-style heights at their on-screen size, expands app-style inner
   scroll panels and sideways-scrolling areas, and turns off animations.
   Every change is undone afterwards.
2. `background.js` attaches `chrome.debugger`, switches to screen styles
   (`Emulation.setEmulatedMedia`), measures the page, and calls
   `Page.printToPDF` with a paper size that matches the page.
3. The PDF is streamed back and handed to `chrome.downloads` as a blob URL made
   by a hidden offscreen page (`offscreen.html`), with no base64 copy in between.
   Images come from `Page.captureScreenshot` with `captureBeyondViewport`.
4. Markdown skips steps 2-3: `markdown.js` reads the page as it's shown
   (computed styles, so hidden text, screen-reader-only text and `<div>`
   layouts are handled like a reader sees them; shadow DOM included) and
   writes Markdown directly. Its formatting rules follow
   [pdfmd](https://github.com/M1ck4/pdfmd) (MIT): `***bold italic***`,
   `- ` / `1. ` lists, pipe tables with the first row as header, escaped `|`
   in cells, number columns right-aligned, and only the characters that break
   Markdown escaped. pdfmd itself is a Python desktop app that has to guess
   structure from a PDF's fonts and positions, so it can't run in an
   extension, and a web page states its structure outright.

Things that cost file size but change nothing visible are skipped during
capture: do-nothing CSS filters like `blur(0px)` (they make Chrome flatten
everything inside into an uncompressed bitmap) and images inside fully
transparent elements (hidden slides, hover images).

## Debug logs

Errors, and the start and end of each capture, are always recorded on this
computer (only the site's domain, not the full address). Turn on **More
settings → Debug logging** to record every step with full addresses when
tracking down a problem. **View logs** opens the logs page: filter, copy,
download or clear them, or **Submit logs**, which saves a report file (version,
browser, settings, logs) to Downloads and opens an email to the developer
(`SUPPORT_EMAIL` in `settings.js`) to attach it to. The last 500
entries are kept.

## Testing

Tests live next to this folder, in `../tests` (not part of the extension).
They load the extension into Chrome for Testing and check real captures.

```
cd ../tests
npm install          # first time only; also downloads Chrome for Testing
npm test             # helper checks + local test pages, about a minute
npm run test:live    # a few real websites, needs internet
```

Saved files stay in `tests/output` for a look afterwards. Clicking Chrome's
toolbar can't be automated, so the tests load a copy of the extension that is
granted access to tabs up front (what a click grants in real use).

## Known limits

- Chrome shows a "started debugging this browser" bar for about a second
  while it captures. That's expected with the `debugger` permission.
- Pages taller than 200 inches (19,200 px) are split into several tall pages,
  because Acrobat and most viewers refuse taller pages.
- `chrome://` pages, the Chrome Web Store and the built-in PDF viewer can't be captured.
  For `file://` pages, turn on "Allow access to file URLs" for the extension.
- Infinite-scroll feeds are captured as far as they load in 30 seconds.
- Sites that remove content as you scroll past it (some social feeds) only
  keep what is still on the page at the end.
- On pages with a lot of shadowed text (over 20,000 characters), text shadows
  are left out of the PDF, because Chrome takes minutes to render them.
- "Hide floating elements" decides by position and size, so now and then it
  may hide something you wanted or keep a banner. Turn it off for that page.
- "Include sideways-scrolling areas" tells carousels from wide tables by how
  they behave and what they're called; a carousel it doesn't recognise is
  laid out in one long row. Turn the option off for that page. Areas that
  would make the capture wider than 8,000 px keep scrolling as they are.

- Markdown: images and links point at their web addresses (images aren't
  downloaded). Tables used for layout, or with lists or headings in their
  cells, come out as plain paragraphs. Text drawn in `<canvas>` or inside
  `<iframe>`s isn't included. A region keeps whole lines and paragraphs that
  reach into the box.

## Version history

- **0.10.1**: Faster, lighter Markdown. Saving no longer scrolls through
  the page with the debugger attached unless you turn on "Load the whole page
  first" for Markdown (lazy images are named from their data attributes
  instead). The page is read about 40% faster, and the visible area or a
  region 10-50x faster on big pages (only the boxes on screen are read).
  Very large tables can no longer fail the save.
- **0.10.0**: Save as Markdown: the page's text as a `.md` file, for the full
  page, the visible area or a region, with headings, lists, tables, code,
  links, images and math. "Main content only" option. Copy puts Markdown
  text on the clipboard. Formatting rules adapted from pdfmd (MIT).

- **0.9.2**: Fixed leftover progress cards appearing in later captures and
  improved Save all tabs permission handling. Reduced memory use for large
  images and very wide captures, improved download reliability and error
  messages, and limited error-log addresses to the site when Debug logging
  is off. Requires Chrome 118 or later.
- **0.9.1**: Fixed long pages coming out with near-blank pages in PDFs.
  Sites built on older grid frameworks (e.g. Yale Appliance's blog) lay the
  whole article out as one inline-block, which Chrome won't split across
  pages, so it pushed the article onto a fresh page (and on Letter/A4 cut
  lines in half at page edges). Such rows are now laid out so pages break
  between lines, and put back afterwards. The page is also restored more
  cleanly (no empty style attributes left behind).

- **0.9.0**: Captures sideways scrolling too. Full-page PDFs and images now
  include wide tables and charts that scroll sideways (every column, e.g.
  Consumer Reports ratings charts) and pages wider than the window, at the
  page's on-screen layout; Letter/A4 pages scale the full width to fit. New
  option "Include sideways-scrolling areas" (on by default). Long lines in
  code blocks wrap instead of being cut off. Fixed script-loaded lazy images
  sometimes being missed while loading long pages.

- **0.8.0**: New logo (a camera in front of a document, Material style).
  Compression now also works for visible-area and region PDFs (only images in
  the area are processed). "Submit logs" opens an email to
  stoneforestdesign@gmail.com. Chrome Web Store package, listing text,
  artwork and privacy policy in `../store`.

- **0.7.0**: Capture modes: visible area and drag-to-select region (as an
  exact screenshot, or as a PDF with real text). Save all tabs. Debug logs
  with a logs page and Submit logs. Keyboard shortcut Alt+Shift+R for regions
  and a "Save visible area" shortcut you can assign. Right-click menu items
  for both.

- **0.6.0**: Compression no longer needs access to all sites: images come
  from what the page already loaded (faster, and works on images a site won't
  serve twice, like review photos). Light and Medium now also compress CSS
  background photos. Optional page address and date header/footer. PDF
  properties record title, address and save time. Copy to clipboard (popup
  button and right-click menu). File name styles. Lazy images inside web
  components now load. Fixed a hang while compressing on some shop pages.
  Automated tests in `../tests`.

- **0.5.1**: Renamed to Webpage Screenshot Pro (default save folder is now
  Downloads/Webpage Screenshot Pro; a folder you picked yourself is kept).
  Pinned and sticky sidebars that scroll on their own, like a long table of
  contents, are now captured in full instead of only the part that fit on
  screen.
- **0.5.0**: Save as JPEG or PNG. Compression levels (Off / Light / Medium /
  High) replace Smaller file; High also shrinks background images and
  flattens transparent images. Choose a save folder inside Downloads; "Ask
  where to save" removed. Right-click menu. Fixed one-page PDFs spilling onto
  a second (blank or nearly blank) page. Smaller files on sites using no-op
  CSS filters or hidden images, and compression now finds images inside web
  components (e.g. review widgets) and images still loading. Faster, lighter
  saving of big files.
- **0.4.0**: One-time Smaller file tip. After a PDF over 2 MB from a page with
  3+ photos saved without Smaller file, the progress card suggests it and the
  popup offers a "Turn on" button until you answer.
- **0.3.1**: Fixed pages that never finished rendering (Chrome's PDF engine
  stalls on heavy text shadows, e.g. code-heavy documentation; shadows are now
  dropped only on such pages). Loading long pages is about 2-4x faster.
  Rendering shows elapsed seconds. Smaller file now also replaces images the
  page showed as WebP with the server's JPEG version.
- **0.3.0**: Much faster loading of long pages (no more stopping partway);
  progress card with Stop and Save now; progress bar and Stop in the popup;
  Smaller file also converts WebP/AVIF/PNG photos to JPEG.
- **0.2.0**: Hide floating elements option (chat bubbles, cookie banners;
  pinned sidebars print once in Letter/A4).
- **0.1.0**: First version: full-page searchable PDF, one long page or
  Letter/A4, lazy-content loading, Smaller file, Ask where to save.
