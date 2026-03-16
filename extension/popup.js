// -------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------
const BAMBI_SERVER = "http://127.0.0.1:5655";
const DEFAULT_DOMAINS = ["hypnotube.com"];

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

  domains.forEach(domain => {
    const item = document.createElement("div");
    item.className = "domain-item";

    const name = document.createElement("span");
    name.className = "domain-name";
    name.textContent = domain;

    const btn = document.createElement("button");
    btn.className = "domain-remove";
    btn.textContent = "\u2715";
    btn.title = "Remove domain";
    btn.addEventListener("click", () => removeDomain(domain));

    item.appendChild(name);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

// -------------------------------------------------------
// ADD / REMOVE DOMAINS
// -------------------------------------------------------
function removeDomain(domain) {
  chrome.storage.local.get({ bambiDomains: DEFAULT_DOMAINS }, data => {
    const updated = data.bambiDomains.filter(d => d !== domain);
    chrome.storage.local.set({ bambiDomains: updated }, () => renderDomains(updated));
  });
}

function addDomain() {
  const input = document.getElementById("domainInput");
  let value = input.value.trim().toLowerCase();

  // Strip protocol / path if user pastes a full URL
  value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();

  if (!value) return;

  chrome.storage.local.get({ bambiDomains: DEFAULT_DOMAINS }, data => {
    if (data.bambiDomains.includes(value)) {
      input.value = "";
      return;
    }
    const updated = [...data.bambiDomains, value];
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
// INIT
// -------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {

  // Load saved state
  chrome.storage.local.get(
    {
      bambiActivated: false,
      bambiDomains: DEFAULT_DOMAINS,
      bambiBlacklist: [],
      bambiMultiMonitor: true,
    },
    data => {
      document.getElementById("masterToggle").checked = data.bambiActivated;
      document.getElementById("multiMonitorToggle").checked = data.bambiMultiMonitor;
      renderDomains(data.bambiDomains);
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
