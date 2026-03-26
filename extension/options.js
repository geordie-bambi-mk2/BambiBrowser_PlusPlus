// -------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------
const BAMBI_SERVER = "http://127.0.0.1:5655";
const DEFAULT_DOMAINS = ["hypnotube.com"];
const AUTO_MODE_DOMAINS = ["hypnotube.com"]; // Domains that use auto-play, not manual
const DEFAULT_INTENT_WINDOW_MS = 2200;
const DEFAULT_MANUAL_SHORTCUT = "Alt+Shift+V";
const REMOTE_CONFIG_URL = "https://geordie-bambi-mk2.github.io/bbrowser-resources/config.json";
const UPDATE_REPO_URL = "https://github.com/geordie-bambi-mk2/BambiBrowser_PlusPlus";
const DEFAULT_VLC_ACTIVE_PLAYBACK_MS = 15 * 60 * 1000;
const BAMBI_STATUS_ENDPOINT = BAMBI_SERVER + "/status";

function markLikelyVlcPlaybackActive(durationMs = DEFAULT_VLC_ACTIVE_PLAYBACK_MS, source = "popup-local-file") {
  const startedAt = Date.now();
  const activeMs = Math.max(60 * 1000, Number(durationMs) || DEFAULT_VLC_ACTIVE_PLAYBACK_MS);
  chrome.storage.local.set({
    bambiVlcPlaybackStartedAt: startedAt,
    bambiVlcPlaybackUntil: startedAt + activeMs,
    bambiVlcPlaybackSource: source,
  });
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

function fitPopupToTab(tabName) {
  const panels = document.querySelector(".tab-panels");
  if (!panels) return;
  panels.style.height = "auto";
  panels.style.minHeight = "0";
}

function setupTabs() {
  const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
  const panes = Array.from(document.querySelectorAll(".tab-pane"));

  function activate(tabName) {
    tabButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
    panes.forEach(pane => pane.classList.toggle("active", pane.id === `tab-${tabName}`));
    fitPopupToTab(tabName);
  }

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });

  const initialTab = tabButtons.find(btn => btn.classList.contains("active"))?.dataset.tab || "general";
  activate(initialTab);
}

// Helper: determine if a domain should use auto or manual mode
function determineDomainMode(domain) {
  const normalized = normalizeDomainInput(domain);
  return AUTO_MODE_DOMAINS.some(d => hostMatchesDomain(normalized, d)) ? "auto" : "manual";
}

function parseVersionParts(version) {
  return String(version || "0")
    .replace(/^v/i, "")
    .split(".")
    .map(p => Number.parseInt(p, 10))
    .map(n => Number.isFinite(n) ? n : 0);
}

function compareVersions(a, b) {
  const ap = parseVersionParts(a);
  const bp = parseVersionParts(b);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i += 1) {
    const av = ap[i] || 0;
    const bv = bp[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

// -------------------------------------------------------
// SERVER HEALTH CHECK
// -------------------------------------------------------
async function checkServer() {
  try {
    const r = await fetch(BAMBI_SERVER + "/health", { method: "GET", cache: "no-store" });
    return r.status === 200;
  } catch {
    return false;
  }
}

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

async function refreshServerStatus() {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  const playbackText = document.getElementById("statusPlayback");
  const progress = document.getElementById("statusProgress");
  const progressFill = document.getElementById("statusProgressFill");
  if (!dot || !text) return;

  const setProgressHidden = () => {
    if (progress) {
      progress.classList.remove("active");
      progress.setAttribute("aria-valuenow", "0");
    }
    if (progressFill) progressFill.style.width = "0%";
  };

  const status = await fetchServerStatus();
  dot.classList.remove("online", "offline");

  if (!status) {
    dot.classList.add("offline");
    text.textContent = "bambi_player offline";
    if (playbackText) playbackText.textContent = "";
    setProgressHidden();
    return;
  }

  dot.classList.add("online");
  if (status.playing) {
    text.textContent = "bambi_player playing";
    if (playbackText) {
      const position = Number(status.position_sec);
      const length = Number(status.length_sec);
      const remaining = Number(status.remaining_sec);
      if (Number.isFinite(position) && Number.isFinite(length) && length > 0) {
        const remainingText = Number.isFinite(remaining) && remaining >= 0
          ? ` (-${formatClock(remaining)})`
          : "";
        playbackText.textContent = `VLC ${formatClock(position)} / ${formatClock(length)}${remainingText}`;
        const ratio = Math.max(0, Math.min(1, position / length));
        const percent = Math.round(ratio * 100);
        if (progress) {
          progress.classList.add("active");
          progress.setAttribute("aria-valuenow", String(percent));
        }
        if (progressFill) progressFill.style.width = `${percent}%`;
      } else {
        playbackText.textContent = "VLC active";
        setProgressHidden();
      }
    }
  } else {
    text.textContent = "bambi_player connected";
    if (playbackText) playbackText.textContent = "";
    setProgressHidden();
  }
}

// -------------------------------------------------------
// RENDER DOMAIN LIST
// -------------------------------------------------------
function renderDomains(domains) {
  const list = document.getElementById("domainList");
  const empty = document.getElementById("emptyMsg");

  // Remove all existing domain items (keep the empty-msg element)
  Array.from(list.querySelectorAll(".domain-item")).forEach(el => el.remove());

  if (domains.length === 0) {
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  domains.map(normalizeDomainInput).filter(Boolean).forEach(domain => {
    const item = document.createElement("div");
    item.className = "domain-item";

    const name = document.createElement("span");
    name.className = "domain-name";

    const domainText = document.createElement("span");
    domainText.textContent = domain;

    const mode = determineDomainMode(domain);
    const badge = document.createElement("span");
    badge.className = `domain-mode ${mode}`;
    badge.textContent = mode.toUpperCase();

    name.appendChild(domainText);
    name.appendChild(badge);

    const btn = document.createElement("button");
    btn.className = "domain-remove";
    btn.textContent = "\u2715";
    btn.title = "Remove domain";
    btn.addEventListener("click", () => removeDomain(domain));

    const actions = document.createElement("span");
    actions.className = "domain-actions";

    if (mode === "manual") {
      const configBtn = document.createElement("button");
      configBtn.className = "domain-config";
      configBtn.textContent = "\u2699";
      configBtn.title = "Learn player for this domain";
      configBtn.addEventListener("click", () => configureDomainPlayer(domain));
      actions.appendChild(configBtn);
    }

    actions.appendChild(btn);

    item.appendChild(name);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

async function configureDomainPlayer(domain) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (!activeTab?.id) {
    alert("Could not find active tab. Open the site page and try again.");
    return;
  }

  const tabUrl = activeTab.url || "";
  let tabHost = "";
  try {
    tabHost = new URL(tabUrl).hostname;
  } catch {
    tabHost = "";
  }

  if (!hostMatchesDomain(tabHost, domain)) {
    alert(`Open a page on ${domain} in the current tab, then click the cog again.`);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "BAMBI_LEARN_PLAYER",
      domain,
    });

    if (response?.ok) {
      alert("Learning mode started. Click the main player window once on the page.");
      return;
    }

    alert(response?.reason || "Could not start learning mode on this page.");
  } catch {
    alert("Open a page on that domain first, then click the cog again.");
  }
}

// -------------------------------------------------------
// ADD / REMOVE DOMAINS
// -------------------------------------------------------
function removeDomain(domain) {
  chrome.storage.local.get({ bambiDomains: DEFAULT_DOMAINS }, data => {
    const updated = (data.bambiDomains || [])
      .map(normalizeDomainInput)
      .filter(d => d && d !== normalizeDomainInput(domain));
    chrome.storage.local.set({ bambiDomains: updated }, () => renderDomains(updated));
  });
}

function addDomain() {
  const input = document.getElementById("domainInput");
  const value = normalizeDomainInput(input.value);

  if (!value) return;

  chrome.storage.local.get({ bambiDomains: DEFAULT_DOMAINS }, data => {
    const existing = (data.bambiDomains || []).map(normalizeDomainInput).filter(Boolean);
    if (existing.includes(value)) {
      input.value = "";
      return;
    }
    const updated = [...existing, value];
    chrome.storage.local.set({ bambiDomains: updated }, () => {
      renderDomains(updated);
      input.value = "";
    });
  });
}

// -------------------------------------------------------
// RENDER BLACKLIST
// -------------------------------------------------------
function renderBlacklist(entries) {
  const list  = document.getElementById("blacklistList");
  const empty = document.getElementById("blacklistEmptyMsg");

  Array.from(list.querySelectorAll(".domain-item")).forEach(el => el.remove());

  if (entries.length === 0) {
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  entries.forEach(entry => {
    const item = document.createElement("div");
    item.className = "domain-item bl-item";

    const name = document.createElement("span");
    name.className = "domain-name";
    name.textContent = entry;

    const btn = document.createElement("button");
    btn.className = "domain-remove";
    btn.textContent = "\u2715";
    btn.title = "Remove from blacklist";
    btn.addEventListener("click", () => removeBlacklistEntry(entry));

    item.appendChild(name);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

// -------------------------------------------------------
// ADD / REMOVE BLACKLIST ENTRIES
// -------------------------------------------------------
function removeBlacklistEntry(entry) {
  chrome.storage.local.get({ bambiBlacklist: [] }, data => {
    const updated = data.bambiBlacklist.filter(e => e !== entry);
    chrome.storage.local.set({ bambiBlacklist: updated }, () => renderBlacklist(updated));
  });
}

function addBlacklistEntry() {
  const input = document.getElementById("blacklistInput");
  // Keep path portion (unlike domain allowlist) but strip protocol
  let value = input.value.trim().toLowerCase().replace(/^https?:\/\//, "").trim();

  if (!value) return;

  chrome.storage.local.get({ bambiBlacklist: [] }, data => {
    if (data.bambiBlacklist.includes(value)) {
      input.value = "";
      return;
    }
    const updated = [...data.bambiBlacklist, value];
    chrome.storage.local.set({ bambiBlacklist: updated }, () => {
      renderBlacklist(updated);
      input.value = "";
    });
  });
}

// -------------------------------------------------------
// CONFIG STATUS
// -------------------------------------------------------
async function loadConfigStatus() {
  const data = await new Promise(r => chrome.storage.local.get({
    bambiConfigVersion: null,
    bambiConfigStale: false,
    bambiDomainAssocMapFetchedAt: 0,
    bambiPresets: [],
    bambiAdDomains: [],
  }, r));

  const versionEl  = document.getElementById("configVersion");
  const staleEl    = document.getElementById("configStale");
  const detailEl   = document.getElementById("configDetail");

  if (versionEl) versionEl.textContent = data.bambiConfigVersion ? `v${data.bambiConfigVersion}` : "v—";
  if (staleEl)   staleEl.style.display = data.bambiConfigStale ? "" : "none";
  if (detailEl) {
    const syncTime    = data.bambiDomainAssocMapFetchedAt
      ? new Date(data.bambiDomainAssocMapFetchedAt).toLocaleTimeString()
      : "never";
    const presetCount = (data.bambiPresets || []).length;
    const adCount     = (data.bambiAdDomains || []).length;
    detailEl.textContent = `${presetCount} presets · ${adCount} ad filters · synced ${syncTime}`;
  }
}

async function loadUpdateStatus() {
  const updateStatusEl = document.getElementById("updateStatus");
  const updateBtn = document.getElementById("openUpdateBtn");
  const currentVersion = chrome.runtime.getManifest().version;
  const headerVersion = document.getElementById("headerVersion");
  if (headerVersion) headerVersion.textContent = `v${currentVersion}`;

  if (!updateStatusEl || !updateBtn) return;

  updateBtn.style.display = "none";
  updateStatusEl.classList.remove("has-update");
  updateStatusEl.textContent = "Checking extension updates…";

  try {
    const resp = await fetch(REMOTE_CONFIG_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();

    const remoteVersion =
      json.extensionVersion ||
      json.latestExtensionVersion ||
      json.latestVersion ||
      json.version;

    if (!remoteVersion) {
      updateStatusEl.textContent = `Current: v${currentVersion} (remote version unavailable)`;
      return;
    }

    const cmp = compareVersions(remoteVersion, currentVersion);
    if (cmp > 0) {
      updateStatusEl.classList.add("has-update");
      updateStatusEl.textContent = `Update available: v${remoteVersion} (current v${currentVersion})`;
      updateBtn.style.display = "";
    } else {
      updateStatusEl.textContent = `Up to date: v${currentVersion}`;
    }
  } catch (_) {
    updateStatusEl.textContent = `Current: v${currentVersion} (update check failed)`;
  }
}

// -------------------------------------------------------
// PRESETS
// -------------------------------------------------------
async function renderPresets(activeDomains) {
  const list = document.getElementById("presetList");
  const loading = document.getElementById("presetLoading");
  if (!list) return;

  let presets = [];
  const stored = await new Promise(r => chrome.storage.local.get({ bambiPresets: [] }, r));
  presets = stored.bambiPresets || [];

  if (!presets.length) {
    try {
      const resp = await fetch(REMOTE_CONFIG_URL, { cache: "no-store" });
      if (resp.ok) {
        const json = await resp.json();
        presets = Array.isArray(json.presets) ? json.presets : [];
        if (presets.length) chrome.storage.local.set({ bambiPresets: presets });
      }
    } catch (_) {}
  }

  if (loading) loading.remove();
  Array.from(list.querySelectorAll(".preset-item")).forEach(el => el.remove());

  if (!presets.length) {
    const msg = document.createElement("div");
    msg.className = "preset-loading";
    msg.textContent = "No presets available";
    list.appendChild(msg);
    return;
  }

  const active = new Set((activeDomains || []).map(normalizeDomainInput).filter(Boolean));

  presets.forEach(preset => {
    const domain = normalizeDomainInput(preset.domain || "");
    if (!domain) return;

    const item = document.createElement("div");
    item.className = "preset-item";

    const name = document.createElement("span");
    name.className = "preset-name";
    const label = document.createElement("span");
    label.textContent = preset.label || domain;
    const mode = String(preset.mode || "manual");
    const badge = document.createElement("span");
    badge.className = `domain-mode ${mode}`;
    badge.textContent = mode.toUpperCase();
    name.appendChild(label);
    name.appendChild(badge);

    const btn = document.createElement("button");
    btn.className = "preset-add-btn";
    const isAdded = active.has(domain);
    btn.textContent = isAdded ? "\u2713" : "+";
    btn.disabled = isAdded;
    btn.title = isAdded ? "Already active" : "Add " + domain;

    if (!isAdded) {
      btn.addEventListener("click", () => {
        chrome.storage.local.get({ bambiDomains: DEFAULT_DOMAINS }, data => {
          const existing = (data.bambiDomains || []).map(normalizeDomainInput).filter(Boolean);
          if (!existing.includes(domain)) {
            const updated = [...existing, domain];
            chrome.storage.local.set({ bambiDomains: updated }, () => {
              renderDomains(updated);
              btn.textContent = "\u2713";
              btn.disabled = true;
            });
          }
        });
      });
    }

    item.appendChild(name);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

// -------------------------------------------------------
// INIT
// -------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  const intentWindowSelect = document.getElementById("intentWindowSelect");
  const manualShortcutToggle = document.getElementById("manualShortcutToggle");
  const manualShortcutSelect = document.getElementById("manualShortcutSelect");
  const multiMonitorToggle = document.getElementById("multiMonitorToggle");
  const inputLockToggle = document.getElementById("inputLockToggle");
  const inputLockDurationSelect = document.getElementById("inputLockDurationSelect");
  const inputLockTimerRow = document.getElementById("inputLockTimerRow");
  const inputLockLockdownBtn = document.getElementById("inputLockLockdownBtn");
  const inputLockLockdownStatus = document.getElementById("inputLockLockdownStatus");
  const inputLockReasonBadge = document.getElementById("inputLockReasonBadge");

  let inputLockDurationMs = 3600000;
  let inputLockLockedUntil = 0;
  let inputLockTickerId = null;

  function isInputLockLockdownActive() {
    return Number(inputLockLockedUntil) > Date.now();
  }

  function formatRemainingDuration(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  function updateInputLockUi() {
    const lockdownActive = isInputLockLockdownActive();
    const effectiveInputLockOn = Boolean(inputLockToggle.checked) || lockdownActive;

    inputLockToggle.checked = effectiveInputLockOn;
    inputLockToggle.disabled = lockdownActive;
    inputLockDurationSelect.disabled = lockdownActive;
    inputLockTimerRow.style.display = effectiveInputLockOn ? "" : "none";
    inputLockLockdownBtn.disabled = !effectiveInputLockOn || lockdownActive;

    if (lockdownActive) {
      inputLockReasonBadge.style.display = "";
      inputLockReasonBadge.textContent = "LOCKDOWN";
    } else {
      inputLockReasonBadge.style.display = "none";
      inputLockReasonBadge.textContent = "";
    }

    if (lockdownActive) {
      const remaining = inputLockLockedUntil - Date.now();
      inputLockLockdownStatus.textContent = `Lockdown active: ${formatRemainingDuration(remaining)} remaining.`;
      if (inputLockTickerId === null) {
        inputLockTickerId = setInterval(() => {
          if (!isInputLockLockdownActive()) {
            inputLockLockedUntil = 0;
            chrome.storage.local.set({ bambiInputLockLockedUntil: 0 });
            if (inputLockTickerId !== null) {
              clearInterval(inputLockTickerId);
              inputLockTickerId = null;
            }
          }
          updateInputLockUi();
        }, 1000);
      }
    } else {
      inputLockLockdownStatus.textContent = "Lockdown inactive.";
      if (inputLockTickerId !== null) {
        clearInterval(inputLockTickerId);
        inputLockTickerId = null;
      }
    }
  }

  // Load saved state
  chrome.storage.local.get(
    {
      bambiActivated: false,
      bambiDomains: DEFAULT_DOMAINS,
      bambiBlacklist: [],
      bambiMultiMonitor: true,
      bambiIntentWindowMs: DEFAULT_INTENT_WINDOW_MS,
      bambiManualShortcutEnabled: false,
      bambiManualShortcut: DEFAULT_MANUAL_SHORTCUT,
      bambiInputLockEnabled: false,
      bambiInputLockDurationMs: 3600000,
      bambiInputLockLockedUntil: 0,
      bambiAutoPlayEnabled: false,
      bambiAutoPlayUrl: "",
      bambiAutoPlayDelayMs: 600000,
      bambiAutoPlayLastTriggerAt: 0,
    },
    data => {
      document.getElementById("masterToggle").checked = data.bambiActivated;
      multiMonitorToggle.checked = Boolean(data.bambiMultiMonitor);
      inputLockToggle.checked = Boolean(data.bambiInputLockEnabled);
      const validLockDurations = [600000,1200000,3600000,7200000,14400000,21600000,28800000,43200000];
      const savedLockDuration = Number(data.bambiInputLockDurationMs);
      inputLockDurationMs = validLockDurations.includes(savedLockDuration) ? savedLockDuration : 3600000;
      inputLockDurationSelect.value = String(inputLockDurationMs);
      inputLockLockedUntil = Number(data.bambiInputLockLockedUntil) || 0;
      if (inputLockLockedUntil && !isInputLockLockdownActive()) {
        inputLockLockedUntil = 0;
        chrome.storage.local.set({ bambiInputLockLockedUntil: 0 });
      }
      if (isInputLockLockdownActive()) {
        inputLockToggle.checked = true;
        chrome.storage.local.set({ bambiInputLockEnabled: true });
      }
      updateInputLockUi();
      document.getElementById("autoPlayToggle").checked = Boolean(data.bambiAutoPlayEnabled);
      document.getElementById("autoPlaySettings").style.display = data.bambiAutoPlayEnabled ? "" : "none";
      document.getElementById("autoPlayUrlInput").value = data.bambiAutoPlayUrl || "";
      updateLastTriggerDisplay(data.bambiAutoPlayLastTriggerAt || 0);
      const validDelays = [300000,600000,900000,1200000,1800000,2700000,3600000];
      const savedDelay = Number(data.bambiAutoPlayDelayMs);
      document.getElementById("autoPlayDelaySelect").value = String(validDelays.includes(savedDelay) ? savedDelay : 600000);
      manualShortcutToggle.checked = Boolean(data.bambiManualShortcutEnabled);
      const selectedShortcut = String(data.bambiManualShortcut || DEFAULT_MANUAL_SHORTCUT);
      manualShortcutSelect.value = ["Alt+Shift+V", "Ctrl+Shift+V", "Alt+V", "Ctrl+Alt+V"].includes(selectedShortcut)
        ? selectedShortcut
        : DEFAULT_MANUAL_SHORTCUT;
      const savedIntentWindow = Number.parseInt(data.bambiIntentWindowMs, 10);
      const normalizedIntentWindow =
        Number.isFinite(savedIntentWindow) && [1200, 2200, 3200].includes(savedIntentWindow)
          ? savedIntentWindow
          : DEFAULT_INTENT_WINDOW_MS;
      intentWindowSelect.value = String(normalizedIntentWindow);
      const normalizedDomains = (data.bambiDomains || []).map(normalizeDomainInput).filter(Boolean);
      if (JSON.stringify(normalizedDomains) !== JSON.stringify(data.bambiDomains || [])) {
        chrome.storage.local.set({ bambiDomains: normalizedDomains });
      }
      renderDomains(normalizedDomains);
      renderPresets(normalizedDomains);
      renderBlacklist(data.bambiBlacklist);
    }
  );

  loadConfigStatus();
  loadUpdateStatus();

  document.getElementById("refreshConfigBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("refreshConfigBtn");
    if (btn) { btn.disabled = true; btn.textContent = "\u21BB Syncing\u2026"; }

    // Tell the content script to refresh (updates its in-memory state if it's running)
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        await chrome.tabs.sendMessage(tabs[0].id, { type: "BAMBI_FORCE_REFRESH_CONFIG" }).catch(() => {});
      }
    } catch (_) {}

    // Also fetch directly from the popup so storage is always updated,
    // even when the active tab doesn't have the content script running.
    try {
      const resp = await fetch(REMOTE_CONFIG_URL, { cache: "no-store" });
      if (resp.ok) {
        const json = await resp.json();
        const updates = { bambiConfigStale: false, bambiDomainAssocMapFetchedAt: Date.now() };
        if (typeof json.version === "number") updates.bambiConfigVersion = json.version;
        if (Array.isArray(json.presets))      updates.bambiPresets = json.presets;
        if (Array.isArray(json.adDomains))    updates.bambiAdDomains = json.adDomains;
        await chrome.storage.local.set(updates);
      }
    } catch (_) {}

    await loadConfigStatus();
    await loadUpdateStatus();
    if (btn) { btn.disabled = false; btn.textContent = "\u21BB Sync"; }
  });

  document.getElementById("openUpdateBtn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: UPDATE_REPO_URL });
  });

  // Master toggle — also triggers hijack on the currently active tab
  document.getElementById("masterToggle").addEventListener("change", e => {
    const activated = e.target.checked;
    chrome.storage.local.set({ bambiActivated: activated });
    if (activated) {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: "BAMBI_ACTIVATE" }).catch(() => {});
        }
      });
    }
  });

  // Multi-monitor toggle
  multiMonitorToggle.addEventListener("change", e => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ bambiMultiMonitor: enabled });
    updateInputLockUi();
  });

  // Input lock toggle
  inputLockToggle.addEventListener("change", e => {
    if (isInputLockLockdownActive()) {
      inputLockToggle.checked = true;
      updateInputLockUi();
      return;
    }
    const enabled = e.target.checked;
    chrome.storage.local.set({ bambiInputLockEnabled: enabled });
    updateInputLockUi();
  });
  inputLockDurationSelect.addEventListener("change", e => {
    const val = Number(e.target.value);
    if (!val) return;
    inputLockDurationMs = val;
    chrome.storage.local.set({ bambiInputLockDurationMs: val });
  });
  inputLockLockdownBtn.addEventListener("click", () => {
    const durationMs = Number(inputLockDurationSelect.value) || inputLockDurationMs || 3600000;
    inputLockDurationMs = durationMs;
    inputLockLockedUntil = Date.now() + durationMs;
    inputLockToggle.checked = true;
    chrome.storage.local.set({
      bambiInputLockEnabled: true,
      bambiInputLockDurationMs: durationMs,
      bambiInputLockLockedUntil: inputLockLockedUntil,
    });
    updateInputLockUi();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.bambiMultiMonitor !== undefined) {
      multiMonitorToggle.checked = Boolean(changes.bambiMultiMonitor.newValue);
    }
    if (changes.bambiInputLockEnabled !== undefined) {
      inputLockToggle.checked = Boolean(changes.bambiInputLockEnabled.newValue);
    }
    if (changes.bambiInputLockDurationMs !== undefined) {
      const nextDuration = Number(changes.bambiInputLockDurationMs.newValue) || 3600000;
      inputLockDurationMs = nextDuration;
      inputLockDurationSelect.value = String(nextDuration);
    }
    if (changes.bambiInputLockLockedUntil !== undefined) {
      inputLockLockedUntil = Number(changes.bambiInputLockLockedUntil.newValue) || 0;
    }
    if (
      changes.bambiMultiMonitor !== undefined ||
      changes.bambiInputLockEnabled !== undefined ||
      changes.bambiInputLockDurationMs !== undefined ||
      changes.bambiInputLockLockedUntil !== undefined
    ) {
      updateInputLockUi();
    }
    if (changes.bambiAutoPlayLastTriggerAt !== undefined) {
      updateLastTriggerDisplay(changes.bambiAutoPlayLastTriggerAt.newValue || 0);
    }
  });

  // Auto-play fallback
  function updateLastTriggerDisplay(ts) {
    const el = document.getElementById("autoPlayLastTriggerStatus");
    if (!el) return;
    if (!ts) { el.textContent = "never"; return; }
    const agoSec = Math.floor((Date.now() - ts) / 1000);
    if (agoSec < 60) {
      el.textContent = `${agoSec}s ago`;
    } else if (agoSec < 3600) {
      el.textContent = `${Math.floor(agoSec / 60)}m ago`;
    } else {
      const h = Math.floor(agoSec / 3600);
      const m = Math.floor((agoSec % 3600) / 60);
      el.textContent = m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
    }
  }

  document.getElementById("autoPlayToggle").addEventListener("change", e => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ bambiAutoPlayEnabled: enabled });
    document.getElementById("autoPlaySettings").style.display = enabled ? "" : "none";
  });
  document.getElementById("autoPlayUrlInput").addEventListener("change", e => {
    chrome.storage.local.set({ bambiAutoPlayUrl: e.target.value.trim() });
  });
  document.getElementById("autoPlayDelaySelect").addEventListener("change", e => {
    const val = Number(e.target.value);
    if (!val) return;
    chrome.storage.local.set({ bambiAutoPlayDelayMs: val });
  });

  // Manual-mode click sensitivity
  intentWindowSelect.addEventListener("change", e => {
    const value = Number.parseInt(e.target.value, 10);
    if (!Number.isFinite(value) || value < 800 || value > 5000) return;
    chrome.storage.local.set({ bambiIntentWindowMs: value });
  });

  manualShortcutToggle.addEventListener("change", e => {
    chrome.storage.local.set({ bambiManualShortcutEnabled: Boolean(e.target.checked) });
  });

  manualShortcutSelect.addEventListener("change", e => {
    const value = String(e.target.value || "").trim();
    if (!value) return;
    chrome.storage.local.set({ bambiManualShortcut: value });
  });

  // -------------------------------------------------------
  // LOCAL FILE → VLC
  // -------------------------------------------------------
  const localFilePicker = document.getElementById("localFilePicker");
  const localFileInput = document.getElementById("localFileInput");
  const localFileBrowseBtn = document.getElementById("localFileBrowseBtn");
  const localFileBtn = document.getElementById("localFileBtn");
  const localFileStatus = document.getElementById("localFileStatus");
  let localFileResolvedPath = "";
  let localFileSelectedFile = null;

  function normalizeLocalPath(rawPath) {
    let trimmed = String(rawPath || "").trim();
    while (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }

  function hasLikelyFilesystemPath(rawPath) {
    const normalized = normalizeLocalPath(rawPath);
    return /^\\\\/.test(normalized) || /^[a-zA-Z]:[\\/]/.test(normalized) || normalized.startsWith("/");
  }

  function filePathToUrl(rawPath) {
    const trimmed = normalizeLocalPath(rawPath);
    if (!trimmed) return null;
    // UNC paths: \\server\share\... → file://server/share/...
    if (/^\\\\/.test(trimmed)) {
      return "file:" + trimmed.replace(/\\/g, "/");
    }
    // Local paths: may use backslashes or forward slashes
    const normalized = trimmed.replace(/\\/g, "/");
    return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
  }

  async function sendLocalFile() {
    const typedValue = normalizeLocalPath(localFileInput.value || "");
    const raw = normalizeLocalPath(localFileResolvedPath || typedValue || "");
    const usePickedUpload = Boolean(localFileSelectedFile) && !hasLikelyFilesystemPath(raw);

    if (!raw && !usePickedUpload) {
      localFileStatus.style.color = "#cc6060";
      localFileStatus.textContent = "Pick a file first.";
      return;
    }

    const extensionSource = usePickedUpload ? (localFileSelectedFile.name || raw) : raw;
    const ext = extensionSource.split("?")[0].split(".").pop().toLowerCase();
    const knownExts = ["mp4","mkv","avi","mov","wmv","flv","webm","m4v","mpg","mpeg","ts","m2ts","ogg","ogv"];
    if (!knownExts.includes(ext)) {
      localFileStatus.style.color = "#cc9900";
      localFileStatus.textContent = `Unrecognised extension ".${ext}" — will try anyway.`;
    } else {
      localFileStatus.style.color = "#c892d4";
      localFileStatus.textContent = usePickedUpload ? "Uploading to VLC\u2026" : "Sending to VLC\u2026";
    }

    // Read multi-monitor preference at send time
    const storageData = await chrome.storage.local.get({ bambiMultiMonitor: true, bambiInputLockEnabled: false, bambiInputLockLockedUntil: 0 });
    const lockdownActive = Number(storageData.bambiInputLockLockedUntil) > Date.now();
    const inputLockOn = Boolean(storageData.bambiInputLockEnabled) || lockdownActive;

    try {
      let r;
      if (usePickedUpload) {
        r = await fetch(BAMBI_SERVER + "/play-upload", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Bambi-Filename": localFileSelectedFile.name || "video.bin",
            "X-Bambi-Multi-Monitor": String(Boolean(storageData.bambiMultiMonitor)),
            "X-Bambi-Input-Lock": String(inputLockOn),
          },
          body: await localFileSelectedFile.arrayBuffer(),
        });
      } else {
        const fileUrl = filePathToUrl(raw);
        if (!fileUrl) {
          localFileStatus.style.color = "#cc6060";
          localFileStatus.textContent = "Invalid path.";
          return;
        }
        r = await fetch(BAMBI_SERVER + "/play", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: fileUrl, multi_monitor: storageData.bambiMultiMonitor, input_lock: inputLockOn }),
        });
      }

      if (r.ok) {
        localFileStatus.style.color = "#50d050";
        localFileStatus.textContent = "\u2713 Sent to VLC!";
        markLikelyVlcPlaybackActive(DEFAULT_VLC_ACTIVE_PLAYBACK_MS, "local-file");
        localFileResolvedPath = "";
        localFileSelectedFile = null;
        localFilePicker.value = "";
        localFileInput.value = "";
      } else {
        localFileStatus.style.color = "#cc6060";
        localFileStatus.textContent = `Server error (${r.status}) — check bambi_player logs.`;
      }
    } catch {
      localFileStatus.style.color = "#cc6060";
      localFileStatus.textContent = "bambi_player is offline — start it first.";
    }
  }

  localFileBrowseBtn.addEventListener("click", () => localFilePicker.click());
  localFilePicker.addEventListener("change", () => {
    const picked = localFilePicker.files && localFilePicker.files[0];
    if (!picked) return;
    localFileSelectedFile = picked;

    // Some Chromium variants expose a non-standard real local path on File.path.
    // Standard browser behaviour hides it for privacy and only exposes a fake path.
    const nativePath = normalizeLocalPath(typeof picked.path === "string" ? picked.path : "");
    const inputValue = String(localFilePicker.value || "").trim();

    if (nativePath) {
      localFileResolvedPath = nativePath;
      localFileInput.value = nativePath;
      localFileStatus.style.color = "#c892d4";
      localFileStatus.textContent = "File selected. Press Play to send to VLC.";
      return;
    }

    localFileResolvedPath = "";
    localFileInput.value = picked.name || inputValue;
    localFileStatus.style.color = "#c892d4";
    localFileStatus.textContent = "File selected. Press Play to upload it to bambi_player and launch VLC.";
  });

  localFileBtn.addEventListener("click", sendLocalFile);
  localFileInput.addEventListener("keydown", e => { if (e.key === "Enter") sendLocalFile(); });
  localFileInput.addEventListener("input", () => {
    localFileInput.value = normalizeLocalPath(localFileInput.value);
    if (hasLikelyFilesystemPath(localFileInput.value)) {
      localFileResolvedPath = "";
    }
  });

  // Add domain button + Enter key
  document.getElementById("addBtn").addEventListener("click", addDomain);
  document.getElementById("domainInput").addEventListener("keydown", e => {
    if (e.key === "Enter") addDomain();
  });

  // Add blacklist entry button + Enter key
  document.getElementById("addBlacklistBtn").addEventListener("click", addBlacklistEntry);
  document.getElementById("blacklistInput").addEventListener("keydown", e => {
    if (e.key === "Enter") addBlacklistEntry();
  });

  // Help button — opens guide in a new tab
  document.getElementById("helpBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://geordie-bambi-mk2.github.io/bbrowser-resources/guide/" });
  });

  // Server status indicator + live playback clock.
  refreshServerStatus();
  setInterval(refreshServerStatus, 2000);
});
