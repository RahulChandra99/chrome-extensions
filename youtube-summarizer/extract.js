// Injected into every frame of the tab when the panel asks for it. Finds the
// video, reads whatever captions the page exposes, and lets the panel seek.
// Runs in the extension's isolated world, so it can't see page scripts.
(() => {
  if (globalThis.__vn) return;
  const { parseAny, parseJson3, parseTime, dedupe } = globalThis.VN.cap;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 8000, interval = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v && (!Array.isArray(v) || v.length)) return v;
      await sleep(interval);
    }
    return null;
  }

  // ---------- which video is this ----------
  function findVideos() {
    let vids = [...document.querySelectorAll("video")];
    if (!vids.length) {
      // some players keep the <video> inside a shadow root
      for (const el of document.querySelectorAll("*")) {
        if (el.shadowRoot) vids.push(...el.shadowRoot.querySelectorAll("video"));
        if (vids.length > 4) break;
      }
    }
    return vids
      .map((v) => {
        const r = v.getBoundingClientRect();
        return { v, area: Math.round(r.width * r.height), playing: !v.paused && !v.ended };
      })
      .filter((x) => x.area > 2500 || x.playing)
      .sort((a, b) => b.playing - a.playing || b.area - a.area);
  }
  const bestVideo = () =>
    document.querySelector("video.html5-main-video") || (findVideos()[0] || {}).v || document.querySelector("video");

  const meta = (sel) => document.querySelector(sel)?.getAttribute("content") || "";

  function site() {
    const h = location.hostname.replace(/^www\./, "");
    const p = location.pathname;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(h)) {
      const id =
        (p === "/watch" && new URLSearchParams(location.search).get("v")) ||
        (/^\/(?:shorts|embed|live)\/([\w-]{6,})/.exec(p) || [])[1] ||
        null;
      return { kind: "youtube", id };
    }
    if (h === "vimeo.com" || h === "player.vimeo.com") {
      const id = (/(?:^|\/)(\d{6,})(?:\/|$|\?)/.exec(p) || [])[1] || null;
      return { kind: "vimeo", id };
    }
    if (/(^|\.)twitch\.tv$/.test(h)) return { kind: "twitch", id: (/\/videos\/(\d+)/.exec(p) || [])[1] || null };
    return { kind: "html5", id: null };
  }

  function detect() {
    const s = site();
    const found = findVideos();
    const v = bestVideo();
    if (!v && !(s.kind !== "html5" && s.id)) return null;
    const dur = v && isFinite(v.duration) ? v.duration : 0;
    // YouTube doesn't refresh its og tags on in-app navigation, the tab title is the live one
    let title = (s.kind === "youtube" ? "" : meta('meta[property="og:title"]')) || document.title;
    title = title.replace(/^\(\d+\+?\)\s*/, "").replace(/\s+[-|–]\s+(YouTube|Vimeo|Twitch)$/i, "").replace(/ on Vimeo$/i, "").trim();
    let channel = "";
    if (s.kind === "youtube") {
      channel =
        document.querySelector("ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a")?.textContent.trim() ||
        document.querySelector('span[itemprop="author"] link[itemprop="name"]')?.getAttribute("content") || "";
    } else channel = meta('meta[name="author"]') || meta('meta[property="og:site_name"]');
    return {
      kind: s.kind,
      id: s.id,
      top: self === window.top,
      pageUrl: location.href,
      host: location.hostname.replace(/^www\./, ""),
      title,
      channel,
      duration: dur,
      live: !!v && v.duration === Infinity,
      thumb: s.kind === "youtube" && s.id ? `https://i.ytimg.com/vi/${s.id}/mqdefault.jpg` : meta('meta[property="og:image"]'),
      area: found[0]?.area || 0,
      playing: !!found[0]?.playing,
      tracks: v ? v.querySelectorAll("track").length + (v.textTracks ? v.textTracks.length : 0) : 0,
    };
  }

  // ---------- YouTube ----------
  // Pull a JSON object literal that follows `marker` out of a page's HTML.
  function jsonAfter(text, marker) {
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

  function pickTrack(tracks, prefer) {
    const code = (t) => (t.languageCode || t.lang || "").toLowerCase();
    const manual = (t) => t.kind !== "asr";
    for (const p of prefer) {
      const hit = tracks.find((t) => code(t).startsWith(p) && manual(t)) || tracks.find((t) => code(t).startsWith(p));
      if (hit) return hit;
    }
    return tracks.find(manual) || tracks[0];
  }

  // 1: the caption track listed in the player response. Fast, no UI side effects.
  async function ytCaptionTrack(pr, prefer) {
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return null;
    const track = pickTrack(tracks, prefer);
    try {
      const url = new URL(track.baseUrl, location.origin);
      url.searchParams.set("fmt", "json3");
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return null;
      const body = await res.text();
      if (!body.trim()) return null; // empty when YouTube wants a PO token
      const segments = parseJson3(JSON.parse(body));
      if (!segments.length) return null;
      const name = track.name?.simpleText || track.name?.runs?.map((r) => r.text).join("") || track.languageCode;
      return { segments, source: `YouTube captions, ${name}` };
    } catch {
      return null;
    }
  }

  // 2: the request YouTube's own transcript panel makes.
  function collect(node, key, out = []) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) { for (const n of node) collect(n, key, out); return out; }
    for (const k in node) {
      if (k === key) out.push(node[k]);
      else collect(node[k], key, out);
    }
    return out;
  }
  async function ytTranscriptApi(html) {
    try {
      const params = (/"getTranscriptEndpoint":\{"params":"([^"]+)"/.exec(html) || [])[1];
      const version = (/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1];
      if (!params || !version) return null;
      const res = await fetch("/youtubei/v1/get_transcript?prettyPrint=false", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: version } }, params: decodeURIComponent(params) }),
      });
      if (!res.ok) return null;
      const segments = collect(await res.json(), "transcriptSegmentRenderer")
        .map((s) => ({
          start: Number(s.startMs || 0) / 1000,
          text: (s.snippet?.runs || []).map((r) => r.text).join("").replace(/\s+/g, " ").trim() || s.snippet?.simpleText || "",
        }))
        .filter((s) => s.text);
      return segments.length ? { segments, source: "YouTube transcript" } : null;
    } catch {
      return null;
    }
  }

  // 3: open the "Show transcript" panel on the page and read it.
  const panelSegs = () => [...document.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model")];
  async function ytTranscriptPanel() {
    if (self !== window.top || location.pathname !== "/watch") return null;
    let els = panelSegs();
    let opened = false;
    if (!els.length) {
      opened = true;
      document.querySelector("ytd-watch-metadata #description-inline-expander #expand")?.click();
      await sleep(400);
      const btn =
        document.querySelector("ytd-video-description-transcript-section-renderer button") ||
        [...document.querySelectorAll("button")].find((b) =>
          /show transcript/i.test(`${b.textContent} ${b.getAttribute("aria-label") || ""}`)
        );
      if (!btn) return null;
      btn.click();
      els = await waitFor(panelSegs, 10000);
      if (!els) return null;
    }
    const tsRe = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
    const segments = els
      .map((el) => {
        const lines = el.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
        const ts = lines.find((l) => tsRe.test(l));
        const text = lines.filter((l) => l !== ts && !/^\d+\s+(hours?|minutes?|seconds?)/i.test(l)).join(" ").trim();
        return ts && text ? { start: parseTime(ts), text } : null;
      })
      .filter(Boolean);
    // Put the page back the way it was
    if (opened)
      document
        .querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #visibility-button button')
        ?.click();
    return segments.length ? { segments, source: "YouTube transcript" } : null;
  }

  async function youtube(id, prefer) {
    // Fetch the watch page fresh. The in-page player data goes stale after
    // YouTube's in-app navigation.
    let html = "";
    try {
      html = await (await fetch(`/watch?v=${encodeURIComponent(id)}`, { credentials: "include" })).text();
    } catch {}
    const pr = jsonAfter(html, "ytInitialPlayerResponse = ");
    const d = pr?.videoDetails || {};
    const got = (await ytCaptionTrack(pr, prefer)) || (await ytTranscriptApi(html)) || (await ytTranscriptPanel());
    const info = {
      title: d.title || "",
      channel: d.author || "",
      duration: Number(d.lengthSeconds) || 0,
      live: !!d.isLive,
    };
    if (!got) {
      const off = pr && !pr.captions;
      return {
        info,
        error: d.isLive
          ? "This stream is live, so there's no transcript yet. Try again once it has ended."
          : off
          ? "This video has no captions, so there's nothing to read."
          : self !== window.top || location.pathname !== "/watch"
          ? "Embedded YouTube players don't expose captions. Open this video on youtube.com and try again."
          : "Couldn't read this video's captions. Open YouTube's own transcript once (in the description, Show transcript) and try again.",
      };
    }
    return { ...got, info };
  }

  // ---------- any other site: <track> files and loaded cues ----------
  async function html5(prefer) {
    const v = bestVideo();
    if (!v) return { error: "No video found on this page." };
    const els = [...v.querySelectorAll("track")]
      .filter((t) => t.src && (!t.kind || /subtitles|captions/.test(t.kind)))
      .map((t) => ({ url: t.src, label: t.label || t.srclang || "captions", lang: t.srclang || "" }));
    const ordered = els.length ? [pickTrack(els, prefer), ...els].filter((t, i, a) => a.indexOf(t) === i) : [];

    for (const t of ordered) {
      try {
        const res = await fetch(t.url, { credentials: "include" });
        if (!res.ok) continue;
        const segments = parseAny(await res.text());
        if (segments.length) return { segments, source: `Captions, ${t.label}` };
      } catch {}
    }

    // Players that load captions through script (HLS, video.js) only expose cues.
    const tts = [...(v.textTracks || [])].filter((t) => /subtitles|captions/.test(t.kind));
    const want = tts.length ? [pickTrack(tts.map((t) => ({ t, lang: t.language, kind: t.kind })), prefer).t, ...tts] : [];
    for (const tt of want) {
      if (tt.mode === "disabled") tt.mode = "hidden";
      await waitFor(() => tt.cues && tt.cues.length, 1800, 150);
      const cues = [...(tt.cues || [])];
      if (!cues.length) continue;
      const segments = cues
        .map((c) => ({ start: c.startTime, end: c.endTime, text: (c.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }))
        .filter((s) => s.text);
      if (!segments.length) continue;
      const lastEnd = segments[segments.length - 1].end || 0;
      const partial = isFinite(v.duration) && v.duration > 120 && lastEnd < v.duration * 0.8;
      return { segments, partial, source: `Captions, ${tt.label || tt.language || "loaded cues"}` };
    }

    // Nothing readable here; hand the URLs to the panel, which isn't bound by the page's CORS.
    if (ordered.length) return { tracks: ordered };
    return { error: "none" };
  }

  async function extract(prefer = ["en"]) {
    const s = site();
    let out;
    if (s.kind === "youtube" && s.id) out = await youtube(s.id, prefer);
    else out = await html5(prefer);
    if (out.segments) out.segments = dedupe(out.segments.map((x) => ({ start: x.start, text: x.text })));
    return { kind: s.kind, id: s.id, ...out };
  }

  function seek(t) {
    const v = bestVideo();
    if (!v) return false;
    v.currentTime = t;
    v.play().catch(() => {});
    return true;
  }
  const time = () => {
    const v = bestVideo();
    return v ? v.currentTime : -1;
  };

  globalThis.__vn = { detect, extract, seek, time };
})();
