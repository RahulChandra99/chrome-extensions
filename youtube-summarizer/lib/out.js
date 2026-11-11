// Where notes can go once they're written: clipboard, a file, Notion, Obsidian,
// a webhook, or a companion link-saver extension.
(() => {
  const VN = (globalThis.VN = globalThis.VN || {});
  const { fmtTime } = VN.cap;

  const DESTS = [
    ["file", "File in Downloads"],
    ["notion", "Notion"],
    ["obsidian", "Obsidian"],
    ["hook", "Webhook"],
    ["saver", "Link saver"],
  ];
  const KEYS = ["notionToken", "notionParent", "notionBase", "obsVault", "obsFolder", "hookUrl", "saverId", "fileFormat", "auto"];
  const settings = () => chrome.storage.local.get(KEYS);

  // Which destinations are set up enough to use
  function ready(c) {
    return {
      file: true,
      notion: !!(c.notionToken && c.notionParent),
      obsidian: !!c.obsVault,
      hook: /^https?:\/\//.test(c.hookUrl || ""),
      saver: /^[a-p]{32}$/.test(c.saverId || ""),
    };
  }

  const safeName = (s) => (s || "Video notes").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 90) || "Video notes";
  const metaLine = (rec) => [rec.channel, rec.duration ? fmtTime(rec.duration) : "", rec.category].filter(Boolean).join(" · ");

  function markdown(rec, level) {
    const body = VN.md.withLinks(VN.md.splitMeta(rec.notes[level] || "").body, rec);
    const src = /^https?:/.test(rec.url || "") ? `[${rec.site || "Source"}](${rec.url})` : rec.site || "";
    const lines = [`# ${rec.title}`, "", [src, metaLine(rec)].filter(Boolean).join(" · ")];
    if (rec.tags?.length) lines.push("Tags: " + rec.tags.join(", "));
    lines.push("", body.trim(), "");
    return lines.join("\n");
  }

  function plain(rec, level) {
    const body = VN.md.toPlain(VN.md.splitMeta(rec.notes[level] || "").body);
    return [rec.title, metaLine(rec), /^https?:/.test(rec.url || "") ? rec.url : "", "", body, ""].filter((l, i) => l || i > 2).join("\n");
  }

  // Short version for places with a small note field
  function digest(rec, level, max = 1200) {
    const text = VN.md.toPlain(VN.md.splitMeta(rec.notes[level] || "").body);
    const tldr = /TL;DR\n([\s\S]*?)(?:\n\n|$)/.exec(text);
    const take = /KEY (?:TAKEAWAYS|POINTS)\n([\s\S]*?)(?:\n\n[A-Z]|$)/.exec(text);
    const out = [tldr && tldr[1].trim(), take && take[1].trim()].filter(Boolean).join("\n\n") || text;
    return out.length > max ? out.slice(0, max - 1).trimEnd() + "…" : out;
  }

  function download(name, text, type = "text/plain") {
    const url = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
    const done = () => setTimeout(() => URL.revokeObjectURL(url), 20000);
    return chrome.downloads.download({ url, filename: name, saveAs: false, conflictAction: "uniquify" }).finally(done);
  }

  async function file(rec, level, c) {
    const txt = c.fileFormat === "txt";
    const name = `Video Notes/${safeName(rec.title)}.${txt ? "txt" : "md"}`;
    await download(name, txt ? plain(rec, level) : markdown(rec, level), txt ? "text/plain" : "text/markdown");
    return { where: `Downloads/${name}` };
  }

  // ---------- Notion ----------
  const notionId = (s) => {
    const m = (s || "").split("?")[0].replace(/-/g, "").match(/[0-9a-f]{32}/gi);
    return m ? m[m.length - 1] : "";
  };

  async function notion(rec, level, c) {
    const id = notionId(c.notionParent);
    if (!id) throw new Error("The Notion page link in settings doesn't contain a page ID.");
    const base = (c.notionBase || "https://api.notion.com") + "/v1";
    const headers = { Authorization: `Bearer ${c.notionToken}`, "Notion-Version": "2022-06-28", "content-type": "application/json" };
    const call = async (path, method, body) => {
      const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) throw new Error("Notion rejected the token. Check it in settings.");
        if (res.status === 404) throw new Error("Notion can't see that page. Share it with your integration (page menu, Connections).");
        throw new Error(`Notion error ${res.status}: ${json.message || "request failed"}`);
      }
      return json;
    };

    const title = [{ type: "text", text: { content: rec.title.slice(0, 1900) } }];
    let parent = { page_id: id };
    let properties = { title: { title } };
    // The link may point at a database. If so, fill the columns it has.
    const dbRes = await fetch(`${base}/databases/${id}`, { headers });
    if (dbRes.ok) {
      const db = await dbRes.json();
      parent = { database_id: id };
      properties = {};
      for (const [name, p] of Object.entries(db.properties || {})) {
        const n = name.toLowerCase();
        if (p.type === "title") properties[name] = { title };
        else if (p.type === "url" && /^https?:/.test(rec.url || "")) properties[name] = { url: rec.url };
        else if (p.type === "select" && /categor|topic|type/.test(n) && rec.category) properties[name] = { select: { name: rec.category.replace(/,/g, " ") } };
        else if (p.type === "multi_select" && /tag/.test(n) && rec.tags?.length) properties[name] = { multi_select: rec.tags.map((t) => ({ name: t.replace(/,/g, " ") })) };
        else if (p.type === "rich_text" && /channel|author|creator/.test(n) && rec.channel) properties[name] = { rich_text: [{ type: "text", text: { content: rec.channel } }] };
      }
    }

    const body = VN.md.splitMeta(rec.notes[level] || "").body;
    const head = [];
    const info = [];
    if (/^https?:/.test(rec.url || "")) info.push({ type: "text", text: { content: rec.site || "Source", link: { url: rec.url } } });
    const ml = metaLine(rec);
    if (ml) info.push({ type: "text", text: { content: (info.length ? " · " : "") + ml } });
    if (info.length) head.push({ object: "block", type: "paragraph", paragraph: { rich_text: info } });
    const blocks = [...head, ...VN.md.toNotion(body, rec)];

    // 100 blocks per request, so the first batch creates the page and the rest are appended.
    const page = await call("/pages", "POST", { parent, properties, children: blocks.slice(0, 80) });
    for (let i = 80; i < blocks.length; i += 80) {
      await call(`/blocks/${page.id}/children`, "PATCH", { children: blocks.slice(i, i + 80) });
    }
    return { where: "Notion", url: page.url };
  }

  async function notionTest(c) {
    const id = notionId(c.notionParent);
    if (!c.notionToken || !id) throw new Error("Add the token and the page link first.");
    const base = (c.notionBase || "https://api.notion.com") + "/v1";
    const headers = { Authorization: `Bearer ${c.notionToken}`, "Notion-Version": "2022-06-28" };
    for (const kind of ["pages", "databases"]) {
      const res = await fetch(`${base}/${kind}/${id}`, { headers });
      if (res.ok) return kind === "pages" ? "Connected. Notes will be added as sub-pages." : "Connected. Notes will be added as rows in this database.";
      if (res.status === 401) throw new Error("Notion rejected the token.");
    }
    throw new Error("Notion can't see that page. Share it with your integration (page menu, Connections).");
  }

  // ---------- Obsidian ----------
  // Uses the obsidian:// link. Long notes go through the clipboard because URLs have a size limit.
  async function obsidian(rec, level, c) {
    const md = markdown(rec, level);
    const path = (c.obsFolder ? c.obsFolder.replace(/^\/|\/$/g, "") + "/" : "") + safeName(rec.title);
    let url = `obsidian://new?vault=${encodeURIComponent(c.obsVault)}&file=${encodeURIComponent(path)}`;
    if (md.length < 1500) url += `&content=${encodeURIComponent(md)}`;
    else {
      await navigator.clipboard.writeText(md);
      url += "&clipboard=true";
    }
    const a = document.createElement("a");
    a.href = url;
    a.click();
    return { where: "Obsidian" };
  }

  async function hook(rec, level, c) {
    const res = await fetch(c.hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: rec.title, url: rec.url, site: rec.site, channel: rec.channel, duration: rec.duration,
        category: rec.category || "", tags: rec.tags || [], level,
        markdown: markdown(rec, level), text: plain(rec, level), created: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`The webhook answered ${res.status}.`);
    return { where: "Webhook" };
  }

  // Another extension that saves links can take the video plus a short note.
  async function saver(rec, level, c) {
    if (!/^https?:/.test(rec.url || "")) throw new Error("This note has no web link to save.");
    let reply;
    try {
      reply = await chrome.runtime.sendMessage(c.saverId, {
        type: "vn-save",
        url: rec.url, title: rec.title, by: rec.channel, duration: rec.duration ? fmtTime(rec.duration) : "",
        image: rec.thumb || "", note: digest(rec, level),
      });
    } catch {
      throw new Error("The link saver extension didn't answer. Check its ID in settings and that it's turned on.");
    }
    if (!reply?.ok) throw new Error(reply?.error || "The link saver refused the note.");
    return { where: reply.where || "Link saver" };
  }

  const SEND = { file, notion, obsidian, hook, saver };
  async function send(dest, rec, level) {
    const c = await settings();
    if (!ready(c)[dest]) throw new Error("Set this destination up in settings first.");
    return SEND[dest](rec, level, c);
  }

  VN.out = { DESTS, settings, ready, send, markdown, plain, digest, download, safeName, notionTest, notionId };
})();
