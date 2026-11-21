/* DSA Tracker — plain JS, no framework, no backend, no browser storage.
   data.json is THE storage: the page opens it with the File System Access API (Chrome/Edge)
   and writes every change straight back to that file. */
(function () {
  'use strict';

  let DATA = null;
  let fileHandle = null;           // FileSystemFileHandle for data.json
  const FS_OK = 'showOpenFilePicker' in window;
  const UI = { view: 'dashboard', week: 1, openNotes: new Set() };

  // ---------- date helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function today() { return toISO(new Date()); }
  function parse(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(iso, n) { const d = parse(iso); d.setDate(d.getDate() + n); return toISO(d); }
  function diffDays(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmt(iso) { if (!iso) return ''; const d = parse(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; }
  function relDue(iso) {
    const n = diffDays(today(), iso);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return '1 day overdue';
    if (n < 0) return `${-n} days overdue`;
    return `in ${n} days`;
  }
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function planDate(w, d) { return addDays(DATA.settings.startDate, (w - 1) * 7 + d - 1); }
  function dayLabel(w, d) { const iso = planDate(w, d); return `${WEEKDAYS[parse(iso).getDay()]} ${fmt(iso)}`; }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- roadmap helpers ----------
  function itemId(w, d, i) { return `w${w}d${d}i${i}`; }
  function norm(item) { return typeof item === 'string' ? { name: item, type: 'problem' } : { name: item.name, type: item.type || 'problem', hot: !!item.hot, topic: item.topic || '' }; }
  function weekByNum(n) { return DATA.weeks.find((w) => w.week === n) || DATA.weeks[0]; }
  function firstWeek() { return DATA.weeks[0].week; }
  function lastWeek() { return DATA.weeks[DATA.weeks.length - 1].week; }
  function phaseName(p) { return (DATA.guide.phases && DATA.guide.phases[p]) || `Phase ${p}`; }
  function phaseColor(p) { return { 0: cssVar('--muted'), 1: cssVar('--accent'), 2: cssVar('--blue'), 3: cssVar('--green') }[p] || cssVar('--accent'); }
  function phaseBadge(p) { return { 0: '', 1: 'accent', 2: 'green', 3: 'amber' }[p] || ''; }
  function allItems() {
    const out = [];
    DATA.weeks.forEach((wk) => wk.days.forEach((day) => day.items.forEach((it, i) => {
      const n = norm(it);
      out.push({ id: itemId(wk.week, day.day, i), week: wk.week, day: day.day, idx: i, name: n.name, type: n.type, focus: day.focus, weekTitle: wk.title });
    })));
    return out;
  }
  function problems() { return allItems().filter((x) => x.type === 'problem'); }
  function isSolved(id) { const p = DATA.progress[id]; return !!(p && p.solved); }
  function isTaskDone(id) { const p = DATA.progress[id]; return !!(p && p.done); }

  function currentPosition() {
    const start = DATA.settings.startDate || today();
    const n = diffDays(start, today());
    if (n < 0) {
      // Days before the start date belong to week 0 (the GHA / diagnostic gate), counted back from day 1 of week 1.
      const w0 = DATA.weeks[0];
      if (w0.week === 0) {
        const len = w0.days.length;
        return { week: 0, day: Math.max(1, len + 1 + n), before: n < -len, daysUntil: -n };
      }
      return { week: w0.week, day: 1, before: true, daysUntil: -n };
    }
    const last = lastWeek();
    const week = Math.min(last, Math.floor(n / 7) + 1);
    const day = (n % 7) + 1;
    return { week, day, after: n >= last * 7 };
  }

  function weekStats(wk) {
    let total = 0, done = 0, tasks = 0, tasksDone = 0;
    wk.days.forEach((day) => day.items.forEach((it, i) => {
      const n = norm(it); const id = itemId(wk.week, day.day, i);
      if (n.type === 'problem') { total++; if (isSolved(id)) done++; }
      else { tasks++; if (isTaskDone(id)) tasksDone++; }
    }));
    return { total, done, tasks, tasksDone, pct: total ? Math.round((done / total) * 100) : (tasks ? Math.round((tasksDone / tasks) * 100) : 0) };
  }

  // All redo entries flattened
  function allRedos() {
    const out = [];
    const byId = Object.fromEntries(allItems().map((x) => [x.id, x]));
    Object.entries(DATA.progress).forEach(([id, p]) => {
      if (!p.redos) return;
      p.redos.forEach((r, i) => {
        const it = byId[id]; if (!it) return;
        out.push({ id, idx: i, item: it, label: r.label, due: r.due, done: r.done, skipped: !!r.skipped });
      });
    });
    return out;
  }

  // Activity per date: {date: {solved, redos, tasks, drills}}
  function activity() {
    const map = {};
    const bump = (d, k) => { if (!d) return; map[d] = map[d] || { solved: 0, redos: 0, tasks: 0, drills: 0 }; map[d][k]++; };
    Object.values(DATA.progress).forEach((p) => {
      if (p.solved) bump(p.solved, 'solved');
      if (p.done) bump(p.done, 'tasks');
      (p.redos || []).forEach((r) => { if (r.done && !r.skipped) bump(r.done, 'redos'); });
    });
    (DATA.drillLog || []).forEach((l) => bump(l.date, 'drills'));
    return map;
  }
  function streak() {
    const act = activity();
    let d = today(); let s = 0;
    if (!act[d]) d = addDays(d, -1); // allow today not yet done
    while (act[d]) { s++; d = addDays(d, -1); }
    return s;
  }

  // ---------- persistence ----------
  let saveTimer = null;
  const saveEl = document.getElementById('save-state');
  function setSaveState(cls, title) {
    saveEl.className = 'save-state ' + cls; saveEl.title = title;
    const t = document.getElementById('save-text'); if (t) t.textContent = title.length > 34 ? title.slice(0, 32) + '…' : title;
  }

  // The only thing kept in the browser is a *pointer* to the file (so reconnecting is one click).
  // The data itself is never stored in the browser.
  const idb = {
    open: () => new Promise((res, rej) => {
      const r = indexedDB.open('dsa-tracker-handle', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Browser storage is blocked by another tab'));
    }),
    async get(k) { const db = await this.open(); return new Promise((res) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(null); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = () => res(); t.onerror = () => res(); }); },
  };

  function normalize(json) {
    if (!json || !Array.isArray(json.weeks)) throw new Error('This is not a tracker data.json (no "weeks" array).');
    json.progress = json.progress || {};
    json.drillLog = json.drillLog || [];
    json.notes = Object.assign({ triggers: '', journal: [] }, json.notes || {});
    json.settings = Object.assign({ startDate: today(), redoOffsets: [3, 14] }, json.settings || {});
    return json;
  }

  let writable = false; // true once data.json is linked with read/write permission

  // Read the linked file. The linked file is always the source of truth: a hosted copy fetched
  // before linking is display-only, so nothing in memory can overwrite the file.
  async function readFromHandle() {
    const file = await fileHandle.getFile();
    DATA = normalize(JSON.parse(await file.text()));
    writable = true;
    hideBanner();
    setSaveState('', `Saving to ${fileHandle.name}`);
  }

  // Auto-read data.json next to index.html (works whenever the folder is served over http/https).
  async function loadViaFetch() {
    const r = await fetch('data.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('data.json not found next to index.html');
    DATA = normalize(await r.json());
  }

  async function pickFile() {
    const [h] = await window.showOpenFilePicker({
      id: 'dsa-tracker', types: [{ description: 'Tracker data (JSON)', accept: { 'application/json': ['.json'] } }],
    });
    if (h.name !== 'data.json') toast(`Linked "${h.name}" — expected data.json, but continuing`);
    fileHandle = h;
    // Ask for write access right now, while the click is still fresh; Chrome offers "Allow on every visit" here.
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Write access was not granted');
    try { await withTimeout(idb.set('handle', h), 3000, 'Browser storage'); } catch (_) { /* remembering the link is a convenience only */ }
    await readFromHandle();
    return true;
  }

  // Re-grant access to the remembered file. Must run inside a user gesture (click).
  async function reconnect() {
    if (!fileHandle) return false;
    let perm = await fileHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await fileHandle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    await readFromHandle();
    return true;
  }

  // Until data.json is linked the app is display-only. The first click in the app (a user
  // gesture, which the browser requires) links the file: re-grant if remembered, else the picker.
  function linkOnGesture() {
    if (!FS_OK) return toast('This browser cannot write files — open the site in Chrome or Edge to save');
    const p = fileHandle ? reconnect() : pickFile();
    p.then((ok) => {
      if (ok) { render(); toast('Linked to data.json — saving is on. Click again to apply that action.'); }
      else toast('Access to data.json was not granted — changes are not being saved');
    }).catch((err) => { if (err.name !== 'AbortError') toast(err.message); });
  }

  // ----- banner (shown while changes are not being written to the file) -----
  const banner = document.getElementById('banner');
  function showBanner(kind) {
    banner.hidden = false;
    banner.innerHTML = kind === 'unsupported'
      ? `<span>Read-only: this browser cannot write files. Open the site in <b>Chrome</b> or <b>Edge</b> to save into data.json.</span>`
      : kind === 'reconnect'
        ? `<span>Showing the last published copy. Allow access to your <b>data.json</b> to load it and resume saving.</span><button class="btn small primary" id="banner-reconnect">Allow</button>`
        : `<span>Showing the last published copy. Link the <b>data.json</b> on your computer once — Chrome can remember it for every visit.</span><button class="btn small primary" id="banner-pick">Link data.json</button>`;
  }
  function hideBanner() { banner.hidden = true; }
  banner.addEventListener('click', async (e) => {
    try {
      if (e.target.id === 'banner-pick') { await pickFile(); render(); toast('Linked — saving to data.json'); }
      else if (e.target.id === 'banner-reconnect') { if (await reconnect()) { render(); toast('Saving to data.json is on'); } }
    } catch (err) { if (err.name !== 'AbortError') toast(err.message); }
  });

  function save() {
    clearTimeout(saveTimer);
    setSaveState('saving', 'Saving…');
    saveTimer = setTimeout(async () => {
      DATA.updatedAt = new Date().toISOString();
      if (!fileHandle || !writable) { setSaveState('error', 'data.json is not linked — changes are not saved'); return; }
      try {
        const w = await fileHandle.createWritable();
        await w.write(JSON.stringify(DATA, null, 2) + '\n');
        await w.close();
        setSaveState('', `Saved to ${fileHandle.name} · ${new Date().toLocaleTimeString()}`);
      } catch (e) {
        setSaveState('error', 'Write failed: ' + e.message);
        toast('Could not write ' + fileHandle.name + ' — ' + e.message);
      }
    }, 200);
  }

  function downloadCopy() {
    const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'data.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ----- gate (start screen) -----
  const gate = document.getElementById('gate');
  function showGate(html) { gate.innerHTML = html; gate.hidden = false; document.getElementById('app').hidden = true; }
  function hideGate() { gate.hidden = true; document.getElementById('app').hidden = false; }

  // Startup order — everything automatic where the browser allows it:
  //   1. data.json was linked before and Chrome remembered the permission  → read + write, zero clicks.
  //   2. otherwise read data.json next to index.html automatically (http/https) → app opens at once;
  //      a slim banner (or the first click) grants write access.
  //   3. opened straight from disk (file://) on a first visit — Chrome blocks reading sibling files,
  //      so a one-time "Open data.json" screen is shown.
  // A browser call that never answers (a stuck IndexedDB, a file handle on an unavailable drive)
  // must not leave the page on "Loading…" forever: give each startup step a deadline and move on.
  function withTimeout(promise, ms, what) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not respond within ${ms / 1000}s`)), ms))]);
  }

  async function boot() {
    if (FS_OK) {
      try { fileHandle = (await withTimeout(idb.get('handle'), 3000, 'Browser storage')) || null; }
      catch (e) { console.warn('[dsa-tracker] remembered file link unavailable:', e); fileHandle = null; }
      if (fileHandle) {
        let loaded = false;
        try {
          if ((await withTimeout(fileHandle.queryPermission({ mode: 'readwrite' }), 3000, 'File permission check')) === 'granted') {
            await withTimeout(readFromHandle(), 5000, 'Reading the linked data.json');
            loaded = true;
          }
        } catch (e) { console.warn('[dsa-tracker] could not read the linked data.json:', e); fileHandle = null; writable = false; }
        if (loaded) return start();
      }
    }
    let fetched = false;
    try { await withTimeout(loadViaFetch(), 8000, 'Loading data.json'); fetched = true; }
    catch (e) { console.warn('[dsa-tracker] data.json could not be fetched:', e); /* file:// — fall through to the one-time gate */ }
    if (fetched) {
      start();
      showBanner(!FS_OK ? 'unsupported' : fileHandle ? 'reconnect' : 'link');
      return;
    }
    if (!FS_OK) {
      return showGate(`<div class="card gate-card"><h2>Browser not supported</h2>
        <p class="muted" style="margin-top:8px">Open this folder in <b>Chrome</b> or <b>Edge</b>, which can read and write <code>data.json</code> directly.</p></div>`);
    }
    showGate(`<div class="card gate-card">
      <div class="logo" style="font-size:28px">◆</div>
      <h2 style="margin-top:8px">DSA Mastery</h2>
      <p class="muted" style="margin:8px 0 16px">Everything is stored in <code>data.json</code> next to this page. ${fileHandle ? 'Allow access to continue.' : 'Pick that file once.'}
        When Chrome asks, choose <b>“Allow on every visit”</b> and it will open automatically from then on.</p>
      ${fileHandle ? `<button class="btn primary" id="gate-reconnect">Continue with ${esc(fileHandle.name)}</button>
        <button class="btn ghost" id="gate-pick" style="margin-left:6px">Choose another file</button>`
        : `<button class="btn primary" id="gate-pick">Open data.json</button>`}
    </div>`);
  }
  function start() { hideGate(); UI.week = currentPosition().week; render(); }

  gate.addEventListener('click', async (e) => {
    const id = e.target.id;
    try {
      if (id === 'gate-pick') { if (await pickFile()) start(); }
      else if (id === 'gate-reconnect') { if (await reconnect()) start(); else toast('Permission denied — choose the file again'); }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled the picker
      toast(err.message || String(err));
    }
  });

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- actions ----------
  function makeRedos(fromDate, prefix = '') {
    return (DATA.settings.redoOffsets || [3, 14]).map((n) => ({ label: `${prefix}+${n}`, due: addDays(fromDate, n), done: null }));
  }
  function toggleSolved(id) {
    const prev = DATA.progress[id] || {};
    if (isSolved(id)) {
      if (prev.note) DATA.progress[id] = { note: prev.note }; else delete DATA.progress[id];
      toast('Unmarked');
    } else {
      DATA.progress[id] = { solved: today(), redos: makeRedos(today()), note: prev.note || '' };
      toast('Solved · re-do scheduled for +3 and +14 days');
    }
    save(); render();
  }
  function setNote(id, text) {
    const p = DATA.progress[id];
    if (p) { p.note = text; if (!text && !p.solved && !p.done) delete DATA.progress[id]; }
    else if (text) DATA.progress[id] = { note: text };
    save();
  }
  function setSolvedDate(id, date) {
    const p = DATA.progress[id]; if (!p || !date) return;
    p.solved = date;
    const offs = DATA.settings.redoOffsets || [3, 14];
    p.redos.forEach((r, i) => { if (!r.done && i < offs.length && !r.label.startsWith('R')) r.due = addDays(date, offs[i]); });
    save(); render();
  }
  function toggleRedo(id, idx, skipped = false) {
    const p = DATA.progress[id]; if (!p || !p.redos[idx]) return;
    const r = p.redos[idx];
    if (r.done) { r.done = null; delete r.skipped; }
    else { r.done = today(); if (skipped) r.skipped = true; }
    save(); render();
  }
  function requeue(id) {
    const p = DATA.progress[id]; if (!p) return;
    const failures = p.redos.filter((r) => r.label.startsWith('R')).length / (DATA.settings.redoOffsets || [3, 14]).length;
    p.redos.push(...makeRedos(today(), 'R'));
    if (failures >= 1) { p.redos.push({ label: 'R+30', due: addDays(today(), 30), done: null }); toast('Failed twice — re-queued at +3, +14 and +30 days'); }
    else toast('Re-queued for +3 and +14 days from today');
    save(); render();
  }
  function toggleTask(id) {
    const prev = DATA.progress[id] || {};
    if (isTaskDone(id)) { if (prev.note) DATA.progress[id] = { note: prev.note }; else delete DATA.progress[id]; }
    else DATA.progress[id] = { done: today(), note: prev.note || '' };
    save(); render();
  }
  function logDrill(name, minutes, seconds) {
    const entry = { name, date: today(), minutes: minutes ? Number(minutes) : null };
    if (seconds) entry.seconds = seconds;
    DATA.drillLog.push(entry);
    toast('Drill logged'); save(); render();
  }

  // ----- drill stopwatch -----
  // Lives in memory only: nothing reaches drillLog until "Log" is pressed, so a botched attempt
  // can be restarted or discarded without leaving an entry behind.
  const TIMERS = {}; // primitive name -> { running, start (ms epoch), elapsed (ms, once stopped) }
  let tickId = null;
  const timerMs = (t) => (t.running ? Date.now() - t.start : t.elapsed);
  const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
  const dur = (minutes) => clock(Math.round(minutes * 60) * 1000); // logged minutes -> m:ss
  function tick() {
    if (!Object.values(TIMERS).some((t) => t.running)) { clearInterval(tickId); tickId = null; return; }
    document.querySelectorAll('[data-timer-display]').forEach((el) => {
      const t = TIMERS[el.dataset.timerDisplay]; if (!t) return;
      const ms = timerMs(t);
      el.textContent = clock(ms);
      el.classList.toggle('over', ms > Number(el.dataset.target) * 60000);
    });
  }
  function timerStart(name) { TIMERS[name] = { running: true, start: Date.now(), elapsed: 0 }; if (!tickId) tickId = setInterval(tick, 250); render(); }
  function timerStop(name) { const t = TIMERS[name]; if (!t || !t.running) return; t.elapsed = Date.now() - t.start; t.running = false; render(); }
  function timerDiscard(name) { delete TIMERS[name]; render(); }
  function timerLog(name) {
    const t = TIMERS[name]; if (!t || t.running) return;
    const seconds = Math.floor(t.elapsed / 1000);
    if (seconds < 1) return toast('Nothing timed yet');
    delete TIMERS[name];
    logDrill(name, Math.round((seconds / 60) * 100) / 100, seconds);
  }
  window.addEventListener('beforeunload', (e) => { if (Object.keys(TIMERS).length) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- rendering ----------
  const $ = (sel) => document.querySelector(sel);
  function render() {
    const pos = currentPosition();
    $('#brand-sub').textContent = pos.before ? `Starts in ${pos.daysUntil} day${pos.daysUntil === 1 ? '' : 's'} (${fmt(DATA.settings.startDate)})`
      : pos.after ? 'Plan complete — keep revising' : `Week ${pos.week} · Day ${pos.day} — ${weekByNum(pos.week).title}`;
    const due = allRedos().filter((r) => !r.done && r.due <= today()).length;
    const pill = $('#pill-due'); pill.textContent = due; pill.classList.toggle('zero', due === 0);
    const g = gameState();
    $('#hud-lv').textContent = 'LV ' + g.level; $('#hud-rank').textContent = g.rank;
    $('#side-pct').textContent = 'Bounty ' + berry(g.xp); $('#side-bar').style.width = Math.round(100 * g.into / g.need) + '%';
    $('#hud-streak').textContent = '🔥 ' + g.streak; $('#hud-hp').textContent = '⚓ ' + g.hp;
    $('#hud-hp').classList.toggle('low', g.hp < 70);
    celebrate(g);
    document.querySelectorAll('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.view === UI.view));
    document.querySelectorAll('.view').forEach((v) => {
      const active = v.id === 'view-' + UI.view;
      v.classList.toggle('active', active);
      if (!active) v.innerHTML = ''; // only one view lives in the DOM at a time
    });
    ({ dashboard: renderDashboard, roadmap: renderRoadmap, revision: renderRevision, drills: renderDrills, notes: renderNotes, guide: renderGuide, settings: renderSettings })[UI.view]();
    dressHeroes();
  }

  // ===================== Game layer =====================
  // XP is earned by ticking things; nothing is stored — it is recomputed from progress and the drill log.
  const XP = { problem: 50, hot: 10, redoOnTime: 30, redoLate: 15, touch: 20, mock: 40, contest: 60, task: 10, drill: 10, drillAtTarget: 5 };
  const RANKS = [[1, 'Cabin Hand'], [3, 'Deckhand'], [5, 'Rookie Pirate'], [8, 'Supernova'], [11, 'First Mate'], [14, 'Warlord of the Sea'], [17, 'Fleet Commander'], [20, 'Emperor of the Sea'], [23, 'King of the Pirates']];
  // bounty: 1 XP = 100,000 berries
  const berry = (xp) => '฿' + (xp * 100000).toLocaleString('en-US');
  const berryShort = (xp) => { const m = xp / 10; return '฿' + (m >= 1000 ? (m / 1000).toFixed(m % 1000 ? 2 : 0).replace(/0+$/, '').replace(/\.$/, '') + 'B' : (Number.isInteger(m) ? m : m.toFixed(1)) + 'M'); };
  function itemXP(it, focus) {
    if (it.type === 'problem') return XP.problem + (it.hot ? XP.hot : 0);
    if (it.topic) return XP.touch;
    if (focus === 'Contest') return XP.contest;
    if (/^D · Mock/.test(it.name)) return XP.mock;
    return XP.task;
  }
  const xpToNext = (level) => 100 + 50 * (level - 1);
  function gameState() {
    let xp = 0, solved = 0, touches = 0, mocks = 0, contests = 0, daysCleared = 0, weeksCleared = 0, onTime = 0, redoDone = 0;
    DATA.weeks.forEach((wk) => {
      let weekAll = true;
      wk.days.forEach((day) => {
        let all = day.items.length > 0;
        day.items.forEach((raw, i) => {
          const it = norm(raw); const p = DATA.progress[itemId(wk.week, day.day, i)];
          const done = !!(p && (p.solved || p.done));
          if (!done) { all = false; return; }
          xp += itemXP(it, day.focus);
          if (it.type === 'problem') solved++; else if (it.topic) touches++; else if (day.focus === 'Contest') contests++; else if (/^D · Mock/.test(it.name)) mocks++;
          (p.redos || []).forEach((r) => { if (r.done && !r.skipped) { redoDone++; if (r.done <= r.due) { onTime++; xp += XP.redoOnTime; } else xp += XP.redoLate; } });
        });
        if (all && day.focus !== 'Rest') daysCleared++;
        if (!all) weekAll = false;
      });
      if (weekAll) weeksCleared++;
    });
    const targets = Object.fromEntries(DATA.guide.primitives.map((p) => [p.name, p.target]));
    (DATA.drillLog || []).forEach((l) => { xp += XP.drill; if (l.minutes && targets[l.name] && l.minutes <= targets[l.name]) xp += XP.drillAtTarget; });
    let level = 1, into = xp;
    while (into >= xpToNext(level)) { into -= xpToNext(level); level++; }
    const rank = RANKS.filter(([l]) => level >= l).pop()[1];
    const overdue = allRedos().filter((r) => !r.done && r.due < today()).length;
    const hp = Math.max(0, 100 - 10 * overdue);
    const atTarget = DATA.guide.primitives.filter((p) => !/\(optional\)/.test(p.name)).filter((p) => { const mine = (DATA.drillLog || []).filter((l) => l.name === p.name); const last = mine[mine.length - 1]; return last && last.minutes && last.minutes <= p.target; }).length;
    return { xp, level, into, need: xpToNext(level), rank, hp, overdue, streak: streak(), solved, touches, mocks, contests, daysCleared, weeksCleared, onTime, redoDone, atTarget };
  }
  function achievements(g) {
    const a = (icon, name, desc, have, goal) => ({ icon, name, desc, have: Math.min(have, goal), goal, done: have >= goal });
    const corePrims = DATA.guide.primitives.filter((p) => !/\(optional\)/.test(p.name)).length;
    return [
      a('⚔️', 'First Blood', 'Solve your first problem', g.solved, 1),
      a('✅', 'Clean Sweep', 'Clear every quest in a day', g.daysCleared, 1),
      a('🔥', 'On Fire', 'Hold a 7-day streak', g.streak, 7),
      a('🌋', 'Unbreakable', 'Hold a 30-day streak', g.streak, 30),
      a('⏱️', 'On the Clock', 'Finish 10 re-solves on time', g.onTime, 10),
      a('🛡️', 'Iron Discipline', 'Finish 50 re-solves on time', g.onTime, 50),
      a('🗺️', 'Stage Clear', 'Clear every quest in a week', g.weeksCleared, 1),
      a('🧩', 'Half Century', 'Solve 50 problems', g.solved, 50),
      a('💯', 'Centurion', 'Solve 100 problems', g.solved, 100),
      a('🧰', 'Sharp Tools', '10 primitives at target time', g.atTarget, 10),
      a('🗡️', 'Full Arsenal', `All ${corePrims} primitives at target time`, g.atTarget, corePrims),
      a('🏟️', 'Contender', 'Sit 5 contests', g.contests, 5),
      a('🎤', 'Sparring Partner', 'Finish 5 mock interviews', g.mocks, 5),
      a('👑', 'Final Boss', 'Finish all 15 mock interviews', g.mocks, 15),
      a('🧠', 'Wide Net', 'Clear 40 concept-touch problems', g.touches, 40),
      a('🚀', 'Level 10', 'Reach level 10', g.level, 10),
    ];
  }
  // feedback when XP goes up: a floating "+N XP", and a level-up card with confetti
  let lastXP = null, lastLevel = null;
  const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  document.addEventListener('pointerdown', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, true);
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wantedHTML = (g, extra = '') => `<div class="wanted ${extra}"><span class="pin"></span><div class="w-title">WANTED</div><div class="w-photo"><span>🏴‍☠️</span></div><div class="w-doa">dead or alive</div><div class="w-name">${esc(g.rank)}</div><div class="w-bounty">${berry(g.xp)}</div></div>`;
  function celebrate(g) {
    if (lastXP !== null && g.xp > lastXP) {
      const pop = document.createElement('div'); pop.className = 'xp-pop'; pop.textContent = '+' + berryShort(g.xp - lastXP);
      document.body.appendChild(pop); setTimeout(() => pop.remove(), 1500);
      if (!calm()) {
        for (let i = 0; i < 16; i++) {
          const c = document.createElement('i'); c.className = 'coin'; c.textContent = '฿';
          const ang = Math.random() * Math.PI * 2, dist = 70 + Math.random() * 130;
          c.style.cssText = `left:${pointer.x}px;top:${pointer.y}px;--dx:${Math.cos(ang) * dist}px;--dy:${Math.sin(ang) * dist - 60}px;animation-delay:${Math.random() * 0.08}s`;
          document.body.appendChild(c); setTimeout(() => c.remove(), 1200);
        }
        document.body.classList.add('shake'); setTimeout(() => document.body.classList.remove('shake'), 420);
      }
      if (g.level > lastLevel) {
        const card = document.createElement('div'); card.className = 'levelup';
        card.innerHTML = `<div class="lu-rays"></div><div class="lu-wrap"><div class="lu-top">Bounty raised!</div>${wantedHTML(g, 'big')}<div class="lu-rank">Level ${g.level}</div></div>`;
        if (!calm()) for (let i = 0; i < 44; i++) { const c = document.createElement('i'); c.className = 'rain'; c.textContent = '฿'; c.style.cssText = `left:${Math.random() * 100}%;animation-delay:${Math.random() * 0.7}s;animation-duration:${1.3 + Math.random() * 1.2}s;font-size:${14 + Math.random() * 18}px`; card.appendChild(c); }
        document.body.appendChild(card); setTimeout(() => card.remove(), 3400);
      }
    }
    lastXP = g.xp; lastLevel = g.level;
  }
  // every hero gets a sea: sun, clouds, gulls, a ship sailing across, three layers of waves
  const SEA = '<div class="sea" aria-hidden="true"><span class="sun"></span><span class="cloud c1"></span><span class="cloud c2"></span><span class="cloud c3"></span><span class="gull g1">〰</span><span class="gull g2">〰</span><span class="ship"><span>⛵</span></span><span class="wave w1"></span><span class="wave w2"></span><span class="wave w3"></span></div>';
  function dressHeroes() { document.querySelectorAll('.hero, .page-hero').forEach((h) => { if (!h.querySelector('.sea')) h.insertAdjacentHTML('beforeend', SEA); }); }

  // ===================== Views =====================
  // Every page has the same skeleton: a hero (eyebrow, headline, lede, numbers), then sections.
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hl = (t) => `<span class="hl">${esc(t)}</span>`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const stat = (value, label, cls = '') => `<div class="s ${cls}"><div class="v">${value}</div><div class="l">${label}</div></div>`;
  function dayDone(w, day) { let n = 0; day.items.forEach((it, i) => { const p = DATA.progress[itemId(w, day.day, i)]; if (p && (p.solved || p.done)) n++; }); return n; }
  function mondayOfThisWeek() { return addDays(today(), -((new Date().getDay() + 6) % 7)); }
  // The weekday board as it applies this plan week: a `rotationUntilWeek` extra drops off after that week.
  // `since` is the date from which a log counts as "done" for that day's chips.
  function drillBoard() {
    const week = currentPosition().week;
    const monday = mondayOfThisWeek();
    return (DATA.guide.drillSchedule || []).map((d) => {
      const out = Object.assign({}, d, { since: monday });
      if (d.rotationUntilWeek && week > d.rotationUntilWeek) delete out.rotation;
      return out;
    });
  }

  // ----- Item row (shared by Today and Plan) -----
  function renderItem(w, d, i, raw) {
    const it = norm(raw); const id = itemId(w, d, i);
    if (it.type === 'task') {
      const done = isTaskDone(id);
      return `<label class="item ${done ? 'done' : ''}">
        <input type="checkbox" data-task="${id}" ${done ? 'checked' : ''}>
        <span class="name">${esc(it.name)}${it.hot ? ' <span class="hot" title="Verified high-frequency in Google interview reports">G</span>' : ''}</span>
        <span class="meta">${done ? '' : `<span class="xp">+${berryShort(itemXP(it, (weekByNum(w).days.find((x) => x.day === d) || {}).focus))}</span>`}${it.topic ? `<span class="badge accent" title="Concept touch: 25 minutes, not re-queued">${esc(it.topic)}</span>` : ''}${done ? `<span class="date">${fmt(DATA.progress[id].done)}</span>` : ''}</span></label>`;
    }
    const p = DATA.progress[id];
    const solved = !!(p && p.solved);
    const note = (p && p.note) || '';
    const open = UI.openNotes.has(id);
    let meta = '';
    if (solved) {
      meta += `<input type="date" value="${p.solved}" data-solved-date="${id}" title="Solved on">`;
      p.redos.forEach((r, ri) => {
        const cls = r.done ? 'done' : r.due < today() ? 'overdue' : r.due === today() ? 'due' : '';
        const txt = r.done ? `${r.label} ✓` : `${r.label} · ${fmt(r.due)}`;
        meta += `<button class="chip btn ${cls}" data-redo="${id}" data-redo-idx="${ri}" title="${r.done ? (r.skipped ? 'Skipped on ' : 'Re-solved on ') + fmt(r.done) + ' — click to undo' : 'Due ' + relDue(r.due) + ' — click when re-solved'}">${txt}</button>`;
      });
      meta += `<button class="chip btn" data-requeue="${id}" title="Struggled? Schedule another +3 / +14 from today">↻ redo</button>`;
    }
    if (!solved) meta += `<span class="xp">+${berryShort(itemXP(it))}</span>`;
    meta += `<button class="chip btn note-chip ${note ? 'has-note' : ''} ${open ? 'open' : ''}" data-note-toggle="${id}" title="${note ? 'Edit note' : 'Add a note (approach, trigger, what went wrong)'}">${note ? 'Note' : '+ Note'}</button>`;
    return `<div class="item ${solved ? 'done' : ''}">
      <input type="checkbox" data-solve="${id}" ${solved ? 'checked' : ''} title="${solved ? 'Unmark (removes its re-do schedule)' : 'Mark solved (schedules +3 and +14 re-solves)'}">
      <span class="name">${esc(it.name)}${it.hot ? ' <span class="hot" title="Verified high-frequency in Google interview reports">G</span>' : ''}</span>
      <span class="meta">${meta}</span></div>
      ${open ? `<div class="note-row"><textarea class="note-input" data-note="${id}" rows="3" placeholder="Approach · trigger phrase · what went wrong · variant to try">${esc(note)}</textarea></div>` : ''}`;
  }

  // ----- Today -----
  function renderDashboard() {
    const el = $('#view-dashboard');
    const pos = currentPosition();
    const probs = problems();
    const solved = probs.filter((p) => isSolved(p.id)).length;
    const redos = allRedos();
    const redosDone = redos.filter((r) => r.done && !r.skipped).length;
    const dueToday = redos.filter((r) => !r.done && r.due === today()).length;
    const overdue = redos.filter((r) => !r.done && r.due < today()).length;
    const tasks = allItems().filter((x) => x.type === 'task');
    const tasksDone = tasks.filter((t) => isTaskDone(t.id)).length;
    const st = streak();
    const onTime = redos.filter((r) => r.done && !r.skipped && r.done <= r.due).length;
    const late = redos.filter((r) => r.done && !r.skipped && r.done > r.due).length;
    const skipped = redos.filter((r) => r.skipped).length;
    const pending = redos.filter((r) => !r.done && r.due >= today()).length;
    const wk = weekByNum(pos.week);
    const todayDay = wk.days.find((d) => d.day === pos.day);
    const dueList = redos.filter((r) => !r.done && r.due <= today()).sort((a, b) => a.due.localeCompare(b.due));
    const wkStats = weekStats(wk);
    const pct = probs.length ? Math.round(100 * solved / probs.length) : 0;
    const longDate = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const isContest = !pos.before && !!todayDay && todayDay.focus === 'Contest';
    const isRest = !pos.before && !!todayDay && todayDay.focus === 'Rest';
    const rows = todayDay ? todayDay.items.map((raw, i) => ({ raw, i, it: norm(raw) })) : [];
    const gProblems = rows.filter((x) => x.it.type === 'problem');
    const gTouch = rows.filter((x) => x.it.type !== 'problem' && x.it.topic);
    const gTasks = rows.filter((x) => x.it.type !== 'problem' && !x.it.topic);
    const sched = drillBoard().find((d) => d.weekday === FULL_DAYS[new Date().getDay()]);
    const byN = Object.fromEntries(DATA.guide.primitives.map((p) => [p.n, p]));
    const monday = mondayOfThisWeek();
    const log = DATA.drillLog || [];

    const headline = pos.after ? `Plan ${hl('complete')}` : !todayDay ? 'Nothing scheduled'
      : pos.before ? `Starts ${esc(dayLabel(1, 1))}: ${hl(todayDay.focus)}`
      : isRest ? `${hl('Rest day')}. Close the laptop.` : isContest ? `Contest day: ${hl('90 minutes')}, then the post-mortem`
      : `Day ${pos.day}: ${hl(todayDay.focus)}`;
    const parts = [];
    if (gProblems.length) parts.push(plural(gProblems.length, 'new problem'));
    if (gTouch.length) parts.push(`${gTouch.length} concept-touch`);
    parts.push(dueList.length ? `${plural(dueList.length, 're-solve')} due` : 'no re-solves due');
    if (sched && sched.prims.length && !isRest) parts.push(`drills: ${sched.theme.toLowerCase()}`);

    const weekRows = wk.days.map((day) => {
      const done = dayDone(wk.week, day);
      const isToday = !pos.before && day.day === pos.day;
      const off = day.focus === 'Contest' || day.focus === 'Rest';
      return `<button class="wrow ${isToday ? 'today' : ''} ${off ? 'off' : ''}" data-go-week="${wk.week}" title="Open week ${wk.week}">
        <span class="wd">${esc(dayLabel(wk.week, day.day))}</span>
        <span class="wf">${esc(day.focus)}</span>
        <span class="segs">${day.items.map((it, i) => { const p = DATA.progress[itemId(wk.week, day.day, i)]; return `<i class="${p && (p.solved || p.done) ? 'on' : ''}"></i>`; }).join('')}</span>
        <span class="wc">${done}/${day.items.length}</span></button>`;
    }).join('');

    const block = (tag, title, hint, list) => (list.length ? `<div class="card block"><div class="block-head"><span class="block-tag">${tag}</span><h3>${title}</h3><span class="hint">${hint}</span></div>
      <div class="items">${list.map((x) => renderItem(wk.week, todayDay.day, x.i, x.raw)).join('')}</div></div>` : '');

    // countdown, discipline and the day's rule
    const endDate = planDate(lastWeek(), 7);
    const totalDays = lastWeek() * 7;
    const dayNo = pos.before ? 0 : Math.min(totalDays, diffDays(DATA.settings.startDate, today()) + 1);
    const daysLeft = pos.after ? 0 : diffDays(today(), endDate) + 1;
    const actMap = activity();
    let owed = 0, shown = 0;
    for (let k = 0; k < dayNo; k++) {
      const w = Math.floor(k / 7) + 1, d = (k % 7) + 1; const dd = weekByNum(w).days.find((x) => x.day === d);
      if (!dd || dd.focus === 'Rest') continue;
      const iso = planDate(w, d);
      if (iso === today() && !actMap[iso]) continue; // today is still open
      owed++; if (actMap[iso]) shown++;
    }
    const showedPct = owed ? Math.round(100 * shown / owed) : null;
    const RULES = [
      'Blank file. Timer on. Set sail.',
      'A captain does not skip the re-solves.',
      'The sea does not care how you feel today.',
      'Cut the new problems before you cut the re-solves.',
      'The plan only works on the days you do not feel like it.',
      'Nobody else can do these reps for you.',
      'Speed is graded. So is showing up.',
      'You do not need motivation tonight. You need the list.',
      'A skipped day is a vote for the old result.',
      'Four lines before any code. Every time.',
      'January is built in November.',
      'Do the hard one first.',
      'Say it out loud or you do not know it.',
      'The interviewer will not wait for a good mood.',
    ];
    const rule = RULES[((diffDays('2026-01-01', today()) % RULES.length) + RULES.length) % RULES.length];
    const phaseIds = Object.keys(DATA.guide.phases || {});
    const route = phaseIds.map((ph) => {
      const ws = DATA.weeks.filter((w) => String(w.phase) === ph); if (!ws.length) return '';
      const total = ws.reduce((n, w) => n + weekStats(w).total, 0), done = ws.reduce((n, w) => n + weekStats(w).done, 0);
      const first = ws[0].week, last = ws[ws.length - 1].week;
      const state = pos.after || (!pos.before && pos.week > last) ? 'done' : !pos.before && pos.week >= first ? 'now' : 'next';
      return `<div class="leg ${state}"><div class="leg-top"><span class="leg-state">${state === 'done' ? 'Conquered' : state === 'now' ? 'Anchored here' : 'Uncharted'}</span><span class="leg-weeks">Weeks ${first}${last > first ? '–' + last : ''}</span></div>
        <h3>${esc(DATA.guide.phases[ph])}</h3><p>${fmt(planDate(first, 1))} – ${fmt(planDate(last, 7))} · ${done} of ${total} problems</p>
        <div class="bar"><span style="width:${total ? Math.round(100 * done / total) : 0}%"></span></div></div>`;
    }).join('');

    const g = gameState();
    const badges = achievements(g);
    const questXP = rows.reduce((n, x) => n + itemXP(x.it, todayDay.focus), 0);
    const questLeft = rows.filter((x) => { const p = DATA.progress[itemId(wk.week, todayDay.day, x.i)]; return !(p && (p.solved || p.done)); }).reduce((n, x) => n + itemXP(x.it, todayDay.focus), 0);
    const bossHP = 100 - wkStats.pct;
    const ach = (b) => `<div class="ach ${b.done ? 'got' : ''}" title="${esc(b.desc)}"><span class="ach-ico">${b.icon}</span><div class="ach-body"><b>${esc(b.name)}</b><span>${esc(b.desc)}</span>
      <div class="bar thin"><span style="width:${Math.round(100 * b.have / b.goal)}%"></span></div></div><span class="ach-n">${b.done ? '✓' : b.have + '/' + b.goal}</span></div>`;
    const nextUp = badges.filter((b) => !b.done).sort((x, y) => y.have / y.goal - x.have / x.goal).slice(0, 4);

    const heatStart = addDays(DATA.settings.startDate, -((parse(DATA.settings.startDate).getDay() + 6) % 7));
    const heatRows = Math.ceil((diffDays(heatStart, DATA.settings.startDate) + lastWeek() * 7) / 7);

    el.innerHTML = `
      <section class="hero">
        <div>
          <span class="eyebrow">${longDate} · week ${pos.week} of ${lastWeek()}</span>
          <h1>${headline}</h1>
          <p class="lede">${parts.join(' · ')}</p>
          <div class="cta-row"><a class="btn primary cta" href="#today-list">Start today's list</a><button class="btn cta" data-go-week="${pos.week}">Open week ${pos.week}</button></div>
        </div>
        <div class="hero-side">
        <div class="player">
          ${wantedHTML(g)}
          <div class="pl-side">
            <div class="pl-rank">Level ${g.level}</div>
            <div class="bar"><span style="width:${Math.round(100 * g.into / g.need)}%"></span></div>
            <div class="pl-xp">${berryShort(g.need - g.into)} more to raise your bounty</div>
            <div class="pl-stats">
              <div title="Consecutive days with anything logged"><b>🔥 ${g.streak}</b><span>days at sea</span></div>
              <div class="${g.hp < 70 ? 'low' : ''}" title="Every overdue re-solve is a leak that costs 10 hull. Clear the queue to repair."><b>⚓ ${g.hp}</b><span>hull</span></div>
              <div title="Days left until ${fmt(endDate)}${pos.before ? '' : ' · day ' + dayNo + ' of ' + totalDays}"><b>⏳ ${daysLeft}</b><span>days to port</span></div>
              <div title="Working days so far on which something was logged"><b>${showedPct === null ? '—' : showedPct + '%'}</b><span>showed up</span></div>
            </div>
          </div>
        </div>
        </div>
      </section>
      <div class="rule"><span class="rule-tag">Captain's orders</span><p>${esc(rule)}</p></div>
      <div class="weekstrip">${wk.days.map((day) => { const done = dayDone(wk.week, day); const isT = !pos.before && day.day === pos.day; const off = day.focus === 'Contest' || day.focus === 'Rest'; const iso = planDate(wk.week, day.day);
        return `<button class="wpill ${isT ? 'today' : ''} ${off ? 'off' : ''} ${done === day.items.length ? 'complete' : ''}" data-go-week="${wk.week}" title="${esc(day.focus)}"><b>${WEEKDAYS[parse(iso).getDay()]}</b><span>${off ? esc(day.focus) : done + '/' + day.items.length}</span></button>`; }).join('')}</div>

      <section class="section" id="today-list">
        <div class="section-head left"><h2>${pos.before ? 'First' : 'Daily'} quests</h2><p>${rows.length ? `${berryShort(questXP)} in bounty on the board${questLeft && questLeft !== questXP ? ` · ${berryShort(questLeft)} still to claim` : questLeft === 0 ? ' · all claimed' : ''}. ` : ''}Short on time: cut new problems, never the re-solves.</p></div>
        <div class="grid grid-21">
          <div class="stack">
            ${isRest ? '<div class="card"><div class="empty">Rest day. Skipping it costs two weeks you do not have.</div></div>' : ''}
            ${block('A', 'New problems', '25-minute timer before any editorial', gProblems)}
            ${block('C', 'Concept touch', '25 minutes each · not re-queued', gTouch)}
            ${block(gProblems.length || gTouch.length ? '+' : '•', isContest ? 'Contest' : isRest ? 'Rest' : 'Tasks', 'tick when done', gTasks)}
            ${!todayDay ? '<div class="card"><div class="empty">Nothing scheduled</div></div>' : ''}
            <div class="card block"><div class="block-head"><span class="block-tag d">D</span><h3>Drills · ${esc(FULL_DAYS[new Date().getDay()])}</h3><button class="btn small" data-go-view="drills">Log drills</button></div>
              ${!isRest && sched && (sched.prims.length || sched.rotation) ? `<p class="muted small" style="margin-bottom:10px">${esc(sched.theme)}</p>
                <div class="row wrap" style="gap:6px">${sched.prims.map((n) => { const p = byN[n]; if (!p) return ''; const done = log.some((l) => l.name === p.name && l.date >= sched.since); return `<span class="chip ${done ? 'done' : ''}" title="${esc(p.name)} · target ${p.target} min">#${n} ${esc(p.short || p.name)}</span>`; }).join('')}
                ${(sched.optional || []).map((n) => { const p = byN[n]; if (!p) return ''; const done = log.some((l) => l.name === p.name && l.date >= sched.since); return `<span class="chip ${done ? 'done' : ''}" title="${esc(p.name)} · target ${p.target} min">#${n} ${esc(p.short || p.name)} · optional</span>`; }).join('')}
                ${sched.rotation ? `<span class="chip ${log.some((l) => l.name === sched.rotation && l.date >= monday) ? 'done' : 'due'}">${esc(sched.rotation)}</span>` : ''}</div>`
                : '<div class="empty">No drills today</div>'}</div>
          </div>
          <div class="stack">
            <div class="card block"><div class="block-head"><span class="block-tag b">B</span><h3>Re-solves due</h3><button class="btn small" data-go-view="revision">Full queue</button></div>
              ${dueList.length ? dueList.slice(0, 6).map(renderQueueRow).join('') + (dueList.length > 6 ? `<div class="muted small" style="margin-top:8px">+${dueList.length - 6} more in the queue</div>` : '')
                : `<div class="empty">Queue clear${pending ? ` · ${pending} upcoming` : ''}</div>`}</div>
            <div class="card boss ${bossHP === 0 ? 'down' : ''}"><div class="boss-top"><span class="boss-tag">☠ Island ${wk.week} boss</span><span class="boss-hp">${bossHP === 0 ? 'Defeated' : bossHP + ' HP'}</span></div>
              <h3>${esc(wk.title)}</h3>
              <div class="bar"><span style="width:${bossHP}%"></span></div>
              <p>${wk.checkpoint ? esc(wk.checkpoint) : 'Clear every problem this week to bring it down.'}</p></div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="section-head left"><h2>Treasure chest</h2><p>${badges.filter((b) => b.done).length} of ${badges.length} unlocked · closest next</p></div>
        <div class="badges">${nextUp.map(ach).join('')}</div>
        <details class="more"><summary>All ${badges.length} treasures</summary><div class="badges">${badges.map(ach).join('')}</div></details>
      </section>

      <section class="mission">
        <div class="section-head"><span class="eyebrow">The voyage</span><h2>Eleven islands. One treasure. ${hl('Ready by ' + fmt(endDate) + '.')}</h2>
          <p>One virtual coding round, one Googleyness round, two in-person coding rounds. Each day on this page is a deposit toward those four hours.</p></div>
        <div class="route">${route}<div class="leg goal"><div class="leg-top"><span class="leg-state">The treasure</span><span class="leg-weeks">${fmt(endDate)}</span></div><h3>The Google offer</h3><p>Unseen medium in 25 minutes, spoken aloud, bug-free first run.</p></div></div>
      </section>

      <section class="band">
        <div class="section-head"><h2>Your ${hl('progress')}</h2><p>${redosDone} of ${redos.length} scheduled re-solves done · ${tasksDone} of ${tasks.length} tasks ticked</p></div>
        <div class="grid grid-3">
          <div class="card progress-card"><div class="card-title"><h3>Plan</h3><span class="hint">${lastWeek()} weeks</span></div>
            <div class="pc-top"><canvas id="c-overall" class="chart"></canvas>
              <div class="pc-nums">
                <div class="pc-num"><span class="muted">Problems</span><b>${solved} / ${probs.length}</b></div>
                <div class="pc-num"><span class="muted">Re-solves</span><b>${redosDone} / ${redos.length}</b></div>
                <div class="pc-num"><span class="muted">Tasks</span><b>${tasksDone} / ${tasks.length}</b></div>
                <div class="pc-num"><span class="muted">Notes</span><b>${Object.values(DATA.progress).filter((p) => p.note && p.note.trim()).length}</b></div>
              </div></div></div>
          <div class="card"><div class="card-title"><h3>Revision discipline</h3><span class="hint">+3 / +14</span></div>
            <canvas id="c-revision" class="chart short"></canvas>
            <div class="legend"><span><i style="background:var(--green)"></i>On time ${onTime}</span><span><i style="background:var(--amber)"></i>Late ${late}</span><span><i style="background:var(--red)"></i>Overdue ${overdue}</span><span><i style="background:var(--blue)"></i>Pending ${pending}</span><span><i style="background:var(--track)"></i>Skipped ${skipped}</span></div></div>
          <div class="card"><div class="card-title"><h3>Activity heatmap</h3><span class="hint">from ${fmt(heatStart)}</span></div>
            <canvas id="c-heat" class="chart tall"></canvas></div>
        </div>
        <details class="more"><summary>More charts</summary><div class="grid grid-2">
          <div class="card"><div class="card-title"><h3>Last 28 days</h3><span class="hint">solves per day</span></div>
            <canvas id="c-activity" class="chart"></canvas>
            <div class="legend"><span><i style="background:var(--accent)"></i>New solves</span><span><i style="background:var(--green)"></i>Re-solves</span></div></div>
          <div class="card"><div class="card-title"><h3>Completion by week</h3><span class="hint">% of each week's problems</span></div>
            <canvas id="c-weeks" class="chart"></canvas></div>
        </div></details>
      </section>`;

    Charts.donut($('#c-overall'), [{ value: solved, color: cssVar('--accent') }, { value: probs.length - solved, color: 'transparent' }], `${pct}%`, 'solved');
    const graded = onTime + late + overdue + skipped;
    Charts.donut($('#c-revision'), [
      { value: onTime, color: cssVar('--green') }, { value: late, color: cssVar('--amber') }, { value: overdue, color: cssVar('--red') },
      { value: pending, color: cssVar('--blue') }, { value: skipped, color: cssVar('--track') },
    ], graded ? `${Math.round(100 * onTime / graded)}%` : '—', graded ? 'on time' : redos.length ? `${pending} scheduled` : 'nothing yet');
    const act = activity();
    const labels = [], sNew = [], sRedo = [];
    for (let i = 27; i >= 0; i--) { const d = addDays(today(), -i); labels.push(fmt(d)); sNew.push(act[d] ? act[d].solved : 0); sRedo.push(act[d] ? act[d].redos : 0); }
    Charts.lines($('#c-activity'), labels, [{ name: 'new', color: cssVar('--accent'), values: sNew }, { name: 'redo', color: cssVar('--green'), values: sRedo }], { minMax: 3 });
    Charts.bars($('#c-weeks'), DATA.weeks.map((w) => ({ label: 'W' + w.week, value: weekStats(w).pct, color: phaseColor(w.phase), highlight: w.week === pos.week ? cssVar('--green') : null })), { yMax: 100, yFormat: (v) => v + '%' });
    const cells = [];
    for (let w = 0; w < heatRows; w++) for (let d = 0; d < 7; d++) {
      const date = addDays(heatStart, w * 7 + d); const a = act[date];
      cells.push({ value: a ? a.solved + a.redos + a.tasks + a.drills : 0, rowLabel: fmt(date), future: date > today(), today: date === today() });
    }
    Charts.heatmap($('#c-heat'), cells);
  }

  // ----- Plan: week stepper + day timeline -----
  function renderRoadmap() {
    const el = $('#view-roadmap');
    const pos = currentPosition();
    const wk = weekByNum(UI.week);
    const stats = weekStats(wk);
    const idx = DATA.weeks.indexOf(wk);
    const prev = DATA.weeks[idx - 1], next = DATA.weeks[idx + 1];
    const stepper = DATA.weeks.map((w) => {
      const s = weekStats(w);
      const cls = [w.week === UI.week ? 'active' : '', !pos.before && w.week === pos.week ? 'current' : '', s.pct === 100 ? 'complete' : '', 'ph' + w.phase].join(' ');
      const short = w.title.split(/\s[—–-]\s|,|&/)[0].trim();
      return `<button class="step ${cls}" data-week="${w.week}" title="Week ${w.week} — ${esc(w.title)} · ${s.pct}%">
        <span class="step-dot">${s.pct === 100 ? '✓' : w.week}</span><span class="step-label">${esc(short)}</span><span class="step-pct">${s.pct}%</span></button>`;
    }).join('');
    const days = wk.days.map((day) => {
      const isToday = !pos.before && wk.week === pos.week && day.day === pos.day;
      const off = day.focus === 'Contest' || day.focus === 'Rest';
      const done = dayDone(wk.week, day);
      const iso = planDate(wk.week, day.day);
      return `<div class="tl-day ${isToday ? 'today' : ''} ${off ? 'off' : ''} ${done === day.items.length ? 'complete' : ''}">
        <div class="tl-date"><b>${WEEKDAYS[parse(iso).getDay()]}</b><span>${fmt(iso)}</span>${isToday ? '<span class="badge accent">today</span>' : ''}</div>
        <div class="tl-rail"><span class="tl-dot">${done === day.items.length ? '✓' : ''}</span></div>
        <div class="card day-card"><div class="day-head"><span class="dn">${esc(day.focus)}</span><span class="df">${done} / ${day.items.length} done</span></div>
          <div class="items">${day.items.map((it, i) => renderItem(wk.week, day.day, i, it)).join('')}</div></div>
      </div>`;
    }).join('');
    el.innerHTML = `
      <section class="page-hero">
        <div>
          <span class="eyebrow">Island ${wk.week} of ${lastWeek()} · ${esc(phaseName(wk.phase))} · ${fmt(planDate(wk.week, 1))} – ${fmt(planDate(wk.week, 7))}</span>
          <h1>Week ${wk.week}: ${hl(wk.title)}</h1>
          <p class="lede">${stats.total ? `${stats.done} of ${plural(stats.total, 'problem')} solved` : `${stats.tasksDone} of ${plural(stats.tasks, 'task')} done`} · ${stats.pct}%${wk.week === pos.week && !pos.before ? ' · this is the current week' : ''}</p>
        </div>
        <div class="hero-actions">
          <button class="btn" data-week="${prev ? prev.week : wk.week}" ${prev ? '' : 'disabled'}>← Week ${prev ? prev.week : ''}</button>
          <button class="btn" data-week="${next ? next.week : wk.week}" ${next ? '' : 'disabled'}>Week ${next ? next.week : ''} →</button>
          ${wk.week !== pos.week ? `<button class="btn primary" data-week="${pos.week}">Current week</button>` : ''}
        </div>
      </section>
      <div class="stepper" style="--weeks:${DATA.weeks.length}">${stepper}</div>
      <section class="section"><div class="timeline">${days}</div></section>
      ${(wk.notes && wk.notes.length) || wk.checkpoint ? `<section class="band"><div class="section-head"><h2>Week ${wk.week} ${hl('notes')}</h2><p>What this week is teaching, and the bar to clear before moving on.</p></div>
        <div class="notes-grid">${(wk.notes || []).map((x) => `<div class="note">${esc(x)}</div>`).join('')}${wk.checkpoint ? `<div class="note checkpoint">${esc(wk.checkpoint)}</div>` : ''}</div></section>` : ''}`;
  }

  // ----- Revision -----
  function renderQueueRow(r) {
    const cls = r.done ? 'done' : r.due < today() ? 'overdue' : r.due === today() ? 'due' : '';
    return `<div class="qrow">
      <div><div class="qname">${esc(r.item.name)}</div><div class="qsub">W${r.item.week} D${r.item.day} · ${esc(r.item.focus)} · solved ${fmt(DATA.progress[r.id].solved)}</div></div>
      <span class="chip ${cls}">${r.label} · ${r.done ? (r.skipped ? 'skipped ' : 'done ') + fmt(r.done) : fmt(r.due) + ' · ' + relDue(r.due)}</span>
      ${r.done ? `<button class="btn small ghost" data-redo="${r.id}" data-redo-idx="${r.idx}">Undo</button><span></span>`
        : `<button class="btn small primary" data-redo="${r.id}" data-redo-idx="${r.idx}">Re-solved</button><button class="btn small ghost" data-skip="${r.id}" data-redo-idx="${r.idx}" title="Mark as skipped (counts against discipline)">Skip</button>`}
    </div>`;
  }
  function renderRevision() {
    const el = $('#view-revision');
    const redos = allRedos();
    const t = today();
    const byDue = (a, b) => a.due.localeCompare(b.due);
    const overdue = redos.filter((r) => !r.done && r.due < t).sort(byDue);
    const dueToday = redos.filter((r) => !r.done && r.due === t);
    const week = redos.filter((r) => !r.done && r.due > t && diffDays(t, r.due) <= 7).sort(byDue);
    const later = redos.filter((r) => !r.done && diffDays(t, r.due) > 7).sort(byDue);
    const completed = redos.filter((r) => r.done).sort((a, b) => b.done.localeCompare(a.done)).slice(0, 15);
    const onTime = redos.filter((r) => r.done && !r.skipped && r.done <= r.due).length;
    const graded = redos.filter((r) => r.done || r.due < t).length;
    const dueNow = overdue.length + dueToday.length;
    const dates = [...new Set(week.map((r) => r.due))];
    const group = (title, hint, body) => `<div class="card queue-group"><div class="card-title"><h3>${title}</h3><span class="hint">${hint}</span></div>${body}</div>`;
    el.innerHTML = `
      <section class="page-hero">
        <div>
          <span class="eyebrow">Block B · every day, even bad days</span>
          <h1>${dueNow ? `${hl(plural(dueNow, 're-solve'))} due now` : `Revision queue ${hl('clear')}`}</h1>
          <p class="lede">Every solved problem comes back at +3 and +14 days. Re-solve from a blank file inside 12 minutes, then mark it. Could not finish, or cannot state the invariant: use ↻ redo on the problem instead.</p>
          <div class="statline">
            ${stat(overdue.length, 'overdue', overdue.length ? 'bad' : '')}
            ${stat(dueToday.length, 'due today', dueToday.length ? 'warn' : '')}
            ${stat(week.length, 'next 7 days')}
            ${stat(graded ? Math.round(100 * onTime / graded) + '<small>%</small>' : '—', 'done on time')}
          </div>
        </div>
      </section>
      <section class="section"><div class="grid grid-21">
        <div class="stack">
          ${group('Due now', dueNow ? plural(dueNow, 'problem') : 'nothing waiting', dueNow ? (overdue.length ? `<div class="date-head bad">Overdue</div>${overdue.map(renderQueueRow).join('')}` : '') + (dueToday.length ? `<div class="date-head">Today</div>${dueToday.map(renderQueueRow).join('')}` : '') : '<div class="empty">Queue clear. Solve something new and it will come back in 3 days.</div>')}
          ${group('Next 7 days', plural(week.length, 're-solve'), week.length ? dates.map((d) => `<div class="date-head">${WEEKDAYS[parse(d).getDay()]} ${fmt(d)} · ${relDue(d)}</div>${week.filter((r) => r.due === d).map(renderQueueRow).join('')}`).join('') : '<div class="empty">Nothing scheduled this week</div>')}
        </div>
        <div class="stack">
          ${group('Later', plural(later.length, 're-solve'), later.length ? later.slice(0, 12).map((r) => `<div class="mini-row"><span>${esc(r.item.name)}</span><span class="chip">${r.label} · ${fmt(r.due)}</span></div>`).join('') + (later.length > 12 ? `<div class="muted small" style="margin-top:8px">+${later.length - 12} more</div>` : '') : '<div class="empty">Nothing further out</div>')}
          ${group('Recently completed', `last ${completed.length}`, completed.length ? completed.map((r) => `<div class="mini-row"><span>${esc(r.item.name)}</span><span class="row" style="gap:6px"><span class="chip ${r.skipped ? '' : 'done'}">${r.label} · ${r.skipped ? 'skipped' : 'done'} ${fmt(r.done)}</span><button class="btn small ghost" data-redo="${r.id}" data-redo-idx="${r.idx}">Undo</button></span></div>`).join('') : '<div class="empty">Nothing completed yet</div>')}
        </div>
      </div></section>`;
  }

  // ----- Drills -----
  function renderDrills() {
    const el = $('#view-drills');
    const pos = currentPosition();
    const log = DATA.drillLog || [];
    const monday = mondayOfThisWeek();
    const todayName = FULL_DAYS[new Date().getDay()];
    const byN = Object.fromEntries(DATA.guide.primitives.map((p) => [p.n, p]));
    const info = DATA.guide.primitives.map((p) => {
      const mine = log.filter((l) => l.name === p.name);
      const last = mine.length ? mine[mine.length - 1] : null;
      const best = mine.filter((l) => l.minutes).reduce((b, l) => (b === null || l.minutes < b ? l.minutes : b), null);
      return { p, mine, last, best, lastMin: last && last.minutes ? last.minutes : null, optional: /\(optional\)/.test(p.name) };
    });
    const core = info.filter((x) => !x.optional);
    const atTarget = core.filter((x) => x.lastMin !== null && x.lastMin <= x.p.target).length;
    const never = core.filter((x) => !x.mine.length).length;
    const thisWeek = log.filter((l) => l.date >= monday).length;

    const chip = (n, since, optional) => { const p = byN[n]; if (!p) return ''; const done = log.some((l) => l.name === p.name && l.date >= since); return `<span class="chip ${done ? 'done' : ''}" title="${esc(p.name)} · target ${p.target} min">#${n} ${esc(p.short || p.name)}${optional ? ' · optional' : ''}</span>`; };
    const board = drillBoard().map((d) => `<div class="card wk-col ${d.weekday === todayName ? 'today' : ''}">
        <div class="wk-day">${esc(d.weekday)}${d.weekday === todayName ? ' <span class="badge accent">today</span>' : ''}</div>
        <div class="wk-theme">${esc(d.theme)}</div>
        <div class="wk-chips">${d.prims.map((n) => chip(n, d.since)).join('')}${(d.optional || []).map((n) => chip(n, d.since, true)).join('')}${d.rotation ? `<span class="chip ${log.some((l) => l.name === d.rotation && l.date >= monday) ? 'done' : 'due'}">${esc(d.rotation)}</span>` : ''}</div>
        <p class="wk-why">${esc(d.why || '')}</p></div>`).join('');

    const pcard = (x) => {
      const p = x.p; const key = esc(p.name);
      const sched = (DATA.guide.drillSchedule || []).find((d) => d.prims.includes(p.n) || (d.optional || []).includes(p.n));
      const status = x.lastMin !== null ? `<span class="badge ${x.lastMin <= p.target ? 'green' : 'amber'}">${x.lastMin <= p.target ? 'at target' : `${dur(x.lastMin - p.target)} over`}</span>` : x.mine.length ? '<span class="badge">logged</span>' : '<span class="badge">not drilled yet</span>';
      const tm = TIMERS[p.name]; const ms = tm ? timerMs(tm) : 0;
      const logRow = !tm
        ? `<div class="pc-log"><button class="btn small primary" data-timer-start="${key}" title="Start the stopwatch for this drill">▶ Start</button><input type="number" min="1" max="120" placeholder="min" aria-label="Minutes taken (manual entry)" data-minutes="${key}"><button class="btn small" data-drill="${key}" title="Log without the timer">Log</button></div>`
        : `<div class="pc-log timing ${tm.running ? 'running' : 'stopped'}"><span class="pc-clock ${ms > p.target * 60000 ? 'over' : ''}" data-timer-display="${key}" data-target="${p.target}">${clock(ms)}</span>
            ${tm.running ? `<button class="btn small primary" data-timer-stop="${key}">Stop</button>` : `<button class="btn small primary" data-timer-log="${key}">Log ${clock(ms)}</button>`}
            <button class="btn small" data-timer-start="${key}" title="Throw this attempt away and start again from 0:00">Restart</button>
            <button class="btn small ghost" data-timer-discard="${key}" title="Discard this attempt without logging" aria-label="Discard this attempt">✕</button></div>`;
      return `<div class="card pcard ${sched && sched.weekday === todayName ? 'today' : ''} ${tm ? 'timing' : ''}">
        <div class="pc-head"><span class="pc-n">#${p.n}</span>${sched ? `<span class="pc-day">${esc(sched.weekday.slice(0, 3))}</span>` : ''}${status}</div>
        <div class="pc-name">${key}</div>
        <div class="pc-meta">Target ${p.target} min${x.mine.length ? ` · ${x.mine.length}× · last ${fmt(x.last.date)}${x.best !== null ? ` · best ${dur(x.best)}` : ''}` : ''}</div>
        ${p.test && p.test.length ? `<div class="pc-test">Test on: ${p.test.map((t) => `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.label)}</a>`).join(' · ')}</div>` : ''}
        ${logRow}
      </div>`;
    };
    const rotation = (DATA.guide.drills || []).map((d) => {
      const mine = log.filter((l) => l.name === d.name); const key = esc(d.name);
      return `<div class="card rcard"><div class="card-title"><h3>${key}${d.star ? ' <span class="badge accent">most Google-specific</span>' : ''}</h3><button class="btn small" data-drill="${key}">Log</button></div>
        <div class="pc-meta">${esc(d.when)}${mine.length ? ` · ${mine.length}× · last ${fmt(mine[mine.length - 1].date)}` : ''}</div><p class="rtext">${esc(d.text)}</p></div>`;
    }).join('');
    const recent = log.slice(-10).reverse();
    const perWeek = [];
    for (let w = 0; w < lastWeek(); w++) {
      const a = addDays(DATA.settings.startDate, w * 7), b = addDays(a, 6);
      perWeek.push({ label: 'W' + (w + 1), value: log.filter((l) => l.date >= a && l.date <= b).length, highlight: w + 1 === pos.week ? cssVar('--green') : null });
    }
    el.innerHTML = `
      <section class="page-hero">
        <div>
          <span class="eyebrow">Block D · 20 minutes a day</span>
          <h1>Blind ${hl('primitives')}, on a timer</h1>
          <p class="lede">${esc(DATA.guide.primitivesGoal)}</p>
          <div class="statline">
            ${stat(`${atTarget}<small>/ ${core.length}</small>`, 'at target time')}
            ${stat(thisWeek, 'logged this week')}
            ${stat(never, 'never drilled', never ? 'warn' : '')}
            ${stat(log.length, 'attempts in total')}
          </div>
        </div>
      </section>
      <section class="section">
        <div class="section-head left"><h2>The week, by weekday</h2><p>Five topics a day, the same every week. No primitive comes up twice. A chip turns green once logged this week.</p></div>
        <div class="wk-board">${board}</div>
      </section>
      <section class="section">
        <div class="section-head left"><h2>All primitives</h2><p>Start the timer, write it from a blank file, submit it to the test problem, then stop and log. Nothing is logged until you press Log, so restart a botched attempt freely.</p></div>
        <div class="pgrid">${info.map(pcard).join('')}</div>
      </section>
      <section class="section"><details class="more"><summary>Rotation drills · the weekday extras</summary>
        <div class="grid grid-3">${rotation}</div>
        ${DATA.guide.bugLog ? `<p class="muted small" style="margin-top:18px;text-align:center">${esc(DATA.guide.bugLog)}</p>` : ''}
      </details></section>
      <section class="section"><div class="grid grid-2">
        <div class="card"><div class="card-title"><h3>Drills per week</h3><span class="hint">logged attempts</span></div><canvas id="c-drills" class="chart short"></canvas>
          <div class="card-title" style="margin-top:18px"><h3>Variant prompts</h3><span class="hint">after every solve</span></div>
          <div class="row wrap" style="gap:6px">${DATA.guide.variantPrompts.map((v) => `<span class="chip">${esc(v)}</span>`).join('')}</div></div>
        <div class="card"><div class="card-title"><h3>Recent log</h3><span class="hint">last ${recent.length}</span></div>${recent.length ? `<table><tr><th>Date</th><th>Drill</th><th>Time</th><th></th></tr>
          ${recent.map((l) => `<tr><td>${fmt(l.date)}</td><td>${esc(l.name)}</td><td>${l.minutes ? dur(l.minutes) : '—'}</td><td><button class="btn small ghost" data-del-drill="${log.indexOf(l)}" aria-label="Delete this log entry">✕</button></td></tr>`).join('')}</table>` : '<div class="empty">No drills logged yet</div>'}</div>
      </div></section>`;
    Charts.bars($('#c-drills'), perWeek, { yMax: Math.max(4, ...perWeek.map((p) => p.value)), ticks: 2 });
  }

  // ----- Notes -----
  function renderNotes() {
    const n = DATA.notes;
    const byId = Object.fromEntries(allItems().map((x) => [x.id, x]));
    const probNotes = Object.entries(DATA.progress).filter(([, p]) => p.note && p.note.trim()).map(([id, p]) => ({ id, item: byId[id], note: p.note })).filter((x) => x.item)
      .sort((a, b) => a.item.week - b.item.week || a.item.day - b.item.day || a.item.idx - b.item.idx);
    const journal = (n.journal || []).map((e, i) => ({ ...e, i })).sort((a, b) => b.date.localeCompare(a.date));
    const triggerLines = (n.triggers || '').split('\n').filter((l) => l.trim()).length;
    $('#view-notes').innerHTML = `
      <section class="page-hero">
        <div>
          <span class="eyebrow">Saved in data.json as you type</span>
          <h1>Notes, ${hl('triggers')} and journal</h1>
          <p class="lede">What you write after a miss is what stops the next one: a trigger line for the pattern, a note on the problem, a journal entry for the day.</p>
          <div class="statline">${stat(triggerLines, 'trigger lines')}${stat(probNotes.length, 'problem notes')}${stat(journal.length, 'journal entries')}</div>
        </div>
      </section>
      <section class="section"><div class="grid grid-2">
        <div class="stack">
          <div class="card"><div class="card-title"><h3>Trigger notes</h3><span class="hint">cue → pattern, one per line</span></div>
            <textarea class="note-input mono" data-triggers rows="14" placeholder="${esc(DATA.guide.triggers.map((t) => `${t.cue}  →  ${t.pattern}`).join('\n'))}">${esc(n.triggers || '')}</textarea>
            <p class="muted small" style="margin-top:8px">Add a line every time an editorial teaches you a shape you should have recognised.</p></div>
          <div class="card"><div class="card-title"><h3>Problem notes</h3><span class="hint">${plural(probNotes.length, 'note')}</span></div>
            ${probNotes.length ? probNotes.map((x) => `<div class="pnote"><div class="row spread"><b>${esc(x.item.name)}</b><button class="btn small ghost" data-go-week="${x.item.week}" data-open-note="${x.id}">Week ${x.item.week} →</button></div><div class="pnote-text">${esc(x.note)}</div></div>`).join('')
              : '<div class="empty">Use “+ Note” on any problem in the Plan. They all collect here.</div>'}</div>
        </div>
        <div class="card"><div class="card-title"><h3>Journal</h3><button class="btn small primary" id="btn-add-journal">+ Today</button></div>
          <p class="muted small" style="margin-bottom:6px">Post-mortems, contest notes, what to fix tomorrow.</p>
          <div class="jlist">${journal.length ? journal.map((e) => `<div class="jentry">
              <div class="row spread"><input type="date" value="${e.date}" data-journal-date="${e.i}" aria-label="Entry date"><button class="btn small ghost" data-del-journal="${e.i}" aria-label="Delete entry">✕</button></div>
              <textarea class="note-input" rows="4" data-journal="${e.i}" placeholder="What happened, what to change…">${esc(e.text || '')}</textarea></div>`).join('')
            : '<div class="empty">No entries yet</div>'}</div></div>
      </div></section>`;
  }

  // ----- Guide: contents rail + sections -----
  function renderGuide() {
    const g = DATA.guide;
    const ol = (arr) => `<ol>${(arr || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`;
    const tbl = (rows) => `<table><tr><th>Block</th><th>Time</th><th>What</th></tr>${(rows || []).map((b) => `<tr><td><b>${esc(b.block)}</b></td><td>${esc(b.duration)}</td><td>${esc(b.content)}</td></tr>`).join('')}</table>`;
    const sections = [
      g.research && ['g-research', 'The Google process now', `<div class="notes-grid">${g.research.map((r) => `<div class="note"><b>${esc(r.title)}</b><div style="margin-top:4px">${esc(r.text)}</div></div>`).join('')}</div>`],
      ['g-rules', 'The rules', ol(g.rules)],
      ['g-daily', 'Daily template · weeks 1–6', tbl(g.dailyTemplate) + `<ul style="margin-top:10px">${(g.dailyNotes || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`],
      ['g-conv', 'Daily template · weeks 7–11', tbl(g.phase2Template)],
      g.topicFrequency && ['g-topics', 'Topic frequency', `<table><tr><th>Topic</th><th>Share</th><th>Difficulty</th><th>In this plan</th></tr>${g.topicFrequency.map((t) => `<tr><td>${esc(t.topic)}</td><td><b>${esc(t.share)}</b></td><td>${esc(t.difficulty)}</td><td>${esc(t.weeks)}</td></tr>`).join('')}</table><p class="muted small" style="margin-top:8px">Shares from ~600 reported Google problems, 2022–2025.</p>`],
      g.drills && ['g-drills', 'The drills', `<div class="notes-grid">${g.drills.map((d) => `<div class="note ${d.star ? 'checkpoint plain' : ''}"><b>${esc(d.name)}</b> <span class="muted small">· ${esc(d.when)}</span><div style="margin-top:4px">${esc(d.text)}</div></div>`).join('')}</div>`],
      ['g-triggers', 'Trigger notes', `<div class="trig">${g.triggers.map((t) => `<span class="cue">${esc(t.cue)}</span><span>${esc(t.pattern)}</span>`).join('')}</div>${g.triage ? `<p class="muted small" style="margin-top:12px"><b>Triage card</b> (90 s per problem): ${g.triage.map(esc).join(' · ')}</p>` : ''}`],
      ['g-verbal', 'The verbal protocol', `<p class="muted small">Every problem. Record yourself and watch it back.</p>${ol(g.verbalProtocol)}`],
      ['g-exit', 'Exit criteria', ol(g.exitCriteria)],
      ['g-fail', 'Failure modes, ranked', ol(g.failureModes)],
      g.googleyness && ['g-google', 'Googleyness stories', ol(g.googleyness)],
      g.recruiter && ['g-recruiter', 'Ask your recruiter', ol(g.recruiter) + (g.scope ? `<p class="muted small" style="margin-top:10px">${esc(g.scope)}</p>` : '')],
      ['g-resources', 'Resources', `<table><tr><th>Resource</th><th>Use it for</th></tr>${g.resources.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.use)}</td></tr>`).join('')}</table>${g.excluded ? `<p class="muted small" style="margin-top:10px">${esc(g.excluded)}</p>` : ''}`],
    ].filter(Boolean);
    $('#view-guide').innerHTML = `
      <section class="page-hero">
        <div>
          <span class="eyebrow">Read once, then follow it</span>
          <h1>The ${hl('guide')}</h1>
          <p class="lede">${esc(g.intro)}</p>
        </div>
      </section>
      <section class="section guide">
        <nav class="toc" aria-label="Guide contents"><div class="toc-title">On this page</div>${sections.map(([id, title]) => `<a href="#${id}">${esc(title)}</a>`).join('')}</nav>
        <div class="stack">${sections.map(([id, title, html]) => `<article class="card gsec" id="${id}"><h2>${esc(title)}</h2>${html}</article>`).join('')}</div>
      </section>`;
  }

  // ----- Settings -----
  function renderSettings() {
    const s = DATA.settings;
    const solvedCount = Object.values(DATA.progress).filter((p) => p.solved).length;
    $('#view-settings').innerHTML = `
      <section class="page-hero">
        <div>
          <span class="eyebrow">${fileHandle && writable ? `Saving to ${esc(fileHandle.name)}` : 'Not linked — changes are not being saved'}</span>
          <h1>Settings and ${hl('storage')}</h1>
          <p class="lede">Everything lives in <code>data.json</code> next to <code>index.html</code>. Nothing is kept in the browser, so copy or sync the folder and open it anywhere.</p>
        </div>
      </section>
      <section class="section"><div class="grid grid-3">
        <div class="card"><h3>Plan</h3>
          <div class="field" style="margin-top:14px"><label for="set-start">Plan start date (day 1 of week 1)</label><input type="date" id="set-start" value="${s.startDate}"></div>
          <div class="field"><label for="set-offsets">Re-solve offsets (days, comma-separated)</label><input type="text" id="set-offsets" value="${(s.redoOffsets || [3, 14]).join(', ')}"></div>
          <button class="btn primary" id="set-save">Save settings</button></div>
        <div class="card"><h3>Storage</h3>
          <p class="muted small" style="margin-top:8px">Linked file: <b>${fileHandle && writable ? esc(fileHandle.name) : 'none'}</b>${DATA.updatedAt ? ` · last saved ${new Date(DATA.updatedAt).toLocaleString()}` : ''}. If Chrome asks for access again, choose <b>“Allow on every visit”</b>.</p>
          <div class="row wrap" style="margin-top:14px">
            <button class="btn ${writable ? '' : 'primary'}" id="btn-switch">${writable ? 'Link a different file' : 'Link data.json'}</button>
            <button class="btn" id="btn-reload" ${writable ? '' : 'disabled'}>Reload from file</button>
            <button class="btn ghost" id="btn-export">Download a copy</button>
          </div></div>
        <div class="card"><h3>Danger zone</h3>
          <p class="muted small" style="margin-top:8px">${plural(solvedCount, 'problem')} marked solved, ${plural(Object.keys(DATA.progress).length, 'progress entry').replace('entrys', 'entries')}, ${plural((DATA.drillLog || []).length, 'drill log')}.</p>
          <button class="btn danger" id="btn-reset" style="margin-top:14px">Reset all progress</button></div>
      </div></section>`;
  }

  // ---------- events (delegated) ----------
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]'); if (!b || !DATA) return;
    UI.view = b.dataset.view; render(); window.scrollTo(0, 0);
  });

  let resetArmed = false;
  document.getElementById('app').addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('a[href]')) return; // plain links (drill test problems) always work
    if (!writable) { e.preventDefault(); return linkOnGesture(); }
    const goWeek = t.closest('[data-go-week]'); if (goWeek) { UI.week = Number(goWeek.dataset.goWeek); UI.view = 'roadmap'; if (goWeek.dataset.openNote) UI.openNotes.add(goWeek.dataset.openNote); return render(); }
    const nt = t.closest('[data-note-toggle]'); if (nt) { const id = nt.dataset.noteToggle; if (UI.openNotes.has(id)) UI.openNotes.delete(id); else UI.openNotes.add(id); render(); const ta = document.querySelector(`[data-note="${id}"]`); if (ta) ta.focus(); return; }
    if (t.id === 'btn-add-journal') { DATA.notes.journal.push({ date: today(), text: '' }); save(); render(); const ta = document.querySelector(`[data-journal="${DATA.notes.journal.length - 1}"]`); if (ta) ta.focus(); return; }
    const dj = t.closest('[data-del-journal]'); if (dj) { DATA.notes.journal.splice(Number(dj.dataset.delJournal), 1); save(); return render(); }
    const goView = t.closest('[data-go-view]'); if (goView) { UI.view = goView.dataset.goView; return render(); }
    const wk = t.closest('[data-week]'); if (wk && !wk.disabled) { UI.week = Number(wk.dataset.week); return render(); }
    const redo = t.closest('[data-redo]'); if (redo) return toggleRedo(redo.dataset.redo, Number(redo.dataset.redoIdx));
    const skip = t.closest('[data-skip]'); if (skip) return toggleRedo(skip.dataset.skip, Number(skip.dataset.redoIdx), true);
    const rq = t.closest('[data-requeue]'); if (rq) return requeue(rq.dataset.requeue);
    const ts = t.closest('[data-timer-start]'); if (ts) return timerStart(ts.dataset.timerStart);
    const tp = t.closest('[data-timer-stop]'); if (tp) return timerStop(tp.dataset.timerStop);
    const tl = t.closest('[data-timer-log]'); if (tl) return timerLog(tl.dataset.timerLog);
    const td = t.closest('[data-timer-discard]'); if (td) return timerDiscard(td.dataset.timerDiscard);
    const drill = t.closest('[data-drill]'); if (drill) {
      const inp = document.querySelector(`[data-minutes="${CSS.escape(drill.dataset.drill)}"]`);
      return logDrill(drill.dataset.drill, inp && inp.value);
    }
    const dd = t.closest('[data-del-drill]'); if (dd) { DATA.drillLog.splice(Number(dd.dataset.delDrill), 1); save(); return render(); }
    if (t.id === 'set-save') {
      const start = $('#set-start').value; if (start) DATA.settings.startDate = start;
      const offs = $('#set-offsets').value.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0);
      if (offs.length) DATA.settings.redoOffsets = offs;
      save(); toast('Settings saved'); return render();
    }
    if (t.id === 'btn-export') return downloadCopy();
    if (t.id === 'btn-switch') { pickFile().then(() => { toast('Switched to ' + fileHandle.name); render(); }).catch((err) => { if (err.name !== 'AbortError') toast(err.message); }); return; }
    if (t.id === 'btn-reload') { readFromHandle().then(() => { toast('Reloaded from ' + fileHandle.name); render(); }).catch((err) => toast(err.message)); return; }
    if (t.id === 'btn-reset') {
      if (!resetArmed) { resetArmed = true; t.textContent = 'Click again to confirm reset'; setTimeout(() => { resetArmed = false; if (document.body.contains(t)) t.textContent = 'Reset all progress'; }, 4000); return; }
      DATA.progress = {}; DATA.drillLog = []; resetArmed = false; save(); toast('Progress reset'); return render();
    }
  });

  document.getElementById('app').addEventListener('change', (e) => {
    const t = e.target;
    if (!writable) { render(); return linkOnGesture(); }
    if (t.dataset.solve) return toggleSolved(t.dataset.solve);
    if (t.dataset.task) return toggleTask(t.dataset.task);
    if (t.dataset.solvedDate) return setSolvedDate(t.dataset.solvedDate, t.value);
    if (t.dataset.journalDate !== undefined) { const e = DATA.notes.journal[Number(t.dataset.journalDate)]; if (e && t.value) { e.date = t.value; save(); } return; }
  });

  // Typing in any note: save (debounced) without re-rendering, so focus and caret are kept.
  document.getElementById('app').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.note !== undefined) {
      setNote(t.dataset.note, t.value);
      const chip = document.querySelector(`[data-note-toggle="${t.dataset.note}"]`);
      if (chip) { chip.classList.toggle('has-note', !!t.value.trim()); chip.innerHTML = (t.value.trim() ? 'Note' : '+ Note'); }
      return;
    }
    if (t.dataset.triggers !== undefined) { DATA.notes.triggers = t.value; return save(); }
    if (t.dataset.journal !== undefined) { const en = DATA.notes.journal[Number(t.dataset.journal)]; if (en) { en.text = t.value; save(); } }
  });

  document.getElementById('app').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.minutes) {
      logDrill(e.target.dataset.minutes, e.target.value);
    }
  });

  boot().catch((err) => {
    // Never fail silently: a startup error is shown on the page instead of an endless "Loading…".
    console.error('[dsa-tracker] startup failed:', err);
    document.getElementById('brand-sub').textContent = 'Could not start';
    showGate(`<div class="card gate-card"><h2>Could not start</h2>
      <p class="muted" style="margin:8px 0 16px">${esc(err && err.message ? err.message : String(err))}</p>
      <button class="btn primary" onclick="location.reload()">Reload</button></div>`);
  });
})();
