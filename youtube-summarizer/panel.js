// The panel: finds the video in the current tab, makes notes, shows the
// transcript, answers questions, and sends notes elsewhere.
(() => {
  const { cap, md, claude, store, out } = VN;
  const $ = (s) => document.querySelector(s);
  const fixedTab = Number(new URLSearchParams(location.search).get("tab")) || null;

  const S = {
    tabId: null, det: null, rec: null, pinned: false,
    level: "standard", view: "notes",
    busy: null, abort: null, live: "", stale: false,
    cfg: { ...claude.DEFAULTS }, dest: {}, ready: {},
    note: "", error: null, libCat: "", pasteFor: "new", nowLine: -1,
  };
  const linked = () => !!(S.det && S.rec && S.det.key === S.rec.key);
  const hasNotes = (rec = S.rec, level = S.level) => !!(rec && rec.notes && rec.notes[level]);
  const words = (rec) => (rec.blocks || []).reduce((n, b) => n + b.t.split(/\s+/).length, 0);
  const num = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));

  // ---------- finding the video ----------
  async function activeTab() {
    try {
      if (fixedTab) return await chrome.tabs.get(fixedTab);
      const here = await chrome.tabs.query({ active: true, currentWindow: true });
      return here[0] || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
    } catch {
      return null;
    }
  }

  async function scan() {
    const tab = await activeTab();
    if (!tab) return null;
    S.tabId = tab.id;
    let res;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["lib/captions.js", "extract.js"] });
      res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => globalThis.__vn?.detect() });
    } catch {
      return null; // browser pages and the web store can't be read
    }
    const known = (c) => c.kind !== "html5" && c.id;
    const score = (c) => (known(c) && c.top ? 4e9 : 0) + (c.playing ? 2e9 : 0) + (known(c) ? 1e9 : 0) + c.area;
    const best = res
      .filter((r) => r.result)
      .map((r) => ({ ...r.result, frameId: r.frameId }))
      .filter((c) => !(c.kind === "youtube" && !c.id)) // hover previews on the home page
      .sort((a, b) => score(b) - score(a))[0];
    if (!best) return null;
    const d = best;
    d.url =
      d.kind === "youtube" ? `https://www.youtube.com/watch?v=${d.id}`
      : d.kind === "vimeo" && d.id ? `https://vimeo.com/${d.id}`
      : tab.url;
    if (!d.top && (d.kind === "html5" || !d.title)) d.title = tab.title || d.title;
    d.site =
      d.kind === "youtube" ? "YouTube" : d.kind === "vimeo" ? "Vimeo" : d.kind === "twitch" ? "Twitch"
      : new URL(tab.url).hostname.replace(/^www\./, "");
    d.key = store.keyFor(d);
    return d;
  }

  const fresh = (d) => ({
    key: d.key, kind: d.kind, id: d.id, url: d.url, site: d.site, title: d.title || "Untitled video",
    channel: d.channel || "", duration: d.duration || 0, thumb: d.thumb || "", created: Date.now(),
    blocks: null, source: "", notes: {}, chat: [], category: "", tags: [],
  });

  async function refresh() {
    if (S.busy) { S.stale = true; return; }
    S.stale = false;
    const det = await scan();
    S.det = det;
    if (det && !S.pinned && (!S.rec || S.rec.key !== det.key)) {
      S.rec = (await store.get(det.key)) || fresh(det);
      S.error = null; S.note = "";
      pickLevel();
    } else if (det && S.rec && S.rec.key === det.key && !S.rec.blocks && !hasAny(S.rec)) {
      // nothing saved yet, so keep the title in step with the page
      S.rec.title = det.title || S.rec.title;
      S.rec.channel = det.channel || S.rec.channel;
      S.rec.duration = det.duration || S.rec.duration;
    }
    render();
  }
  const hasAny = (rec) => Object.values(rec.notes || {}).some(Boolean);
  function pickLevel() {
    const want = S.cfg.level || "standard";
    S.level = hasNotes(S.rec, want) || !hasAny(S.rec) ? want : ["standard", "detailed", "brief"].find((l) => hasNotes(S.rec, l));
  }

  let timer = null;
  function schedule(ms = 500) {
    clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  }

  // ---------- reading captions ----------
  class NoCaptions extends Error {}

  const LANGS = { english: "en", spanish: "es", french: "fr", german: "de", hindi: "hi", portuguese: "pt", italian: "it", japanese: "ja", korean: "ko", chinese: "zh", arabic: "ar", russian: "ru", dutch: "nl", turkish: "tr", polish: "pl" };
  const prefer = () => [...new Set([LANGS[(S.cfg.language || "").toLowerCase()] || "en", "en"])];

  async function fetchTrack(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return [];
    return cap.dedupe(cap.parseAny(await res.text()));
  }

  async function vimeo(id) {
    try {
      const cfg = await (await fetch(`https://player.vimeo.com/video/${id}/config`, { credentials: "include" })).json();
      const tracks = cfg?.request?.text_tracks || [];
      if (!tracks.length) return null;
      const want = prefer();
      const t = want.map((p) => tracks.find((x) => (x.lang || "").startsWith(p))).find(Boolean) || tracks[0];
      const segs = await fetchTrack(new URL(t.url, "https://vimeo.com").href);
      const v = cfg.video || {};
      return segs.length ? { segs, source: `Vimeo captions, ${t.label || t.lang}`, info: { title: v.title, channel: v.owner?.name, duration: v.duration } } : null;
    } catch {
      return null;
    }
  }

  async function loadTranscript() {
    const rec = S.rec;
    if (rec.blocks?.length) return;
    if (!linked()) throw new NoCaptions("Open this video's tab so its captions can be read.");
    let res = null;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: S.tabId, frameIds: [S.det.frameId] },
        func: (p) => globalThis.__vn.extract(p),
        args: [prefer()],
      });
      res = r?.result;
    } catch {}
    let segs = res?.segments, source = res?.source || "", info = res?.info;
    if (!segs?.length && res?.tracks) {
      for (const t of res.tracks) {
        try { segs = await fetchTrack(t.url); } catch { segs = []; }
        if (segs.length) { source = `Captions, ${t.label}`; break; }
      }
    }
    if (!segs?.length && rec.kind === "vimeo" && rec.id) {
      const v = await vimeo(rec.id);
      if (v) ({ segs, source, info } = v);
    }
    if (!segs?.length) {
      const why = res?.error && res.error !== "none" ? res.error
        : rec.kind === "twitch" ? "Twitch doesn't publish captions for streams or past broadcasts, so there's no transcript to read."
        : "This video has no captions the panel can read.";
      throw new NoCaptions(why);
    }
    if (info) {
      if (info.title) rec.title = info.title;
      if (info.channel) rec.channel = info.channel;
      if (info.duration) rec.duration = info.duration;
    }
    rec.blocks = cap.toBlocks(segs);
    rec.source = source;
    rec.partial = !!res?.partial;
    await store.put(rec);
  }

  // ---------- notes ----------
  function setBusy(kind) {
    S.busy = kind;
    S.error = null;
    S.note = "";
    render();
  }
  async function endBusy() {
    S.busy = null;
    S.abort = null;
    render();
    if (S.stale) refresh();
  }

  async function makeNotes() {
    if (S.busy || !S.rec) return;
    const rec = S.rec, level = S.level;
    S.live = "";
    setBusy("notes");
    const ac = (S.abort = new AbortController());
    try {
      status("Reading the captions", "busy");
      await loadTranscript();
      renderVideo();
      status(`Writing ${level} notes from ${num(words(rec))} words`, "busy");
      const r = await claude.stream({
        messages: claude.notesMessages(rec, cap.toPrompt(rec.blocks), level, S.cfg.language),
        signal: ac.signal,
        onText: (t) => { S.live = t; paintLive(); },
      });
      rec.notes[level] = r.text;
      const m = md.splitMeta(r.text);
      if (m.category) { rec.category = m.category; rec.tags = m.tags; }
      await store.put(rec);
      S.note = r.cut ? "Cut off at the length limit." : `${num(r.usage.input)} tokens read, ${num(r.usage.output)} written`;
      autoSend(rec, level);
    } catch (e) {
      if (ac.signal.aborted) S.note = "Stopped.";
      else S.error = e;
    }
    endBusy();
  }

  let painting = false;
  function paintLive() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      if (S.busy !== "notes") return;
      const m = md.splitMeta(S.live);
      $("#notes").innerHTML = md.render(m.body);
      if (m.category) paintChips(m.category, m.tags);
    });
  }

  // ---------- rendering ----------
  function status(text, cls = "", el = $("#status")) {
    el.className = "status" + (cls ? " " + cls : "");
    el.textContent = text;
  }
  function statusError(e, el = $("#status")) {
    el.className = "status err";
    el.textContent = e.message || String(e);
    const add = (label, act) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.dataset.act = act;
      el.append(" ", b);
    };
    if (e.code === "no_key") add("Open settings", "settings");
    if (e instanceof NoCaptions && linked()) add("Paste a transcript", "paste-current");
  }

  function paintChips(category, tags) {
    $("#chips").innerHTML =
      (category ? `<span class="chip cat">${md.esc(category)}</span>` : "") +
      (tags || []).map((t) => `<span class="chip">${md.esc(t)}</span>`).join("");
  }

  function thumbInto(el, rec) {
    if (rec.thumb) { el.style.backgroundImage = `url("${rec.thumb.replace(/"/g, "%22")}")`; el.textContent = ""; }
    else { el.style.backgroundImage = ""; el.textContent = (rec.site || rec.title || "V").trim()[0].toUpperCase(); }
  }

  function renderVideo() {
    const rec = S.rec;
    thumbInto($("#thumb"), rec);
    $("#vtitle").textContent = rec.title;
    $("#vsub").textContent = [rec.site, rec.channel, rec.duration ? cap.fmtTime(rec.duration) : ""].filter(Boolean).join(" · ");
    paintChips(rec.category, rec.tags);
  }

  function render() {
    const rec = S.rec;
    const none = !rec;
    $("#v-empty").hidden = !none;
    $("#video").hidden = $("#tabs").hidden = none;
    for (const v of ["notes", "transcript", "ask"]) $("#v-" + v).hidden = none || S.view !== v;
    const banner = $("#banner");
    banner.hidden = true;
    if (!S.cfg.apiKey) {
      banner.hidden = false;
      banner.className = "banner";
      banner.innerHTML = 'Add your Anthropic API key to start. <button data-act="settings">Open settings</button>';
    } else if (rec && S.pinned && S.det && S.det.key !== rec.key) {
      banner.hidden = false;
      banner.className = "banner";
      banner.innerHTML = 'From your library. <button data-act="unpin">Back to this tab\'s video</button>';
    }
    if (none) { $("#foot").hidden = true; return; }

    renderVideo();
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === S.view));
    if (S.view === "notes") renderNotes();
    else if (S.view === "transcript") renderTranscript();
    else renderAsk();
    $("#foot").hidden = !(S.view === "notes" && hasNotes() && S.busy !== "notes");
  }

  function renderNotes() {
    const rec = S.rec;
    document.querySelectorAll("#levels button").forEach((b) => {
      b.classList.toggle("on", b.dataset.level === S.level);
      b.classList.toggle("has", hasNotes(rec, b.dataset.level));
      b.disabled = !!S.busy;
    });
    const make = $("#btn-make");
    make.textContent = S.busy === "notes" ? "Stop" : hasNotes() ? "Redo" : "Make notes";
    make.disabled = !!S.busy && S.busy !== "notes";
    const hint = $("#notes-hint");
    hint.hidden = true;
    if (S.busy === "notes") return; // the stream paints itself
    if (S.error) statusError(S.error);
    else status(S.note);
    if (hasNotes()) {
      $("#notes").innerHTML = md.render(md.splitMeta(rec.notes[S.level]).body, { ask: true });
    } else {
      $("#notes").innerHTML = "";
      hint.hidden = !!S.error;
      const other = ["brief", "standard", "detailed"].filter((l) => hasNotes(rec, l));
      hint.textContent = other.length
        ? `You have ${other.join(" and ")} notes for this video. Press Make notes for a ${S.level} version.`
        : "Brief is the TL;DR and key points. Standard sorts the video into sections. Detailed is full study notes with an outline, key terms and action items.";
    }
  }

  // ---------- transcript ----------
  async function ensureTranscript(el) {
    if (S.rec.blocks?.length) return true;
    if (S.busy) return false;
    S.busy = "transcript";
    status("Reading the captions", "busy", el);
    let ok = true;
    try { await loadTranscript(); } catch (e) { ok = false; statusError(e, el); }
    S.busy = null;
    if (S.stale) refresh();
    return ok;
  }

  async function renderTranscript() {
    const rec = S.rec, el = $("#t-status"), box = $("#lines");
    if (!rec.blocks?.length) {
      box.innerHTML = "";
      if (!(await ensureTranscript(el))) return;
      if (S.rec !== rec || S.view !== "transcript") return;
      renderVideo();
    }
    el.className = "status";
    el.innerHTML = `${md.esc(rec.source || "Transcript")} · ${num(words(rec))} words${rec.partial ? " · only the part loaded so far, play further to load more" : ""} · <button data-act="t-copy">Copy</button> · <button data-act="t-txt">.txt</button>${cap.timed(rec.blocks) ? ' · <button data-act="t-srt">.srt</button>' : ""}`;
    paintLines();
  }

  function paintLines() {
    const rec = S.rec;
    const q = $("#t-search").value.trim().toLowerCase();
    const mark = (text) => {
      if (!q) return md.esc(text);
      const out = [];
      const low = text.toLowerCase();
      let i = 0, j;
      while ((j = low.indexOf(q, i)) >= 0) {
        out.push(md.esc(text.slice(i, j)), "<mark>", md.esc(text.slice(j, j + q.length)), "</mark>");
        i = j + q.length;
      }
      out.push(md.esc(text.slice(i)));
      return out.join("");
    };
    const rows = [];
    rec.blocks.forEach((b, i) => {
      if (q && !b.t.toLowerCase().includes(q)) return;
      rows.push(`<div class="line" data-i="${i}"${b.s >= 0 ? ` data-t="${b.s}"` : ""}>${b.s >= 0 ? `<a class="ts" data-t="${b.s}">${cap.fmtTime(b.s)}</a>` : ""}<span>${mark(b.t)}</span></div>`);
    });
    $("#lines").innerHTML = rows.join("") || '<div class="lib-empty">Nothing matches.</div>';
    S.nowLine = -1;
  }

  // Highlight the line being spoken while the transcript is open.
  setInterval(async () => {
    if (S.view !== "transcript" || !linked() || !S.rec?.blocks?.length || document.hidden || $("#t-search").value) return;
    let t = -1;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: S.tabId, frameIds: [S.det.frameId] }, func: () => globalThis.__vn?.time() ?? -1 });
      t = r?.result ?? -1;
    } catch {}
    if (t < 0) return;
    const blocks = S.rec.blocks;
    let i = -1;
    for (let k = 0; k < blocks.length && blocks[k].s <= t; k++) i = k;
    if (i === S.nowLine) return;
    S.nowLine = i;
    document.querySelector(".line.now")?.classList.remove("now");
    const row = document.querySelector(`.line[data-i="${i}"]`);
    if (!row) return;
    row.classList.add("now");
    if ($("#t-follow").checked) row.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 1000);

  // ---------- ask ----------
  const SUGGEST = [
    ["Explain it simply", "Explain the main idea of this video in simple terms, as if I'm new to the topic."],
    ["Action items", "List everything the video tells me to do, as a checklist in order."],
    ["Key terms", "List the key terms, names and tools mentioned in this video with what each one means here."],
    ["Quiz me", "Write five quiz questions that test whether I understood this video. Put the answers at the end."],
    ["Weak points", "Where is the video's reasoning weak, or what does it leave out?"],
    ["Best quotes", "Pull out the most quotable lines from this video, word for word."],
  ];

  function renderAsk(live) {
    const rec = S.rec, box = $("#chat");
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const parts = rec.chat.map((m) =>
      m.role === "user" ? `<div class="bubble user">${md.esc(m.text)}</div>` : `<div class="bubble assistant">${md.render(m.text)}</div>`
    );
    if (live != null) parts.push(`<div class="bubble assistant">${live ? md.render(live) : '<span class="status busy">Thinking</span>'}</div>`);
    if (S.askError) parts.push(`<div class="bubble err">${md.esc(S.askError)}</div>`);
    if (!parts.length) parts.push('<div class="chat-empty">Ask anything about this video. Answers come from the transcript and link back to the moment it was said.</div>');
    else if (!S.busy) parts.push('<div class="chat-tools"><button data-act="chat-clear">Clear this chat</button></div>');
    box.innerHTML = parts.join("");
    if (stick || live === "") box.scrollTop = box.scrollHeight;
    $("#suggest").innerHTML = SUGGEST.map((s, i) => `<button data-suggest="${i}">${s[0]}</button>`).join("");
    $("#ask-send").textContent = S.busy === "ask" ? "Stop" : "Ask";
    $("#ask-send").disabled = !!S.busy && S.busy !== "ask";
  }

  async function ask(text) {
    text = (text || "").trim();
    if (!text || S.busy || !S.rec) return;
    const rec = S.rec;
    S.askError = "";
    rec.chat.push({ role: "user", text });
    S.busy = "ask";
    const ac = (S.abort = new AbortController());
    renderAsk("");
    let failed = null;
    try {
      await loadTranscript();
      const r = await claude.stream({
        messages: claude.askMessages(rec, cap.toPrompt(rec.blocks), rec.chat, S.cfg.language),
        signal: ac.signal,
        maxTokens: 16000,
        onText: (t) => { if (S.view === "ask" && S.rec === rec) renderAsk(t); },
      });
      rec.chat.push({ role: "assistant", text: r.text });
      await store.put(rec);
    } catch (e) {
      failed = e;
      rec.chat.pop();
      if (!ac.signal.aborted) {
        S.askError = e.message || String(e);
        $("#ask-input").value = text;
      }
    }
    S.busy = null;
    S.abort = null;
    if (S.view === "ask") render();
    if (S.stale) refresh();
    return !failed;
  }

  // ---------- sending notes elsewhere ----------
  let toastTimer = null;
  function toast(text, { err = false, url = "", ms = 5000 } = {}) {
    const t = $("#toast");
    t.className = "toast" + (err ? " err" : "");
    t.textContent = text;
    if (url) {
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.textContent = "Open";
      t.append(a);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  async function sendTo(dest, rec = S.rec, level = S.level, quiet = false) {
    const label = out.DESTS.find((d) => d[0] === dest)[1];
    try {
      const r = await out.send(dest, rec, level);
      rec.sent = { ...(rec.sent || {}), [dest]: r.url || true };
      await store.put(rec);
      toast(dest === "file" ? `Saved to ${r.where}` : `Sent to ${r.where}`, { url: r.url });
      return true;
    } catch (e) {
      toast(`${label}: ${e.message}`, { err: true, ms: 8000 });
      return false;
    }
  }

  async function autoSend(rec, level) {
    const c = await out.settings();
    const ready = out.ready(c);
    for (const dest of c.auto || []) if (ready[dest] && dest !== "obsidian") await sendTo(dest, rec, level, true);
  }

  async function openMenu(id) {
    const menu = $(id);
    const was = !menu.hidden;
    closeMenus();
    if (was) return;
    if (id === "#menu-send") {
      const ready = out.ready(await out.settings());
      menu.innerHTML = out.DESTS
        .map(([k, label]) => `<button data-send="${k}"${ready[k] ? "" : ' data-setup="1"'}>${label}${ready[k] ? (S.rec.sent?.[k] ? "<small>sent</small>" : "") : "<small>set up</small>"}</button>`)
        .join("") + '<div class="sep"></div><button data-act="settings">Destinations and auto-send</button>';
    } else {
      menu.innerHTML =
        '<button data-dl="md">Notes as Markdown<small>.md</small></button><button data-dl="txt">Notes as plain text<small>.txt</small></button>' +
        (S.rec.blocks?.length ? '<div class="sep"></div><button data-dl="t-txt">Transcript<small>.txt</small></button>' + (cap.timed(S.rec.blocks) ? '<button data-dl="t-srt">Transcript with timings<small>.srt</small></button>' : "") : "");
    }
    menu.hidden = false;
  }
  const closeMenus = () => document.querySelectorAll(".menu").forEach((m) => (m.hidden = true));

  function downloadAs(kind) {
    const rec = S.rec, name = "Video Notes/" + out.safeName(rec.title);
    if (kind === "md") return out.download(name + ".md", out.markdown(rec, S.level), "text/markdown");
    if (kind === "txt") return out.download(name + ".txt", out.plain(rec, S.level));
    if (kind === "t-txt") return out.download(name + " transcript.txt", `${rec.title}\n${rec.url || ""}\n\n${cap.toText(rec.blocks)}\n`);
    if (kind === "t-srt") return out.download(name + ".srt", cap.toSrt(rec.blocks));
  }

  // ---------- library ----------
  async function renderLibrary() {
    const idx = await store.index();
    const q = $("#lib-search").value.trim().toLowerCase();
    const cats = [...new Set(idx.map((e) => e.category).filter(Boolean))].sort();
    if (S.libCat && !cats.includes(S.libCat)) S.libCat = "";
    $("#lib-cats").innerHTML = cats.length > 1
      ? [`<button data-cat="" class="${S.libCat ? "" : "on"}">All</button>`, ...cats.map((c) => `<button data-cat="${md.esc(c)}" class="${S.libCat === c ? "on" : ""}">${md.esc(c)}</button>`)].join("")
      : "";
    const list = idx.filter((e) =>
      (!S.libCat || e.category === S.libCat) &&
      (!q || [e.title, e.channel, e.site, e.category, ...(e.tags || [])].join(" ").toLowerCase().includes(q))
    );
    const box = $("#lib-list");
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = `<div class="lib-empty">${idx.length ? "Nothing matches." : "Notes you make are kept here, so you never pay for the same video twice."}</div>`;
      return;
    }
    for (const e of list) {
      const row = document.createElement("div");
      row.className = "lib-item";
      row.dataset.key = e.key;
      row.innerHTML = `<div class="thumb"></div><div class="vinfo"><div class="t"></div><div class="s"></div></div><button class="icon del" data-del="${md.esc(e.key)}">Delete</button>`;
      thumbInto(row.querySelector(".thumb"), e);
      row.querySelector(".t").textContent = e.title;
      row.querySelector(".s").textContent = [e.category, e.site, e.channel, new Date(e.updated).toLocaleDateString()].filter(Boolean).join(" · ");
      box.append(row);
    }
  }

  async function openFromLibrary(key) {
    const rec = await store.get(key);
    if (!rec) return;
    S.rec = rec;
    S.pinned = !(S.det && S.det.key === key);
    S.error = null; S.note = ""; S.askError = "";
    pickLevel();
    S.view = "notes";
    $("#library").hidden = true;
    render();
  }

  // ---------- pasted transcripts ----------
  async function usePasted() {
    const text = $("#paste-text").value;
    const segs = cap.parseAny(text);
    if (!segs.length) return toast("There's no text to use yet.", { err: true });
    const blocks = cap.toBlocks(/-->/.test(text) ? cap.dedupe(segs) : segs);
    const title = $("#paste-title").value.trim();
    let rec;
    if (S.pasteFor === "current" && S.rec) {
      rec = S.rec;
      if (title) rec.title = title;
    } else {
      rec = fresh({ key: "manual:" + Date.now().toString(36), kind: "manual", id: null, url: "", site: "Pasted", title: title || blocks[0].t.slice(0, 60) });
      S.pinned = true;
    }
    rec.blocks = blocks;
    rec.source = "Pasted transcript";
    rec.partial = false;
    await store.put(rec);
    S.rec = rec;
    S.error = null;
    $("#paste").hidden = true;
    $("#paste-text").value = "";
    S.view = "notes";
    render();
  }

  function openPaste(forCurrent) {
    S.pasteFor = forCurrent ? "current" : "new";
    $("#paste-title").value = forCurrent && S.rec ? S.rec.title : "";
    $("#paste").hidden = false;
    $("#paste-text").focus();
  }

  // ---------- events ----------
  async function seek(t) {
    if (linked()) {
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: S.tabId, frameIds: [S.det.frameId] },
          func: (x) => globalThis.__vn?.seek(x) ?? false,
          args: [t],
        });
        if (r?.result) return;
      } catch {}
    }
    const u = md.urlAt(S.rec, t);
    if (u) chrome.tabs.create({ url: u });
    else toast("This note isn't linked to a video you can jump around in.");
  }

  document.addEventListener("click", async (e) => {
    const el = e.target;
    if (!el.closest(".menu-wrap")) closeMenus();

    const ts = el.closest("a.ts");
    if (ts) { e.preventDefault(); return seek(Number(ts.dataset.t)); }
    const line = el.closest(".line[data-t]");
    if (line) return seek(Number(line.dataset.t));

    const pt = el.closest(".askpt");
    if (pt) {
      const text = pt.parentElement.querySelector(".pt").textContent.replace(/\s*\d{1,2}:\d{2}(:\d{2})?\s*$/, "").trim();
      S.view = "ask";
      render();
      return ask(`Explain this point in more detail: "${text}"`);
    }

    const view = el.closest("#tabs button")?.dataset.view;
    if (view) { S.view = view; return render(); }

    const level = el.closest("#levels button")?.dataset.level;
    if (level && !S.busy) { S.level = level; S.error = null; S.note = ""; return render(); }

    const sg = el.closest("[data-suggest]");
    if (sg) return ask(SUGGEST[Number(sg.dataset.suggest)][1]);

    const send = el.closest("[data-send]");
    if (send) {
      closeMenus();
      if (send.dataset.setup) return chrome.runtime.openOptionsPage();
      toast(`Sending to ${send.firstChild.textContent}`, { ms: 20000 });
      return sendTo(send.dataset.send);
    }
    const dl = el.closest("[data-dl]");
    if (dl) { closeMenus(); await downloadAs(dl.dataset.dl); return toast("Saved to Downloads/Video Notes"); }

    const cat = el.closest("[data-cat]");
    if (cat) { S.libCat = cat.dataset.cat; return renderLibrary(); }
    const del = el.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      if (del.dataset.sure) {
        await store.remove(del.dataset.del);
        if (S.rec?.key === del.dataset.del) { S.rec = null; S.pinned = false; refresh(); }
        return renderLibrary();
      }
      del.dataset.sure = "1";
      del.textContent = "Really delete?";
      return;
    }
    const item = el.closest(".lib-item");
    if (item) return openFromLibrary(item.dataset.key);
    if (el.closest("[data-close]")) return (el.closest(".sheet").hidden = true);

    const act = el.closest("[data-act]")?.dataset.act;
    if (act === "settings") return chrome.runtime.openOptionsPage();
    if (act === "unpin") { S.pinned = false; S.rec = null; return refresh(); }
    if (act === "paste-current") return openPaste(true);
    if (act === "chat-clear") { S.rec.chat = []; S.askError = ""; await store.put(S.rec); return render(); }
    if (act === "t-copy") { await navigator.clipboard.writeText(cap.toText(S.rec.blocks)); return toast("Transcript copied"); }
    if (act === "t-txt" || act === "t-srt") { await downloadAs(act); return toast("Saved to Downloads/Video Notes"); }

    switch (el.id) {
      case "btn-make": return S.busy === "notes" ? S.abort?.abort() : makeNotes();
      case "btn-copy": await navigator.clipboard.writeText(out.markdown(S.rec, S.level)); return toast("Notes copied as Markdown");
      case "btn-download": return openMenu("#menu-download");
      case "btn-send": return openMenu("#menu-send");
      case "btn-settings": return chrome.runtime.openOptionsPage();
      case "btn-library": $("#library").hidden = false; return renderLibrary();
      case "btn-rescan": return refresh();
      case "btn-paste": return openPaste(false);
      case "paste-go": return usePasted();
    }
  });

  $("#ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (S.busy === "ask") return S.abort?.abort();
    const input = $("#ask-input");
    const text = input.value;
    input.value = "";
    input.style.height = "";
    ask(text);
  });
  $("#ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#ask-form").requestSubmit(); }
  });
  $("#ask-input").addEventListener("input", (e) => {
    e.target.style.height = "";
    e.target.style.height = Math.min(e.target.scrollHeight + 2, 120) + "px";
  });

  let searchTimer = null;
  $("#t-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => S.rec?.blocks?.length && paintLines(), 150);
  });
  $("#lib-search").addEventListener("input", renderLibrary);
  $("#paste-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("#paste-text").value = await f.text();
    if (!$("#paste-title").value) $("#paste-title").value = f.name.replace(/\.[^.]+$/, "");
    e.target.value = "";
  });

  // Follow the user around: new tab, new page, or YouTube moving to the next video.
  if (!fixedTab) chrome.tabs.onActivated.addListener(() => { S.pinned = false; schedule(300); });
  chrome.tabs.onUpdated.addListener((id, ch) => {
    if (id !== S.tabId && id !== fixedTab) return;
    if (ch.url) S.pinned = false;
    if (ch.url || ch.status === "complete" || ch.title) schedule(ch.url ? 900 : 500);
  });

  async function loadConfig() {
    S.cfg = await claude.config();
  }
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "session" && changes.autostart?.newValue) return autostart(changes.autostart.newValue);
    if (area !== "local") return;
    if (["apiKey", "model", "effort", "language", "level"].some((k) => k in changes)) {
      await loadConfig();
      if (!S.busy) render();
    }
  });

  // The YouTube button and the right-click menu ask for notes straight away.
  async function autostart(a) {
    if (!a || Date.now() - a.at > 8000) return;
    chrome.storage.session.remove("autostart");
    S.pinned = false;
    await refresh();
    if (S.rec && linked() && S.tabId === a.tabId && !hasNotes() && S.cfg.apiKey) { S.view = "notes"; makeNotes(); }
  }

  (async () => {
    await loadConfig();
    S.level = S.cfg.level;
    await refresh();
    const { autostart: a } = await chrome.storage.session.get("autostart");
    autostart(a);
  })();

  // Handy when poking at the panel from DevTools
  globalThis.__panel = { S, refresh, makeNotes, ask, sendTo };
})();
