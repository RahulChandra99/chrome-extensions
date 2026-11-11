const FIELDS = ["apiKey", "model", "level", "effort", "language", "notionToken", "notionParent", "fileFormat", "obsVault", "obsFolder", "hookUrl", "saverId"];
const $ = (id) => document.getElementById(id);

$("model").innerHTML = VN.claude.MODELS.map(([id, name]) => `<option value="${id}">${name}</option>`).join("");
const modelNote = () => ($("model-note").textContent = VN.claude.MODELS.find((m) => m[0] === $("model").value)?.[2] || "");
$("model").addEventListener("change", modelNote);

function read() {
  const vals = {};
  for (const f of FIELDS) vals[f] = $(f).value.trim();
  if (!vals.language) vals.language = "English";
  vals.auto = [...document.querySelectorAll("[data-auto]")].filter((c) => c.checked).map((c) => c.dataset.auto);
  return vals;
}

chrome.storage.local.get([...FIELDS, "auto"]).then((vals) => {
  const d = { ...VN.claude.DEFAULTS, fileFormat: "md", ...vals };
  for (const f of FIELDS) if (d[f]) $(f).value = d[f];
  for (const c of document.querySelectorAll("[data-auto]")) c.checked = (vals.auto || []).includes(c.dataset.auto);
  modelNote();
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set(read());
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});

$("notion-test").addEventListener("click", async () => {
  const out = $("notion-result");
  out.textContent = "Checking";
  try {
    const hidden = await chrome.storage.local.get("notionBase");
    out.textContent = await VN.out.notionTest({ ...read(), ...hidden });
  } catch (e) {
    out.textContent = e.message;
  }
});
