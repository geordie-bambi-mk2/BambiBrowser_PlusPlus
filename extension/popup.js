// -------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------
const BAMBI_SERVER = "http://127.0.0.1:5655";
const DEFAULT_DOMAINS = ["hypnotube.com"];
const AUTO_MODE_DOMAINS = ["hypnotube.com"]; // Domains that use auto-play, not manual
const DEFAULT_INTENT_WINDOW_MS = 2200;
const DEFAULT_MANUAL_SHORTCUT = "Alt+Shift+V";
const REMOTE_CONFIG_URL = "https://geordie-bambi-mk2.github.io/bbrowser-resources/config.json";

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

function setupTabs() {
  const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
  const panes = Array.from(document.querySelectorAll(".tab-pane"));

  function activate(tabName) {
    tabButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
    panes.forEach(pane => pane.classList.toggle("active", pane.id === `tab-${tabName}`));
  }

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });
}

// Helper: determine if a domain should use auto or manual mode
function determineDomainMode(domain) {
  const normalized = normalizeDomainInput(domain);
  return AUTO_MODE_DOMAINS.some(d => hostMatchesDomain(normalized, d)) ? "auto" : "manual";
}

// -------------------------------------------------------
// SERVER HEALTH CHECK
// -------------------------------------------------------
async function checkServer() {
  try {
    const r = await fetch(BAMBI_SERVER + "/health", { method: "GET" });
    return r.status === 200;
  } catch {
    return false;
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
    },
    data => {
      document.getElementById("masterToggle").checked = data.bambiActivated;
      document.getElementById("multiMonitorToggle").checked = data.bambiMultiMonitor;
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
  document.getElementById("multiMonitorToggle").addEventListener("change", e => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ bambiMultiMonitor: enabled });
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

  function filePathToUrl(rawPath) {
    const trimmed = rawPath.trim();
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
    const raw = (localFileResolvedPath || localFileInput.value || "").trim();
    if (!raw) {
      localFileStatus.style.color = "#cc6060";
      localFileStatus.textContent = "Pick a file first.";
      return;
    }

    const fileUrl = filePathToUrl(raw);
    if (!fileUrl) {
      localFileStatus.style.color = "#cc6060";
      localFileStatus.textContent = "Invalid path.";
      return;
    }

    const ext = fileUrl.split("?")[0].split(".").pop().toLowerCase();
    const knownExts = ["mp4","mkv","avi","mov","wmv","flv","webm","m4v","mpg","mpeg","ts","m2ts","ogg","ogv"];
    if (!knownExts.includes(ext)) {
      localFileStatus.style.color = "#cc9900";
      localFileStatus.textContent = `Unrecognised extension ".${ext}" — will try anyway.`;
    } else {
      localFileStatus.style.color = "#c892d4";
      localFileStatus.textContent = "Sending to VLC\u2026";
    }

    // Read multi-monitor preference at send time
    const storageData = await chrome.storage.local.get({ bambiMultiMonitor: true });

    try {
      const r = await fetch(BAMBI_SERVER + "/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: fileUrl, multi_monitor: storageData.bambiMultiMonitor }),
      });
      if (r.ok) {
        localFileStatus.style.color = "#50d050";
        localFileStatus.textContent = "\u2713 Sent to VLC!";
        localFileResolvedPath = "";
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

    // Some Chromium variants expose a non-standard real local path on File.path.
    // Standard browser behaviour hides it for privacy and only exposes a fake path.
    const nativePath = typeof picked.path === "string" ? picked.path.trim() : "";
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
    localFileStatus.style.color = "#cc9900";
    localFileStatus.textContent = "Browser privacy hides absolute path in picker here. If Play fails, paste full path manually.";
  });

  localFileBtn.addEventListener("click", sendLocalFile);
  localFileInput.addEventListener("keydown", e => { if (e.key === "Enter") sendLocalFile(); });

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

  // Server status indicator
  checkServer().then(online => {
    const dot  = document.getElementById("statusDot");
    const text = document.getElementById("statusText");
    if (online) {
      dot.classList.add("online");
      text.textContent = "bambi_player connected";
    } else {
      dot.classList.add("offline");
      text.textContent = "bambi_player offline";
    }
  });
});
