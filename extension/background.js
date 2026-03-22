// BambiBrowser+ background service worker
// Handles tasks that content scripts cannot do (e.g. chrome.tabs.create)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "BAMBI_OPEN_TAB") {
    const url = msg.url;
    // Only open http/https URLs for safety
    if (typeof url === "string" && /^https?:\/\/.+/.test(url)) {
      chrome.tabs.create({ url });
    }
  }
});
