// Background service worker: calls the Claude API and streams the summary back
// to the content script over a long-lived port.
//
// Plain fetch is used instead of the Anthropic SDK so the extension loads
// unpacked with no build step.

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `You summarize YouTube videos from their transcripts. Accuracy is the top priority: the reader relies on your summary instead of watching the video.

Faithfulness rules:
- Use only what is said in the transcript. Do not add facts, opinions, background, or advice that the speaker did not give.
- Keep names, numbers, prices, dates, measurements, quotes, and recommendations exactly as stated. Do not round or generalize them.
- Keep the speaker's hedges: if they say "probably", "I think", or "rumored", say so.
- Captions may be auto-generated and contain misheard words. Correct only obvious mistakes; if a word is ambiguous, keep it and add "(?)".
- Cover every substantive point the video makes, in proportion to how much time the video spends on it. Skip filler, greetings, and like/subscribe requests.
- If there is a sponsor segment, mention it in one bullet only, under the last category.

Format (Markdown only, no preamble or closing remarks):
## TL;DR
2–3 sentences on what the video is about and its main conclusion.

Then 3–7 category sections. Name each heading after the video's actual topics (for example "## Battery Life" or "## Step 2: Mixing the Dough"), not generic labels like "Main Points".
- Use bullet points ("- ") for facts, ideas, arguments, and examples.
- Use numbered lists ("1. ") for anything with an order: steps, instructions, rankings, timelines.
- Use nested bullets (indent two spaces) for supporting details under a point.
- End each top-level bullet or numbered item with the timestamp where it is said, copied from the transcript, in square brackets, e.g. [3:42].
- Bold only the key term of a point, sparingly.

## Key Takeaways
A numbered list of the 3–7 most important points, each with a timestamp.`;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "openOptions") chrome.runtime.openOptionsPage();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "summarize") return;
  const controller = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => { open = false; controller.abort(); });
  const send = (m) => { if (open) port.postMessage(m); };

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "start") return;
    try {
      await summarize(msg, send, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) send({ type: "error", message: err.message || String(err) });
    }
  });
});

async function summarize(req, send, signal) {
  const { apiKey, effort = "medium", language = "English" } =
    await chrome.storage.local.get(["apiKey", "effort", "language"]);
  if (!apiKey) {
    send({ type: "error", code: "no_key", message: "No API key set." });
    return;
  }

  const userContent =
    `<video_title>${req.title}</video_title>\n` +
    (req.channel ? `<channel>${req.channel}</channel>\n` : "") +
    (req.duration ? `<duration>${req.duration}</duration>\n` : "") +
    `<transcript>\n${req.transcript}\n</transcript>\n\n` +
    `Summarize this video following the rules and format above. Write the summary in ${language}.`;

  const res = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01",
      // Required for calls made from a browser context; the key stays on this device.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 64000,
      stream: true,
      // If a safety classifier declines, the API retries on a fallback model in the same call.
      fallbacks: "default",
      output_config: { effort },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    let message = `Claude API error (HTTP ${res.status})`;
    try {
      const j = await res.json();
      if (j?.error?.message) message = `${message}: ${j.error.message}`;
    } catch {}
    if (res.status === 401) message = "Invalid API key. Check it in the extension settings.";
    throw new Error(message);
  }

  // Parse the server-sent event stream.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let stopReason = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }

      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        send({ type: "chunk", text: ev.delta.text });
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
        stopReason = ev.delta.stop_reason;
      } else if (ev.type === "error") {
        throw new Error(ev.error?.message || "The Claude API stream failed.");
      }
    }
  }

  if (stopReason === "refusal") {
    throw new Error("Claude declined to summarize this video.");
  }
  send({
    type: "done",
    note: stopReason === "max_tokens" ? "Summary was cut off at the length limit." : "",
  });
}
