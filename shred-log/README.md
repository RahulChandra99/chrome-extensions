# Shred Log for Chrome

One click sends the page you're on to your Shred Log, sorted into a topic.

- **YouTube videos** go to **Saves → Watch later**, with the channel and length.
- **Everything else** goes to **Saves → Saved links**: topics, Today's 5, Keep / Done / Drop, search, and notes.

## Install (one time)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `shred-log-extension` folder.
4. Click the puzzle piece 🧩 in the toolbar and pin **Shred Log**.

Stay signed in to claude.ai in Chrome. Links are written through your Shred Log page, so they sync to your account.

## Using it

| Do this | What happens |
| --- | --- |
| Click the toolbar button | Saves the page right away. The popup shows where it went, and you can change the topic, add a note or undo |
| `Alt+Shift+S` | Same as clicking the button |
| `Alt+Shift+D` | Saves without the popup and shows a small "Saved" note on the page |
| Right-click a link → **Send link to Shred Log** | Saves the link without opening it, with a small "Sending… / Sent" note on the page |
| Drag a bookmark onto the **📥 Shred Log** folder on your bookmarks bar | Sends it, and the bookmark goes back to where it was. Dragging a folder sends every link inside |
| ⭐ Star a page into the **📥 Shred Log** folder | Sends the page, with no extra bookmark left behind |

Chrome doesn't let extensions add items to the bookmarks bar's own right-click menu, so the 📥 folder is the one-step way to send bookmarks.

If your Shred Log isn't open, the extension opens it in a pinned background tab to receive the link. While links are waiting, the toolbar badge shows a count.

## Sorting

Links are sorted on your machine from the site, the title and the description, with no AI calls. The topics match your Shred Log: AI & Claude, Tech & coding, Jobs & visa, Game dev, Workouts, Food, Hair/skin/style, Dating & social, Mindset, Places, Watch, Games, Music, Articles, Learn, Money, Shopping, Funny and Unsorted.

To add your own rules (for example `hitmarker.net → Jobs & visa`) or try the sorter, open the extension's **Settings** (the gear in the popup).

## Files

- `background.js`: the queue, delivery to your Shred Log tab, right-click menu and shortcuts
- `bridge.js`: runs only inside the Shred Log page (it has a `shredlog-inbox` tag) and passes links in and replies back
- `classify.js`: the topic sorter
- `popup.*` and `options.*`: the interface
