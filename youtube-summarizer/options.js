const fields = ["apiKey", "effort", "language"];

chrome.storage.local.get(fields).then((vals) => {
  for (const f of fields) if (vals[f]) document.getElementById(f).value = vals[f];
});

document.getElementById("save").addEventListener("click", async () => {
  const vals = {};
  for (const f of fields) vals[f] = document.getElementById(f).value.trim();
  if (!vals.language) vals.language = "English";
  await chrome.storage.local.set(vals);
  const saved = document.getElementById("saved");
  saved.textContent = "Saved";
  setTimeout(() => (saved.textContent = ""), 1500);
});
