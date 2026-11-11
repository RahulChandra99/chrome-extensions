// Markdown in, three things out: HTML for the panel, Notion blocks, and plain text.
// Only handles what the notes prompt asks the model to write.
(() => {
  const VN = (globalThis.VN = globalThis.VN || {});
  const { parseTime } = VN.cap;

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const INLINE = /\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|`([^`]+)`|\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g;
  function tokens(text) {
    const out = [];
    let last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      if (m[1] != null) out.push({ text: m[1], bold: true });
      else if (m[2] != null) out.push({ text: m[2], italic: true });
      else if (m[3] != null) out.push({ text: m[3], code: true });
      else out.push({ text: m[4], ts: parseTime(m[4]) });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  const inlineHtml = (text) =>
    tokens(text)
      .map((t) =>
        t.ts != null ? `<a class="ts" data-t="${t.ts}">${t.text}</a>`
        : t.bold ? `<strong>${esc(t.text)}</strong>`
        : t.italic ? `<em>${esc(t.text)}</em>`
        : t.code ? `<code>${esc(t.text)}</code>`
        : esc(t.text)
      )
      .join("");

  // The notes start with one line of metadata: "Category: X | Tags: a, b, c"
  function splitMeta(md) {
    const m = /^\s*>?\s*\**Category\**:\s*([^|\n]+?)\s*(?:\|\s*\**Tags\**:\s*([^\n]*))?\n/i.exec(md);
    if (!m) return { category: "", tags: [], body: md };
    return {
      category: m[1].replace(/\*/g, "").trim(),
      tags: (m[2] || "").split(",").map((t) => t.replace(/[*#]/g, "").trim()).filter(Boolean).slice(0, 6),
      body: md.slice(m[0].length).replace(/^\s*\n/, ""),
    };
  }

  // Line-level structure shared by every output.
  function parse(md) {
    const nodes = [];
    for (const raw of md.split("\n")) {
      const line = raw.replace(/\t/g, "    ");
      if (!line.trim()) { nodes.push({ type: "gap" }); continue; }
      let m;
      if ((m = /^(\s*)([-*•]|(\d+)[.)])\s+(.*)$/.exec(line)))
        nodes.push({ type: "li", indent: m[1].length, ordered: !!m[3], num: m[3], text: m[4] });
      else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) nodes.push({ type: "h", level: m[1].length, text: m[2].replace(/\s*#+$/, "") });
      else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) nodes.push({ type: "hr" });
      else if ((m = /^\s*>\s?(.*)$/.exec(line))) nodes.push({ type: "quote", text: m[1] });
      else nodes.push({ type: "p", text: line.trim() });
    }
    return nodes;
  }

  function render(md, { ask = false } = {}) {
    const out = [];
    const stack = [];
    const closeTo = (indent) => { while (stack.length && stack[stack.length - 1].indent > indent) out.push(`</li></${stack.pop().tag}>`); };
    const closeAll = () => closeTo(-1);
    const askBtn = ask ? '<button class="askpt" title="Ask about this point" aria-label="Ask about this point">?</button>' : "";
    for (const n of parse(md)) {
      if (n.type === "li") {
        const tag = n.ordered ? "ol" : "ul";
        closeTo(n.indent);
        const top = stack[stack.length - 1];
        if (top && top.indent === n.indent && top.tag === tag) out.push("</li><li>");
        else {
          if (top && top.indent === n.indent) out.push(`</li></${stack.pop().tag}>`);
          out.push(`<${tag}${n.ordered && n.num !== "1" ? ` start="${n.num}"` : ""}><li>`);
          stack.push({ tag, indent: n.indent });
        }
        out.push(`<span class="pt">${inlineHtml(n.text)}</span>${askBtn}`);
        continue;
      }
      if (n.type === "gap") { closeAll(); continue; }
      closeAll();
      if (n.type === "h") out.push(n.level <= 2 ? `<h3>${inlineHtml(n.text)}</h3>` : `<h4>${inlineHtml(n.text)}</h4>`);
      else if (n.type === "hr") out.push("<hr>");
      else if (n.type === "quote") out.push(`<blockquote>${inlineHtml(n.text)}</blockquote>`);
      else out.push(`<p>${inlineHtml(n.text)}</p>`);
    }
    closeAll();
    return out.join("");
  }

  // Where a timestamp should point for a given saved video.
  function urlAt(rec, t) {
    t = Math.floor(t);
    if (rec.kind === "youtube" && rec.id) return `https://www.youtube.com/watch?v=${rec.id}&t=${t}s`;
    if (rec.kind === "vimeo" && rec.id) return `https://vimeo.com/${rec.id}#t=${t}s`;
    if (rec.kind === "twitch" && rec.id) return `https://www.twitch.tv/videos/${rec.id}?t=${t}s`;
    if (!/^https?:/.test(rec.url || "")) return "";
    return rec.url.split("#")[0] + `#t=${t}`;
  }

  const TS = /\[((?:\d{1,2}:)?\d{1,2}:\d{2})\](?!\()/g;
  const withLinks = (md, rec) =>
    md.replace(TS, (all, t) => {
      const u = urlAt(rec, parseTime(t));
      return u ? `[${t}](${u})` : all;
    });

  function toPlain(md) {
    return parse(md)
      .map((n) =>
        n.type === "gap" ? ""
        : n.type === "hr" ? "----"
        : n.type === "h" ? "\n" + strip(n.text).toUpperCase()
        : n.type === "li" ? " ".repeat(n.indent) + (n.ordered ? `${n.num}. ` : "- ") + strip(n.text)
        : strip(n.text)
      )
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  const strip = (s) => tokens(s).map((t) => (t.ts != null ? `[${t.text}]` : t.text)).join("");

  // ---------- Notion ----------
  function rich(text, rec) {
    const out = [];
    for (const t of tokens(text)) {
      const link = t.ts != null ? urlAt(rec, t.ts) : "";
      const content = t.ts != null ? t.text : t.text;
      for (let i = 0; i < content.length; i += 1900) {
        const item = { type: "text", text: { content: content.slice(i, i + 1900) } };
        if (link) item.text.link = { url: link };
        const a = {};
        if (t.bold) a.bold = true;
        if (t.italic) a.italic = true;
        if (t.code || t.ts != null) a.code = !link && true;
        if (Object.values(a).some(Boolean)) item.annotations = a;
        out.push(item);
      }
    }
    return out.slice(0, 100);
  }

  function toNotion(md, rec) {
    const blocks = [];
    const path = []; // open list items: { indent, block }
    const mk = (type, text, extra = {}) => ({ object: "block", type, [type]: { rich_text: rich(text, rec), ...extra } });
    for (const n of parse(md)) {
      if (n.type === "li") {
        const b = mk(n.ordered ? "numbered_list_item" : "bulleted_list_item", n.text);
        while (path.length && path[path.length - 1].indent >= n.indent) path.pop();
        // Notion takes two levels of children per request; deeper points sit at level three.
        while (path.length > 2) path.pop();
        const parent = path[path.length - 1];
        if (parent) {
          const body = parent.block[parent.block.type];
          (body.children = body.children || []).push(b);
        } else blocks.push(b);
        path.push({ indent: n.indent, block: b });
        continue;
      }
      path.length = 0;
      if (n.type === "h") blocks.push(mk(n.level <= 1 ? "heading_1" : n.level === 2 ? "heading_2" : "heading_3", n.text));
      else if (n.type === "hr") blocks.push({ object: "block", type: "divider", divider: {} });
      else if (n.type === "quote") blocks.push(mk("quote", n.text));
      else if (n.type === "p") blocks.push(mk("paragraph", n.text));
    }
    return blocks;
  }

  VN.md = { esc, tokens, splitMeta, parse, render, urlAt, withLinks, toPlain, toNotion };
})();
