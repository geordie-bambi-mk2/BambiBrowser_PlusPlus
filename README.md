# 💖 BambiBrowser+ — Sissy Edition 💖

> 🔍🆕 New in v5.21: Video-detection inspection tooling + popup update-check support.
>
> 🔒🔄 v5.2: Input Lock Timer and Auto-Play Fallback — smarter single-monitor sessions and automatic video redirection.
>
> 🖥️🖥️🖥️ v5.1: Multi-monitor mode — one video, all screens, primary audio only.
Welcome, sweetie.

This guide explains how your **BambiBrowser+** setup works. It's simple, automatic, and designed so you barely have to lift a finger.

> **Based on [BambiBrowser](https://github.com/sissy3city/BambiBrowser) by [sissy3city](https://github.com/sissy3city) — extended with a popup GUI, multi-domain support, URL blacklisting, and live activation.**

---

## 🌸 1. Install Your Extension

- Open your browser (any Chromium-based: Chrome, Edge, Brave, Opera…).
- Navigate to `chrome://extensions/` (or the equivalent for your browser).
- Turn on **Developer Mode**.
- Click **Load unpacked**.
- Select the `extension` folder inside this repo.

Your browser is now ready to behave for you.

---

## 🌸 2. Start the Bambi Player

Double-click **`bambi_player.exe`**.

A tiny tray icon appears — that means your helper is awake and waiting quietly in the background. No windows, no popups.

### Multi-monitor mode (new)

If you want playback on all monitors at once (2-3 screens), run:

```powershell
.\start_bambi_player_multimon.ps1
```

This starts `bambi_player_multimon.py` on the same API (`http://127.0.0.1:5655`) used by the extension.

- Monitor 1 (primary): full volume
- Monitor 2/3+: muted
- All monitors: fullscreen playback

---

## 🌸 3. Configure via the Popup

Click the **BambiBrowser+** icon in your browser toolbar to open the control panel.

### Enable Hijack toggle
Flips Bambi Mode on or off instantly. Turning it on while a matching tab is already open triggers the hijack immediately — no page reload needed.

### Active Domains
The list of sites the extension watches. **hypnotube.com** is included by default. Add any domain (e.g. `example.com`) and it will be treated exactly like hypnotube — video detected, sent to the player, fullscreen + lock activated.

### ⛔ Blacklist
Enter any keyword, path segment, or partial URL. If the current page URL contains that string *anywhere*, the extension will skip it entirely — even if the domain is in the active list.

Examples:
- `category1` → skips `site.com/category1/video` **and** `site.com/category1plusmoretext`
- `?preview=` → skips any preview/embed URL
- `site.com/skip` → skips only that specific path

### Status dot
- 🟢 Green — `bambi_player.exe` is running and reachable
- 🔴 Red — player is offline; extension falls back to browser autoplay

---

## 🌸 4. What Happens Automatically

Whenever you open a video on a watched domain:

1. The extension detects the main video element.
2. It checks whether the current URL is blacklisted — if so, skips entirely.
3. It checks whether `bambi_player` is running.

**If the player is running:**
- Browser video pauses
- Video URL is sent to `bambi_player` → VLC opens fullscreen
- Keyboard + pointer lock activates
- When the video ends: VLC closes, locks release, everything returns to normal

**If the player is not running:**
- Browser plays the video normally with autoplay + unmute
- No fullscreen hijack, no lock

The extension also handles **SPA navigation** (sites that load new videos without a full page reload) — video state resets automatically when the URL changes.

---

## 🌸 5. How to Stop the Bambi Player

Right-click the tray icon → **Quit**.

This instantly disables hijacking until you run it again. You can also just flip the popup toggle off.

---

## 🌸 6. That's Everything, Sweetie

No setup pages. No popups you didn't ask for. No fuss.

Just automatic fullscreen hijack whenever your helper is running — on whatever sites you choose.

---

## Credits

| | |
|---|---|
| Original author | [sissy3city](https://github.com/sissy3city) — [BambiBrowser](https://github.com/sissy3city/BambiBrowser) |
| This fork | [geordie-bambi-mk2](https://github.com/geordie-bambi-mk2) — BambiBrowser+ v5.21 |

---

## 🌸 v5.21 — Video Detection Inspection + Update Check

### Playwright live video inspection

Set up once:

```powershell
npm install
npx playwright install chromium
```

Run interactive inspection (headed):

```powershell
npm run pw:inspect:headed
```

Run automated inspection (headless):

```powershell
npm run pw:inspect:headless
```

Optional single-domain run:

```powershell
node tests/playwright-video-inspect.mjs --headed --domain hypnotube.com --ms 90000
```

Reports and screenshots are saved to `tests/artifacts/`.

### Popup update check

The popup now compares the installed extension version with the hosted config version and shows:

- Up-to-date status when current build matches or exceeds remote version
- Update available notice when remote is newer
- A one-click button to open:
	`https://github.com/geordie-bambi-mk2/BambiBrowser_PlusPlus`

---

## 🌸 v5.2 — New Features

### 🔒 Input Lock Timer (single-monitor)

Multi-monitor mode has always locked the keyboard and pointer during playback. Now single-monitor sessions can do the same — with an automatic release timer so you don't get stuck.

**How to use:**
1. Open the popup → **General** tab → **Playback** section.
2. Toggle on **Input lock (single-monitor)**.
3. Choose **Lockdown duration** — picks from 10 min, 20 min, 1 h, 2 h, 4 h, 6 h, 8 h, or 12 h.
4. Click **Start Lockdown**.

When a VLC fullscreen session starts, keyboard and pointer lock engage. During lockdown, input lock cannot be disabled in settings. After the timer ends, input lock is still ON — the timer only allows you to disable it manually again.

> **Note:** Multi-monitor mode is unaffected by this toggle — it always engages input lock regardless.

---

### 🔄 Auto-Play Fallback URL

If Bambi Mode is active but no video has been sent to VLC for a while, the extension can automatically open a fallback URL in a new tab — keeping your session going without manual navigation.

**How to use:**
1. Open the popup → **General** tab → **Auto-Play Fallback** section.
2. Toggle on **Open URL if no video found**.
3. Enter a **Fallback URL** — any `https://` page on a site already in your active domains.
4. Choose **Open after idle for** — 5 min, 10 min, 15 min, 20 min, 30 min, 45 min, or 1 hour.

When the idle timer expires without a video being found, the URL opens in a new tab. The timer then reschedules itself for the next idle window. Once a video is successfully sent to VLC, the timer cancels for that page session.

> **Tip:** The fallback URL should point to a page on a domain already in your active domains list — so the extension will automatically try to hijack its video when the tab loads.

---

## 📖 Full Guide

Detailed docs now live in the `guide/` folder as a multi-page set:
- `guide/index.html` (hub)
- `guide/install.html`
- `guide/player.html`
- `guide/boot.html`
- `guide/usage.html`
- `guide/input-lock.html`
- `guide/auto-play.html`
- `guide/features.html` (full deep-dive, all sections)

