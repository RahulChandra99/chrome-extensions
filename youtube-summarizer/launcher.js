// A small button above YouTube's recommendations that opens the notes panel.
// The panel does the work; this only saves a trip to the toolbar.
(() => {
  const ID = "vn-launch";
  const onWatch = () => location.pathname === "/watch";

  async function mount() {
    document.getElementById(ID)?.remove();
    if (!onWatch()) return;
    let anchor = null;
    for (let i = 0; i < 60 && !anchor; i++) {
      anchor = document.querySelector("#secondary-inner") || document.querySelector("#secondary");
      if (!anchor) await new Promise((r) => setTimeout(r, 250));
    }
    if (!anchor || !onWatch() || document.getElementById(ID)) return;
    const btn = document.createElement("button");
    btn.id = ID;
    btn.type = "button";
    btn.innerHTML = '<span class="vn-mark"></span><span>Make notes from this video</span>';
    btn.addEventListener("click", () => {
      try { chrome.runtime.sendMessage({ type: "open-panel" }); } catch {}
    });
    anchor.prepend(btn);
  }

  document.addEventListener("yt-navigate-finish", mount);
  mount();
})();
