// BambiBrowser+ background service worker
// Handles tasks that content scripts cannot do (e.g. chrome.tabs.create)
// and runs resilient idle autoplay checks via alarms.

const AUTOPLAY_ALARM = "bambi-autoplay-check";
const AUTOPLAY_MIN_PERIOD_MINUTES = 1;
const BAMBI_STATUS_ENDPOINT = "http://127.0.0.1:5655/status";

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\/.+/.test(url);
}

function normalizeAutoPlayUrls(urls, legacyUrl = "") {
  const merged = [];
  if (Array.isArray(urls)) merged.push(...urls);
  if (legacyUrl) merged.push(legacyUrl);

  const seen = new Set();
  const result = [];
  merged.forEach((value) => {
    const candidate = String(value || "").trim();
    if (!isHttpUrl(candidate)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    result.push(candidate);
  });
  return result;
}

function pickRandomAutoPlayUrl(urls) {
  if (!Array.isArray(urls) || !urls.length) return "";
  return urls[Math.floor(Math.random() * urls.length)] || "";
}

function getLikelyVlcPlaybackUntil(data) {
  const until = Number(data?.bambiVlcPlaybackUntil) || 0;
  return until > Date.now() ? until : 0;
}

async function fetchLiveVlcStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(BAMBI_STATUS_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { reachable: false, playing: false, remainingSec: null };
    }
    const payload = await response.json();
    const remainingSec = Number(payload?.remaining_sec);
    return {
      reachable: true,
      playing: Boolean(payload?.playing),
      remainingSec: Number.isFinite(remainingSec) && remainingSec >= 0 ? remainingSec : null,
    };
  } catch {
    return { reachable: false, playing: false, remainingSec: null };
  } finally {
    clearTimeout(timer);
  }
}

function openConfiguredAutoplayUrl(url, reason = "unknown") {
  if (!isHttpUrl(url)) return;
  chrome.tabs.create({ url }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[Bambi:bg] failed to open autoplay URL:", chrome.runtime.lastError.message);
      return;
    }
    console.log("[Bambi:bg] autoplay opened tab:", reason);
  });
}

function ensureAutoplayAlarm(enabled) {
  chrome.alarms.clear(AUTOPLAY_ALARM, () => {
    if (!enabled) return;
    chrome.alarms.create(AUTOPLAY_ALARM, {
      periodInMinutes: AUTOPLAY_MIN_PERIOD_MINUTES,
      delayInMinutes: AUTOPLAY_MIN_PERIOD_MINUTES,
    });
  });
}

function checkIdleAndTriggerAutoplay() {
  chrome.storage.local.get(
    {
      bambiAutoPlayEnabled: false,
      bambiAutoPlayUrl: "",
      bambiAutoPlayUrls: [],
      bambiAutoPlayDelayMs: 600000,
      bambiAutoPlayLastTriggerAt: 0,
      bambiVlcPlaybackUntil: 0,
    },
    (data) => {
      const enabled = Boolean(data.bambiAutoPlayEnabled);
      const urls = normalizeAutoPlayUrls(data.bambiAutoPlayUrls, data.bambiAutoPlayUrl || "");
      const url = pickRandomAutoPlayUrl(urls);
      const delayMs = Math.max(60000, Number(data.bambiAutoPlayDelayMs) || 600000);
      const lastTriggerAt = Number(data.bambiAutoPlayLastTriggerAt) || 0;
      const vlcPlaybackUntil = getLikelyVlcPlaybackUntil(data);

      if (!enabled || !isHttpUrl(url)) return;
      if (vlcPlaybackUntil) return;

      fetchLiveVlcStatus().then((live) => {
        if (live.playing) {
          const remainingMs = live.remainingSec !== null
            ? Math.max(60000, Math.floor(live.remainingSec * 1000) + 2000)
            : 120000;
          chrome.storage.local.set({
            bambiVlcPlaybackUntil: Date.now() + remainingMs,
            bambiVlcPlaybackSource: "live-status",
          });
          return;
        }

        // Avoid repeated tab opens while user stays idle.
        if (lastTriggerAt && (Date.now() - lastTriggerAt) < delayMs) return;

        const thresholdSeconds = Math.max(60, Math.floor(delayMs / 1000));
        chrome.idle.queryState(thresholdSeconds, (state) => {
          if (chrome.runtime.lastError) {
            console.warn("[Bambi:bg] idle query failed:", chrome.runtime.lastError.message);
            return;
          }

          if (state !== "idle" && state !== "locked") return;

          chrome.storage.local.set({
            bambiAutoPlayLastTriggerAt: Date.now(),
            bambiAutoPlayUrls: urls,
            bambiAutoPlayUrl: urls[0] || "",
          }, () => {
            openConfiguredAutoplayUrl(url, `idle-state:${state}`);
          });
        });
      });
    }
  );
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ bambiAutoPlayEnabled: false }, (data) => {
    ensureAutoplayAlarm(Boolean(data.bambiAutoPlayEnabled));
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get({ bambiAutoPlayEnabled: false }, (data) => {
    ensureAutoplayAlarm(Boolean(data.bambiAutoPlayEnabled));
  });
});

// Also initialize on worker boot so existing enabled settings are respected
// even before startup/install events fire in this browser session.
chrome.storage.local.get({ bambiAutoPlayEnabled: false }, (data) => {
  ensureAutoplayAlarm(Boolean(data.bambiAutoPlayEnabled));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.bambiAutoPlayEnabled !== undefined) {
    const enabled = Boolean(changes.bambiAutoPlayEnabled.newValue);
    ensureAutoplayAlarm(enabled);
    if (!enabled) {
      chrome.storage.local.set({ bambiAutoPlayLastTriggerAt: 0 });
    }
  }

  if (
    changes.bambiAutoPlayDelayMs !== undefined ||
    changes.bambiAutoPlayUrl !== undefined ||
    changes.bambiAutoPlayUrls !== undefined
  ) {
    // Let changed settings trigger promptly on next check cycle.
    chrome.storage.local.set({ bambiAutoPlayLastTriggerAt: 0 });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTOPLAY_ALARM) return;
  checkIdleAndTriggerAutoplay();
});

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.type === "BAMBI_OPEN_TAB") {
    openConfiguredAutoplayUrl(msg.url, "content-script-message");
  }
});
