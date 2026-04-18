// ------------------------------------------------------
// PREVENT DOUBLE LOADING
// ------------------------------------------------------
if (window.__bambiLoaded) {
} else {
  window.__bambiLoaded = true;

  const hostname = location.hostname.toLowerCase();

  console.log("[Bambi] content script loaded on", location.href);

  // ------------------------------------------------------
  // CONFIG
  // ------------------------------------------------------
  const BAMBI_SERVER = "http://127.0.0.1:5655";
  const BAMBI_ENDPOINT = BAMBI_SERVER + "/play";
  const BAMBI_STATUS_ENDPOINT = BAMBI_SERVER + "/status";
  const DEFAULT_DOMAINS = ["hypnotube.com"];
  const AUTO_MODE_DOMAINS = ["hypnotube.com"]; // Domains that use auto-play, not manual
  const DEFAULT_INTENT_WINDOW_MS = 2200;
  const DEFAULT_MANUAL_SHORTCUT = "Alt+Shift+V";
  const MULTI_FEED_DOMAINS = ["x.com", "twitter.com", "redgifs.com", "reddit.com"];
  const MANUAL_PREROLL_GRACE_MS = 18000;
  const MANUAL_PREROLL_GRACE_DOMAINS = ["pornhub.com"];
  const REMOTE_DOMAIN_MAP_URL = "https://geordie-bambi-mk2.github.io/bbrowser-resources/config.json";
  const REMOTE_DOMAIN_MAP_REFRESH_MS = 6 * 60 * 60 * 1000;
  const DEFAULT_VLC_ACTIVE_PLAYBACK_MS = 15 * 60 * 1000;
  const VLC_ACTIVE_PLAYBACK_GRACE_MS = 2 * 60 * 1000;
  const MAX_VLC_ACTIVE_PLAYBACK_MS = 4 * 60 * 60 * 1000;

  function isExtensionContextValid() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function safeRuntimeSendMessage(message) {
    if (!isExtensionContextValid()) return false;
    try {
      chrome.runtime.sendMessage(message);
      return true;
    } catch (e) {
      const msg = String(e?.message || e || "");
      if (/extension context invalidated/i.test(msg)) {
        return false;
      }
      console.warn("[Bambi] sendMessage failed:", e);
      return false;
    }
  }

  function safeStorageSet(value) {
    if (!isExtensionContextValid()) return false;
    try {
      chrome.storage.local.set(value);
      return true;
    } catch (e) {
      const msg = String(e?.message || e || "");
      if (/extension context invalidated/i.test(msg)) {
        return false;
      }
      console.warn("[Bambi] storage.set failed:", e);
      return false;
    }
  }

  function clampLikelyVlcPlaybackMs(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_VLC_ACTIVE_PLAYBACK_MS;
    return Math.max(60 * 1000, Math.min(ms, MAX_VLC_ACTIVE_PLAYBACK_MS));
  }

  function estimateLikelyVlcPlaybackMs(videoEl) {
    if (!(videoEl instanceof HTMLVideoElement)) return DEFAULT_VLC_ACTIVE_PLAYBACK_MS;

    const duration = Number(videoEl.duration);
    const currentTime = Number(videoEl.currentTime);
    if (Number.isFinite(duration) && duration > 0) {
      const remainingSeconds = Math.max(duration - (Number.isFinite(currentTime) ? currentTime : 0), 0);
      return clampLikelyVlcPlaybackMs((remainingSeconds * 1000) + VLC_ACTIVE_PLAYBACK_GRACE_MS);
    }

    return DEFAULT_VLC_ACTIVE_PLAYBACK_MS;
  }

  function markLikelyVlcPlaybackActive(durationMs, source = "page-video") {
    const startedAt = Date.now();
    const activeMs = clampLikelyVlcPlaybackMs(durationMs);
    safeStorageSet({
      bambiVlcPlaybackStartedAt: startedAt,
      bambiVlcPlaybackUntil: startedAt + activeMs,
      bambiVlcPlaybackSource: source,
    });
  }

  function getLikelyVlcPlaybackState() {
    if (!isExtensionContextValid()) {
      return Promise.resolve({ active: false, until: 0 });
    }

    return new Promise((resolve) => {
      chrome.storage.local.get({ bambiVlcPlaybackUntil: 0 }, (data) => {
        const until = Number(data.bambiVlcPlaybackUntil) || 0;
        resolve({ active: until > Date.now(), until });
      });
    });
  }

  async function getLiveVlcPlaybackState() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch(BAMBI_STATUS_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return { active: false, until: 0 };
      const payload = await response.json();
      if (!payload?.playing) return { active: false, until: 0 };

      const remainingSec = Number(payload.remaining_sec);
      const activeMs = Number.isFinite(remainingSec) && remainingSec >= 0
        ? Math.max(60 * 1000, Math.floor((remainingSec * 1000) + 2000))
        : DEFAULT_VLC_ACTIVE_PLAYBACK_MS;
      markLikelyVlcPlaybackActive(activeMs, "live-status");
      return { active: true, until: Date.now() + activeMs };
    } catch {
      return { active: false, until: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  async function getVlcPlaybackState() {
    const live = await getLiveVlcPlaybackState();
    if (live.active) return live;
    return getLikelyVlcPlaybackState();
  }

  function normalizeDomainInput(value) {
    if (!value) return "";
    let v = String(value).trim().toLowerCase();
    v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").replace(/\.$/, "");
    return v;
  }

  function hostMatchesDomain(host, domain) {
    const h = normalizeDomainInput(host);
    const d = normalizeDomainInput(domain);
    if (!h || !d) return false;
    return h === d || h.endsWith(`.${d}`);
  }

  function isHttpUrl(value) {
    return typeof value === "string" && /^https?:\/\/.+/i.test(String(value || "").trim());
  }

  function normalizeAutoPlayUrls(urls, legacyUrl = "") {
    const merged = [];
    if (Array.isArray(urls)) merged.push(...urls);
    if (legacyUrl) merged.push(legacyUrl);

    const seen = new Set();
    const normalized = [];
    merged.forEach((raw) => {
      const candidate = String(raw || "").trim();
      if (!isHttpUrl(candidate)) return;
      if (seen.has(candidate)) return;
      seen.add(candidate);
      normalized.push(candidate);
    });
    return normalized;
  }

  function pickRandomAutoPlayUrl(urls) {
    if (!Array.isArray(urls) || !urls.length) return "";
    return urls[Math.floor(Math.random() * urls.length)] || "";
  }

  function normalizeShortcutString(shortcut) {
    if (!shortcut) return DEFAULT_MANUAL_SHORTCUT;

    const raw = String(shortcut).split("+").map(s => s.trim()).filter(Boolean);
    const mods = [];
    let key = "V";

    raw.forEach(part => {
      const p = part.toLowerCase();
      if (p === "ctrl" || p === "control") {
        if (!mods.includes("Ctrl")) mods.push("Ctrl");
      } else if (p === "alt") {
        if (!mods.includes("Alt")) mods.push("Alt");
      } else if (p === "shift") {
        if (!mods.includes("Shift")) mods.push("Shift");
      } else if (p === "meta" || p === "cmd" || p === "command") {
        if (!mods.includes("Meta")) mods.push("Meta");
      } else if (p.length === 1) {
        key = p.toUpperCase();
      } else if (/^f\d{1,2}$/i.test(part)) {
        key = part.toUpperCase();
      }
    });

    const ordered = ["Ctrl", "Alt", "Shift", "Meta"].filter(m => mods.includes(m));
    return [...ordered, key].join("+");
  }

  function shortcutFromKeyboardEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");

    let key = String(e.key || "");
    if (key.length === 1) {
      key = key.toUpperCase();
    } else if (/^F\d{1,2}$/i.test(key)) {
      key = key.toUpperCase();
    } else if (e.code && /^Key[A-Z]$/.test(e.code)) {
      key = e.code.replace("Key", "");
    } else {
      key = key.toUpperCase();
    }

    if (!key) return "";
    return [...parts, key].join("+");
  }

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
  }

  function findBestVideoFromPoint(pointX, pointY, preferredTarget) {
    const directVideo = preferredTarget?.closest?.("video");
    if (directVideo instanceof HTMLVideoElement) return directVideo;

    const videos = Array.from(document.querySelectorAll("video"));
    const visible = videos.filter(v => {
      if (!(v instanceof HTMLVideoElement)) return false;
      const r = v.getBoundingClientRect();
      return r.width >= 160 && r.height >= 90;
    });

    if (!visible.length) return null;

    const underPoint = visible.filter(v => {
      const r = v.getBoundingClientRect();
      return pointX >= r.left && pointX <= r.right && pointY >= r.top && pointY <= r.bottom;
    });

    const pool = underPoint.length ? underPoint : visible;
    pool.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const acx = ar.left + ar.width / 2;
      const acy = ar.top + ar.height / 2;
      const bcx = br.left + br.width / 2;
      const bcy = br.top + br.height / 2;
      const ad = Math.hypot(pointX - acx, pointY - acy);
      const bd = Math.hypot(pointX - bcx, pointY - bcy);
      if (ad !== bd) return ad - bd;
      return (br.width * br.height) - (ar.width * ar.height);
    });

    return pool[0] || null;
  }

  // Helper: extract root domain (e.g., "example.com" from "sub.example.com")
  function getRootDomain(hostStr) {
    const parts = hostStr.split(".").filter(p => p.length > 0);
    if (parts.length <= 1) return hostStr;
    if (parts.length === 2) return hostStr;
    // Return last 2 parts (common for .com, .co.uk, etc.)
    return parts.slice(-2).join(".");
  }

  // Helper: determine if a domain should use auto or manual mode
  // Checks hardcoded AUTO_MODE_DOMAINS first, then falls back to preset mode field.
  function determineDomainMode(domain) {
    if (AUTO_MODE_DOMAINS.some(d => domain.includes(d.toLowerCase()))) return "auto";
    const norm = normalizeDomainInput(domain);
    const preset = bambiPresets.find(p => {
      const pd = normalizeDomainInput(p.domain || "");
      return pd && (norm === pd || norm.endsWith("." + pd));
    });
    if (preset?.mode === "auto") return "auto";
    return "manual";
  }

  // ------------------------------------------------------
  // STATE
  // ------------------------------------------------------
  let bambiActivated = false;
  let bambiDomains = [];
  let bambiBlacklist = [];
  let bambiMultiMonitor = true;
  let isMatchedDomain = false;
  let serverAvailable = false;
  let videoAlreadySent = false;
  let mainVideo = null;
  let domainMode = null; // 'auto' (hypnotube) or 'manual' (custom domains)
  let bambiDomainPlayerHints = {};
  let bambiDomainAssocMap = {};
  let bambiDomainAssocMapFetchedAt = 0;
  let userIntentWindowMs = DEFAULT_INTENT_WINDOW_MS;
  let manualShortcutEnabled = false;
  let manualShortcut = DEFAULT_MANUAL_SHORTCUT;
  let lastUserIntentTs = 0;
  let lastUserIntentTarget = null;
  let lastIntentX = null;
  let lastIntentY = null;
  let learningOverlay = null;
  let learningClickHandler = null;
  let manualTriggerOverlay = null;
  let manualTriggerClickHandler = null;
  let bambiInducedFullscreen = false;
  let manualPlayGraceUntil = 0;
  let manualPlayHandling = false;
  let bambiPresets = [];
  let bambiAdDomains = [];

  // Input lock (single-monitor mode)
  let bambiInputLockEnabled = false;
  let bambiInputLockDurationMs = 3600000;
  let bambiInputLockLockedUntil = 0;

  // Auto-play fallback URL
  let bambiAutoPlayEnabled = false;
  let bambiAutoPlayUrls = [];
  let bambiAutoPlayDelayMs = 600000;
  let autoPlayFallbackTimerId = null;
  let bambiRemotePlayerHints = {};
  let bambiConfigStale = false;
  let bambiConfigVersion = null;

  // ------------------------------------------------------
  // DOMAIN MATCHING
  // ------------------------------------------------------

  // Validates the shape of a fetched remote config object.
  function validateRemoteConfig(json) {
    if (!json || typeof json !== "object" || Array.isArray(json)) return false;
    if ("version" in json && (typeof json.version !== "number" || json.version < 1)) return false;
    if ("domains" in json && (typeof json.domains !== "object" || Array.isArray(json.domains) || json.domains === null)) return false;
    if ("presets" in json && !Array.isArray(json.presets)) return false;
    if ("adDomains" in json && !Array.isArray(json.adDomains)) return false;
    return !!(json.domains || json.presets || json.adDomains);
  }

  function normalizeAssociatedDomainMap(rawMap) {
    const normalized = {};
    if (!rawMap || typeof rawMap !== "object") return normalized;

    Object.entries(rawMap).forEach(([k, v]) => {
      const key = normalizeDomainInput(k);
      if (!key) return;

      const list = Array.isArray(v) ? v : [];
      const cleanValues = list
        .map(item => normalizeDomainInput(String(item).replace(/^\*\./, "")))
        .filter(Boolean);

      if (cleanValues.length) {
        normalized[key] = Array.from(new Set(cleanValues));
      }
    });

    return normalized;
  }

  function getAssociatedDomainsFor(configuredDomain) {
    const key = normalizeDomainInput(configuredDomain);
    return bambiDomainAssocMap[key] || [];
  }

  function getEffectiveDomains(domains) {
    const out = new Set((domains || []).map(normalizeDomainInput).filter(Boolean));
    (domains || []).forEach(base => {
      getAssociatedDomainsFor(base).forEach(assoc => out.add(assoc));
    });
    return Array.from(out);
  }

  async function refreshRemoteDomainAssociations(force = false) {
    if (window.top !== window.self) return;

    const now = Date.now();
    if (!force && bambiDomainAssocMapFetchedAt && (now - bambiDomainAssocMapFetchedAt) < REMOTE_DOMAIN_MAP_REFRESH_MS) {
      return;
    }

    // ── Fetch ────────────────────────────────────────────
    let json = null;
    let usedCache = false;

      try {
        const response = await fetch(REMOTE_DOMAIN_MAP_URL, { cache: "no-store" });
        if (response.ok) {
          const candidate = await response.json();
          if (validateRemoteConfig(candidate)) {
            json = candidate;
            // Persist as last-known-good
            safeStorageSet({ bambiLastGoodConfig: json, bambiLastGoodConfigAt: now });
          } else {
            console.log("[Bambi] remote config failed schema validation — falling back to last-known-good");
          }
        }
    } catch (e) {
      console.log("[Bambi] remote config fetch failed:", e.message);
    }

    // ── Fallback ─────────────────────────────────────────
    if (!json) {
      const cached = await new Promise(r =>
        chrome.storage.local.get({ bambiLastGoodConfig: null }, r)
      );
      if (cached.bambiLastGoodConfig) {
        json = cached.bambiLastGoodConfig;
        usedCache = true;
        console.log("[Bambi] using last-known-good config (stale)");
      } else {
        console.log("[Bambi] no config available — remote fetch failed and no cache");
        return;
      }
    }

    // ── Parse ─────────────────────────────────────────────
    // Support both legacy flat object and new { domains, presets } structure
    const rawMap = (json.domains && typeof json.domains === "object" && !Array.isArray(json.domains))
      ? json.domains
      : (json && typeof json === "object" && !Array.isArray(json) && !json.presets && !json.domains ? json : {});

    const normalizedMap = normalizeAssociatedDomainMap(rawMap);

    const rawPresets = Array.isArray(json.presets) ? json.presets : [];
    rawPresets.forEach(p => {
      const key = normalizeDomainInput(p.domain || "");
      if (!key || !Array.isArray(p.subdomains) || !p.subdomains.length) return;
      const subs = p.subdomains
        .map(s => normalizeDomainInput(String(s).replace(/^\*\./, "")))
        .filter(Boolean);
      if (subs.length) {
        normalizedMap[key] = Array.from(new Set([...(normalizedMap[key] || []), ...subs]));
      }
    });

    // Extract remote player hints keyed by domain
    const remoteHints = {};
    rawPresets.forEach(p => {
      const key = normalizeDomainInput(p.domain || "");
      if (key && p.playerHints && typeof p.playerHints === "object") {
        remoteHints[key] = p.playerHints;
      }
    });

    // Deduplicated + normalized ad domains — host-based only
    const newAdDomains = Array.from(new Set(
      (Array.isArray(json.adDomains) ? json.adDomains : [])
        .filter(d => typeof d === "string" && d.trim())
        .map(d => d.trim().toLowerCase())
    ));

    // ── Apply ─────────────────────────────────────────────
    bambiDomainAssocMap = normalizedMap;
    bambiPresets = rawPresets;
    bambiRemotePlayerHints = remoteHints;
    bambiAdDomains = newAdDomains;
    bambiConfigVersion = typeof json.version === "number" ? json.version : null;
    bambiConfigStale = usedCache;

    // Only advance the fetch-timestamp for genuine fresh responses so stale
    // mode retries on the next page load rather than waiting a full 6 hours.
    if (!usedCache) {
      bambiDomainAssocMapFetchedAt = now;
    }

      safeStorageSet({
      bambiDomainAssocMap: normalizedMap,
      bambiDomainAssocMapFetchedAt: usedCache ? bambiDomainAssocMapFetchedAt : now,
      bambiPresets: rawPresets,
      bambiAdDomains: newAdDomains,
      bambiRemotePlayerHints: remoteHints,
      bambiConfigStale: usedCache,
      bambiConfigVersion: bambiConfigVersion,
    });

    console.log(
      "[Bambi] config applied:", Object.keys(normalizedMap).length, "assoc,",
      rawPresets.length, "presets,", newAdDomains.length, "ad domains",
      usedCache ? "(stale)" : `(fresh v${bambiConfigVersion ?? "?"})`
    );
  }

  function checkDomainMatch(domains) {
    const effective = getEffectiveDomains(domains);
    return effective.some(d => hostMatchesDomain(hostname, d));
  }

  function getMatchedConfiguredDomain() {
    const matched = bambiDomains
      .map(normalizeDomainInput)
      .filter(base => {
        if (hostMatchesDomain(hostname, base)) return true;
        return getAssociatedDomainsFor(base).some(assoc => hostMatchesDomain(hostname, assoc));
      })
      .sort((a, b) => String(b).length - String(a).length);
    return matched[0] || null;
  }

  function isMultiFeedDomain() {
    return MULTI_FEED_DOMAINS.some(d => hostname.includes(d));
  }

  function isPrerollGraceDomain() {
    return MANUAL_PREROLL_GRACE_DOMAINS.some(d => hostMatchesDomain(hostname, d));
  }
  function shouldTreatShortVideosAsAds() {
    return isPrerollGraceDomain();
  }

  function getHintForCurrentDomain() {
    const key = getMatchedConfiguredDomain();
    if (!key) return null;
    // Local learned hint (user-clicked) takes priority over remote preset hint
    return bambiDomainPlayerHints[key] || bambiRemotePlayerHints[key] || null;
  }

  // Returns true when the page hostname matches a known ad/tracking domain.
  // Uses host-based matching so query-string text can never trigger a false positive.
  function isAdDomain() {
    let currentHost = "";
    try {
      currentHost = new URL(location.href).hostname.toLowerCase();
    } catch {
      currentHost = hostname;
    }
    return bambiAdDomains.some(ad => {
      if (!ad) return false;
      return currentHost === ad || currentHost.endsWith("." + ad);
    });
  }

  // ------------------------------------------------------
  // ACTIVATION STATE
  // ------------------------------------------------------
  function isBlacklisted() {
    const url = location.href.toLowerCase();
    // User manual blacklist: substring match on full URL (intentional — supports path patterns)
    if (bambiBlacklist.some(b => b && url.includes(b.toLowerCase()))) return true;
    // Ad domains: host-based only (prevents false positives from query strings or referrer text)
    return isAdDomain();
  }

  // Returns true when the current path matches a preset ignorePaths prefix,
  // meaning the extension should stay silent on this page (e.g. /search, /categories).
  function isIgnoredByPreset() {
    if (!bambiPresets.length) return false;
    const path = location.pathname.toLowerCase();
    const preset = bambiPresets.find(p => {
      const d = normalizeDomainInput(p.domain || "");
      return d && hostMatchesDomain(hostname, d);
    });
    if (!preset) return false;
    const patterns = Array.isArray(preset.ignorePaths) ? preset.ignorePaths : [];
    return patterns.some(p => path.startsWith(String(p).toLowerCase()));
  }

  function isBambiActivated() {
    return bambiActivated && isMatchedDomain && !isBlacklisted() && !isIgnoredByPreset();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.bambiActivated) {
      bambiActivated = Boolean(changes.bambiActivated.newValue);
      console.log("[Bambi] storage change → bambiActivated:", bambiActivated);
    }
    if (changes.bambiDomains) {
      bambiDomains = (changes.bambiDomains.newValue || DEFAULT_DOMAINS)
        .map(normalizeDomainInput)
        .filter(Boolean);
      isMatchedDomain = checkDomainMatch(bambiDomains);
      domainMode = determineDomainMode(hostname);
      console.log("[Bambi] storage change → domains:", bambiDomains, "matched:", isMatchedDomain, "mode:", domainMode);
      refreshRemoteDomainAssociations(false);
    }
    if (changes.bambiBlacklist) {
      bambiBlacklist = changes.bambiBlacklist.newValue || [];
      console.log("[Bambi] storage change → blacklist:", bambiBlacklist);
    }
    if (changes.bambiMultiMonitor) {
      bambiMultiMonitor = Boolean(changes.bambiMultiMonitor.newValue);
      console.log("[Bambi] storage change → multi-monitor:", bambiMultiMonitor);
    }
    if (changes.bambiDomainPlayerHints) {
      bambiDomainPlayerHints = changes.bambiDomainPlayerHints.newValue || {};
      console.log("[Bambi] storage change → domain player hints updated");
    }
    if (changes.bambiDomainAssocMap) {
      bambiDomainAssocMap = normalizeAssociatedDomainMap(changes.bambiDomainAssocMap.newValue || {});
      isMatchedDomain = checkDomainMatch(bambiDomains);
      console.log("[Bambi] storage change → associated domain map updated");
    }
    if (changes.bambiDomainAssocMapFetchedAt) {
      bambiDomainAssocMapFetchedAt = Number(changes.bambiDomainAssocMapFetchedAt.newValue) || 0;
    }
    if (changes.bambiIntentWindowMs) {
      const next = Number.parseInt(changes.bambiIntentWindowMs.newValue, 10);
      if (Number.isFinite(next) && next >= 800 && next <= 5000) {
        userIntentWindowMs = next;
        console.log("[Bambi] storage change → intent window ms:", userIntentWindowMs);
      }
    }
    if (changes.bambiManualShortcutEnabled) {
      manualShortcutEnabled = Boolean(changes.bambiManualShortcutEnabled.newValue);
      console.log("[Bambi] storage change → manual shortcut enabled:", manualShortcutEnabled);
    }
    if (changes.bambiManualShortcut) {
      manualShortcut = normalizeShortcutString(changes.bambiManualShortcut.newValue);
      console.log("[Bambi] storage change → manual shortcut:", manualShortcut);
    }
    if (changes.bambiPresets) {
      bambiPresets = Array.isArray(changes.bambiPresets.newValue) ? changes.bambiPresets.newValue : [];
      console.log("[Bambi] storage change → presets updated:", bambiPresets.length);
    }
    if (changes.bambiAdDomains) {
      bambiAdDomains = Array.isArray(changes.bambiAdDomains.newValue) 
        ? changes.bambiAdDomains.newValue.map(d => String(d).toLowerCase())
        : [];
      console.log("[Bambi] storage change → ad domains updated:", bambiAdDomains.length);
    }
    if (changes.bambiRemotePlayerHints) {
      bambiRemotePlayerHints = (changes.bambiRemotePlayerHints.newValue &&
        typeof changes.bambiRemotePlayerHints.newValue === "object")
        ? changes.bambiRemotePlayerHints.newValue : {};
    }
    if (changes.bambiConfigStale !== undefined) {
      bambiConfigStale = Boolean(changes.bambiConfigStale.newValue);
    }
    if (changes.bambiConfigVersion !== undefined) {
      bambiConfigVersion = changes.bambiConfigVersion.newValue ?? null;
    }
    if (changes.bambiInputLockEnabled !== undefined) {
      bambiInputLockEnabled = Boolean(changes.bambiInputLockEnabled.newValue);
      console.log("[Bambi] storage change → input lock enabled:", bambiInputLockEnabled);
      // Activate/deactivate keyboard and pointer lock based on input lock state
      if (bambiInputLockEnabled) {
        enableKeyboardLock();
        enablePointerLock();
      } else {
        // Unlock keyboard and pointer when input lock is disabled
        if (navigator.keyboard?.unlock) {
          navigator.keyboard.unlock().catch(e => {
            console.warn("[Bambi] keyboard.unlock failed:", e);
          });
          console.log("[Bambi] keyboard unlocked");
        }
        if (document.exitPointerLock) {
          document.exitPointerLock();
          console.log("[Bambi] pointer lock exited");
        }
      }
    }
    if (changes.bambiInputLockDurationMs !== undefined) {
      bambiInputLockDurationMs = Number(changes.bambiInputLockDurationMs.newValue) || 3600000;
    }
    if (changes.bambiInputLockLockedUntil !== undefined) {
      bambiInputLockLockedUntil = Number(changes.bambiInputLockLockedUntil.newValue) || 0;
      if (bambiInputLockLockedUntil && !isInputLockLockdownActive()) {
        bambiInputLockLockedUntil = 0;
        safeStorageSet({ bambiInputLockLockedUntil: 0 });
      }
      enforceInputLockState("lockdown-until-change");
    }
    if (changes.bambiAutoPlayEnabled !== undefined) {
      bambiAutoPlayEnabled = Boolean(changes.bambiAutoPlayEnabled.newValue);
      if (bambiAutoPlayEnabled) scheduleAutoPlayFallback(); else cancelAutoPlayFallback();
    }
    if (changes.bambiAutoPlayUrls !== undefined || changes.bambiAutoPlayUrl !== undefined) {
      bambiAutoPlayUrls = normalizeAutoPlayUrls(
        changes.bambiAutoPlayUrls?.newValue,
        changes.bambiAutoPlayUrl?.newValue || ""
      );
      if (bambiAutoPlayEnabled) scheduleAutoPlayFallback();
    }
    if (changes.bambiAutoPlayDelayMs !== undefined) {
      bambiAutoPlayDelayMs = Number(changes.bambiAutoPlayDelayMs.newValue) || 600000;
      if (bambiAutoPlayEnabled) scheduleAutoPlayFallback();
    }
  });

  // ------------------------------------------------------
  // SERVER HEALTH
  // ------------------------------------------------------
  async function isServerRunning() {
    try {
      const response = await fetch(BAMBI_SERVER + "/health", { method: "GET" });
      return response.status === 200;
    } catch (e) {
      console.log("[Bambi] Server unreachable:", e.message);
      return false;
    }
  }

  async function sendVideoToServer(videoUrl) {
    try {
      const response = await fetch(BAMBI_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: videoUrl,
          multi_monitor: bambiMultiMonitor,
          input_lock: bambiInputLockEnabled || isInputLockLockdownActive(),
        })
      });
      return response.ok;
    } catch (e) {
      console.log("[Bambi] Failed to send to server:", e.message);
      return false;
    }
  }

  // Helper: show cross-domain prompt
  async function showCrossDomainPrompt(videoDomain) {
    return new Promise((resolve) => {
      const subDomain = normalizeDomainInput(videoDomain);
      const rootDomain = getRootDomain(subDomain);
      const hasDistinctRoot = Boolean(rootDomain && rootDomain !== subDomain);

      const overlay = document.createElement("div");
      overlay.style = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999998;
        font-family: Arial, sans-serif;
      `;

      const box = document.createElement("div");
      box.style = `
        background: #222;
        padding: 30px;
        border-radius: 10px;
        max-width: 640px;
        text-align: center;
        border: 2px solid #ff6b6b;
      `;

      box.innerHTML = `
        <h2 style="margin-top: 0; color: #ff6b6b;">Cross-Domain Video Detected</h2>
        <p>Video is hosted on <strong>${subDomain}</strong></p>
        <p>Choose what to do with this detected domain:</p>
        <div style="display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 20px;">
          <button id="bambi-add-subdomain" style="padding: 10px 14px; background: #2e7d32; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.95rem;">Add subdomain (${subDomain})</button>
          <button id="bambi-add-root" style="padding: 10px 14px; background: #388e3c; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.95rem;">Add root domain (${rootDomain})</button>
          <button id="bambi-blacklist-subdomain" style="padding: 10px 14px; background: #8e2a2a; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.95rem;">Blacklist subdomain (${subDomain})</button>
          <button id="bambi-blacklist-root" style="padding: 10px 14px; background: #a13636; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.95rem;">Blacklist root domain (${rootDomain})</button>
        </div>
        <div style="margin-top: 12px;">
          <button id="bambi-skip-domain" style="padding: 9px 16px; background: #555; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 0.95rem;">Skip</button>
        </div>
      `;

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const addSubBtn = box.querySelector("#bambi-add-subdomain");
      const addRootBtn = box.querySelector("#bambi-add-root");
      const blacklistSubBtn = box.querySelector("#bambi-blacklist-subdomain");
      const blacklistRootBtn = box.querySelector("#bambi-blacklist-root");
      const skipBtn = box.querySelector("#bambi-skip-domain");

      if (!hasDistinctRoot) {
        if (addRootBtn) addRootBtn.style.display = "none";
        if (blacklistRootBtn) blacklistRootBtn.style.display = "none";
      }

      function pick(action, domain = null) {
        overlay.remove();
        resolve({ action, domain });
      }

      addSubBtn?.addEventListener("click", () => pick("add-domain", subDomain));
      addRootBtn?.addEventListener("click", () => pick("add-domain", rootDomain));
      blacklistSubBtn?.addEventListener("click", () => pick("blacklist-domain", subDomain));
      blacklistRootBtn?.addEventListener("click", () => pick("blacklist-domain", rootDomain));

      skipBtn?.addEventListener("click", () => pick("skip"));
    });
  }

  // ------------------------------------------------------
  // FULLSCREEN + INPUT LOCK
  // ------------------------------------------------------
  async function enterFullscreen(elem) {
    try {
      if (!document.fullscreenElement && elem?.requestFullscreen) {
        bambiInducedFullscreen = true;
        console.log("[Bambi] requesting fullscreen on", elem);
        await elem.requestFullscreen();
      }
    } catch (e) {
      bambiInducedFullscreen = false;
      console.warn("[Bambi] requestFullscreen failed:", e);
    }
  }

  async function enableKeyboardLock() {
    if (!navigator.keyboard?.lock) return;
    try {
      console.log("[Bambi] enabling keyboard lock");
      await navigator.keyboard.lock([
        "Escape",
        "F11",
        "AltLeft",
        "AltRight",
        "MetaLeft",
        "MetaRight"
      ]);
    } catch (e) {
      console.warn("[Bambi] keyboard.lock failed:", e);
    }
  }

  async function enablePointerLock() {
    try {
      const req =
        document.body.requestPointerLock ||
        document.body.mozRequestPointerLock ||
        document.body.webkitRequestPointerLock;

      if (req) {
        console.log("[Bambi] requesting pointer lock");
        req.call(document.body);
      }
    } catch (e) {
      console.warn("[Bambi] pointer lock failed:", e);
    }
  }

  function registerUserIntent(e) {
    lastUserIntentTs = Date.now();
    lastUserIntentTarget = e.target instanceof Element ? e.target : null;

    if (typeof e.clientX === "number" && typeof e.clientY === "number") {
      lastIntentX = e.clientX;
      lastIntentY = e.clientY;
      return;
    }

    const touch = e.touches?.[0] || e.changedTouches?.[0];
    if (touch) {
      lastIntentX = touch.clientX;
      lastIntentY = touch.clientY;
    }
  }

  document.addEventListener("pointerdown", registerUserIntent, true);
  document.addEventListener("click", registerUserIntent, true);
  document.addEventListener("touchstart", registerUserIntent, true);
  document.addEventListener("keydown", registerUserIntent, true);

  function hasDirectUserIntentForVideo(videoEl) {
    const age = Date.now() - lastUserIntentTs;
    if (age < 0 || age > userIntentWindowMs) return false;

    if (!(videoEl instanceof HTMLVideoElement)) return false;

    if (lastUserIntentTarget instanceof Element) {
      if (
        videoEl === lastUserIntentTarget ||
        videoEl.contains(lastUserIntentTarget) ||
        lastUserIntentTarget.contains(videoEl)
      ) {
        return true;
      }
    }

    if (typeof lastIntentX === "number" && typeof lastIntentY === "number") {
      const rect = videoEl.getBoundingClientRect();
      const pad = 28;
      const insideX = lastIntentX >= rect.left - pad && lastIntentX <= rect.right + pad;
      const insideY = lastIntentY >= rect.top - pad && lastIntentY <= rect.bottom + pad;
      if (insideX && insideY) return true;
    }

    return false;
  }

  function getPlayerContainer(videoEl) {
    if (!(videoEl instanceof HTMLVideoElement)) return null;
    return (
      videoEl.closest('[data-testid*="video" i]') ||
      videoEl.closest(".player") ||
      videoEl.closest(".video-player") ||
      videoEl.closest("article") ||
      videoEl.parentElement
    );
  }

  function buildStableSelector(el) {
    if (!(el instanceof Element)) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let cur = el;
    for (let i = 0; i < 4 && cur && cur !== document.body; i += 1) {
      const tag = cur.tagName.toLowerCase();
      const classes = Array.from(cur.classList || [])
        .filter(c => c && c.length < 40)
        .slice(0, 2)
        .map(c => `.${CSS.escape(c)}`)
        .join("");
      const testid = cur.getAttribute("data-testid");

      if (testid) {
        parts.unshift(`${tag}[data-testid="${CSS.escape(testid)}"]`);
      } else {
        parts.unshift(`${tag}${classes}`);
      }

      cur = cur.parentElement;
      if (cur?.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
    }

    return parts.join(" > ") || null;
  }

  function removeLearningOverlay() {
    if (learningOverlay) {
      learningOverlay.remove();
      learningOverlay = null;
    }
    if (learningClickHandler) {
      document.removeEventListener("click", learningClickHandler, true);
      learningClickHandler = null;
    }
  }

  function removeManualTriggerOverlay() {
    if (manualTriggerOverlay) {
      manualTriggerOverlay.remove();
      manualTriggerOverlay = null;
    }
    if (manualTriggerClickHandler) {
      document.removeEventListener("click", manualTriggerClickHandler, true);
      manualTriggerClickHandler = null;
    }
  }

  async function startManualTriggerMode() {
    removeManualTriggerOverlay();

    const running = await isServerRunning();
    serverAvailable = running;

    manualTriggerOverlay = document.createElement("div");
    manualTriggerOverlay.style = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      color: white;
      z-index: 999996;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 28px;
      font-family: Arial, sans-serif;
      text-align: center;
      pointer-events: none;
    `;
    manualTriggerOverlay.innerHTML = `
      <div style="background:#1f1f1f;border:1px solid #4caf50;border-radius:10px;padding:14px 18px;max-width:560px;box-shadow:0 10px 30px rgba(0,0,0,.4)">
        <div style="font-size:16px;font-weight:700;margin-bottom:6px">Bambi Manual Trigger</div>
        <div style="font-size:13px;color:#c9ffcf">Click the video player you want to send to VLC.</div>
      </div>
    `;
    document.body.appendChild(manualTriggerOverlay);

    manualTriggerClickHandler = async (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const pointX = typeof e.clientX === "number" ? e.clientX : window.innerWidth / 2;
      const pointY = typeof e.clientY === "number" ? e.clientY : window.innerHeight / 2;

      const pickedVideo = findBestVideoFromPoint(pointX, pointY, target);
      if (!(pickedVideo instanceof HTMLVideoElement)) {
        console.log("[Bambi] manual trigger: no playable video found at click point");
        removeManualTriggerOverlay();
        return;
      }

      const pickedUrl = pickedVideo.currentSrc || pickedVideo.src || "";
      if (!pickedUrl) {
        console.log("[Bambi] manual trigger: selected video has no source URL");
        removeManualTriggerOverlay();
        return;
      }

      console.log("[Bambi] manual trigger selected:", pickedUrl.substring(0, 80));
      pickedVideo.pause();
      pickedVideo.autoplay = false;

      if (serverAvailable) {
        const sent = await sendVideoToServer(pickedUrl);
        if (sent) {
          console.log("[Bambi] ✓ Manual trigger sent video to VLC");
          markLikelyVlcPlaybackActive(estimateLikelyVlcPlaybackMs(pickedVideo), "manual-trigger");
          videoAlreadySent = true;
          cancelAutoPlayFallback();
          removeManualTriggerOverlay();
          return;
        }
      }

      console.log("[Bambi] manual trigger fallback → browser playback");
      autoplayWithUnmute(pickedVideo);
      removeManualTriggerOverlay();
    };

    document.addEventListener("click", manualTriggerClickHandler, true);
  }

  document.addEventListener("keydown", async (e) => {
    if (window.top !== window.self) return;
    if (!manualShortcutEnabled) return;
    if (isTypingTarget(e.target)) return;

    const pressed = normalizeShortcutString(shortcutFromKeyboardEvent(e));
    const configured = normalizeShortcutString(manualShortcut);

    if (pressed !== configured) return;

    e.preventDefault();
    e.stopPropagation();
    console.log("[Bambi] manual shortcut detected:", configured);
    await startManualTriggerMode();
  }, true);

  function isVideoInLearnedContainer(videoEl) {
    const hint = getHintForCurrentDomain();
    if (!(videoEl instanceof HTMLVideoElement)) return true;

    // Local learned hints have a single `containerSelector` string;
    // remote preset hints carry a `containerSelectors` array. Handle both.
    const selectors = hint?.containerSelectors ||
      (hint?.containerSelector ? [hint.containerSelector] : []);
    if (!selectors.length) return true;

    try {
      return selectors.some(sel => videoEl.closest(sel) !== null);
    } catch {
      return true;
    }
  }

  function startPlayerLearningMode(learnDomain) {
    removeLearningOverlay();

    if (!hostMatchesDomain(hostname, learnDomain)) {
      return { ok: false, reason: "Open a page on that domain first, then click the cog again." };
    }

    learningOverlay = document.createElement("div");
    learningOverlay.style = `
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      color: white;
      z-index: 999997;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 28px;
      font-family: Arial, sans-serif;
      text-align: center;
      pointer-events: none;
    `;
    learningOverlay.innerHTML = `
      <div style="background:#1f1f1f;border:1px solid #ff9800;border-radius:10px;padding:14px 18px;max-width:520px;box-shadow:0 10px 30px rgba(0,0,0,.4)">
        <div style="font-size:16px;font-weight:700;margin-bottom:6px">Bambi Learn Player</div>
        <div style="font-size:13px;color:#ffd59a">Click the main player window once to save a detection hint for ${learnDomain}.</div>
      </div>
    `;
    document.body.appendChild(learningOverlay);

    learningClickHandler = (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) {
        removeLearningOverlay();
        return;
      }

      const pointX = typeof e.clientX === "number" ? e.clientX : null;
      const pointY = typeof e.clientY === "number" ? e.clientY : null;
      const allVideos = Array.from(document.querySelectorAll("video"));
      const visibleVideos = allVideos.filter(v => {
        const r = v.getBoundingClientRect();
        return r.width >= 160 && r.height >= 90;
      });

      let chosenVideo = target.closest("video");
      if (!chosenVideo && pointX !== null && pointY !== null && visibleVideos.length) {
        chosenVideo = visibleVideos.find(v => {
          const r = v.getBoundingClientRect();
          return pointX >= r.left && pointX <= r.right && pointY >= r.top && pointY <= r.bottom;
        }) || visibleVideos.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const acx = ar.left + ar.width / 2;
          const acy = ar.top + ar.height / 2;
          const bcx = br.left + br.width / 2;
          const bcy = br.top + br.height / 2;
          const ad = Math.hypot((pointX - acx), (pointY - acy));
          const bd = Math.hypot((pointX - bcx), (pointY - bcy));
          return ad - bd;
        })[0];
      }

      const container = getPlayerContainer(chosenVideo) || target.closest("article") || target.parentElement || target;
      const containerSelector = buildStableSelector(container);

      if (!containerSelector) {
        removeLearningOverlay();
        return;
      }

      chrome.storage.local.get({ bambiDomainPlayerHints: {} }, (data) => {
        const nextHints = { ...(data.bambiDomainPlayerHints || {}) };
        nextHints[learnDomain] = {
          containerSelector,
          learnedAt: Date.now(),
        };
        safeStorageSet({ bambiDomainPlayerHints: nextHints });
      });

      console.log("[Bambi] learned player container for", learnDomain, "→", containerSelector);
      removeLearningOverlay();
    };

    document.addEventListener("click", learningClickHandler, true);
    return { ok: true };
  }

  // ------------------------------------------------------
  // INPUT LOCK HELPERS
  // ------------------------------------------------------
  function isInputLockLockdownActive() {
    return Number(bambiInputLockLockedUntil) > Date.now();
  }

  function enforceInputLockState(reason = "") {
    const lockdownActive = isInputLockLockdownActive();
    const shouldForceEnable = lockdownActive;

    if (bambiInputLockLockedUntil && !lockdownActive) {
      bambiInputLockLockedUntil = 0;
      safeStorageSet({ bambiInputLockLockedUntil: 0 });
    }

    if (shouldForceEnable && !bambiInputLockEnabled) {
      bambiInputLockEnabled = true;
      safeStorageSet({ bambiInputLockEnabled: true });
      console.log("[Bambi] forcing input lock on:", reason || "state-enforcement");
    }
  }

  // ------------------------------------------------------
  // AUTO-PLAY FALLBACK HELPERS
  // ------------------------------------------------------
  function scheduleAutoPlayFallback(delayOverrideMs = null) {
    cancelAutoPlayFallback();
    if (!bambiAutoPlayEnabled || !bambiAutoPlayDelayMs || !bambiAutoPlayUrls.length) return;
    if (!isBambiActivated()) return;
    const delayMs = Math.max(1000, Number(delayOverrideMs) || bambiAutoPlayDelayMs);
    autoPlayFallbackTimerId = setTimeout(async () => {
      autoPlayFallbackTimerId = null;
      const playbackState = await getVlcPlaybackState();
      if (playbackState.active) {
        const remainingMs = Math.max(1000, playbackState.until - Date.now());
        console.log("[Bambi] auto-play fallback suppressed while VLC session is likely active for another", Math.ceil(remainingMs / 1000), "s");
        scheduleAutoPlayFallback(Math.min(bambiAutoPlayDelayMs, remainingMs + 1000));
        return;
      }
      const nextUrl = pickRandomAutoPlayUrl(bambiAutoPlayUrls);
      if (!videoAlreadySent && nextUrl && isHttpUrl(nextUrl)) {
        console.log("[Bambi] auto-play fallback → opening:", nextUrl);
        const sent = safeRuntimeSendMessage({ type: "BAMBI_OPEN_TAB", url: nextUrl });
        if (!sent) {
          console.log("[Bambi] runtime unavailable, stopping local fallback timer");
          return;
        }
        scheduleAutoPlayFallback(); // reschedule for next cycle
      }
    }, delayMs);
  }

  function cancelAutoPlayFallback() {
    if (autoPlayFallbackTimerId !== null) { clearTimeout(autoPlayFallbackTimerId); autoPlayFallbackTimerId = null; }
  }

  function suppressKeys(e) {
    // Explicitly block Windows/Meta key, Alt, F11, Escape
    if (e.key === "Meta" || e.metaKey || e.key === "Alt" || e.altKey || e.key === "F11" || e.code === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      return false;
    }
    e.stopPropagation();
    e.preventDefault();
  }

  document.addEventListener("fullscreenchange", () => {
    console.log("[Bambi] fullscreenchange →", !!document.fullscreenElement);
    if (document.fullscreenElement && bambiInducedFullscreen) {
      enforceInputLockState("fullscreen-enter");
      const shouldLock = bambiInputLockEnabled || isInputLockLockdownActive();
      if (shouldLock) {
        enableKeyboardLock();
        enablePointerLock();
        window.addEventListener("keydown", suppressKeys, true);
        window.addEventListener("keyup", suppressKeys, true);
      }
    } else if (!document.fullscreenElement) {
      bambiInducedFullscreen = false;
      window.removeEventListener("keydown", suppressKeys, true);
      window.removeEventListener("keyup", suppressKeys, true);
      if (navigator.keyboard?.unlock) {
        console.log("[Bambi] unlocking keyboard");
        navigator.keyboard.unlock();
      }
    }
  });

  // ------------------------------------------------------
  // SPA NAVIGATION DETECTION
  // ------------------------------------------------------
  function resetVideoState() {
    videoAlreadySent = false;
    mainVideo = null;
    manualPlayGraceUntil = 0;
    console.log("[Bambi] URL change detected → video state reset");
  }

  function onUrlChange() {
    if (!isMatchedDomain || isBlacklisted() || !isBambiActivated()) return;
    if (domainMode !== "auto") {
      console.log("[Bambi] URL change on manual mode domain → skipping auto hijack");
      cancelAutoPlayFallback();
      resetVideoState();
      scheduleAutoPlayFallback();
      return;
    }
    cancelAutoPlayFallback();
    resetVideoState();
    scheduleAutoPlayFallback();
    setTimeout(tryHijackOrFallback, 600);
    setTimeout(tryHijackOrFallback, 1500);
  }

  (() => {
    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState    = function(...a) { origPush(...a);    onUrlChange(); };
    history.replaceState = function(...a) { origReplace(...a); onUrlChange(); };
  })();

  window.addEventListener("popstate",   () => onUrlChange());
  window.addEventListener("hashchange", () => onUrlChange());

  // ------------------------------------------------------
  // MAIN VIDEO DETECTION
  // ------------------------------------------------------
  function findMainVideo() {
    if (mainVideo && document.contains(mainVideo)) {
      const rect = mainVideo.getBoundingClientRect();
      // Re-validate: the cached video must still be large enough AND not look like an ad/preroll.
      // isLikelyAdOrPreviewVideo is a function declaration inside this scope, so it is hoisted.
      if (rect.width >= 320 && rect.height >= 180 && !isLikelyAdOrPreviewVideo(mainVideo)) {
        return mainVideo;
      }
      mainVideo = null; // stale, too small, or now detected as an ad — re-detect
    }

    function getVideoArea(video) {
      const r = video.getBoundingClientRect();
      return r.width * r.height;
    }

    function isLikelyAdOrPreviewVideo(video) {
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      const style = window.getComputedStyle(video);
      const hidden =
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0;

      if (hidden) return true;

      if (isHintBlockedVideo(video)) return true;

      // No usable media source loaded
      if (video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) return true;

      if (isHintPreferredVideo(video)) return false;

      const src = (video.currentSrc || video.src || "").toLowerCase();
      const cls = String(video.className || "").toLowerCase();
      const id = String(video.id || "").toLowerCase();
      const parent = video.closest("[id],[class]");
      const parentMeta = `${String(parent?.id || "")} ${String(parent?.className || "")}`.toLowerCase();

      // Known ad-serving network domains in the src URL
      if (/(2mdn\.net|doubleclick\.net|googleadservices\.com|imasdk\.googleapis\.com|\.adnxs\.com|rubiconproject\.com|\.pubmatic\.com)/.test(src)) return true;

      // IMA SDK / recognised ad-container in DOM ancestry
      try {
        if (video.closest('[id*="AdContainer" i], [class*="AdContainer" i], [id*="ima-ad" i], [class*="ima-ad" i], [class*="ima_ad" i], [id*="ad-container" i], [class*="ad-container" i]')) return true;
      } catch (_) {}

      // ARIA label explicitly marking the element as an advertisement
      const ariaLabel = (video.getAttribute("aria-label") || "").toLowerCase();
      if (/\bad\b|advertisement/.test(ariaLabel)) return true;

      // Only apply the short-duration preroll rule on domains where we know
      // brief ad videos are common. Short HypnoTube clips are legitimate content.
      if (shouldTreatShortVideosAsAds() && Number.isFinite(video.duration) && video.duration > 0 && video.duration < 31) return true;

      const adLike = /(ad-|ads|advert|promo|preroll|outstream|vast|preview|thumbnail|thumb|teaser|dfp|imasdk|adunit|interstitial)/.test(
        `${src} ${cls} ${id} ${parentMeta}`
      );

      const tiny = rect.width < 320 || rect.height < 180;
      const mutedLooper = video.muted && video.loop && !video.controls;
      if (tiny && mutedLooper) return true;
      if (adLike && area < 500000) return true;

      return false;
    }

    const videos = Array.from(document.querySelectorAll("video"));
    const hint = getHintForCurrentDomain();

    // Filter to videos with a usable source and reasonable size
    const baseCandidates = videos.filter(v => {
      if (!(v instanceof HTMLVideoElement)) return false;
      const src = v.currentSrc || v.src || "";
      if (!src) return false;
      const rect = v.getBoundingClientRect();
      if (rect.width < 300 || rect.height < 200) return false;
      if (isLikelyAdOrPreviewVideo(v)) return false;
      return true;
    });

    const preferredCandidates = hint?.containerSelector
      ? baseCandidates.filter(v => isVideoInLearnedContainer(v))
      : baseCandidates;

    const candidates = preferredCandidates.length ? preferredCandidates : baseCandidates;

    if (!candidates.length) return null;

    const hintedMainCandidates = candidates.filter(v => isHintPreferredVideo(v));
    const rankedCandidates = hintedMainCandidates.length ? hintedMainCandidates : candidates;

    // For hypnotube prefer the CDN-hosted source
    if (hostname.includes("hypnotube")) {
      const htVideo = rankedCandidates.find(v => {
        const src = v.currentSrc || v.src || "";
        return src.includes("media.hypnotube.com") ||
               src.includes("cdn.hypnotube.com") ||
               src.includes("video.hypnotube.com");
      });
      if (htVideo) {
        mainVideo = htVideo;
        console.log("[Bambi] MAIN video locked (hypnotube CDN):", htVideo.currentSrc.substring(0, 80));
        return htVideo;
      }
    }

    // Generic fallback: favor the largest, central, non-muted active player.
    rankedCandidates.sort((a, b) => {
      function score(video) {
        const rect = video.getBoundingClientRect();
        const area = getVideoArea(video);
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const centerDx = Math.abs(cx - window.innerWidth / 2);
        const centerDy = Math.abs(cy - window.innerHeight / 2);
        const centerPenalty = (centerDx + centerDy) * 120;

        let total = area - centerPenalty;
        if (!video.muted) total += 25000;
        if (video.controls) total += 15000;
        if (!video.paused) total += 40000;
        if (isHintPreferredVideo(video)) total += 80000;
        if (isHintBlockedVideo(video)) total -= 120000;
        // Favour clearly content-length videos; only penalise short clips on preroll-heavy domains.
        if (Number.isFinite(video.duration) && video.duration > 60) total += 30000;
        if (shouldTreatShortVideosAsAds() && Number.isFinite(video.duration) && video.duration > 0 && video.duration < 31) total -= 20000;
        return total;
      }

      return score(b) - score(a);
    });

    mainVideo = rankedCandidates[0];
    const src = mainVideo.currentSrc || mainVideo.src || "";
    console.log("[Bambi] MAIN video locked:", src.substring(0, 80));
    return mainVideo;
  }

  function isMainSiteVideo(video) {
    const v = findMainVideo();
    return v && v === video;
  }

  function getHintSelectorList(hint, key) {
    if (!hint || typeof hint !== "object") return [];
    const raw = hint[key];
    if (!Array.isArray(raw)) return [];
    return raw.filter(sel => typeof sel === "string" && sel.trim().length > 0);
  }

  function videoMatchesHintSelector(video, selector) {
    if (!(video instanceof HTMLVideoElement) || !selector) return false;

    try {
      if (video.matches(selector)) return true;

      const container = getPlayerContainer(video);
      if (!container) return false;

      if (container.matches(selector)) return true;

      const matchedInContainer = container.querySelector(selector);
      if (!matchedInContainer) return false;

      return (
        matchedInContainer === video ||
        matchedInContainer.contains(video) ||
        video.contains(matchedInContainer)
      );
    } catch {
      return false;
    }
  }

  function videoMatchesAnyHintSelector(video, selectors) {
    if (!(video instanceof HTMLVideoElement) || !selectors.length) return false;
    return selectors.some(sel => videoMatchesHintSelector(video, sel));
  }

  function isHintPreferredVideo(video) {
    const hint = getHintForCurrentDomain();
    const preferred = getHintSelectorList(hint, "preferredVideoSelectors");
    return videoMatchesAnyHintSelector(video, preferred);
  }

  function isHintBlockedVideo(video) {
    const hint = getHintForCurrentDomain();
    const blockedVideo = getHintSelectorList(hint, "blockedVideoSelectors");
    const blockedContainers = getHintSelectorList(hint, "blockedContainerSelectors");
    return (
      videoMatchesAnyHintSelector(video, blockedVideo) ||
      videoMatchesAnyHintSelector(video, blockedContainers)
    );
  }

  function getVideoArea(video) {
    if (!(video instanceof HTMLVideoElement)) return 0;
    const r = video.getBoundingClientRect();
    return r.width * r.height;
  }

  function isLikelyPreviewOrAd(video) {
    if (!(video instanceof HTMLVideoElement)) return true;

    if (isHintBlockedVideo(video)) return true;

    const rect = video.getBoundingClientRect();
    const src = (video.currentSrc || video.src || "").toLowerCase();
    const cls = String(video.className || "").toLowerCase();
    const id = String(video.id || "").toLowerCase();
    const meta = `${src} ${cls} ${id}`;

    if (rect.width < 300 || rect.height < 170) return true;
    if (video.muted && video.loop && !video.controls) return true;
    if (video.muted && video.loop && !video.controls) return true;
    if (isHintPreferredVideo(video)) return false;

    // Known ad-serving network domains in the src URL
    if (/(2mdn\.net|doubleclick\.net|googleadservices\.com|imasdk\.googleapis\.com|\.adnxs\.com|rubiconproject\.com|\.pubmatic\.com)/.test(src)) return true;

    // IMA SDK / recognised ad-container in DOM ancestry
    try {
      if (video.closest('[id*="AdContainer" i], [class*="AdContainer" i], [id*="ima-ad" i], [class*="ima-ad" i], [class*="ima_ad" i], [id*="ad-container" i], [class*="ad-container" i]')) return true;
    } catch (_) {}

    // ARIA label explicitly marking the element as an advertisement
    const ariaLabel = (video.getAttribute("aria-label") || "").toLowerCase();
    if (/\bad\b|advertisement/.test(ariaLabel)) return true;

    // Only treat very short videos as ad-like on domains with known prerolls.
    if (shouldTreatShortVideosAsAds() && Number.isFinite(video.duration) && video.duration > 0 && video.duration < 31) return true;

    if (/(preview|thumbnail|thumb|ad-|ads|promo|teaser|preroll|outstream|dfp|imasdk|adunit|interstitial)/.test(meta) && getVideoArea(video) < 500000) {
      return true;
    }

    return false;
  }

  // Helper: extract video domain from URL
  function getVideoDomain(videoUrl) {
    try {
      const url = new URL(videoUrl);
      return url.hostname.toLowerCase();
    } catch (e) {
      return null;
    }
  }

  // Handle manual mode: wait for user to click play, then hijack with fullscreen
  async function handleManualModePlay(videoElement, videoUrl) {
    console.log("[Bambi] manual mode play detected:", videoUrl.substring(0, 80));

    if (!hasDirectUserIntentForVideo(videoElement)) {
      console.log("[Bambi] ignoring manual-mode play without direct user intent (likely ad/preview)");
      return;
    }

    if (!isVideoInLearnedContainer(videoElement)) {
      console.log("[Bambi] selected video is outside learned container, continuing due to direct intent");
    }

    const lockedMain = findMainVideo();
    if (lockedMain && lockedMain !== videoElement) {
      const lockedMainDomain = getVideoDomain(lockedMain.currentSrc || lockedMain.src || "");
      const pageRootDomain = getRootDomain(hostname);
      const lockedMainIsSameRoot = lockedMainDomain && getRootDomain(lockedMainDomain) === pageRootDomain;
      const lockedMainIsLarger = getVideoArea(lockedMain) > getVideoArea(videoElement) * 1.3;

      if (lockedMainIsSameRoot && lockedMainIsLarger && isLikelyPreviewOrAd(videoElement)) {
        console.log("[Bambi] ignoring smaller non-primary same-root video in favor of main player");
        return;
      }
    }

    if (isMultiFeedDomain() && !hasDirectUserIntentForVideo(videoElement)) {
      console.log("[Bambi] multi-feed domain guard ignored non-click video");
      return;
    }

    const videoDomain = getVideoDomain(videoUrl);
    const pageDomain = hostname;
    const videoRootDomain = videoDomain ? getRootDomain(videoDomain) : null;
    const pageRootDomain = getRootDomain(pageDomain);
    const matchedConfiguredDomain = getMatchedConfiguredDomain();
    const knownAssociatedDomains = matchedConfiguredDomain
      ? getAssociatedDomainsFor(matchedConfiguredDomain)
      : [];
    const isKnownAssociatedVideoHost = videoDomain
      ? knownAssociatedDomains.some(assoc => hostMatchesDomain(videoDomain, assoc))
      : false;

    // Check if video is cross-domain
    if (videoDomain && videoRootDomain !== pageRootDomain && !isKnownAssociatedVideoHost) {
      console.log("[Bambi] cross-domain detected: page=" + pageRootDomain + ", video=" + videoRootDomain);
      
      const choice = await showCrossDomainPrompt(videoDomain);
      const selectedDomain = normalizeDomainInput(choice?.domain || "");

      if (choice?.action === "add-domain" && selectedDomain) {
        chrome.storage.local.get({ bambiDomains: DEFAULT_DOMAINS }, (data) => {
          const updated = (data.bambiDomains || [])
            .map(normalizeDomainInput)
            .filter(Boolean);
          if (!updated.includes(selectedDomain)) {
            updated.push(selectedDomain);
            safeStorageSet({ bambiDomains: updated });
            console.log("[Bambi] added domain:", selectedDomain);
          }
        });
      }

      if (choice?.action === "blacklist-domain" && selectedDomain) {
        chrome.storage.local.get({ bambiBlacklist: [] }, (data) => {
          const updated = (data.bambiBlacklist || [])
            .map(item => normalizeDomainInput(item) || String(item).trim().toLowerCase())
            .filter(Boolean);
          if (!updated.includes(selectedDomain)) {
            updated.push(selectedDomain);
            safeStorageSet({ bambiBlacklist: updated });
            console.log("[Bambi] blacklisted domain:", selectedDomain);
          }
        });
      }
    } else if (isKnownAssociatedVideoHost) {
      console.log("[Bambi] associated host matched from remote map → skipping cross-domain prompt:", videoDomain);
    }

    // Pause in-page player and send to VLC with fullscreen
    console.log("[Bambi] pausing in-page player and preparing VLC launch");
    videoElement.pause();
    videoElement.autoplay = false;

    if (serverAvailable) {
      const sent = await sendVideoToServer(videoUrl);
      if (sent) {
        console.log("[Bambi] ✓ Video sent to VLC (manual mode)");
        markLikelyVlcPlaybackActive(estimateLikelyVlcPlaybackMs(videoElement), "manual-mode");
        videoAlreadySent = true;
        cancelAutoPlayFallback();
        return;
      }
    }

    console.log("[Bambi] failed to send to VLC, resuming browser playback");
    autoplayWithUnmute(videoElement);
  }

  // ------------------------------------------------------
  // POPUP MESSAGE LISTENER (live activate from toggle)
  // ------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "BAMBI_ACTIVATE" && isMatchedDomain && !isBlacklisted()) {
      console.log("[Bambi] received BAMBI_ACTIVATE (mode:", domainMode + ") → triggering hijack");
      isServerRunning().then(running => {
        serverAvailable = running;
        // Only auto-hijack in AUTO mode from popup trigger
        if (domainMode === "auto") {
          tryHijackOrFallback();
        } else if (domainMode === "manual") {
          console.log("[Bambi] manual mode → waiting for user play event");
        }
      });
    }

    if (msg.type === "BAMBI_LEARN_PLAYER") {
      if (window.top !== window.self) {
        return false;
      }
      const result = startPlayerLearningMode(msg.domain || "");
      sendResponse(result);
      return true;
    }

    if (msg.type === "BAMBI_FORCE_REFRESH_CONFIG") {
      if (window.top !== window.self) return false;
      refreshRemoteDomainAssociations(true).then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  // ------------------------------------------------------
  // AUTOPLAY + BLOCK HANDLING
  // ------------------------------------------------------
  function handleAutoplayBlocked(v) {
    console.log("[Bambi] autoplay or unmute blocked → showing continue overlay");

    const overlay = document.createElement("div");
    overlay.style = `
      position: fixed;
      inset: 0;
      background: black;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 3rem;
      z-index: 999999;
      cursor: pointer;
      user-select: none;
    `;
    overlay.textContent = "Click to continue Bambi Mode";

    const continueHandler = async () => {
      overlay.remove();

      try {
        v.muted = false;
        await v.play();
      } catch (err) {
        console.warn("[Bambi] play() failed after gesture:", err);
      }

      await enterFullscreen(v);
      await enableKeyboardLock();
      await enablePointerLock();

      document.removeEventListener("click", continueHandler, true);
      document.removeEventListener("keydown", continueHandler, true);
    };

    document.addEventListener("click", continueHandler, true);
    document.addEventListener("keydown", continueHandler, true);

    document.body.appendChild(overlay);
  }

  function autoplayWithUnmute(v) {
    console.log("[Bambi] autoplay fallback → starting muted");

    v.muted = true;
    v.autoplay = true;

    v.play().then(() => {
      console.log("[Bambi] autoplay started, attempting immediate unmute");

      v.muted = false;

      if (v.paused) {
        handleAutoplayBlocked(v);
      }
    }).catch(err => {
      console.warn("[Bambi] autoplay failed:", err);
      handleAutoplayBlocked(v);
    });
  }

  // ------------------------------------------------------
  // HIJACK LOGIC
  // ------------------------------------------------------
  async function tryHijackOrFallback() {
    if (!isMatchedDomain) return;
    if (!isBambiActivated()) {
      console.log("[Bambi] not activated → no hijack");
      return;
    }
    if (videoAlreadySent) return;

    const v = findMainVideo();
    if (!v) return;

    const videoSrc = v.currentSrc || v.src || "";
    console.log("[Bambi] main video detected:", videoSrc.substring(0, 80));

    // Last-ditch safety: if the resolved URL belongs to a known ad-serving domain, skip this
    // cycle and let the scheduled retries or loadedmetadata handler catch the real content.
    if (/(2mdn\.net|doubleclick\.net|googleadservices\.com|imasdk\.googleapis\.com|\.adnxs\.com)/.test(videoSrc.toLowerCase())) {
      console.log("[Bambi] video src is from an ad network — skipping, will retry on next trigger");
      mainVideo = null;
      return;
    }

    if (serverAvailable) {
      console.log("[Bambi] server available → sending to VLC");
      const sent = await sendVideoToServer(videoSrc);
      if (sent) {
        console.log("[Bambi] ✓ Video sent to VLC");
        markLikelyVlcPlaybackActive(estimateLikelyVlcPlaybackMs(v), "auto-mode");
        videoAlreadySent = true;
        cancelAutoPlayFallback();
        v.pause();
        v.autoplay = false;
        return;
      } else {
        console.log("[Bambi] server error → using browser autoplay fallback");
        autoplayWithUnmute(v);
        return;
      }
    } else {
      console.log("[Bambi] server offline → using browser autoplay fallback");
      autoplayWithUnmute(v);
      return;
    }
  }

  async function maybeHandleManualPlaybackTarget(target, sourceEvent = "play") {
    const directIntent = hasDirectUserIntentForVideo(target);
    const graceActive = Date.now() < manualPlayGraceUntil;

    if (directIntent && isPrerollGraceDomain()) {
      manualPlayGraceUntil = Date.now() + MANUAL_PREROLL_GRACE_MS;
    }

    if (!directIntent && !graceActive) {
      console.log("[Bambi]", sourceEvent, "ignored in manual mode (no direct click intent, likely autoplay/preview)");
      return;
    }

    if (!isVideoInLearnedContainer(target)) {
      console.log("[Bambi]", sourceEvent, "outside learned container, continuing due to direct intent");
    }

    if (isLikelyPreviewOrAd(target) && !isMainSiteVideo(target)) {
      if (directIntent && isPrerollGraceDomain()) {
        console.log("[Bambi] preroll/preview detected after click; waiting for main video within grace window");
      } else {
        console.log("[Bambi]", sourceEvent, "ignored in manual mode (likely preview/ad video)");
      }
      return;
    }

    if (!directIntent && graceActive && isLikelyPreviewOrAd(target)) {
      console.log("[Bambi]", sourceEvent, "ignored in manual mode (likely preview/ad video)");
      return;
    }

    const videoUrl = target.currentSrc || target.src || "";
    if (!videoUrl) {
      console.log("[Bambi] no video source found, ignoring");
      return;
    }

    if (manualPlayHandling) {
      console.log("[Bambi] manual-mode hijack already in progress; ignoring", sourceEvent);
      return;
    }

    manualPlayGraceUntil = 0;
    manualPlayHandling = true;
    try {
      await handleManualModePlay(target, videoUrl);
    } finally {
      manualPlayHandling = false;
    }
  }

  // ------------------------------------------------------
  // GLOBAL PLAY LISTENER (extra safety)
  // ------------------------------------------------------

  // In auto mode, listen for loadedmetadata on any video element. This fires when a new
  // stream is assigned — e.g. after a preroll ad ends and the real content source is set.
  // We re-run detection so we don't miss the main video if it wasn't present at page load.
  document.addEventListener(
    "loadedmetadata",
    (e) => {
      const target = e.target;
      if (!isMatchedDomain) return;
      if (!isBambiActivated()) return;
      if (videoAlreadySent) return;
      if (!(target instanceof HTMLVideoElement)) return;
      if (domainMode !== "auto") return;

      // Only bother if it looks like it could be real content (duration > 30 s if known)
      const dur = target.duration;
      if (Number.isFinite(dur) && dur > 0 && dur < 31) {
        console.log("[Bambi] loadedmetadata: short-duration video (" + dur.toFixed(1) + "s) — skipping re-detect (likely ad)");
        return;
      }

      console.log("[Bambi] loadedmetadata fired — re-running detection for auto mode");
      // Invalidate cache so findMainVideo reconsiders
      mainVideo = null;
      setTimeout(tryHijackOrFallback, 200);
    },
    true
  );

  document.addEventListener(
    "play",
    async (e) => {
      const target = e.target;
      console.log("[Bambi] global play event on", target, "mode:", domainMode);

      if (!isMatchedDomain) return;
      if (!isBambiActivated()) {
        console.log("[Bambi] play ignored, not activated");
        return;
      }

      if (videoAlreadySent) {
        console.log("[Bambi] video already sent to server, ignoring play");
        return;
      }

      if (!(target instanceof HTMLVideoElement)) return;

      // AUTO MODE (hypnotube): prefer proactive detection
      if (domainMode === "auto") {
        if (!isMainSiteVideo(target)) {
          console.log("[Bambi] play ignored, not main video (auto mode)");
          return;
        }
        await tryHijackOrFallback();
        return;
      }

      // MANUAL MODE (custom domains): wait for actual play event
      if (domainMode === "manual") {
        console.log("[Bambi] manual mode activated on play event");
        await maybeHandleManualPlaybackTarget(target, "play");
        return;
      }
    },
    true
  );

  document.addEventListener(
    "playing",
    async (e) => {
      const target = e.target;
      if (!isMatchedDomain) return;
      if (!isBambiActivated()) return;
      if (videoAlreadySent) return;
      if (!(target instanceof HTMLVideoElement)) return;
      if (domainMode !== "manual") return;

      console.log("[Bambi] global playing event on", target, "mode:", domainMode);
      await maybeHandleManualPlaybackTarget(target, "playing");
    },
    true
  );

  // ------------------------------------------------------
  // EXIT FULLSCREEN WHEN MAIN VIDEO ENDS
  // ------------------------------------------------------
  document.addEventListener(
    "ended",
    (e) => {
      const target = e.target;

      if (!isMatchedDomain) return;
      if (!isMainSiteVideo(target)) return;

      console.log("[Bambi] main video ended → exiting fullscreen");
      cancelAutoPlayFallback();

      if (document.fullscreenElement) {
        document.exitFullscreen().catch(err =>
          console.warn("[Bambi] exitFullscreen failed:", err)
        );
      }

      window.removeEventListener("keydown", suppressKeys, true);
      window.removeEventListener("keyup", suppressKeys, true);

      if (navigator.keyboard?.unlock) {
        navigator.keyboard.unlock();
      }
      document.exitPointerLock?.();
    },
    true
  );

  // ------------------------------------------------------
  // ENTRY POINT
  // ------------------------------------------------------
  chrome.storage.local.get(
    {
      bambiActivated: false,
      bambiDomains: ["hypnotube.com"],
      bambiBlacklist: [],
      bambiMultiMonitor: true,
      bambiDomainPlayerHints: {},
      bambiDomainAssocMap: {},
      bambiDomainAssocMapFetchedAt: 0,
      bambiPresets: [],
      bambiAdDomains: [],
      bambiRemotePlayerHints: {},
      bambiConfigStale: false,
      bambiConfigVersion: null,
      bambiIntentWindowMs: DEFAULT_INTENT_WINDOW_MS,
      bambiManualShortcutEnabled: false,
      bambiManualShortcut: DEFAULT_MANUAL_SHORTCUT,
      bambiInputLockEnabled: false,
      bambiInputLockDurationMs: 3600000,
      bambiInputLockLockedUntil: 0,
      bambiAutoPlayEnabled: false,
      bambiAutoPlayUrl: "",
      bambiAutoPlayUrls: [],
      bambiAutoPlayDelayMs: 600000,
      bambiVlcPlaybackUntil: 0,
    },
    async (data) => {
      bambiActivated  = Boolean(data.bambiActivated);
      bambiDomains    = (data.bambiDomains || ["hypnotube.com"])
        .map(normalizeDomainInput)
        .filter(Boolean);
      bambiBlacklist  = data.bambiBlacklist || [];
      bambiMultiMonitor = Boolean(data.bambiMultiMonitor);
      bambiDomainPlayerHints = data.bambiDomainPlayerHints || {};
      bambiDomainAssocMap = normalizeAssociatedDomainMap(data.bambiDomainAssocMap || {});
      bambiDomainAssocMapFetchedAt = Number(data.bambiDomainAssocMapFetchedAt) || 0;
      bambiPresets = Array.isArray(data.bambiPresets) ? data.bambiPresets : [];
      bambiAdDomains = Array.isArray(data.bambiAdDomains) ? data.bambiAdDomains.map(d => String(d).toLowerCase()) : [];
      bambiRemotePlayerHints = (data.bambiRemotePlayerHints && typeof data.bambiRemotePlayerHints === "object") ? data.bambiRemotePlayerHints : {};
      bambiConfigStale = Boolean(data.bambiConfigStale);
      bambiConfigVersion = data.bambiConfigVersion ?? null;
      manualShortcutEnabled = Boolean(data.bambiManualShortcutEnabled);
      manualShortcut = normalizeShortcutString(data.bambiManualShortcut || DEFAULT_MANUAL_SHORTCUT);
      bambiInputLockEnabled = Boolean(data.bambiInputLockEnabled);
      bambiInputLockDurationMs = Number(data.bambiInputLockDurationMs) || 3600000;
      bambiInputLockLockedUntil = Number(data.bambiInputLockLockedUntil) || 0;
      if (bambiInputLockLockedUntil && !isInputLockLockdownActive()) {
        bambiInputLockLockedUntil = 0;
        safeStorageSet({ bambiInputLockLockedUntil: 0 });
      }
      enforceInputLockState("init");
      bambiAutoPlayEnabled = Boolean(data.bambiAutoPlayEnabled);
      bambiAutoPlayUrls = normalizeAutoPlayUrls(data.bambiAutoPlayUrls, data.bambiAutoPlayUrl || "");
      safeStorageSet({
        bambiAutoPlayUrls,
        bambiAutoPlayUrl: bambiAutoPlayUrls[0] || "",
      });
      bambiAutoPlayDelayMs = Number(data.bambiAutoPlayDelayMs) || 600000;
      userIntentWindowMs = Number.isFinite(Number(data.bambiIntentWindowMs))
        ? Number(data.bambiIntentWindowMs)
        : DEFAULT_INTENT_WINDOW_MS;
      if (userIntentWindowMs < 800 || userIntentWindowMs > 5000) {
        userIntentWindowMs = DEFAULT_INTENT_WINDOW_MS;
      }
      isMatchedDomain = checkDomainMatch(bambiDomains);
      domainMode = determineDomainMode(hostname);

      refreshRemoteDomainAssociations(false);

      if (bambiAutoPlayEnabled) scheduleAutoPlayFallback();

      console.log(
        "[Bambi] init → activated:", bambiActivated,
        "domains:", bambiDomains,
        "effective-domains:", getEffectiveDomains(bambiDomains),
        "blacklist:", bambiBlacklist,
        "multi-monitor:", bambiMultiMonitor,
        "manual-shortcut-enabled:", manualShortcutEnabled,
        "manual-shortcut:", manualShortcut,
        "intent-window-ms:", userIntentWindowMs,
        "matched:", isMatchedDomain,
        "blacklisted:", isBlacklisted(),
        "mode:", domainMode
      );

      if (!isMatchedDomain) return;

      const running = await isServerRunning();
      serverAvailable = running;

      if (running) {
        console.log("[Bambi] ✓ bambi_player server running — VLC hijack mode enabled.");
      } else {
        console.log("[Bambi] bambi_player not running — using browser autoplay fallback.");
      }

      // Only auto-hijack in AUTO mode (hypnotube)
      if (bambiActivated && domainMode === "auto") {
        setTimeout(tryHijackOrFallback, 300);
        setTimeout(tryHijackOrFallback, 1000);
      } else if (bambiActivated && domainMode === "manual") {
        console.log("[Bambi] manual mode → waiting for user play event");
      }
    }
  );
}