/* Shred Log background worker: keeps a queue of links and hands them to your Shred Log tab. */
importScripts("classify.js");

const DEFAULTS = {
  shredUrl: "https://claude.ai/artifact/1zqUbP1qA6YGt9Zf4FBRrA",
  openPinned: true,
  autoSave: true,
  rules: []
};
const RECENT_MAX = 40;

async function cfg() {
  const got = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...got };
}
async function getLocal() {
  const { queue = [], recent = [] } = await chrome.storage.local.get(["queue", "recent"]);
  return { queue, recent };
}
/* one writer at a time so popup clicks and deliveries don't trample each other */
let lock = Promise.resolve();
function withState(fn) {
  const run = lock.then(async () => {
    const st = await getLocal();
    const out = await fn(st);
    await chrome.storage.local.set({ queue: st.queue, recent: st.recent.slice(0, RECENT_MAX) });
    return out;
  });
  lock = run.catch(() => {});
  return run;
}
const newKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- saving ---------- */
async function save(meta, opts = {}) {
  const c = await cfg();
  const u = SL.cleanUrl(meta.u);
  if (!/^https?:\/\//i.test(u)) throw new Error("Only web pages can be saved.");
  const sorted = meta.c ? { c: meta.c, why: "You picked this" } : SL.classify({ ...meta, u }, c.rules);
  const isVideo = SL.isYouTubeVideo(u);
  const res = await withState(st => {
    const existing = st.recent.find(r => r.u === u && r.status !== "removed");
    if (existing && !opts.force) return { entry: existing, again: true };
    const key = newKey();
    const entry = {
      key, u, t: meta.t || "", s: meta.s || "", site: meta.site || SL.hostOf(u), img: meta.img || "", fav: meta.fav || "",
      by: meta.by || "", d: meta.d || "", c: sorted.c, why: sorted.why, video: isVideo, note: "",
      ts: Date.now(), status: "queued", where: isVideo ? "Watch later" : "Saved links"
    };
    st.recent = [entry, ...st.recent.filter(r => r.u !== u)];
    st.queue.push({ key, op: "add", u, t: entry.t, s: entry.s, site: entry.site, img: entry.img, by: entry.by, d: entry.d, c: entry.c, src: opts.src || "ext" });
    return { entry, again: false };
  });
  badge();
  deliver();
  return res;
}

async function followUp(key, op, extra) {
  const res = await withState(st => {
    const e = st.recent.find(r => r.key === key);
    if (!e) return null;
    const queued = st.queue.find(q => q.key === key && q.op === "add");
    if (op === "recat") { e.c = extra.c; e.why = "You picked this"; }
    if (op === "note") e.note = extra.note;
    if (op === "del") e.status = "removed";
    if (queued) {
      // still waiting to be delivered: just change what we'll send
      if (op === "recat") queued.c = extra.c;
      if (op === "note") queued.note = extra.note;
      if (op === "del") st.queue = st.queue.filter(q => q !== queued);
    } else {
      st.queue = st.queue.filter(q => !(q.u === e.u && q.op === op)); // newest wins
      st.queue.push({ key: newKey(), ref: key, op, u: e.u, ...extra });
      if (op !== "del") e.status = e.status === "saved" || e.status === "dup" ? "updating" : e.status;
    }
    return e;
  });
  badge();
  deliver();
  return res;
}

/* ---------- finding your Shred Log tab ---------- */
const baseOf = url => String(url || "").split(/[?#]/)[0].replace(/\/$/, "");
async function findShredTab(create) {
  const { shredUrl, openPinned } = await cfg();
  const base = baseOf(shredUrl);
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find(t => baseOf(t.url || t.pendingUrl) === base);
  if (!tab && create) {
    tab = await chrome.tabs.create({ url: shredUrl, active: false, pinned: !!openPinned, index: 0 });
    await chrome.storage.local.set({ openedTab: tab.id });
  } else if (tab && tab.discarded) {
    await chrome.tabs.reload(tab.id);
  }
  return tab || null;
}

let delivering = false, deliverAgain = false;
async function deliver() {
  if (delivering) { deliverAgain = true; return; }
  delivering = true; deliverAgain = false;
  try {
    const { queue } = await getLocal();
    if (!queue.length) return;
    const tab = await findShredTab(true);
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "sl-deliver", ops: queue });
    } catch (e) {
      // the page is still loading; it will ask for the queue once it's ready
    }
  } finally {
    delivering = false;
    if (deliverAgain) deliver();
  }
}

async function applyResults(res, mode) {
  await withState(st => {
    for (const r of res || []) {
      const q = st.queue.find(x => x.key === r.key);
      if (!q) continue; // already handled (delivered twice)
      st.queue = st.queue.filter(x => x !== q);
      const e = st.recent.find(x => x.key === (q.ref || q.key));
      if (!e) continue;
      if (!r.ok) { e.status = "error"; e.err = r.err || "Couldn't save"; continue; }
      if (q.op === "add") { e.status = r.dup ? "dup" : "saved"; e.where = r.where || e.where; e.view = r.view; e.local = mode === "local"; }
      else if (q.op === "del") e.status = "removed";
      else if (e.status === "updating") e.status = "saved";
    }
  });
  badge(true);
}

/* ---------- toolbar badge ---------- */
let flashT;
async function badge(flash) {
  const { queue } = await getLocal();
  clearTimeout(flashT);
  if (queue.length) {
    chrome.action.setBadgeBackgroundColor({ color: "#F28C1D" });
    chrome.action.setBadgeText({ text: String(queue.length) });
  } else if (flash) {
    chrome.action.setBadgeBackgroundColor({ color: "#1F9D62" });
    chrome.action.setBadgeText({ text: "✓" });
    flashT = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

/* ---------- reading a page or a link ---------- */
function decodeEntities(s) {
  return String(s || "").replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (m, g) => {
    g = g.toLowerCase();
    if (g[0] === "#") { const n = g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); return isNaN(n) ? m : String.fromCodePoint(n); }
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[g] || m;
  }).trim();
}
async function fetchMeta(u) {
  const meta = { u };
  try {
    if (SL.isYouTubeVideo(u)) {
      const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(u));
      if (r.ok) { const j = await r.json(); meta.t = j.title; meta.by = j.author_name; meta.site = "YouTube"; meta.img = j.thumbnail_url; return meta; }
    }
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(u, { signal: ctl.signal, credentials: "omit" });
    clearTimeout(timer);
    if (!r.ok || !/html/i.test(r.headers.get("content-type") || "")) return meta;
    const html = (await r.text()).slice(0, 300000);
    const tag = (attr, name) => {
      const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, "i");
      const m = html.match(re); if (!m) return "";
      const c = m[0].match(/content=["']([^"']*)["']/i); return c ? decodeEntities(c[1]) : "";
    };
    meta.t = tag("property", "og:title") || tag("name", "twitter:title") || decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]);
    meta.s = tag("property", "og:description") || tag("name", "description");
    meta.site = tag("property", "og:site_name");
    meta.img = tag("property", "og:image");
    meta.type = tag("property", "og:type");
    meta.kw = tag("name", "keywords");
  } catch (e) { /* fine: we still have the URL */ }
  return meta;
}

/* a small note in the corner of the page you're on (right-click, bookmark and shortcut saves).
   Calling it again while it's showing updates it in place: "Sending…" turns into "Saved". */
function pageToast(tabId, text, sub, icon = "✓") {
  if (tabId == null || tabId < 0) return;
  chrome.scripting.executeScript({
    target: { tabId },
    args: [text, sub, icon],
    func: (text, sub, icon) => {
      let T = window.__slToast;
      if (!T || !T.host.isConnected) {
        const host = document.createElement("div");
        host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:20px;bottom:20px";
        const root = host.attachShadow({ mode: "closed" });
        root.innerHTML = `<style>
          .t{font:500 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Ubuntu,sans-serif;display:flex;gap:12px;align-items:center;
            background:#141720;color:#F4F5F9;border-radius:14px;padding:12px 16px 12px 12px;box-shadow:0 12px 32px rgba(0,0,0,.28);
            max-width:340px;transform:translateY(16px);opacity:0;transition:transform .25s cubic-bezier(.2,.9,.3,1.2),opacity .2s}
          .t.in{transform:none;opacity:1}
          .i{flex:0 0 34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#3D5AFE,#8B5CF6);display:flex;align-items:center;justify-content:center;font-size:17px;color:#fff}
          .i.spin::before{content:"";width:16px;height:16px;border-radius:50%;border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;animation:r .8s linear infinite}
          @keyframes r{to{transform:rotate(360deg)}}
          b{display:block;font-weight:700}span{opacity:.75;font-size:12.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:270px}
          @media (prefers-reduced-motion:reduce){.t{transition:none}.i.spin::before{animation:none}}
        </style><div class="t" role="status"><div class="i"></div><div><b></b><span></span></div></div>`;
        document.documentElement.appendChild(host);
        T = window.__slToast = { host, root, timer: 0 };
        const t = root.querySelector(".t"); requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("in")));
      }
      const r = T.root, ic = r.querySelector(".i");
      ic.className = "i" + (icon === "spin" ? " spin" : ""); ic.textContent = icon === "spin" ? "" : icon;
      r.querySelector("b").textContent = text; r.querySelector("span").textContent = sub || "";
      clearTimeout(T.timer);
      if (icon !== "spin") T.timer = setTimeout(() => { r.querySelector(".t").classList.remove("in"); setTimeout(() => T.host.remove(), 300); }, 2800);
    }
  }).catch(() => {});
}

async function readTab(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: grabPageMeta }).catch(() => [{}]);
  return result || {};
}
/* runs inside the page */
function grabPageMeta() {
  const q = s => document.querySelector(s);
  const m = (attr, name) => (q(`meta[${attr}="${name}"]`) || {}).content || "";
  const out = {
    u: location.href,
    t: m("property", "og:title") || m("name", "twitter:title") || document.title,
    s: m("property", "og:description") || m("name", "description"),
    site: m("property", "og:site_name"),
    img: m("property", "og:image"),
    type: m("property", "og:type"),
    kw: m("name", "keywords")
  };
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    out.by = (q("ytd-watch-metadata #owner #channel-name a") || q("#owner #channel-name a") || q('link[itemprop="name"]') || {}).textContent?.trim()
      || (q('span[itemprop="author"] link[itemprop="name"]') || {}).getAttribute?.("content") || "";
    const iso = m("itemprop", "duration") || (q('meta[itemprop="duration"]') || {}).content || "";
    const mm = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (mm) { const h = +mm[1] || 0, mi = +mm[2] || 0, se = +mm[3] || 0; out.d = (h ? h + ":" + String(mi).padStart(2, "0") : mi) + ":" + String(se).padStart(2, "0"); }
    else { const t = q(".ytp-time-duration"); if (t) out.d = t.textContent.trim(); }
    const vt = q("ytd-watch-metadata h1") || q("h1.title"); if (vt && vt.textContent.trim()) out.t = vt.textContent.trim();
  }
  if (out.t) out.t = out.t.replace(/\s+[-|–·]\s+YouTube$/, "").trim();
  return out;
}

async function quickSave(tab, src) {
  const meta = await readTab(tab.id);
  meta.u = meta.u || tab.url;
  if (!meta.t) meta.t = tab.title;
  meta.fav = tab.favIconUrl || "";
  const { entry, again } = await save(meta, { src });
  const ci = SL.catInfo(entry.c);
  pageToast(tab.id, again ? "Already in your Shred Log" : "Saved to Shred Log", `${ci[1]} · ${entry.where}`);
}

/* the words of the link you right-clicked, used as its title if the site gives none */
async function linkText(tabId, frameId, url) {
  if (tabId == null || tabId < 0) return "";
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] }, args: [url],
      func: (url) => {
        const a = [...document.querySelectorAll("a[href]")].find((x) => x.href === url);
        if (!a) return "";
        return (a.innerText || a.getAttribute("aria-label") || a.title || (a.querySelector("img[alt]") || {}).alt || "").replace(/\s+/g, " ").trim().slice(0, 200);
      }
    });
    return result || "";
  } catch (e) { return ""; }
}

/* right-click → Send link to Shred Log */
async function saveLink(url, tabId, frameId) {
  pageToast(tabId, "Sending to Shred Log…", SL.hostOf(url), "spin");
  const [meta, text] = await Promise.all([fetchMeta(url), linkText(tabId, frameId, url)]);
  if (!meta.t) meta.t = text;
  else if (text && text.length > 3 && !meta.s) meta.s = text;
  const { entry, again } = await save(meta, { src: "ext-menu" });
  const ci = SL.catInfo(entry.c);
  pageToast(tabId, again ? "Already in your Shred Log" : "Sent to Shred Log", `${ci[1]} · ${entry.t || SL.hostOf(entry.u)}`);
  return entry;
}

/* ---------- bookmarks bar inbox: anything put in the "Shred Log inbox" folder is sent ---------- */
const INBOX_TITLE = "Shred Log inbox";
async function inboxFolder(create) {
  const { bmInbox = true } = await chrome.storage.sync.get("bmInbox");
  if (!bmInbox) return null;
  const { inboxId } = await chrome.storage.local.get("inboxId");
  if (inboxId) { try { const [n] = await chrome.bookmarks.get(inboxId); if (n && !n.url) return n.id; } catch (e) { /* deleted */ } }
  const bar = (await chrome.bookmarks.getTree())[0].children[0];
  let f = (bar.children || []).find((n) => !n.url && n.title === INBOX_TITLE);
  if (!f && create) f = await chrome.bookmarks.create({ parentId: bar.id, title: INBOX_TITLE, index: 0 });
  await chrome.storage.local.set({ inboxId: f ? f.id : null });
  return f ? f.id : null;
}
const bmIgnore = new Set(); // moves we make ourselves
async function activeTabId() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t && /^https?:/.test(t.url || "") ? t.id : null;
}
async function sendBookmarks(nodes) {
  const tabId = await activeTabId();
  const leaves = nodes.filter((n) => n.url && /^https?:/i.test(n.url));
  if (!leaves.length) return [];
  pageToast(tabId, leaves.length === 1 ? "Sending to Shred Log…" : `Sending ${leaves.length} links to Shred Log…`, leaves.length === 1 ? (leaves[0].title || SL.hostOf(leaves[0].url)) : "", "spin");
  const out = [];
  for (const n of leaves.slice(0, 100)) {
    const meta = await fetchMeta(n.url);
    if (!meta.t) meta.t = n.title;
    out.push((await save(meta, { src: "ext-bookmark" })).entry);
  }
  const ci = SL.catInfo(out[0].c);
  pageToast(tabId, out.length === 1 ? "Sent to Shred Log" : `Sent ${out.length} links to Shred Log`, out.length === 1 ? `${ci[1]} · ${out[0].t || SL.hostOf(out[0].u)}` : "Sorted into topics");
  return out;
}
chrome.bookmarks.onCreated.addListener(async (id, node) => {
  // a new bookmark made straight into the folder (e.g. the star button with this folder picked) is sent, then tidied away
  const fid = await inboxFolder(false);
  if (!fid || node.parentId !== fid || !node.url) return;
  await sendBookmarks([node]);
  setTimeout(() => chrome.bookmarks.remove(id).catch(() => {}), 1500);
});
chrome.bookmarks.onMoved.addListener(async (id, info) => {
  if (bmIgnore.delete(id)) return;
  const fid = await inboxFolder(false);
  if (!fid || info.parentId !== fid || info.oldParentId === fid) return;
  const [node] = await chrome.bookmarks.getSubTree(id);
  const leaves = []; (function walk(n) { if (n.url) leaves.push(n); (n.children || []).forEach(walk); })(node);
  // a bookmark made seconds ago and moved here from the star dialog: send it and remove it
  const fresh = node.url && Date.now() - (node.dateAdded || 0) < 120000;
  if (fresh) { await sendBookmarks(leaves); setTimeout(() => chrome.bookmarks.remove(id).catch(() => {}), 1500); return; }
  // an existing bookmark dragged onto the folder: put it straight back where it was, then send it
  bmIgnore.add(id);
  try { await chrome.bookmarks.move(id, { parentId: info.oldParentId, index: info.oldIndex }); } catch (e) { bmIgnore.delete(id); }
  await sendBookmarks(leaves);
});

/* ---------- menus, shortcut, messages ---------- */
chrome.runtime.onInstalled.addListener(async (d) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "sl-link", title: "Send link to Shred Log", contexts: ["link"] });
    chrome.contextMenus.create({ id: "sl-page", title: "Send this page to Shred Log", contexts: ["page", "selection", "image", "video"] });
  });
  if (d.reason === "install") chrome.runtime.openOptionsPage();
  inboxFolder(true).catch(() => {});
  badge();
});
chrome.runtime.onStartup.addListener(() => { badge(); deliver(); });
chrome.storage.onChanged.addListener((ch, area) => { if (area === "sync" && ch.bmInbox && ch.bmInbox.newValue) inboxFolder(true).catch(() => {}); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "sl-link" && info.linkUrl) {
      await saveLink(info.linkUrl, tab && tab.id, info.frameId);
    } else if (info.menuItemId === "sl-page" && tab) {
      await quickSave(tab, "ext-menu");
    }
  } catch (e) {
    pageToast(tab && tab.id, "Couldn't save that", e.message);
  }
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "quick-save") return;
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab && /^https?:/.test(tab.url || "")) quickSave(tab, "ext-key").catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg && msg.type) {
      // from the popup
      case "save": return save(msg.meta, { force: msg.force, src: "ext" });
      case "save-tab":
      case "preview-tab": {
        const tab = await chrome.tabs.get(msg.tabId);
        const meta = await readTab(tab.id);
        meta.u = meta.u || tab.url;
        if (!meta.t) meta.t = tab.title;
        meta.fav = tab.favIconUrl || "";
        if (msg.type === "preview-tab") { const c = await cfg(); return { meta, sorted: SL.classify({ ...meta, u: SL.cleanUrl(meta.u) }, c.rules) }; }
        const { entry, again } = await save(meta, { src: "ext" });
        return { entry: { ...entry, again } };
      }
      case "recat": return followUp(msg.key, "recat", { c: msg.c });
      case "note": return followUp(msg.key, "note", { note: msg.note });
      case "undo": return followUp(msg.key, "del", {});
      case "retry": { await withState(st => { const e = st.recent.find(r => r.key === msg.key); if (e && e.status === "error") { e.status = "queued"; if (!st.queue.some(q => q.key === e.key)) st.queue.push({ key: e.key, op: "add", u: e.u, t: e.t, s: e.s, site: e.site, img: e.img, by: e.by, d: e.d, c: e.c, note: e.note }); } }); deliver(); return true; }
      case "classify": { const c = await cfg(); return SL.classify(msg.meta, msg.rules || c.rules); }
      case "open": {
        const tab = await findShredTab(true);
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        if (msg.view) chrome.tabs.sendMessage(tab.id, { type: "sl-go", view: msg.view }).catch(() => {});
        return true;
      }
      case "deliver": deliver(); return true;
      case "inbox-folder": return inboxFolder(true);
      // from the bridge inside your Shred Log page
      case "sl-ready": {
        await chrome.storage.local.set({ lastSeen: Date.now(), lastMode: msg.mode });
        const { queue } = await getLocal();
        return { ops: queue };
      }
      case "sl-done": {
        await chrome.storage.local.set({ lastSeen: Date.now(), lastMode: msg.mode });
        await applyResults(msg.res, msg.mode);
        return true;
      }
    }
  })().then(reply, e => reply({ error: e.message }));
  return true;
});

/* if the Shred Log tab closes with links still waiting, they stay queued and go next time */
setInterval(() => { getLocal().then(({ queue }) => { if (queue.length) deliver(); }); }, 20000);
