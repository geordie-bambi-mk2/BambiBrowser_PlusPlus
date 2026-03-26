const BAMBI_SERVER = "http://127.0.0.1:5655";
const BAMBI_STATUS_ENDPOINT = BAMBI_SERVER + "/status";

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${m}:${ss}`;
}

async function fetchServerStatus() {
  try {
    const r = await fetch(BAMBI_STATUS_ENDPOINT, { method: "GET", cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function setText(id, text, className = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("good", "bad");
  if (className) el.classList.add(className);
}

function setProgress(percent, active) {
  const bar = document.getElementById("playbackProgress");
  const fill = document.getElementById("playbackProgressFill");
  if (!bar || !fill) return;
  if (!active) {
    bar.classList.remove("active");
    bar.setAttribute("aria-valuenow", "0");
    fill.style.width = "0%";
    return;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  bar.classList.add("active");
  bar.setAttribute("aria-valuenow", String(clamped));
  fill.style.width = `${clamped}%`;
}

async function refreshPopupStatus() {
  const [status, storage] = await Promise.all([
    fetchServerStatus(),
    chrome.storage.local.get({
      bambiMultiMonitor: true,
      bambiInputLockEnabled: false,
      bambiInputLockLockedUntil: 0,
    }),
  ]);

  const lockdownActive = Number(storage.bambiInputLockLockedUntil) > Date.now();
  const inputLockEnabled = Boolean(storage.bambiInputLockEnabled) || lockdownActive;

  setText("multiMonitorStatus", storage.bambiMultiMonitor ? "Enabled" : "Disabled", storage.bambiMultiMonitor ? "good" : "bad");
  setText("inputLockStatus", inputLockEnabled ? (lockdownActive ? "Enabled (lockdown)" : "Enabled") : "Disabled", inputLockEnabled ? "good" : "bad");

  const playbackTime = document.getElementById("playbackTime");

  if (!status) {
    setText("helperStatus", "Offline", "bad");
    setText("playbackStatus", "Unavailable", "bad");
    if (playbackTime) playbackTime.textContent = "";
    setProgress(0, false);
    return;
  }

  setText("helperStatus", "Connected", "good");

  if (!status.playing) {
    setText("playbackStatus", "Idle", "bad");
    if (playbackTime) playbackTime.textContent = "";
    setProgress(0, false);
    return;
  }

  setText("playbackStatus", "Playing", "good");
  const position = Number(status.position_sec);
  const length = Number(status.length_sec);
  const remaining = Number(status.remaining_sec);

  if (Number.isFinite(position) && Number.isFinite(length) && length > 0) {
    const remainingText = Number.isFinite(remaining) && remaining >= 0 ? ` (-${formatClock(remaining)})` : "";
    if (playbackTime) playbackTime.textContent = `${formatClock(position)} / ${formatClock(length)}${remainingText}`;
    setProgress((position / length) * 100, true);
  } else {
    if (playbackTime) playbackTime.textContent = "Playback active";
    setProgress(0, false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const ver = chrome.runtime.getManifest().version;
  const versionEl = document.getElementById("headerVersion");
  if (versionEl) versionEl.textContent = `v${ver}`;

  const settingsBtn = document.getElementById("openSettingsBtn");
  settingsBtn?.addEventListener("click", async () => {
    if (chrome.runtime.openOptionsPage) {
      await chrome.runtime.openOptionsPage();
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  });

  refreshPopupStatus();
  setInterval(refreshPopupStatus, 2000);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (
      changes.bambiMultiMonitor !== undefined ||
      changes.bambiInputLockEnabled !== undefined ||
      changes.bambiInputLockLockedUntil !== undefined
    ) {
      refreshPopupStatus();
    }
  });
});
