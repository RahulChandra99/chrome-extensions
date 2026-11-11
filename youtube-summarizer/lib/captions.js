// Caption parsing and time helpers. Loaded both in the panel and inside pages,
// so it only attaches to a shared namespace and touches nothing else.
(() => {
  const VN = (globalThis.VN = globalThis.VN || {});

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  // "1:02:03", "02:03.500", "00:02:03,500" or "123.4s" -> seconds
  function parseTime(str) {
    str = String(str).trim();
    const unit = /^([\d.]+)(h|m|s|ms)$/.exec(str);
    if (unit) return Number(unit[1]) * { h: 3600, m: 60, s: 1, ms: 0.001 }[unit[2]];
    return str.replace(",", ".").split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
  }

  const decode = (s) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

  const clean = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\{\\[^}]*\}/g, "").replace(/\s+/g, " ").trim();

  // WebVTT and SubRip share the "start --> end" cue line, so one parser reads both.
  function parseCues(text) {
    const out = [];
    const lines = text.replace(/\r/g, "").split("\n");
    const cue = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
    for (let i = 0; i < lines.length; i++) {
      const m = cue.exec(lines[i]);
      if (!m) continue;
      const buf = [];
      while (++i < lines.length && lines[i].trim() && !cue.test(lines[i])) buf.push(lines[i]);
      if (i < lines.length && cue.test(lines[i])) i--;
      const t = clean(buf.join(" "));
      if (t) out.push({ start: parseTime(m[1]), end: parseTime(m[2]), text: t });
    }
    return out;
  }

  // TTML / DFXP / SRV1-style XML: any element carrying a begin or start attribute.
  function parseXml(text) {
    const out = [];
    const re = /<(p|text|span)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(text))) {
      const a = /\b(?:begin|start|t)="([^"]+)"/.exec(m[2]);
      if (!a) continue;
      const t = clean(m[3].replace(/<br\s*\/?>/g, " "));
      const raw = a[1];
      const start = /\bt="/.test(m[2]) && /^\d+$/.test(raw) ? Number(raw) / 1000 : parseTime(raw);
      if (t && isFinite(start)) out.push({ start, text: t });
    }
    return out;
  }

  // YouTube's json3 caption format
  function parseJson3(data) {
    return (data.events || [])
      .filter((e) => e.segs)
      .map((e) => ({ start: (e.tStartMs || 0) / 1000, text: e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim() }))
      .filter((s) => s.text);
  }

  // Plain text with optional leading timestamps, for pasted transcripts.
  function parsePlain(text) {
    const out = [];
    const ts = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*[-–:]?\s*(.*)$/;
    let last = null;
    for (const line of text.replace(/\r/g, "").split("\n")) {
      if (!line.trim()) continue;
      const m = ts.exec(line);
      if (m) {
        last = { start: parseTime(m[1]), text: m[2].trim() };
        out.push(last);
      } else if (last && !last.text) last.text = line.trim();
      else if (last && out.some((s) => s.start > 0)) last.text += " " + line.trim();
      else out.push((last = { start: -1, text: line.trim() }));
    }
    return out.filter((s) => s.text);
  }

  function parseAny(text) {
    const t = (text || "").trim();
    if (!t) return [];
    if (t[0] === "{") { try { return parseJson3(JSON.parse(t)); } catch {} }
    if (/-->/.test(t)) return parseCues(t);
    if (/^<\?xml|<tt[\s>]|<transcript|<timedtext/i.test(t)) return parseXml(t);
    return parsePlain(t);
  }

  // Live and auto captions repeat: each cue re-sends the previous line plus a few new
  // words. Keep only what's new so the transcript isn't three copies of itself.
  function dedupe(segs) {
    const out = [];
    let prev = "";
    for (const s of segs) {
      let text = s.text;
      if (!text) continue;
      if (text === prev) continue;
      if (prev && text.startsWith(prev)) text = text.slice(prev.length).trim();
      else if (prev) {
        const max = Math.min(prev.length, text.length);
        for (let n = max; n > 8; n--) {
          if (prev.endsWith(text.slice(0, n))) { text = text.slice(n).trim(); break; }
        }
      }
      prev = s.text;
      if (text) out.push({ start: s.start, text });
    }
    return out;
  }

  // Merge caption fragments into blocks of about `span` seconds. No text is dropped.
  function toBlocks(segs, span = 20) {
    const blocks = [];
    let cur = null;
    for (const s of segs) {
      if (!cur || s.start < 0 || s.start - cur.s > span || cur.t.length > 420) {
        cur = { s: s.start, t: s.text };
        blocks.push(cur);
      } else cur.t += " " + s.text;
    }
    return blocks;
  }

  const timed = (blocks) => blocks.some((b) => b.s > 0);
  const toPrompt = (blocks) => blocks.map((b) => (b.s >= 0 ? `[${fmtTime(b.s)}] ${b.t}` : b.t)).join("\n");
  const toText = (blocks, stamps = true) =>
    blocks.map((b) => (stamps && b.s >= 0 ? `${fmtTime(b.s)}  ${b.t}` : b.t)).join("\n");

  function toSrt(blocks) {
    const f = (x) => {
      const ms = Math.round((x % 1) * 1000);
      const s = Math.floor(x);
      const p = (n, l = 2) => String(n).padStart(l, "0");
      return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)},${p(ms, 3)}`;
    };
    return blocks
      .filter((b) => b.s >= 0)
      .map((b, i, a) => `${i + 1}\n${f(b.s)} --> ${f(a[i + 1] ? a[i + 1].s : b.s + 5)}\n${b.t}\n`)
      .join("\n");
  }

  VN.cap = { fmtTime, parseTime, parseCues, parseXml, parseJson3, parsePlain, parseAny, dedupe, toBlocks, timed, toPrompt, toText, toSrt };
})();
