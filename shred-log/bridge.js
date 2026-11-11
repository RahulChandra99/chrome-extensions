/* Runs in every frame but only wakes up inside your Shred Log page (it carries a
   <meta name="shredlog-inbox"> tag). It passes links from the extension to the page and
   passes the page's replies back. It reads nothing else. */
(() => {
  if (window.__slBridge) return;
  const isShredLog = () => !!document.querySelector('meta[name="shredlog-inbox"]');

  function start() {
    if (window.__slBridge) return;
    window.__slBridge = true;
    const post = (ops) => { if (ops && ops.length) window.postMessage({ __shredlog: "ops", batch: Date.now().toString(36), ops }, "*"); };
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (e.source !== window || !d || typeof d !== "object") return;
      if (d.__shredlog === "hello") {
        chrome.runtime.sendMessage({ type: "sl-ready", mode: d.mode }).then((r) => post(r && r.ops)).catch(() => {});
      } else if (d.__shredlog === "done") {
        chrome.runtime.sendMessage({ type: "sl-done", res: d.res, mode: d.mode }).catch(() => {});
      }
    });
    chrome.runtime.onMessage.addListener((m, _s, reply) => {
      if (!m) return;
      if (m.type === "sl-deliver") { post(m.ops); reply({ ok: true }); }
      else if (m.type === "sl-go") { window.postMessage({ __shredlog: "go", view: m.view }, "*"); reply({ ok: true }); }
    });
    window.postMessage({ __shredlog: "ping" }, "*");
  }

  if (isShredLog()) return start();
  // the page may still be building itself: watch briefly, then give up
  // (only inside embedded frames, where Shred Log lives, so normal sites pay nothing)
  if (!document.documentElement || window.top === window) return;
  const obs = new MutationObserver(() => { if (isShredLog()) { obs.disconnect(); start(); } });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 15000);
})();
