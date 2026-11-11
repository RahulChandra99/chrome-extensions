/* Shred Log popup: saves the current tab the moment it opens, then lets you fix the topic, add a note, or undo. */
const $ = (s, el = document) => el.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
const app = $("#app");
let current = null;   // the entry for this tab
let topicsOpen = false;
let noteTimer = null;

function ago(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function emptyState(title, body) {
  app.innerHTML = `<section class="empty"><div class="big">🔗</div><b></b><span></span>
    <button type="button" class="btn primary" data-act="open">Open Shred Log <span aria-hidden="true">→</span></button></section>`;
  $("b", app).textContent = title;
  $("span", app).textContent = body;
}

function confirmState(meta, sorted) {
  // shown only when "save as soon as I click" is turned off in Settings
  current = { ...meta, c: sorted.c, why: sorted.why, status: "preview", video: SL.isYouTubeVideo(meta.u) };
  build();
  const s = $(".status");
  s.dataset.state = "preview";
  s.innerHTML = `<div class="status-txt"><b class="status-title">Save this page?</b><span class="status-sub"></span></div>`;
  $(".status-sub", s).textContent = current.video ? "It'll go to Watch later" : "It'll go to Saved links";
  $(".actions").innerHTML = `<button type="button" class="btn grad" data-act="save-now">Save to Shred Log</button>`;
  $(".note").hidden = true;
}

function build() {
  app.innerHTML = "";
  app.append($("#tpl-saved").content.cloneNode(true));
  const chips = $(".chips");
  chips.innerHTML = SL.CATS.map(([k, l, e]) =>
    `<button type="button" class="chip" role="radio" aria-checked="false" data-c="${k}"><span class="e">${e}</span>${l}</button>`).join("");
  $("#note").addEventListener("input", (ev) => {
    if (!current || !current.key) return;
    $(".note-state").textContent = "…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      await send({ type: "note", key: current.key, note: ev.target.value.trim() });
      $(".note-state").textContent = "Note saved";
    }, 600);
  });
  fill();
}

function fill() {
  let e = current; if (!e) return;
  const ci = SL.catInfo(e.c);
  // status banner
  const st = $(".status"); if (!st) return;
  if (e.status !== "preview") {
    if (e.again && e.status === "saved") e = { ...e, status: "dup" };
    st.dataset.state = e.status;
    const where = e.where || (e.video ? "Watch later" : "Saved links");
    const T = {
      queued: ["Saving…", "Sending it to your Shred Log"],
      updating: ["Updating…", "Sending your change"],
      saved: [e.video ? "Added to Watch later" : "Saved to Shred Log", e.local ? "Saved on that device only: sign in to Claude to sync" : `${where} · ${ci[2]} ${ci[1]}`],
      dup: ["Already in your Shred Log", `It's in ${where}`],
      error: ["Couldn't save", e.err || "Something went wrong"],
      removed: ["Removed", "It's out of your Shred Log"]
    }[e.status] || ["Saved", ""];
    $(".status-title").textContent = T[0];
    $(".status-sub").textContent = T[1];
    const b = $('[data-act="undo"], [data-act="retry"], [data-act="again"]', st);
    if (b) {
      if (e.status === "error") { b.dataset.act = "retry"; b.textContent = "Retry"; }
      else if (e.status === "removed") { b.dataset.act = "again"; b.textContent = "Save again"; }
      else { b.dataset.act = "undo"; b.textContent = "Undo"; }
      b.hidden = e.status === "queued" && !e.key;
    }
  }
  // preview
  const th = $(".thumb"), img = $(".thumb img");
  if (img && e.img) { if (img.getAttribute("src") !== e.img) img.src = e.img; img.onerror = () => { img.remove(); th.textContent = SL.catInfo(current.c)[2]; }; }
  else { if (img) img.remove(); th.textContent = ci[2]; }
  $(".pv-title").textContent = e.t || e.u;
  $(".pv-site span").textContent = (e.site || SL.hostOf(e.u)) + (e.by ? " · " + e.by : "") + (e.d ? " · " + e.d : "");
  const fav = $(".fav");
  if (fav) { if (e.fav && /^https?:|^data:/.test(e.fav)) { if (fav.getAttribute("src") !== e.fav) fav.src = e.fav; } else fav.remove(); }
  // topic
  $(".topic-ic").textContent = ci[2];
  $(".topic-name").textContent = ci[1];
  $(".topic-why").textContent = e.why || "";
  for (const b of document.querySelectorAll(".chip")) b.setAttribute("aria-checked", String(b.dataset.c === e.c));
  // notes only for links (Watch later rows don't have notes)
  const nt = $(".note"); if (nt && e.status !== "preview") nt.hidden = !!e.video || e.status === "removed";
  const ta = $("#note"); if (ta && document.activeElement !== ta && e.note != null) ta.value = e.note;
}

function paintTopicsToggle() {
  const c = $(".chips"), t = $('[data-act="toggle-topics"]');
  if (!c || !t) return;
  c.hidden = !topicsOpen;
  t.textContent = topicsOpen ? "Done" : "Change";
  t.setAttribute("aria-expanded", String(topicsOpen));
}

async function renderRecent() {
  const { recent = [] } = await chrome.storage.local.get("recent");
  const list = recent.filter((r) => !current || r.key !== current.key).slice(0, 5);
  const box = $("#recent");
  box.hidden = !list.length;
  $("ul", box).innerHTML = list.map((r) => {
    const ci = SL.catInfo(r.c);
    return `<li><span class="e" title="${ci[1]}">${ci[2]}</span><a href="#" data-url="${encodeURI(r.u)}"></a>
      <span class="dot ${r.status}" title="${r.status}"></span><span class="when">${ago(r.ts)}</span></li>`;
  }).join("");
  [...box.querySelectorAll("a")].forEach((a, i) => { a.textContent = list[i].t || list[i].u; a.title = list[i].u; });
}

async function renderConn() {
  const { lastSeen = 0, lastMode, queue = [] } = await chrome.storage.local.get(["lastSeen", "lastMode", "queue"]);
  const el = $("#conn");
  if (queue.length) el.textContent = `⏳ ${queue.length} waiting for Shred Log`;
  else if (lastSeen && lastMode === "local") el.textContent = "⚠️ Shred Log isn't signed in";
  else if (lastSeen) el.innerHTML = `<span class="dot"></span>Connected to your Shred Log`;
  else el.textContent = "Shred Log opens in a pinned tab";
}

/* ---------- actions ---------- */
document.addEventListener("click", async (ev) => {
  const a = ev.target.closest("[data-act], .chip, .recent a");
  if (!a) return;
  if (a.matches(".recent a")) { ev.preventDefault(); chrome.tabs.create({ url: a.dataset.url }); return; }
  if (a.classList.contains("chip")) {
    const c = a.dataset.c;
    if (!current || c === current.c) return;
    current.c = c; current.why = "You picked this";
    fill();
    if (current.key) current = (await send({ type: "recat", key: current.key, c })) || current;
    fill(); renderRecent();
    setTimeout(() => { topicsOpen = false; paintTopicsToggle(); }, 350);
    return;
  }
  switch (a.dataset.act) {
    case "toggle-topics": topicsOpen = !topicsOpen; paintTopicsToggle(); break;
    case "open": await send({ type: "open", view: current && current.video ? "ytsaves" : "links" }); window.close(); break;
    case "undo": if (current && current.key) { current = (await send({ type: "undo", key: current.key })) || current; fill(); } break;
    case "retry": if (current && current.key) { await send({ type: "retry", key: current.key }); } break;
    case "again": {
      const r = await send({ type: "save", meta: current, force: true });
      if (r && r.entry) { current = r.entry; build(); }
      break;
    }
    case "save-now": {
      const r = await send({ type: "save", meta: current });
      if (r && r.entry) { current = r.entry; build(); paintTopicsToggle(); renderConn(); }
      break;
    }
  }
});
$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.recent && current && current.key) {
    const e = (ch.recent.newValue || []).find((r) => r.key === current.key);
    if (e) { const note = current.note; current = e; if (document.activeElement === $("#note")) current.note = note; fill(); }
  }
  if (ch.recent) renderRecent();
  if (ch.queue || ch.lastSeen || ch.lastMode) renderConn();
});

/* ---------- start ---------- */
(async function init() {
  renderConn();
  const forced = +new URLSearchParams(location.search).get("tab"); // popup.html?tab=ID, for previewing outside the toolbar
  const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  const { autoSave = true } = await chrome.storage.sync.get("autoSave");
  if (!tab || !/^https?:\/\//.test(tab.url || "")) {
    emptyState("Nothing to save on this page", "Open a website or video, then click Shred Log again.");
    renderRecent();
    return;
  }
  const r = await send({ type: autoSave ? "save-tab" : "preview-tab", tabId: tab.id });
  if (!r || r.error) { emptyState("Couldn't read this page", (r && r.error) || "Try reloading it."); renderRecent(); return; }
  if (autoSave) { current = r.entry; build(); }
  else confirmState(r.meta, r.sorted);
  paintTopicsToggle();
  renderRecent();
})();
