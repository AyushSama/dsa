# DSA 16-Week Tracker

Plain HTML/CSS/JS site for the Google DSA roadmap (research-updated Sept 2026): Week 0 gate
(GHA + diagnostic), Phase 1 Build (weeks 1–11), Phase 2 Conversion (weeks 12–14), Buffer (15–16).
No framework, no backend, no database, no browser storage.
**`data.json` in this folder is the only place anything is stored.**

```
index.html   page shell
style.css    styles
app.js       all logic
charts.js    canvas charts (no library)
data.json    roadmap content + your progress
```

## Use

Open `index.html` in **Chrome or Edge**. `data.json` sits next to it and is picked up automatically:

- **Reading** is automatic whenever the folder is served over http/https (any static host,
  VS Code Live Server, `python -m http.server`). Opened straight from disk (`file://`), Chrome
  refuses to read sibling files, so the very first visit shows an *Open data.json* button.
- **Writing** needs your permission once — browsers never let a page write to disk silently.
  When Chrome asks, choose **"Allow on every visit"**. From then on the page reads and writes
  `data.json` with no clicks. If the permission was not remembered, your first click in the app
  re-grants it (a yellow banner shows while saving is off).

The browser stores only a *pointer* to the file, never the data. Put the folder in OneDrive /
Dropbox / a git repo and open it from any machine; `data.json` is the single source of truth.
Settings → **Download a copy** gives you a backup.

Direct file writes use the File System Access API, available in Chrome and Edge (desktop).
Firefox and Safari can read the tracker but cannot save to the file.

### Hosting on GitHub Pages (or any static host)

A browser can never write to a file on a server, so the hosted `data.json` is a read-only
snapshot. The workflow is:

1. Open the hosted URL. It shows the last published copy with a yellow banner.
2. Click **Link data.json** (or just click anything) and pick the `data.json` on your computer.
   Tick **"Allow on every visit"**. From now on the page reads and writes *that* file.
3. Next day, open the same URL: it loads your local file automatically (or after one click).
4. Whenever you want the published copy refreshed, commit and push your `data.json`.

Until the file is linked the page is display-only, so the local file is always the source of truth.

## Features

- **Roadmap** — Week 0 plus 16 weeks, day-by-day (5 working days, contest on day 6, rest on
  day 7). Tick a problem when solved; that schedules re-solves on **+3** and **+14** days
  (offsets configurable in Settings). **↻ redo** re-queues +3/+14; a second failure adds **+30**.
  A small **G** marks problems verified high-frequency in Google interview reports.
- **Revision** — due / overdue / upcoming re-solves. Mark *Re-solved* or *Skip*.
- **Dashboard** — overall %, revision discipline (on time / late / overdue), 28-day activity,
  per-week completion, heatmap, today's blocks (B/C/D rotation by weekday) and due queue.
- **Drills** — the 22 timed blind primitives (plus 3 optional from week 11) with target minutes,
  and the weekly rotation (ambiguity, debug hunt, code quality, code comprehension, cold-combo).
  Log attempts with the time taken.
- **Notes** — the ✎ button on any problem attaches a note (approach, trigger, what went wrong);
  the Notes tab collects them, plus a free-form *Trigger notes* editor (your `triggers.md`)
  and a dated *Journal* for contest post-mortems. Everything is saved in `data.json`.
- **Guide** — rules, daily templates, triggers, verbal protocol, exit criteria, resources.

Charts are drawn on canvas at the display's device-pixel ratio and redraw on resize, so they
stay sharp on HiDPI screens and at any zoom level.

## data.json layout

```
settings   { startDate, redoOffsets }
guide      static text from the roadmap
weeks[]    { week, phase, title, days[ { day, focus, items[] } ], notes[], checkpoint }
progress   { "w1d1i0": { solved, redos:[{label, due, done, skipped?}], note } | { done } | { note } }
drillLog[] { name, date, minutes }
notes      { triggers: "text", journal: [ { date, text } ] }
updatedAt  ISO timestamp of the last save
```

Item ids are `w<week>d<day>i<index>`. Items are strings (problems) or `{ name, type: "task" }`.
Edit `weeks` freely to change the plan.
