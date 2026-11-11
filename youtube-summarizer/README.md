# YouTube Exact Summarizer (Chrome extension)

Adds a **Video Summary** panel to every YouTube video page. Click **Summarize** and it:

1. Reads the video's full transcript (caption track, or YouTube's own "Show transcript" panel as a fallback).
2. Sends it to Claude (`claude-opus-5-5`) with strict "only what's in the transcript" rules.
3. Streams back a structured summary:
   - **TL;DR**
   - **Categories** named after the video's real topics
   - **Bullet points** for facts and ideas, **numbered lists** for steps, rankings and timelines
   - **Key Takeaways** as a numbered list
   - A clickable **[m:ss] timestamp** on every point that jumps the video to that moment

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this `youtube-summarizer` folder.
3. Click the extension's toolbar icon to open Settings, paste your Anthropic API key, and Save.
4. Open any YouTube video and click **Summarize** in the panel above the recommendations.

## Notes

- Only works on videos that have captions (manual or auto-generated).
- Auto-generated captions can mishear words; the model fixes only obvious errors and marks unclear ones with "(?)".
- Your API key is stored in `chrome.storage.local` on this machine and sent only to `api.anthropic.com`. Each summary is billed to your Anthropic account.
- Change thoroughness (effort) and the output language in Settings.
