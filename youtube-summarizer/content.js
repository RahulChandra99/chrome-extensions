// Content script: grabs the transcript of the current YouTube video, asks the
// background worker to summarize it, and renders the result in a side panel.
(() => {
  const PANEL_ID = "yts-panel";
  const cache = new Map(); // videoId -> summary markdown (this tab only)
  let currentPort = null;

  // ---------- small helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 10000, interval = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v && (!Array.isArray(v) || v.length)) return v;
      await sleep(interval);
    }
    return null;
  }

  const getVideoId = () =>
    location.pathname === "/watch" ? new URL(location.href).searchParams.get("v") : null;

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  const parseTime = (str) => str.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);

  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Pull a JSON object literal that follows `marker` out of a page's HTML.
  function extractJsonAfter(text, marker) {
    const i = text.indexOf(marker);
    if (i < 0) return null;
    const start = text.indexOf("{", i);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, j + 1)); } catch { return null; }
      }
    }
    return null;
  }

  // ---------- transcript extraction ----------
  // Fetch the watch page fresh: the in-page ytInitialPlayerResponse goes stale
  // after YouTube's in-app navigation.
  async function fetchPlayerResponse(videoId) {
    try {
      const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, { credentials: "include" });
      return extractJsonAfter(await res.text(), "ytInitialPlayerResponse = ");
    } catch {
      return null;
    }
  }

  function pickTrack(tracks) {
    const en = (t) => (t.languageCode || "").startsWith("en");
    const manual = (t) => t.kind !== "asr";
    return (
      tracks.find((t) => en(t) && manual(t)) ||
      tracks.find(en) ||
      tracks.find(manual) ||
      tracks[0]
    );
  }

  // Method 1: the caption track API (fast, no UI side effects).
  async function transcriptFromCaptionTrack(pr) {
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return null;
    const track = pickTrack(tracks);
    try {
      const url = new URL(track.baseUrl, location.origin);
      url.searchParams.set("fmt", "json3");
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return null;
      const body = await res.text();
      if (!body.trim()) return null; // YouTube sometimes returns empty without a PO token
      const data = JSON.parse(body);
      const segments = (data.events || [])
        .filter((e) => e.segs)
        .map((e) => ({
          start: (e.tStartMs || 0) / 1000,
          text: e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim(),
        }))
        .filter((s) => s.text);
      return segments.length ? segments : null;
    } catch {
      return null;
    }
  }

  // Method 2: open YouTube's own "Show transcript" panel and read it.
  const querySegments = () =>
    [...document.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model")];

  async function transcriptFromPanel() {
    let els = querySegments();
    if (!els.length) {
      document.querySelector("ytd-watch-metadata #description-inline-expander #expand")?.click();
      await sleep(400);
      const btn =
        document.querySelector("ytd-video-description-transcript-section-renderer button") ||
        [...document.querySelectorAll("button")].find((b) =>
          /show transcript/i.test(`${b.textContent} ${b.getAttribute("aria-label") || ""}`)
        );
      if (!btn) return null;
      btn.click();
      els = await waitFor(querySegments, 10000);
      if (!els) return null;
    }
    const tsRe = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
    const segments = els
      .map((el) => {
        const lines = el.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
        const ts = lines.find((l) => tsRe.test(l));
        const text = lines
          .filter((l) => l !== ts && !/^\d+\s+(hours?|minutes?|seconds?)/i.test(l))
          .join(" ")
          .trim();
        return ts && text ? { start: parseTime(ts), text } : null;
      })
      .filter(Boolean);
    return segments.length ? segments : null;
  }

  // Group tiny caption fragments into ~20s blocks so each line carries a timestamp
  // without wasting tokens. No text is dropped.
  function toTimestampedText(segments) {
    const blocks = [];
    let cur = null;
    for (const s of segments) {
      if (!cur || s.start - cur.start > 20 || cur.text.length > 400) {
        cur = { start: s.start, text: s.text };
        blocks.push(cur);
      } else {
        cur.text += " " + s.text;
      }
    }
    return blocks.map((b) => `[${fmtTime(b.start)}] ${b.text}`).join("\n");
  }

  async function getTranscript(videoId) {
    const pr = await fetchPlayerResponse(videoId);
    const details = pr?.videoDetails || {};
    const segments = (await transcriptFromCaptionTrack(pr)) || (await transcriptFromPanel());
    if (!segments) throw new Error("No transcript is available for this video (captions are off or disabled by the creator).");
    return {
      title: details.title || document.title.replace(/ - YouTube$/, ""),
      channel: details.author || "",
      duration: details.lengthSeconds ? fmtTime(Number(details.lengthSeconds)) : "",
      transcript: toTimestampedText(segments),
      lineCount: segments.length,
    };
  }

  // ---------- markdown rendering (headings, nested bullet + numbered lists) ----------
  function inline(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g, (_, t) => `<a class="yts-ts" data-t="${parseTime(t)}">${t}</a>`);
  }

  function renderMarkdown(md) {
    const out = [];
    const stack = []; // open lists: { type, indent }
    const closeAll = () => { while (stack.length) out.push(`</li></${stack.pop().type}>`); };

    for (const rawLine of md.split("\n")) {
      const line = rawLine.replace(/\t/g, "    ");
      const li = /^(\s*)([-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
      if (li) {
        const indent = li[1].length;
        const type = li[3] ? "ol" : "ul";
        while (stack.length && stack[stack.length - 1].indent > indent) out.push(`</li></${stack.pop().type}>`);
        const top = stack[stack.length - 1];
        if (top && top.indent === indent && top.type === type) {
          out.push("</li><li>");
        } else {
          if (top && top.indent === indent) out.push(`</li></${stack.pop().type}>`);
          const start = type === "ol" && li[3] !== "1" ? ` start="${li[3]}"` : "";
          out.push(`<${type}${start}><li>`);
          stack.push({ type, indent });
        }
        out.push(inline(li[4]));
        continue;
      }
      if (!line.trim()) { closeAll(); continue; }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      closeAll();
      if (h) out.push(h[1].length <= 2 ? `<h3>${inline(h[2])}</h3>` : `<h4>${inline(h[2])}</h4>`);
      else out.push(`<p>${inline(line.trim())}</p>`);
    }
    closeAll();
    return out.join("");
  }

  // ---------- panel UI ----------
  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="yts-header">
        <span class="yts-title">Video Summary</span>
        <div class="yts-actions">
          <button class="yts-btn yts-primary" data-act="summarize">Summarize</button>
          <button class="yts-btn" data-act="copy" hidden>Copy</button>
          <button class="yts-btn" data-act="collapse" title="Collapse">–</button>
        </div>
      </div>
      <div class="yts-status"></div>
      <div class="yts-body"></div>`;

    panel.addEventListener("click", (e) => {
      const ts = e.target.closest(".yts-ts");
      if (ts) {
        const video = document.querySelector("video.html5-main-video, video");
        if (video) { video.currentTime = Number(ts.dataset.t); video.play(); }
        return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "summarize") runSummary(cache.has(getVideoId()));
      else if (act === "copy") copySummary(e.target);
      else if (act === "collapse") {
        panel.classList.toggle("yts-collapsed");
        e.target.textContent = panel.classList.contains("yts-collapsed") ? "+" : "–";
      } else if (act === "options") chrome.runtime.sendMessage({ type: "openOptions" });
    });
    return panel;
  }

  const $ = (sel) => document.querySelector(`#${PANEL_ID} ${sel}`);

  function setStatus(text, isError = false, html = false) {
    const el = $(".yts-status");
    if (!el) return;
    el.classList.toggle("yts-error", isError);
    if (html) el.innerHTML = text; else el.textContent = text;
  }

  function showSummary(md) {
    const body = $(".yts-body");
    if (body) body.innerHTML = renderMarkdown(md);
  }

  function setBusy(busy, hasSummary) {
    const btn = $('[data-act="summarize"]');
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? "Working…" : hasSummary ? "Regenerate" : "Summarize";
    }
    const copy = $('[data-act="copy"]');
    if (copy) copy.hidden = !hasSummary || busy;
  }

  async function copySummary(btn) {
    const md = cache.get(getVideoId());
    if (!md) return;
    await navigator.clipboard.writeText(md);
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  }

  let renderQueued = false;
  function scheduleRender(getMd) {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; showSummary(getMd()); });
  }

  async function runSummary(force = false) {
    const videoId = getVideoId();
    if (!videoId) return;
    if (!force && cache.has(videoId)) { showSummary(cache.get(videoId)); return; }

    currentPort?.disconnect();
    currentPort = null;
    setBusy(true, false);
    $(".yts-body").innerHTML = "";
    setStatus("Reading transcript…");

    let t;
    try {
      t = await getTranscript(videoId);
    } catch (err) {
      if (getVideoId() === videoId) { setStatus(err.message, true); setBusy(false, false); }
      return;
    }
    if (getVideoId() !== videoId) return; // user navigated away

    setStatus(`Summarizing ${t.lineCount} transcript lines…`);
    const port = chrome.runtime.connect({ name: "summarize" });
    currentPort = port;
    let md = "";

    port.onMessage.addListener((msg) => {
      if (currentPort !== port) return;
      if (msg.type === "chunk") {
        md += msg.text;
        setStatus("Writing summary…");
        scheduleRender(() => md);
      } else if (msg.type === "done") {
        showSummary(md);
        cache.set(videoId, md);
        setStatus(msg.note || "");
        setBusy(false, true);
        port.disconnect();
        currentPort = null;
      } else if (msg.type === "error") {
        if (msg.code === "no_key") {
          setStatus('No API key set. <a href="#" data-act="options">Open settings</a> to add your Anthropic API key.', true, true);
        } else {
          setStatus(msg.message, true);
        }
        setBusy(false, false);
        currentPort = null;
      }
    });
    port.onDisconnect.addListener(() => {
      if (currentPort === port) { setStatus("Connection to the extension was lost. Try again.", true); setBusy(false, false); currentPort = null; }
    });

    port.postMessage({ type: "start", ...t });
  }

  // ---------- mounting & YouTube SPA navigation ----------
  async function mountPanel(videoId) {
    const anchor = await waitFor(
      () => document.querySelector("#secondary-inner") || document.querySelector("#secondary") || document.querySelector("#below"),
      15000
    );
    if (!anchor || getVideoId() !== videoId) return;

    let panel = document.getElementById(PANEL_ID);
    if (!panel) panel = buildPanel();
    if (panel.parentElement !== anchor) anchor.prepend(panel);

    const cached = cache.get(videoId);
    $(".yts-body").innerHTML = cached ? renderMarkdown(cached) : "";
    setStatus(cached ? "" : "Click Summarize to summarize this video from its transcript.");
    setBusy(false, !!cached);
  }

  function onNavigate() {
    currentPort?.disconnect();
    currentPort = null;
    const id = getVideoId();
    if (!id) { document.getElementById(PANEL_ID)?.remove(); return; }
    mountPanel(id);
  }

  document.addEventListener("yt-navigate-finish", onNavigate);
  onNavigate();
})();
