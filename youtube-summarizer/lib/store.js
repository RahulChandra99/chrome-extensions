// Saved notes. One record per video under "n:<key>", plus a light index for the library list.
(() => {
  const VN = (globalThis.VN = globalThis.VN || {});
  const K = (key) => "n:" + key;

  function keyFor(det) {
    if (det.kind === "youtube" && det.id) return "yt:" + det.id;
    if (det.kind === "vimeo" && det.id) return "vimeo:" + det.id;
    if (det.kind === "twitch" && det.id) return "twitch:" + det.id;
    return "url:" + (det.url || det.pageUrl || "").split("#")[0];
  }

  async function get(key) {
    return (await chrome.storage.local.get(K(key)))[K(key)] || null;
  }

  async function index() {
    return (await chrome.storage.local.get("idx")).idx || [];
  }

  async function put(rec) {
    rec.updated = Date.now();
    const idx = (await index()).filter((e) => e.key !== rec.key);
    const has = Object.values(rec.notes || {}).some(Boolean);
    idx.unshift({
      key: rec.key, title: rec.title, site: rec.site, channel: rec.channel, duration: rec.duration,
      thumb: rec.thumb, updated: rec.updated, category: rec.category || "", tags: rec.tags || [], notes: has,
    });
    await chrome.storage.local.set({ [K(rec.key)]: rec, idx });
  }

  async function remove(key) {
    await chrome.storage.local.remove(K(key));
    await chrome.storage.local.set({ idx: (await index()).filter((e) => e.key !== key) });
  }

  VN.store = { keyFor, get, put, remove, index };
})();
