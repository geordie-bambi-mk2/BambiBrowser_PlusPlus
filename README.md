# BambiBrowser+

Quick setup for running the extension locally.

## 1. Download from GitHub

Option A (Git):

```powershell
git clone https://github.com/geordie-bambi-mk2/BambiBrowser_PlusPlus.git
cd BambiBrowser_PlusPlus
```

Option B (no Git):
1. Open the repo page on GitHub.
2. Click Code -> Download ZIP.
3. Extract the ZIP.

## 2. Load the extension

**Chromium (Chrome / Edge / Brave):**
1. Open extensions page: `chrome://extensions/` (or browser equivalent)
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select the `extension/` folder from this repo.

**Firefox:**
Get the signed `.xpi` from the `dist-firefox/` folder in the repo and drag it into Firefox. See the [Firefox install guide](guide/install-firefox.html) for full details.

## 3. Start the helper

Run `bambi_player.exe`.

If it is running, the extension can hand video playback to VLC through the local helper endpoint.

## Full guide pages

For full docs and feature walkthroughs, use:

https://geordie-bambi-mk2.github.io/bbrowser-resources/index.html

## Credits

- Original base: BambiBrowser by sissy3city
- This fork: geordie-bambi-mk2

