# Chrome Web Store listing: Webpage Screenshot Pro

Copy each section into the matching field of the Chrome Web Store Developer
Dashboard (https://chrome.google.com/webstore/devconsole).

## Package

Upload `webpage-screenshot-pro-<version>.zip` from this folder.

## Store listing tab

**Name** (from the manifest): Webpage Screenshot Pro

**Summary** (132 characters max; this is the manifest description):
Save a whole web page, the visible area or a region you draw, as a small searchable PDF or a JPEG/PNG image.

**Description:**

Save any web page exactly as you see it, top to bottom, as a PDF with real, searchable text, or as a JPEG or PNG image.

FULL PAGE, VISIBLE AREA OR A REGION
• Full page: scrolls through the whole page so lazy-loaded images appear, then saves it all.
• Visible area: just what's on screen right now.
• Region: drag a box around any part of the page.

PDFS WITH REAL TEXT
• Search, select and copy text in the saved PDF. It's not just a picture.
• One long page that looks like the website, or Letter / A4 pages for printing.
• Optional header and footer with the page address and the date you saved it.
• The page's title, address and save time are recorded in the PDF's properties.

SMALL FILES
• Four compression levels, from Off to High. A typical recipe page drops from 8.8 MB to under 500 KB.
• Photos in WebP format (which PDFs can't hold) become compact JPEGs, and oversized images are scaled to how they're shown.

HANDLES REAL-WORLD PAGES
• Hides chat bubbles, cookie banners and popups.
• Prints pinned headers and sidebars once, and unrolls scrolling sidebars like long tables of contents.
• Captures wide tables and charts that scroll sideways, every column, plus pages wider than the window.
• Works with app-style pages that scroll inside a panel (mail, notebooks, docs).
• Very long pages load in seconds; a progress bar with Stop and "Save now" keeps you in control.

MORE
• Save all open tabs in one click.
• Copy the page to the clipboard as an image.
• Right-click menu and keyboard shortcuts (Alt+Shift+P full page, Alt+Shift+R region).
• Choose the folder inside Downloads and the file-name style.
• Debug logs you can view, download or send to the developer if something goes wrong.

PRIVATE BY DESIGN
Everything happens on your computer. No accounts, no uploads, no tracking.

Note: while it captures, Chrome shows a "started debugging this browser" bar for a moment. That's how Chrome lets extensions produce PDFs with real text.

**Category:** Productivity → Tools

**Language:** English

**Graphics:**
- Store icon (128×128): `store-icon-128.png`
- Screenshots (1280×800): `screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png`
- Small promo tile (440×280): `promo-tile-440x280.png`

**Support / contact email:** stoneforestdesign@gmail.com

## Privacy tab

**Single purpose description:**
Webpage Screenshot Pro saves web pages, or parts of them, as PDF or image files on the user's computer.

**Permission justifications:**

- **debugger**: Used to have Chrome render the current page as a PDF with real, selectable text (Page.printToPDF) or as a full-page image (Page.captureScreenshot), and to read images the page already loaded so they can be compressed (Page.getResourceContent). Only attached to the tab the user chose to capture, only during that capture.
- **activeTab**: Gives access to the tab the user is capturing, at the moment they click the button, right-click menu item or shortcut.
- **scripting**: Injects the script that prepares the page for capture (loads lazy images, hides floating chat/cookie widgets, shows the progress card and the region selector) and undoes those changes afterwards.
- **downloads**: Saves the finished PDF or image to the user's Downloads folder.
- **storage**: Stores the user's settings and a local debug log.
- **contextMenus**: Adds "Save full page", "Save visible area", "Capture a region" and "Copy full page as image" to the right-click menu.
- **offscreen**: Creates a blob URL for large finished files so they can be handed to the downloads API without building a huge data URL.
- **Host permission (optional, <all_urls>)**: Requested only when the user clicks "Save all tabs", so tabs other than the clicked one can be captured. Not needed for anything else.

**Remote code:** No, I am not using remote code. All code is in the package.

**Data usage:** The extension does not collect or transmit any user data. Tick none of the data types. Certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://thefunzzies.github.io/webpage-screenshot-pro/privacy-policy.html

## Distribution tab

Visibility: Public (or Unlisted to try it with a few people first). Regions: All.
