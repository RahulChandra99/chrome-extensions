// Opens the notes panel. Everything else (reading captions, calling Claude,
// exporting) happens in the panel page itself.
const HAS_SIDE_PANEL = !!chrome.sidePanel;

if (HAS_SIDE_PANEL) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else {
  // Browsers without the side panel API (Vivaldi, for one) get a small window instead.
  chrome.action.onClicked.addListener((tab) => openWindow(tab));
}

const windows = new Map(); // tabId -> window id of its fallback panel
async function openWindow(tab) {
  const known = windows.get(tab.id);
  if (known != null) {
    try { await chrome.windows.update(known, { focused: true }); return; } catch { windows.delete(tab.id); }
  }
  const w = await chrome.windows.create({ url: `panel.html?tab=${tab.id}`, type: "popup", width: 440, height: 820 });
  windows.set(tab.id, w.id);
}
chrome.windows.onRemoved.addListener((id) => {
  for (const [tab, win] of windows) if (win === id) windows.delete(tab);
});

// Must be called straight from a click or shortcut, before anything is awaited,
// or Chrome refuses to open the side panel.
function openPanel(tab, autostart) {
  if (!tab) return;
  if (autostart) chrome.storage.session.set({ autostart: { tabId: tab.id, at: Date.now() } });
  if (HAS_SIDE_PANEL) chrome.sidePanel.open({ tabId: tab.id }).catch(() => openWindow(tab));
  else openWindow(tab);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "vn-notes", title: "Make notes from this video", contexts: ["page", "video", "frame"] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "vn-notes") openPanel(tab, true);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "open-panel") openPanel(sender.tab, true);
  else if (msg?.type === "open-options") chrome.runtime.openOptionsPage();
});
