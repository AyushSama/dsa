# DSA Tracker — DP + conversion plan

Plain HTML/CSS/JS site for an 11-week plan to the end of January (started Thu 12 Nov 2026).
Weeks 1–6: two new DP problems a day, two concept-touch problems a day to keep every other topic
warm, and daily timed drills. Weeks 7–11: every other topic, one family a week — three named
problems a day on the clock, three mocks a week, interview scenarios and Googleyness on alternate days. No framework, no backend, no database, no browser storage.
**`data.json` in this folder is the only place anything is stored.**

```
index.html   page shell
style.css    styles
app.js       all logic
charts.js    canvas charts (no library)
data.json    plan content + your progress
data.backup-2026-11-11.json   the previous 16-week plan and its progress, kept for reference
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

The browser stores only a *pointer* to the file, never the data. Settings → **Download a copy**
gives you a backup. Direct file writes use the File System Access API (Chrome and Edge, desktop).

## Features

The site has a status strip, a sticky navigation bar and seven pages. Every page opens with a dark hero
(eyebrow, headline, lede, numbers) and continues in sections. The site is light only.

- **Today** — the day's headline, a countdown to the last day of the plan, a "showed up" score (working
  days with anything logged), the week at a glance, the day's rule, then the list in lettered blocks
  (A new problems, C concept touch, B re-solves due, D the weekday's drills), the mission route by phase,
  and the progress charts.
- **Plan** — a week stepper across the top and the selected week as a day-by-day timeline. Tick a problem
  when solved; that schedules re-solves on **+3** and **+14** days. **↻ redo** re-queues +3/+14; a second
  failure adds **+30**. **G** marks problems verified high-frequency in Google interview reports; items with
  a topic badge are concept-touch problems (25 minutes, not re-queued). A plan week starts on the weekday
  of the start date (here Thursday): 5 working days, a contest day (Saturday) and a rest day (Sunday).
- **Revision** — what is due now, the next 7 days grouped by date, later, and recently completed.
- **Drills** — the weekday board (`guide.drillSchedule`, one family of primitives a day), every primitive
  as a card with its target, best time, **test problem** links and a log box, and the rotation drills.
- **Notes** — trigger notes, per-problem notes and a dated journal.
- **Guide** — a contents rail and sections: the Google process as checked on 11 Nov 2026, rules, daily
  templates, drills, exit criteria, questions for the recruiter, resources.
- **Settings** — plan dates, the linked `data.json`, reset.

### Theme

A pirate-voyage theme inspired by the world of One Piece: parchment pages, an animated sea in every hero
(waves, a sailing ship, sun, clouds), a WANTED poster carrying your rank and bounty, weeks as islands on a
dashed sea route, a boss per island and a treasure chest of achievements. XP is shown as a bounty in
berries (1 XP = ฿100,000). No character names, artwork or logos from the series are used.
Animations are switched off when the system asks for reduced motion.

### Game layer

Computed from `progress` and `drillLog` on every render; nothing extra is stored.

- **XP:** problem 50 (+10 if marked G), re-solve on time 30 / late 15, concept touch 20, mock 40, contest 60,
  other task 10, drill 10 (+5 at target time). Unticked items show the XP they are worth.
- **Level and rank:** level N to N+1 costs 100 + 50·(N−1) XP. Ranks run Rookie → Offer Material.
- **HP:** 100 minus 10 for every overdue re-solve.
- **Streak:** consecutive days with anything logged.
- **Week boss:** the week's checkpoint; its HP is the share of the week's problems still unsolved.
- **Achievements:** 16 badges with progress bars on the Today page.
- Ticking something shows the XP gained; a level-up shows a card with confetti (skipped when the system
  asks for reduced motion). The status strip shows level, rank, XP bar, streak and HP on every page.

## data.json layout

```
settings   { startDate, redoOffsets }
guide      static text; guide.primitives[] { n, name, target, test[ { label, url } ] }
weeks[]    { week, phase, title, drillFocus[], days[ { day, focus, items[] } ], notes[], checkpoint }
progress   { "w1d1i0": { solved, redos:[{label, due, done, skipped?}], note } | { done } | { note } }
drillLog[] { name, date, minutes }
notes      { triggers: "text", journal: [ { date, text } ] }
updatedAt  ISO timestamp of the last save
```

Item ids are `w<week>d<day>i<index>`. Items are strings or `{ name, hot }` (problems),
`{ name, type: "task" }` (tasks) or `{ name, type: "task", topic }` (concept touch).
A day whose `focus` is `Contest` or `Rest` is treated as such on the dashboard.
Edit `weeks` freely to change the plan.
