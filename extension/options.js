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
const AUTOPLAY_DELAY_OPTIONS_MS = [300000, 600000, 900000, 1200000, 1800000, 2700000, 3600000];
const SETTINGS_XML_ROOT = "bambi-settings";
let bambiLockdownUiActive = false;

const SETTINGS_EXPORT_DEFAULTS = {
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
  bambiAutoPlayUrls: [],
  bambiAutoPlayDelayMs: 600000,
  bambiAutoPlayLastTriggerAt: 0,
  bambiDomainPlayerHints: {},
  bambiDomainAssocMap: {},
  bambiDomainAssocMapFetchedAt: 0,
  bambiPresets: [],
  bambiAdDomains: [],
  bambiRemotePlayerHints: {},
  bambiConfigVersion: null,
  bambiConfigStale: false,
  bambiMaxVideoLengthEnabled: false,
  bambiMaxVideoLengthMins: 15,
  bambiMaxVideoLengthAction: "soft-unlock",
};

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\/.+/i.test(value.trim());
}

function normalizeAutoPlayUrlList(urls, legacyUrl = "") {
  const values = [];
  if (Array.isArray(urls)) {
    values.push(...urls);
  } else if (typeof urls === "string") {
    values.push(...urls.split(/[\r\n,]+/));
  }
  if (legacyUrl) values.push(legacyUrl);

  const seen = new Set();
  const normalized = [];
  values.forEach((raw) => {
    const candidate = String(raw || "").trim();
    if (!isHttpUrl(candidate)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    normalized.push(candidate);
  });
  return normalized;
}

function autoPlayUrlsToText(urls) {
  return normalizeAutoPlayUrlList(urls).join("\n");
}

function parseAutoPlayUrlsFromText(input) {
  return normalizeAutoPlayUrlList(String(input || "").split(/\r?\n/));
}

function toPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function toIntegerOrDefault(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function ensureDownload(filename, contentType, textContent) {
  const blob = new Blob([textContent], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildSettingsXml(settings) {
  const doc = document.implementation.createDocument("", SETTINGS_XML_ROOT, null);
  const root = doc.documentElement;
  root.setAttribute("format", "1");
  root.setAttribute("exportedAt", new Date().toISOString());
  root.setAttribute("extensionVersion", chrome.runtime.getManifest().version);

  Object.keys(settings).sort().forEach((key) => {
    const entry = doc.createElement("setting");
    entry.setAttribute("key", key);
    entry.textContent = JSON.stringify(settings[key]);
    root.appendChild(entry);
  });

  return new XMLSerializer().serializeToString(doc);
}

function parseSettingsXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(xmlText || ""), "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid XML file.");
  }

  const root = doc.documentElement;
  if (!root || root.nodeName !== SETTINGS_XML_ROOT) {
    throw new Error("Unexpected XML format.");
  }

  const raw = {};
  Array.from(root.querySelectorAll("setting[key]")).forEach((node) => {
    const key = String(node.getAttribute("key") || "").trim();
    if (!key) return;
    const text = node.textContent || "";
    try {
      raw[key] = JSON.parse(text);
    } catch {
      raw[key] = text;
    }
  });

  return raw;
}

function sanitizeImportedSettings(rawSettings) {
  const raw = toPlainObject(rawSettings);
  const updates = {};

  if (raw.bambiActivated !== undefined) updates.bambiActivated = Boolean(raw.bambiActivated);
  if (raw.bambiMultiMonitor !== undefined) updates.bambiMultiMonitor = Boolean(raw.bambiMultiMonitor);
  if (raw.bambiManualShortcutEnabled !== undefined) updates.bambiManualShortcutEnabled = Boolean(raw.bambiManualShortcutEnabled);
  if (raw.bambiInputLockEnabled !== undefined) updates.bambiInputLockEnabled = Boolean(raw.bambiInputLockEnabled);
  if (raw.bambiAutoPlayEnabled !== undefined) updates.bambiAutoPlayEnabled = Boolean(raw.bambiAutoPlayEnabled);
  if (raw.bambiConfigStale !== undefined) updates.bambiConfigStale = Boolean(raw.bambiConfigStale);

  if (raw.bambiDomains !== undefined) {
    updates.bambiDomains = Array.isArray(raw.bambiDomains)
      ? raw.bambiDomains.map(normalizeDomainInput).filter(Boolean)
      : DEFAULT_DOMAINS;
  }
  if (raw.bambiBlacklist !== undefined) {
    updates.bambiBlacklist = Array.isArray(raw.bambiBlacklist)
      ? raw.bambiBlacklist.map(v => String(v || "").trim().toLowerCase()).filter(Boolean)
      : [];
  }

  if (raw.bambiIntentWindowMs !== undefined) {
    const intent = toIntegerOrDefault(raw.bambiIntentWindowMs, DEFAULT_INTENT_WINDOW_MS);
    updates.bambiIntentWindowMs = [1200, 2200, 3200].includes(intent) ? intent : DEFAULT_INTENT_WINDOW_MS;
  }

  if (raw.bambiManualShortcut !== undefined) {
    const shortcut = String(raw.bambiManualShortcut || "").trim();
    const validShortcuts = ["Alt+Shift+V", "Ctrl+Shift+V", "Alt+V", "Ctrl+Alt+V"];
    updates.bambiManualShortcut = validShortcuts.includes(shortcut) ? shortcut : DEFAULT_MANUAL_SHORTCUT;
  }

  if (raw.bambiInputLockDurationMs !== undefined) {
    const lockDuration = toIntegerOrDefault(raw.bambiInputLockDurationMs, 3600000);
    const validDurations = [600000, 1200000, 3600000, 7200000, 14400000, 21600000, 28800000, 43200000];
    updates.bambiInputLockDurationMs = validDurations.includes(lockDuration) ? lockDuration : 3600000;
  }
  if (raw.bambiInputLockLockedUntil !== undefined) {
    const lockUntil = Math.max(0, toIntegerOrDefault(raw.bambiInputLockLockedUntil, 0));
    updates.bambiInputLockLockedUntil = lockUntil;
  }

  const importedUrls = normalizeAutoPlayUrlList(raw.bambiAutoPlayUrls, raw.bambiAutoPlayUrl || "");
  if (raw.bambiAutoPlayUrls !== undefined || raw.bambiAutoPlayUrl !== undefined) {
    updates.bambiAutoPlayUrls = importedUrls;
    updates.bambiAutoPlayUrl = importedUrls[0] || "";
  }

  if (raw.bambiAutoPlayDelayMs !== undefined) {
    const delay = toIntegerOrDefault(raw.bambiAutoPlayDelayMs, 600000);
    updates.bambiAutoPlayDelayMs = AUTOPLAY_DELAY_OPTIONS_MS.includes(delay) ? delay : 600000;
  }
  if (raw.bambiAutoPlayLastTriggerAt !== undefined) {
    updates.bambiAutoPlayLastTriggerAt = Math.max(0, toIntegerOrDefault(raw.bambiAutoPlayLastTriggerAt, 0));
  }

  if (raw.bambiDomainPlayerHints !== undefined) updates.bambiDomainPlayerHints = toPlainObject(raw.bambiDomainPlayerHints);
  if (raw.bambiDomainAssocMap !== undefined) updates.bambiDomainAssocMap = toPlainObject(raw.bambiDomainAssocMap);
  if (raw.bambiRemotePlayerHints !== undefined) updates.bambiRemotePlayerHints = toPlainObject(raw.bambiRemotePlayerHints);

  if (raw.bambiDomainAssocMapFetchedAt !== undefined) {
    updates.bambiDomainAssocMapFetchedAt = Math.max(0, toIntegerOrDefault(raw.bambiDomainAssocMapFetchedAt, 0));
  }

  if (raw.bambiPresets !== undefined) {
    updates.bambiPresets = Array.isArray(raw.bambiPresets) ? raw.bambiPresets : [];
  }
  if (raw.bambiAdDomains !== undefined) {
    updates.bambiAdDomains = Array.isArray(raw.bambiAdDomains)
      ? raw.bambiAdDomains.map(v => String(v || "").trim().toLowerCase()).filter(Boolean)
      : [];
  }
  if (raw.bambiConfigVersion !== undefined) {
    updates.bambiConfigVersion = raw.bambiConfigVersion;
  }

  if (raw.bambiMaxVideoLengthEnabled !== undefined) updates.bambiMaxVideoLengthEnabled = Boolean(raw.bambiMaxVideoLengthEnabled);
  if (raw.bambiMaxVideoLengthMins !== undefined) {
    const mins = toIntegerOrDefault(raw.bambiMaxVideoLengthMins, 15);
    updates.bambiMaxVideoLengthMins = (Number.isFinite(mins) && mins >= 1 && mins <= 600) ? mins : 15;
  }
  if (raw.bambiMaxVideoLengthAction !== undefined) {
    const action = String(raw.bambiMaxVideoLengthAction || "");
    updates.bambiMaxVideoLengthAction = ["soft-unlock", "exit", "auto-skip"].includes(action) ? action : "soft-unlock";
  }

  return updates;
}

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
    btn.disabled = bambiLockdownUiActive;
    if (bambiLockdownUiActive) {
      btn.title = "Domain removal is locked during lockdown";
    }
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
  chrome.storage.local.get({ bambiInputLockLockedUntil: 0 }, lockData => {
    const lockdownActive = Number(lockData.bambiInputLockLockedUntil) > Date.now();
    if (lockdownActive) return;

  chrome.storage.local.get({ bambiDomains: DEFAULT_DOMAINS }, data => {
    const updated = (data.bambiDomains || [])
      .map(normalizeDomainInput)
      .filter(d => d && d !== normalizeDomainInput(domain));
    chrome.storage.local.set({ bambiDomains: updated }, () => renderDomains(updated));
  });
  });
}

function addDomain() {
  chrome.storage.local.get({ bambiInputLockLockedUntil: 0 }, lockData => {
    const lockdownActive = Number(lockData.bambiInputLockLockedUntil) > Date.now();
    if (lockdownActive) return;

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
  const masterToggle = document.getElementById("masterToggle");
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
  const autoPlayToggle = document.getElementById("autoPlayToggle");
  const maxVideoLengthToggle = document.getElementById("maxVideoLengthToggle");
  const maxVideoLengthSettings = document.getElementById("maxVideoLengthSettings");
  const maxVideoLengthMinsInput = document.getElementById("maxVideoLengthMinsInput");
  const maxVideoLengthActionSelect = document.getElementById("maxVideoLengthActionSelect");
  const maxVideoLengthActionHelp = document.getElementById("maxVideoLengthActionHelp");

  const MAX_VIDEO_LENGTH_ACTION_HELP = {
    "soft-unlock": "At the time limit, input lock turns off with a notification sound. The video keeps playing in VLC and you can exit when ready.",
    "exit": "At the time limit, VLC stops and input lock turns off, as if the video ended normally.",
    "auto-skip": "When a video is detected, if its duration exceeds the limit it is skipped immediately and not sent to VLC.",
  };

  function updateMaxVideoLengthActionHelp() {
    if (maxVideoLengthActionHelp && maxVideoLengthActionSelect) {
      maxVideoLengthActionHelp.textContent = MAX_VIDEO_LENGTH_ACTION_HELP[maxVideoLengthActionSelect.value] || "";
    }
  }
  const autoPlaySettings = document.getElementById("autoPlaySettings");
  const autoPlayUrlsInput = document.getElementById("autoPlayUrlsInput");
  const autoPlayDelaySelect = document.getElementById("autoPlayDelaySelect");
  const addDomainBtn = document.getElementById("addBtn");
  const domainInput = document.getElementById("domainInput");
  const exportSettingsBtn = document.getElementById("exportSettingsBtn");
  const importSettingsBtn = document.getElementById("importSettingsBtn");
  const settingsImportInput = document.getElementById("settingsImportInput");

  let inputLockDurationMs = 3600000;
  let inputLockLockedUntil = 0;
  let inputLockTickerId = null;
  let lockdownStorageSyncInFlight = false;

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

  function updateLockdownBoundControls(lockdownActive) {
    bambiLockdownUiActive = lockdownActive;

    if (lockdownActive) {
      masterToggle.checked = true;
      multiMonitorToggle.checked = true;
      inputLockToggle.checked = true;
      autoPlayToggle.checked = true;
      autoPlaySettings.style.display = "";
    }

    masterToggle.disabled = lockdownActive;
    multiMonitorToggle.disabled = lockdownActive;
    autoPlayToggle.disabled = lockdownActive;
    autoPlayUrlsInput.disabled = lockdownActive;
    autoPlayDelaySelect.disabled = lockdownActive;
    addDomainBtn.disabled = lockdownActive;
    domainInput.disabled = lockdownActive;

    Array.from(document.querySelectorAll("#domainList .domain-remove")).forEach(btn => {
      btn.disabled = lockdownActive;
      if (lockdownActive) {
        btn.title = "Domain removal is locked during lockdown";
      } else {
        btn.title = "Remove domain";
      }
    });
  }

  function syncLockdownManagedSettings() {
    if (!isInputLockLockdownActive() || lockdownStorageSyncInFlight) return;
    lockdownStorageSyncInFlight = true;
    chrome.storage.local.get(
      {
        bambiActivated: false,
        bambiMultiMonitor: false,
        bambiInputLockEnabled: false,
        bambiAutoPlayEnabled: false,
      },
      data => {
        const updates = {};
        if (!data.bambiActivated) updates.bambiActivated = true;
        if (!data.bambiMultiMonitor) updates.bambiMultiMonitor = true;
        if (!data.bambiInputLockEnabled) updates.bambiInputLockEnabled = true;
        if (!data.bambiAutoPlayEnabled) updates.bambiAutoPlayEnabled = true;

        const done = () => {
          lockdownStorageSyncInFlight = false;
        };

        if (Object.keys(updates).length) {
          chrome.storage.local.set(updates, done);
          return;
        }
        done();
      }
    );
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

    updateLockdownBoundControls(lockdownActive);
    if (lockdownActive) syncLockdownManagedSettings();
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
      bambiAutoPlayUrls: [],
      bambiAutoPlayDelayMs: 600000,
      bambiAutoPlayLastTriggerAt: 0,
      bambiMaxVideoLengthEnabled: false,
      bambiMaxVideoLengthMins: 15,
      bambiMaxVideoLengthAction: "soft-unlock",
    },
    data => {
      masterToggle.checked = data.bambiActivated;
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
      autoPlayToggle.checked = Boolean(data.bambiAutoPlayEnabled);
      autoPlaySettings.style.display = data.bambiAutoPlayEnabled ? "" : "none";
      const normalizedAutoPlayUrls = normalizeAutoPlayUrlList(data.bambiAutoPlayUrls, data.bambiAutoPlayUrl || "");
      autoPlayUrlsInput.value = autoPlayUrlsToText(normalizedAutoPlayUrls);
      if (
        JSON.stringify(normalizedAutoPlayUrls) !== JSON.stringify(Array.isArray(data.bambiAutoPlayUrls) ? data.bambiAutoPlayUrls : []) ||
        (data.bambiAutoPlayUrl || "") !== (normalizedAutoPlayUrls[0] || "")
      ) {
        chrome.storage.local.set({
          bambiAutoPlayUrls: normalizedAutoPlayUrls,
          bambiAutoPlayUrl: normalizedAutoPlayUrls[0] || "",
        });
      }
      updateLastTriggerDisplay(data.bambiAutoPlayLastTriggerAt || 0);
      const savedDelay = Number(data.bambiAutoPlayDelayMs);
      autoPlayDelaySelect.value = String(AUTOPLAY_DELAY_OPTIONS_MS.includes(savedDelay) ? savedDelay : 600000);
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
      updateInputLockUi();

      // Max video length
      maxVideoLengthToggle.checked = Boolean(data.bambiMaxVideoLengthEnabled);
      maxVideoLengthSettings.style.display = data.bambiMaxVideoLengthEnabled ? "" : "none";
      const savedMins = Number(data.bambiMaxVideoLengthMins);
      maxVideoLengthMinsInput.value = String(Number.isFinite(savedMins) && savedMins >= 1 ? Math.floor(savedMins) : 15);
      const savedAction = String(data.bambiMaxVideoLengthAction || "soft-unlock");
      maxVideoLengthActionSelect.value = ["soft-unlock", "exit", "auto-skip"].includes(savedAction) ? savedAction : "soft-unlock";
      updateMaxVideoLengthActionHelp();
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
  masterToggle.addEventListener("change", e => {
    if (isInputLockLockdownActive()) {
      masterToggle.checked = true;
      return;
    }
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
    if (isInputLockLockdownActive()) {
      multiMonitorToggle.checked = true;
      updateInputLockUi();
      return;
    }
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
    if (changes.bambiActivated !== undefined) {
      masterToggle.checked = Boolean(changes.bambiActivated.newValue);
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
      changes.bambiActivated !== undefined ||
      changes.bambiMultiMonitor !== undefined ||
      changes.bambiInputLockEnabled !== undefined ||
      changes.bambiInputLockDurationMs !== undefined ||
      changes.bambiInputLockLockedUntil !== undefined
    ) {
      updateInputLockUi();
    }
    if (changes.bambiAutoPlayEnabled !== undefined) {
      autoPlayToggle.checked = Boolean(changes.bambiAutoPlayEnabled.newValue);
      autoPlaySettings.style.display = autoPlayToggle.checked ? "" : "none";
      if (isInputLockLockdownActive()) {
        syncLockdownManagedSettings();
      }
    }
    if (changes.bambiAutoPlayUrls !== undefined || changes.bambiAutoPlayUrl !== undefined) {
      const nextUrls = normalizeAutoPlayUrlList(
        changes.bambiAutoPlayUrls?.newValue,
        changes.bambiAutoPlayUrl?.newValue || ""
      );
      autoPlayUrlsInput.value = autoPlayUrlsToText(nextUrls);
    }
    if (changes.bambiDomains !== undefined) {
      const nextDomains = (changes.bambiDomains.newValue || []).map(normalizeDomainInput).filter(Boolean);
      renderDomains(nextDomains);
    }
    if (changes.bambiAutoPlayLastTriggerAt !== undefined) {
      updateLastTriggerDisplay(changes.bambiAutoPlayLastTriggerAt.newValue || 0);
    }
    if (changes.bambiMaxVideoLengthEnabled !== undefined) {
      maxVideoLengthToggle.checked = Boolean(changes.bambiMaxVideoLengthEnabled.newValue);
      maxVideoLengthSettings.style.display = maxVideoLengthToggle.checked ? "" : "none";
    }
    if (changes.bambiMaxVideoLengthMins !== undefined) {
      const nextMins = Number(changes.bambiMaxVideoLengthMins.newValue) || 15;
      maxVideoLengthMinsInput.value = String(nextMins);
    }
    if (changes.bambiMaxVideoLengthAction !== undefined) {
      const nextAction = String(changes.bambiMaxVideoLengthAction.newValue || "soft-unlock");
      maxVideoLengthActionSelect.value = ["soft-unlock", "exit", "auto-skip"].includes(nextAction) ? nextAction : "soft-unlock";
      updateMaxVideoLengthActionHelp();
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

  autoPlayToggle.addEventListener("change", e => {
    if (isInputLockLockdownActive()) {
      autoPlayToggle.checked = true;
      autoPlaySettings.style.display = "";
      syncLockdownManagedSettings();
      return;
    }
    const enabled = e.target.checked;
    chrome.storage.local.set({ bambiAutoPlayEnabled: enabled });
    autoPlaySettings.style.display = enabled ? "" : "none";
  });
  autoPlayUrlsInput.addEventListener("change", e => {
    if (isInputLockLockdownActive()) {
      return;
    }
    const urls = parseAutoPlayUrlsFromText(e.target.value);
    autoPlayUrlsInput.value = autoPlayUrlsToText(urls);
    chrome.storage.local.set({
      bambiAutoPlayUrls: urls,
      bambiAutoPlayUrl: urls[0] || "",
    });
  });
  autoPlayDelaySelect.addEventListener("change", e => {
    if (isInputLockLockdownActive()) {
      return;
    }
    const val = Number(e.target.value);
    if (!val) return;
    chrome.storage.local.set({ bambiAutoPlayDelayMs: val });
  });

  exportSettingsBtn?.addEventListener("click", async () => {
    const data = await new Promise(resolve => chrome.storage.local.get(SETTINGS_EXPORT_DEFAULTS, resolve));
    const normalizedUrls = normalizeAutoPlayUrlList(data.bambiAutoPlayUrls, data.bambiAutoPlayUrl || "");
    data.bambiAutoPlayUrls = normalizedUrls;
    data.bambiAutoPlayUrl = normalizedUrls[0] || "";
    const xml = buildSettingsXml(data);
    const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+/, "");
    ensureDownload(`bambi-settings-${stamp}.xml`, "application/xml", xml);
  });

  importSettingsBtn?.addEventListener("click", () => {
    settingsImportInput?.click();
  });

  settingsImportInput?.addEventListener("change", async () => {
    const file = settingsImportInput.files && settingsImportInput.files[0];
    if (!file) return;
    try {
      const xmlText = await file.text();
      const raw = parseSettingsXml(xmlText);
      const updates = sanitizeImportedSettings(raw);
      if (!Object.keys(updates).length) {
        alert("No supported settings found in this XML file.");
        return;
      }
      await chrome.storage.local.set(updates);
      await loadConfigStatus();
      await loadUpdateStatus();
      updateInputLockUi();
      alert("Settings imported successfully.");
    } catch (err) {
      alert(`Import failed: ${err?.message || "Unknown error"}`);
    } finally {
      settingsImportInput.value = "";
    }
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

  // Max video length
  maxVideoLengthToggle.addEventListener("change", e => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ bambiMaxVideoLengthEnabled: enabled });
    maxVideoLengthSettings.style.display = enabled ? "" : "none";
  });

  maxVideoLengthMinsInput.addEventListener("change", e => {
    const val = Math.max(1, Math.min(600, Math.floor(Number(e.target.value) || 15)));
    maxVideoLengthMinsInput.value = String(val);
    chrome.storage.local.set({ bambiMaxVideoLengthMins: val });
  });

  maxVideoLengthActionSelect.addEventListener("change", e => {
    chrome.storage.local.set({ bambiMaxVideoLengthAction: e.target.value });
    updateMaxVideoLengthActionHelp();
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
    chrome.tabs.create({ url: "https://geordie-bambi-mk2.github.io/bbrowser-resources/" });
  });

  // Server status indicator + live playback clock.
  refreshServerStatus();
  setInterval(refreshServerStatus, 2000);
});
