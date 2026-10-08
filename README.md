# Webpage Screenshot Pro

A Chrome extension that saves a whole web page, the visible area or a region
you draw as a small PDF with real, searchable text, or as a JPEG or PNG image.

- **Privacy policy:** https://thefunzzies.github.io/webpage-screenshot-pro/privacy-policy.html
- **Contact:** stoneforestdesign@gmail.com

## Folders

| Folder | What's in it |
|---|---|
| [`fullpage-pdf/`](fullpage-pdf) | The extension itself. Its [README](fullpage-pdf/README.md) covers features, options, how it works and the version history. |
| [`tests/`](tests) | Automated tests that load the extension into Chrome for Testing, plus the script that renders the store artwork. |
| [`store/`](store) | Chrome Web Store material: listing text ([LISTING.md](store/LISTING.md)), icons, screenshots and promo tile. |
| [`docs/`](docs) | The GitHub Pages site: a home page and the privacy policy. |

## Try it

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `fullpage-pdf` folder.
3. Open any page and click the extension's icon.

## Tests

```
cd tests
npm install
npm test
```

`npm run test:live` also checks a few real websites, and `npm run store:assets`
rebuilds the icons and store artwork.
