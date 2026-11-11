// Talks to the Claude API straight from the panel with fetch, so the extension
// loads unpacked with no build step. The key stays in chrome.storage.local.
(() => {
  const VN = (globalThis.VN = globalThis.VN || {});

  const DEFAULTS = { model: "claude-opus-5-5", effort: "medium", language: "English", level: "standard" };
  const MODELS = [
    ["claude-opus-5-5", "Opus 5.5", "Most accurate."],
    ["claude-sonnet-5-5", "Sonnet 5.5", "Faster and about half the price."],
    ["claude-haiku-5-5", "Haiku 5.5", "Fastest and cheapest. Fine for short, simple videos."],
  ];
  // Haiku has no server-side refusal fallback, the other two do.
  const HAS_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

  const CATEGORIES =
    "Programming, Game Dev, AI, Tech, Science, Business, Finance, Career, Productivity, Health & Fitness, Cooking, Education, Design, Music, Gaming, News & Politics, History, Entertainment, Lifestyle, Other";

  // One system prompt for notes and for questions, so the cached transcript is reused by both.
  const SYSTEM = `You work from the transcript of a video. You write notes from it and answer questions about it. The reader relies on you instead of watching the video, so accuracy comes first.

Faithfulness rules:
- Use only what is said in the transcript. Do not add facts, opinions, background or advice the speaker did not give, unless the reader asks for outside explanation, and then say clearly which part is yours.
- Keep names, numbers, prices, dates, measurements, quotes and recommendations exactly as stated. Do not round or generalise them.
- Keep the speaker's hedges. If they say "probably", "I think" or "rumoured", say so.
- Captions may be auto-generated and contain misheard words. Correct only obvious mistakes. If a word is ambiguous, keep it and add "(?)".
- Skip filler, greetings and like/subscribe requests.

Timestamps:
- Transcript lines start with a timestamp in square brackets. When you make a point, end it with the timestamp where it is said, copied from the transcript, in square brackets, for example [3:42].
- If the transcript has no timestamps, leave them out. Never invent one.

Write Markdown only, with no preamble and no closing remarks.`;

  const HEAD = `Start with this line exactly, filled in, then a blank line:
Category: <one of: ${CATEGORIES}> | Tags: <three to five short lowercase tags, comma separated>`;

  const LEVELS = {
    brief: `${HEAD}

Then write brief notes, about 150 to 250 words in total:
## TL;DR
Two sentences on what the video is about and its main conclusion.
## Key points
Five to eight bullets with the points that matter most, each with a timestamp.`,

    standard: `${HEAD}

Then write the notes:
## TL;DR
Two or three sentences on what the video is about and its main conclusion.

Then three to seven sections. Name each heading after the video's actual topics (for example "## Battery life" or "## Step 2: Mixing the dough"), not generic labels like "Main points".
- Use bullets for facts, ideas, arguments and examples.
- Use numbered lists for anything with an order: steps, instructions, rankings, timelines.
- Use nested bullets (indent two spaces) for supporting detail under a point.
- End each top-level bullet or numbered item with its timestamp.
- Bold only the key term of a point, sparingly.
- Cover every substantive point, in proportion to the time the video spends on it.
- If there is a sponsor segment, mention it in one bullet under the last section.

## Key takeaways
A numbered list of the three to seven most important points, each with a timestamp.`,

    detailed: `${HEAD}

Then write detailed study notes. Someone should be able to revise from these without the video.
## TL;DR
Three or four sentences on what the video is about, who it is for and its main conclusion.

## Outline
A numbered list of the video's parts in order, one line each, with the timestamp where each starts.

Then one section per part of the video, as many as it needs. Name each heading after its actual topic.
- Bullets for facts, ideas, arguments and examples. Numbered lists for steps, rankings and timelines.
- Nested bullets (indent two spaces) for the reasoning, examples, numbers and caveats behind each point. Keep the speaker's own examples.
- Quote short phrases word for word when the wording matters.
- End each top-level bullet or numbered item with its timestamp.
- Bold only the key term of a point.
- Leave nothing substantive out. Length should follow the video.

## Key terms
Terms, names or tools the video introduces, each with the meaning given in the video. Leave this section out if there are none.

## Action items
What the speaker tells the viewer to do, as a numbered list. Leave this section out if there are none.

## Key takeaways
A numbered list of the five to ten most important points, each with a timestamp.`,
  };

  const ASK = `Answer the question below about this video.
- Answer from the transcript and cite timestamps for what you take from it.
- Be direct and keep it short unless asked for depth. Use bullets or numbered steps when they help.
- If the video does not cover it, say so first. You may then add outside explanation, clearly marked as not from the video.

Question: `;

  function context(rec, promptText) {
    const head =
      `<video>\n<title>${rec.title || "Untitled"}</title>\n` +
      (rec.channel ? `<channel>${rec.channel}</channel>\n` : "") +
      (rec.site ? `<site>${rec.site}</site>\n` : "") +
      (rec.duration ? `<duration>${VN.cap.fmtTime(rec.duration)}</duration>\n` : "") +
      `</video>\n<transcript>\n${promptText}\n</transcript>`;
    return { type: "text", text: head, cache_control: { type: "ephemeral" } };
  }

  const notesMessages = (rec, promptText, level, language) => [
    { role: "user", content: [context(rec, promptText), { type: "text", text: `${LEVELS[level] || LEVELS.standard}\n\nWrite in ${language}. Keep the Category line in English.` }] },
  ];

  // chat: [{ role: "user" | "assistant", text }]
  function askMessages(rec, promptText, chat, language) {
    return chat.map((m, i) =>
      i === 0
        ? { role: "user", content: [context(rec, promptText), { type: "text", text: `${ASK}${m.text}\n\nAnswer in ${language}.` }] }
        : { role: m.role, content: m.text }
    );
  }

  async function config() {
    const c = await chrome.storage.local.get(["apiKey", "model", "effort", "language", "level", "apiBase"]);
    for (const k in DEFAULTS) if (!c[k]) c[k] = DEFAULTS[k];
    return c;
  }

  class ApiError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }

  async function stream({ messages, onText, signal, maxTokens = 64000 }) {
    const c = await config();
    if (!c.apiKey) throw new ApiError("No API key set.", "no_key");
    const fallback = HAS_FALLBACK.has(c.model);
    const headers = {
      "content-type": "application/json",
      "x-api-key": c.apiKey,
      "anthropic-version": "2026-10-21",
      // Needed for calls made from a browser. The key never leaves this device except to the API.
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (fallback) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    const body = { model: c.model, max_tokens: maxTokens, stream: true, output_config: { effort: c.effort }, system: SYSTEM, messages };
    // If a safety classifier declines, the API retries on a fallback model in the same call.
    if (fallback) body.fallbacks = "default";

    let res;
    try {
      res = await fetch((c.apiBase || "https://api.anthropic.com") + "/v1/messages", { method: "POST", signal, headers, body: JSON.stringify(body) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ApiError("Couldn't reach the Claude API. Check your connection.", "network");
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.error?.message || ""; } catch {}
      if (res.status === 401) throw new ApiError("That API key was rejected. Check it in settings.", "no_key");
      if (res.status === 429) throw new ApiError("Rate limited by the Claude API. Wait a moment and try again.", "rate");
      if (res.status === 413 || /too long|too large/i.test(detail)) throw new ApiError("This transcript is too long for one request.", "too_long");
      if (res.status >= 500) throw new ApiError("The Claude API is having trouble right now. Try again shortly.", "server");
      throw new ApiError(`Claude API error ${res.status}${detail ? ": " + detail : ""}`, "api");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const usage = { input: 0, cached: 0, output: 0 };
    let buf = "", text = "", stop = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          text += ev.delta.text;
          onText?.(text);
        } else if (ev.type === "message_start") {
          const u = ev.message?.usage || {};
          usage.cached = u.cache_read_input_tokens || 0;
          usage.input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + usage.cached;
        } else if (ev.type === "message_delta") {
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
          if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
        } else if (ev.type === "error") {
          throw new ApiError(ev.error?.message || "The Claude API stream failed.", "api");
        }
      }
    }
    if (stop === "refusal") throw new ApiError("Claude declined to work on this video.", "refusal");
    return { text, stop, usage, cut: stop === "max_tokens" };
  }

  VN.claude = { DEFAULTS, MODELS, config, stream, notesMessages, askMessages, ApiError };
})();
