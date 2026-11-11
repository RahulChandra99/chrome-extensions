# What the AI got wrong

Most of this extension was written by Claude Code. These are the places where the first version was wrong or the plan had to change, and how each one was found.

## YouTube blocks the two fast caption routes

The plan was three ways to get a YouTube transcript, fastest first: the caption track URL from the player response, YouTube's `get_transcript` endpoint, and as a last resort clicking Show transcript and reading the panel.

Tested against a real video in headless Chrome on 11 Nov 2026. The caption track URL answers 200 with an empty body, because it now wants a proof-of-origin token. `get_transcript` answers 400 "Precondition check failed", even with the page's full client context and visitor ID. Only the on-page panel worked.

So the "last resort" is the route that actually carries the feature. It opens a panel on the page as a side effect, which the first version left open. The fix closes it again after reading. The two fast routes are still tried first in case YouTube relaxes them for signed-in users. That hasn't been checked.

## A variable that shadowed `top`

`detect()` had `const top = self === top.self`. That reads `top` inside its own declaration and throws. Caught by reading the file back before the first run, not by a test.

## A made-up price in the model picker

The settings page described Opus as "about 4 dollars per million words read". Pricing is per token, not per word, and the figure wasn't checked. Replaced with plain descriptions that don't quote a number.

## Test script that never exited

The second browser test appeared to hang for two minutes. The extension was fine. The script left its DevTools sockets open, so Node never quit. Worth remembering before blaming the code under test.

## Not verified yet

- A real Claude API call. Tests used a local mock that streams the same event format.
- A real Notion workspace. The request shape was checked against a mock, not Notion itself.
- Obsidian's `obsidian://` link.
- The side panel opening from the toolbar icon and from the YouTube button. Headless Chrome can't click the toolbar.
- Embedded YouTube players on other sites. With both fast routes blocked they have no transcript panel to fall back on, so they show a message asking you to open the video on youtube.com.
