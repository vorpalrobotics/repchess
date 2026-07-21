# Help topics

The Help modal (hamburger menu → Help) reads this folder at runtime.

- `topics.json` — the topic list, in display order:
  ```json
  [{ "id": "intro", "title": "Intro", "file": "intro.html" }]
  ```
- Each topic's `file` is an HTML **fragment** (not a full document — no
  `<html>`/`<head>`/`<body>`), fetched and injected directly into the Help
  modal's content pane, so it inherits the app's own fonts/colors.

## Adding a topic

1. Create `help/<name>.html` with just the content (headings, paragraphs,
   lists — whatever plain HTML you need).
2. Wrap any mention of the product name in `<span class="repchess-brand">
   REPchess</span>` so it picks up the brand styling.
3. Add `{ "id": "<name>", "title": "<Sidebar label>", "file": "<name>.html" }`
   to `topics.json`, in the order you want it to appear in the sidebar.

No other changes are needed — `js/app.js`'s Help modal code (`openHelpModal`
/ `openHelpTopic`) reads `topics.json` fresh each time the modal opens.
