const $ = (s) => document.querySelector(s);
const DEFAULTS = { shredUrl: "https://claude.ai/artifact/1zqUbP1qA6YGt9Zf4FBRrA", openPinned: true, autoSave: true, bmInbox: true, rules: [] };
let state = { ...DEFAULTS };
let flagT;

function flag(msg = "Saved") {
  const f = $("#savedFlag"); f.textContent = msg; f.classList.add("on");
  clearTimeout(flagT); flagT = setTimeout(() => f.classList.remove("on"), 1400);
}
async function persist(patch) {
  state = { ...state, ...patch };
  await chrome.storage.sync.set(patch);
  flag();
}

function catOptions(sel) {
  return SL.CATS.map(([k, l, e]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${e} ${l}</option>`).join("");
}
function renderRules() {
  const box = $("#rules");
  box.innerHTML = state.rules.map((r, i) => `<div class="rule" data-i="${i}">
      <input type="text" data-f="m" placeholder="website or word" aria-label="Website or word">
      <span class="arrow" aria-hidden="true">→</span>
      <select data-f="c" aria-label="Topic">${catOptions(r.c)}</select>
      <button type="button" class="x" data-del="${i}" aria-label="Remove rule" title="Remove">✕</button></div>`).join("");
  box.querySelectorAll(".rule").forEach((row, i) => { row.querySelector("input").value = state.rules[i].m || ""; });
}

$("#rules").addEventListener("change", (e) => {
  const row = e.target.closest(".rule"); if (!row) return;
  const i = +row.dataset.i, f = e.target.dataset.f;
  const rules = state.rules.slice(); rules[i] = { ...rules[i], [f]: e.target.value.trim() };
  persist({ rules });
});
$("#rules").addEventListener("click", (e) => {
  const d = e.target.closest("[data-del]"); if (!d) return;
  const rules = state.rules.filter((_, i) => i !== +d.dataset.del);
  persist({ rules }).then(renderRules);
});
$("#addRule").addEventListener("click", () => {
  state.rules = [...state.rules, { m: "", c: "other" }];
  renderRules();
  const inputs = document.querySelectorAll(".rule input"); inputs[inputs.length - 1].focus();
});

$("#shredUrl").addEventListener("change", (e) => {
  const v = e.target.value.trim();
  if (!/^https:\/\/claude\.ai\/(code\/)?artifact\//.test(v)) { flag("That should be a claude.ai/artifact/… link"); return; }
  persist({ shredUrl: v });
});
$("#testOpen").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open" }));
$("#openPinned").addEventListener("change", (e) => persist({ openPinned: e.target.checked }));
$("#autoSave").addEventListener("change", (e) => persist({ autoSave: e.target.checked }));
$("#bmInbox").addEventListener("change", (e) => persist({ bmInbox: e.target.checked }));
$("#makeFolder").addEventListener("click", async () => {
  if (!state.bmInbox) { $("#bmInbox").checked = true; await persist({ bmInbox: true }); }
  const id = await chrome.runtime.sendMessage({ type: "inbox-folder" });
  flag(id ? "📥 Shred Log is on your bookmarks bar" : "Couldn't add the folder");
});

async function tryIt() {
  const raw = $("#tryText").value.trim(); if (!raw) return;
  const m = raw.match(/https?:\/\/\S+/);
  const meta = { u: m ? m[0] : "https://example.com/", t: raw.replace(m ? m[0] : "", "").trim() };
  const r = SL.classify(meta, state.rules);
  const ci = SL.catInfo(r.c);
  const where = SL.isYouTubeVideo(meta.u) ? "Watch later" : "Saved links";
  $("#tryOut").innerHTML = `<span class="e">${ci[2]}</span><div><b></b><small></small></div>`;
  $("#tryOut b").textContent = `${ci[1]} · ${where}`;
  $("#tryOut small").textContent = r.why;
}
$("#tryBtn").addEventListener("click", tryIt);
$("#tryText").addEventListener("keydown", (e) => { if (e.key === "Enter") tryIt(); });

async function renderQueue() {
  const { queue = [], recent = [], lastSeen = 0, lastMode } = await chrome.storage.local.get(["queue", "recent", "lastSeen", "lastMode"]);
  const bits = [];
  bits.push(queue.length ? `⏳ ${queue.length} waiting to be delivered.` : "✓ Nothing waiting.");
  bits.push(`${recent.length} in the recent list.`);
  if (lastSeen) bits.push(lastMode === "local" ? "⚠️ Last time, your Shred Log wasn't signed in, so links saved on that device only." : `Last talked to your Shred Log ${new Date(lastSeen).toLocaleString()}.`);
  $("#queueInfo").textContent = bits.join(" ");
}
$("#retryAll").addEventListener("click", () => { chrome.runtime.sendMessage({ type: "deliver" }); flag("Sending…"); });
$("#clearRecent").addEventListener("click", async () => { await chrome.storage.local.set({ recent: [] }); renderQueue(); flag("Cleared"); });
chrome.storage.onChanged.addListener((_c, area) => { if (area === "local") renderQueue(); });

(async () => {
  state = { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
  $("#shredUrl").value = state.shredUrl;
  $("#openPinned").checked = !!state.openPinned;
  $("#autoSave").checked = !!state.autoSave;
  $("#bmInbox").checked = !!state.bmInbox;
  renderRules();
  renderQueue();
})();
