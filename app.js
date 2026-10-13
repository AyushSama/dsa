/* DSA 16-Week Tracker — plain JS, no framework, no backend, no browser storage.
   data.json is THE storage: the page opens it with the File System Access API (Chrome/Edge)
   and writes every change straight back to that file. */
(function () {
  'use strict';

  let DATA = null;
  let fileHandle = null;           // FileSystemFileHandle for data.json
  const FS_OK = 'showOpenFilePicker' in window;
  const UI = { view: 'dashboard', week: 1, openNotes: new Set(), sdWeek: null, sdOpen: new Set() };

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
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- roadmap helpers ----------
  function itemId(w, d, i) { return `w${w}d${d}i${i}`; }
  function norm(item) { return typeof item === 'string' ? { name: item, type: 'problem' } : { name: item.name, type: item.type || 'problem', hot: !!item.hot }; }
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
    json.sdProgress = Object.assign({ items: {}, notes: {} }, json.sdProgress || {});
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
    try { await idb.set('handle', h); } catch (_) { /* remembering the link is a convenience only */ }
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
  async function boot() {
    if (FS_OK) {
      try { fileHandle = (await idb.get('handle')) || null; } catch (_) { fileHandle = null; }
      if (fileHandle) {
        try {
          if ((await fileHandle.queryPermission({ mode: 'readwrite' })) === 'granted') { await readFromHandle(); return start(); }
        } catch (_) { fileHandle = null; }
      }
    }
    try {
      await loadViaFetch();
      start();
      showBanner(!FS_OK ? 'unsupported' : fileHandle ? 'reconnect' : 'link');
      return;
    } catch (_) { /* file:// — fall through to the one-time gate */ }
    if (!FS_OK) {
      return showGate(`<div class="card gate-card"><h2>Browser not supported</h2>
        <p class="muted" style="margin-top:8px">Open this folder in <b>Chrome</b> or <b>Edge</b>, which can read and write <code>data.json</code> directly.</p></div>`);
    }
    showGate(`<div class="card gate-card">
      <div class="logo" style="font-size:28px">◆</div>
      <h2 style="margin-top:8px">16-Week DSA Mastery</h2>
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
  function logDrill(name, minutes) {
    DATA.drillLog.push({ name, date: today(), minutes: minutes ? Number(minutes) : null });
    toast('Drill logged'); save(); render();
  }

  // ---------- rendering ----------
  const $ = (sel) => document.querySelector(sel);
  function render() {
    const pos = currentPosition();
    $('#brand-sub').textContent = pos.before ? `Starts in ${pos.daysUntil} day${pos.daysUntil === 1 ? '' : 's'} (${fmt(DATA.settings.startDate)})`
      : pos.after ? 'Plan complete — keep revising' : `Week ${pos.week} · Day ${pos.day}\n${weekByNum(pos.week).title}`;
    const due = allRedos().filter((r) => !r.done && r.due <= today()).length;
    const pill = $('#pill-due'); pill.textContent = due; pill.classList.toggle('zero', due === 0);
    document.querySelectorAll('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.view === UI.view));
    document.querySelectorAll('.view').forEach((v) => {
      const active = v.id === 'view-' + UI.view;
      v.classList.toggle('active', active);
      if (!active) v.innerHTML = ''; // only one view lives in the DOM at a time
    });
    ({ dashboard: renderDashboard, roadmap: renderRoadmap, revision: renderRevision, drills: renderDrills, notes: renderNotes, guide: renderGuide, settings: renderSettings,
       sd: renderSDDash, 'sd-concepts': renderSDConcepts, 'sd-questions': renderSDQuestions, 'sd-guide': renderSDGuide })[UI.view]();
  }

  // ----- Dashboard -----
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
    const pct = Math.round(100 * solved / probs.length);
    const d = new Date();
    const longDate = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const isContest = pos.week > 0 && pos.day === 6;
    const isRest = pos.week > 0 && pos.day === 7;
    const rotation = { 1: 'primitives only', 2: 'primitives + debug hunt', 3: 'primitives + code quality pass', 4: 'primitives + ambiguity drill ⭐', 5: 'primitives + code comprehension', 6: 'cold-combo (after the contest)' }[pos.day] || 'primitives';
    const posLine = pos.before ? `Week 1 starts ${fmt(DATA.settings.startDate)} · do Week 0 now` : pos.after ? 'Plan complete' : `Week ${pos.week}, day ${pos.day} · ${esc(wk.title)}`;

    el.innerHTML = `
      <div class="page-head">
        <div><h1>Dashboard</h1><div class="sub">${longDate} · ${posLine}</div></div>
        <div class="actions"><button class="btn small" data-go-view="revision">Revision queue</button><button class="btn small primary" data-go-week="${pos.week}">Open week ${pos.week}</button></div>
      </div>
      <div class="stack">
        <div class="grid grid-4">
          <div class="card stat"><div class="label">Problems solved</div><div class="value">${solved}<small>/ ${probs.length}</small></div><div class="sub">${pct}% of the plan</div><div class="bar thin"><span style="width:${pct}%"></span></div></div>
          <div class="card stat"><div class="label">This week</div><div class="value">${wkStats.total ? `${wkStats.done}<small>/ ${wkStats.total}</small>` : `${wkStats.tasksDone}<small>/ ${wkStats.tasks}</small>`}</div><div class="sub">${wkStats.total ? 'problems' : 'tasks'} · week ${pos.week}</div><div class="bar thin ${wkStats.pct === 100 ? 'green' : ''}"><span style="width:${wkStats.pct}%"></span></div></div>
          <div class="card stat ${overdue ? 'bad' : dueToday ? 'warn' : 'good'}"><div class="label">Re-solves due</div><div class="value">${dueToday + overdue}</div><div class="sub">${overdue} overdue · ${dueToday} due today · ${pending} upcoming</div></div>
          <div class="card stat"><div class="label">Streak</div><div class="value">${st}<small>day${st === 1 ? '' : 's'}</small></div><div class="sub">${redosDone} re-solves done · ${tasksDone}/${tasks.length} tasks</div></div>
        </div>

        <div class="grid grid-21">
          <div class="card today-card">
            <div class="today-head"><h3>Today · Week ${pos.week}, Day ${pos.day}</h3><span class="hint muted small">Block A</span></div>
            <div class="focus">${esc(todayDay ? todayDay.focus : '')}</div>
            <div class="items">${todayDay ? todayDay.items.map((it, i) => renderItem(wk.week, todayDay.day, i, it)).join('') : '<div class="empty">Nothing scheduled</div>'}</div>
            <div class="blocks">
              ${isRest ? '<span class="chip done">Rest day · no blocks</span>' : `
              <button class="chip btn ${dueList.length ? (overdue ? 'overdue' : 'due') : 'done'}" data-go-view="revision">Block B · ${dueList.length ? `${dueList.length} re-solve${dueList.length === 1 ? '' : 's'} due` : 'queue clear'}</button>
              ${isContest ? '<span class="chip">Contest · 90 min + 90 min post-mortem</span>' : '<span class="chip">Block C · editorials · triggers · triage 15 min · one variant</span>'}
              <button class="chip btn" data-go-view="drills">Block D · ${rotation}</button>`}
            </div>
          </div>
          <div class="card progress-card">
            <div class="card-title"><h3>Progress</h3><span class="hint">16-week plan</span></div>
            <div class="pc-top">
              <canvas id="c-overall" class="chart"></canvas>
              <div class="pc-nums">
                <div class="pc-num"><span class="muted">New problems</span><b>${solved} / ${probs.length}</b></div>
                <div class="pc-num"><span class="muted">Re-solves done</span><b>${redosDone} / ${redos.length}</b></div>
                <div class="pc-num"><span class="muted">Tasks</span><b>${tasksDone} / ${tasks.length}</b></div>
                <div class="pc-num"><span class="muted">Notes written</span><b>${Object.values(DATA.progress).filter((p) => p.note && p.note.trim()).length}</b></div>
              </div>
            </div>
            <div class="mini-stats">
              <div class="mini-stat"><div class="v" style="color:var(--green)">${onTime}</div><div class="l">on time</div></div>
              <div class="mini-stat"><div class="v" style="color:var(--amber)">${late}</div><div class="l">late</div></div>
              <div class="mini-stat"><div class="v" style="color:var(--red)">${overdue}</div><div class="l">overdue</div></div>
            </div>
          </div>
        </div>

        <div class="grid grid-21">
          <div class="card"><div class="card-title"><h3>Activity · last 28 days</h3><span class="hint">solves per day</span></div>
            <canvas id="c-activity" class="chart"></canvas>
            <div class="legend"><span><i style="background:var(--accent)"></i>New solves</span><span><i style="background:var(--green)"></i>Re-solves</span></div></div>
          <div class="card"><div class="card-title"><h3>Revision discipline</h3><span class="hint">+3 / +14</span></div>
            <canvas id="c-revision" class="chart"></canvas>
            <div class="legend"><span><i style="background:var(--green)"></i>On time ${onTime}</span><span><i style="background:var(--amber)"></i>Late ${late}</span><span><i style="background:var(--red)"></i>Overdue ${overdue}</span><span><i style="background:var(--blue)"></i>Pending ${pending}</span><span><i style="background:var(--track)"></i>Skipped ${skipped}</span></div></div>
        </div>

        <div class="grid grid-2">
          <div class="card"><div class="card-title"><h3>Completion by week</h3><span class="hint">% of each week's problems</span></div>
            <canvas id="c-weeks" class="chart tall"></canvas></div>
          <div class="card"><div class="card-title"><h3>Activity heatmap</h3><span class="hint">16 weeks from ${fmt(DATA.settings.startDate)}</span></div>
            <canvas id="c-heat" class="chart tall"></canvas></div>
        </div>

        ${dueList.length ? `<div class="card">
          <div class="card-title"><h3>Due now</h3><button class="btn small" data-go-view="revision">Full queue</button></div>
          ${dueList.slice(0, 8).map(renderQueueRow).join('')}
          ${dueList.length > 8 ? `<div class="muted small" style="margin-top:8px">+${dueList.length - 8} more in the queue</div>` : ''}
        </div>` : ''}
      </div>`;

    // charts
    Charts.donut($('#c-overall'), [
      { value: solved, color: cssVar('--accent') },
      { value: probs.length - solved, color: 'transparent' },
    ], `${pct}%`, 'solved');

    const totalRedo = redos.length;
    Charts.donut($('#c-revision'), [
      { value: onTime, color: cssVar('--green') },
      { value: late, color: cssVar('--amber') },
      { value: overdue, color: cssVar('--red') },
      { value: pending, color: cssVar('--blue') },
      { value: skipped, color: cssVar('--track') },
    ], (onTime + late + overdue + skipped) ? `${Math.round(100 * onTime / (onTime + late + overdue + skipped))}%` : '—',
      (onTime + late + overdue + skipped) ? 'on time' : totalRedo ? `${pending} scheduled` : 'nothing scheduled yet');

    const act = activity();
    const labels = [], sNew = [], sRedo = [];
    for (let i = 27; i >= 0; i--) {
      const d = addDays(today(), -i);
      labels.push(fmt(d)); sNew.push(act[d] ? act[d].solved : 0); sRedo.push(act[d] ? act[d].redos : 0);
    }
    Charts.lines($('#c-activity'), labels, [
      { name: 'new', color: cssVar('--accent'), values: sNew },
      { name: 'redo', color: cssVar('--green'), values: sRedo },
    ], { minMax: 3 });

    Charts.bars($('#c-weeks'), DATA.weeks.map((w) => {
      const s = weekStats(w);
      return { label: 'W' + w.week, value: s.pct, color: phaseColor(w.phase), highlight: w.week === pos.week ? cssVar('--green') : null };
    }), { yMax: 100, yFormat: (v) => v + '%' });

    const cells = [];
    const start = DATA.settings.startDate;
    for (let w = 0; w < lastWeek(); w++) for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const a = act[date];
      cells.push({ value: a ? a.solved + a.redos + a.tasks + a.drills : 0, rowLabel: 'W' + (w + 1), future: date > today(), today: date === today() });
    }
    Charts.heatmap($('#c-heat'), cells);
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  // ----- Item row (shared by dashboard & roadmap) -----
  function renderItem(w, d, i, raw) {
    const it = norm(raw); const id = itemId(w, d, i);
    if (it.type === 'task') {
      const done = isTaskDone(id);
      return `<label class="item ${done ? 'done' : ''}">
        <input type="checkbox" data-task="${id}" ${done ? 'checked' : ''}>
        <span class="name">${esc(it.name)}</span>
        <span class="meta"><span class="badge">task</span>${done ? `<span class="date">${fmt(DATA.progress[id].done)}</span>` : ''}</span></label>`;
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
    meta += `<button class="chip btn note-chip ${note ? 'has-note' : ''} ${open ? 'open' : ''}" data-note-toggle="${id}" title="${note ? 'Edit note' : 'Add a note (approach, trigger, what went wrong)'}">✎${note ? ' note' : ''}</button>`;
    return `<div class="item ${solved ? 'done' : ''}">
      <input type="checkbox" data-solve="${id}" ${solved ? 'checked' : ''} title="${solved ? 'Unmark (removes its re-do schedule)' : 'Mark solved (schedules +3 and +14 re-solves)'}">
      <span class="name">${esc(it.name)}${it.hot ? ' <span class="hot" title="Verified high-frequency in Google interview reports">G</span>' : ''}</span>
      <span class="meta">${meta}</span></div>
      ${open ? `<div class="note-row"><textarea class="note-input" data-note="${id}" rows="3" placeholder="Approach · trigger phrase · what went wrong · variant to try">${esc(note)}</textarea></div>` : ''}`;
  }

  // ----- Roadmap -----
  function renderRoadmap() {
    const el = $('#view-roadmap');
    const pos = currentPosition();
    const wk = weekByNum(UI.week);
    const stats = weekStats(wk);
    const idx = DATA.weeks.indexOf(wk);
    const prev = DATA.weeks[idx - 1], next = DATA.weeks[idx + 1];
    const strip = DATA.weeks.map((w) => {
      const s = weekStats(w);
      return `<button class="week-pill ${w.week === UI.week ? 'active' : ''} ${w.week === pos.week ? 'current' : ''} ph${w.phase}" data-week="${w.week}" title="Week ${w.week} — ${esc(w.title)} · ${s.pct}%">
        ${w.week}<div class="bar thin ${s.pct === 100 ? 'green' : ''}"><span style="width:${s.pct}%"></span></div></button>`;
    }).join('');
    const phaseLine = Object.entries(DATA.guide.phases || {}).map(([p, name]) => {
      const ws = DATA.weeks.filter((w) => String(w.phase) === p).map((w) => w.week);
      return ws.length ? `${esc(name)} · week${ws.length > 1 ? 's' : ''} ${ws[0]}${ws.length > 1 ? '–' + ws[ws.length - 1] : ''}` : '';
    }).filter(Boolean).join(' &nbsp;·&nbsp; ');

    const days = wk.days.map((day) => `
      <div class="card day-card ${wk.week === pos.week && day.day === pos.day ? 'today' : ''}">
        <div class="day-head"><span class="dn">Day ${day.day}${wk.week === pos.week && day.day === pos.day ? ' <span class="badge accent">today</span>' : ''}</span><span class="df">${esc(day.focus)}</span></div>
        <div class="items">${day.items.map((it, i) => renderItem(wk.week, day.day, i, it)).join('')}</div>
      </div>`).join('');

    el.innerHTML = `
      <div class="page-head">
        <div><h1>Roadmap</h1><div class="sub">${phaseLine}</div></div>
        <div class="actions">
          <button class="btn small" data-week="${prev ? prev.week : wk.week}" ${prev ? '' : 'disabled'}>${prev ? `← Week ${prev.week}` : '← Start'}</button>
          <button class="btn small" data-week="${next ? next.week : wk.week}" ${next ? '' : 'disabled'}>${next ? `Week ${next.week} →` : 'End →'}</button>
        </div>
      </div>
      <div class="week-strip">${strip}</div>
      <div class="stack">
        <div class="card">
          <div class="week-head">
            <div class="wh-title"><span class="badge ${phaseBadge(wk.phase)}">${esc(phaseName(wk.phase))}</span><h2>${wk.week === 0 ? esc(wk.title) : `Week ${wk.week} — ${esc(wk.title)}`}</h2>${wk.week === pos.week ? '<span class="badge">current</span>' : ''}</div>
            <div class="muted small">${stats.total ? `${stats.done} of ${stats.total} problems` : `${stats.tasksDone} of ${stats.tasks} tasks`} · ${stats.pct}%</div>
          </div>
          <div class="bar ${stats.pct === 100 ? 'green' : ''}" style="margin-top:12px"><span style="width:${stats.pct}%"></span></div>
        </div>
        <div class="days-grid">${days}</div>
        ${(wk.notes && wk.notes.length) || wk.checkpoint ? `<div class="card"><div class="card-title"><h3>Week notes</h3><span class="hint">from the plan</span></div><div class="notes-list">
          ${(wk.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join('')}
          ${wk.checkpoint ? `<div class="note checkpoint">${esc(wk.checkpoint)}</div>` : ''}</div></div>` : ''}
      </div>`;
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
    const groups = [
      { title: 'Overdue', cls: 'red', rows: redos.filter((r) => !r.done && r.due < t) },
      { title: 'Due today', cls: 'amber', rows: redos.filter((r) => !r.done && r.due === t) },
      { title: 'Next 7 days', cls: '', rows: redos.filter((r) => !r.done && r.due > t && diffDays(t, r.due) <= 7) },
      { title: 'Later', cls: '', rows: redos.filter((r) => !r.done && diffDays(t, r.due) > 7) },
      { title: 'Recently completed', cls: 'green', rows: redos.filter((r) => r.done).sort((a, b) => b.done.localeCompare(a.done)).slice(0, 15) },
    ];
    groups.forEach((g) => { if (g.title !== 'Recently completed') g.rows.sort((a, b) => a.due.localeCompare(b.due)); });
    const dueNow = groups[0].rows.length + groups[1].rows.length;
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Revision</h1><div class="sub">Every solved problem comes back at +3 and +14 days. Re-solve from a blank file, then mark it. If time runs short, cut new problems, never this.</div></div>
        <div class="actions"><span class="badge ${dueNow ? 'amber' : 'green'}">${dueNow ? `${dueNow} due now` : 'Queue clear'}</span></div>
      </div>
      <div class="stack">
      ${groups.map((g) => `<div class="card queue-group"><h3>${g.title} <span class="badge ${g.cls}">${g.rows.length}</span></h3>
        ${g.rows.length ? g.rows.map(renderQueueRow).join('') : '<div class="empty" style="margin-top:8px">Nothing here</div>'}</div>`).join('')}
      </div>`;
  }

  // ----- Drills -----
  function renderDrills() {
    const el = $('#view-drills');
    const pos = currentPosition();
    const log = DATA.drillLog || [];
    const weekAgo = addDays(today(), -7);
    const rows = DATA.guide.primitives.map((p) => {
      const mine = log.filter((l) => l.name === p.name);
      const last = mine.length ? mine[mine.length - 1] : null;
      const best = mine.filter((l) => l.minutes).reduce((b, l) => (b === null || l.minutes < b ? l.minutes : b), null);
      const lastMin = last && last.minutes ? last.minutes : null;
      const locked = p.from && pos.week < p.from;
      const stale = last && last.date < weekAgo;
      const key = esc(p.name);
      const status = locked ? '' : lastMin !== null ? `<span class="badge ${lastMin <= p.target ? 'green' : 'amber'}">${lastMin <= p.target ? 'at target' : `${lastMin - p.target} min over`}</span>` : stale ? '<span class="badge amber">stale</span>' : '<span></span>';
      return `<div class="prim ${locked ? 'locked' : ''}">
        <div><div class="pname">${p.n ? `<span class="muted">#${p.n}</span> ` : ''}${key}</div><div class="pmeta">Target ${p.target} min${locked ? ` · from week ${p.from}` : mine.length ? ` · ${mine.length}× · last ${fmt(last.date)}${best !== null ? ` · best ${best} min` : ''}` : ' · not drilled yet'}</div></div>
        ${status}
        <input type="number" min="1" max="120" placeholder="min" data-minutes="${key}">
        <button class="btn small" data-drill="${key}">Log</button></div>`;
    }).join('');
    const rotation = (DATA.guide.drills || []).map((d) => {
      const mine = log.filter((l) => l.name === d.name);
      const key = esc(d.name);
      return `<div class="prim"><div><div class="pname">${key}${d.star ? ' <span class="badge accent">most Google-specific</span>' : ''}</div><div class="pmeta">${esc(d.when)}${mine.length ? ` · ${mine.length}× · last ${fmt(mine[mine.length - 1].date)}` : ''}</div><div class="pdesc">${esc(d.text)}</div></div>
        <span></span><span></span><button class="btn small" data-drill="${key}">Log</button></div>`;
    }).join('');
    const recent = log.slice(-12).reverse();
    const perWeek = [];
    for (let w = 0; w < lastWeek(); w++) {
      const a = addDays(DATA.settings.startDate, w * 7), b = addDays(a, 6);
      perWeek.push({ label: 'W' + (w + 1), value: log.filter((l) => l.date >= a && l.date <= b).length, highlight: w + 1 === pos.week ? cssVar('--green') : null });
    }
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Drills</h1><div class="sub">${esc(DATA.guide.primitivesGoal)}</div></div>
      </div>
      <div class="stack">
      <div class="grid grid-2">
        <div class="card"><div class="card-title"><h3>Blind primitives</h3><span class="hint">daily · 20 min · pick 5</span></div>${rows}</div>
        <div class="stack">
          <div class="card"><div class="card-title"><h3>Drills per week</h3><span class="hint">logged attempts</span></div><canvas id="c-drills" class="chart short"></canvas></div>
          <div class="card"><div class="card-title"><h3>Weekly rotation</h3><span class="hint">Block D</span></div>${rotation}
            ${DATA.guide.bugLog ? `<p class="muted small" style="margin-top:12px">${esc(DATA.guide.bugLog)}</p>` : ''}</div>
          <div class="card"><div class="card-title"><h3>Variant generation</h3><span class="hint">daily · mandatory</span></div>
            <div class="row wrap" style="gap:6px">${DATA.guide.variantPrompts.map((v) => `<span class="chip">${esc(v)}</span>`).join('')}</div></div>
          <div class="card"><h3>Recent drill log</h3>${recent.length ? `<table style="margin-top:8px"><tr><th>Date</th><th>Drill</th><th>Min</th><th></th></tr>
            ${recent.map((l) => `<tr><td>${fmt(l.date)}</td><td>${esc(l.name)}</td><td>${l.minutes || '—'}</td><td><button class="btn small ghost" data-del-drill="${log.indexOf(l)}">✕</button></td></tr>`).join('')}</table>` : '<div class="empty" style="margin-top:8px">No drills logged yet</div>'}</div>
        </div>
      </div></div>`;
    Charts.bars($('#c-drills'), perWeek, { yMax: Math.max(4, ...perWeek.map((p) => p.value)), ticks: 2 });
  }

  // ----- System design (separate track: own schedule in systemDesign.weeks, own progress in sdProgress) -----
  const SD = () => DATA.systemDesign;
  const SDP = () => DATA.sdProgress;
  function sdPosition() {
    const sd = SD(); if (!sd) return null;
    const n = diffDays(sd.startDate || today(), today());
    const last = sd.weeks.length ? sd.weeks[sd.weeks.length - 1].week : 1;
    if (n < 0) return { week: 1, day: 1, before: true, daysUntil: -n };
    return { week: Math.min(last, Math.floor(n / 7) + 1), day: (n % 7) + 1, after: n >= last * 7 };
  }
  function sdWeek(n) { return SD().weeks.find((w) => w.week === n) || SD().weeks[0]; }
  function sdItems() { const out = []; SD().weeks.forEach((w) => w.days.forEach((d) => d.items.forEach((it) => out.push({ ...it, week: w.week, day: d.day })))); return out; }
  function sdDone(id) { const p = SDP().items[id]; return !!(p && p.done); }
  function sdToggle(id) { const items = SDP().items; if (sdDone(id)) delete items[id]; else items[id] = { done: today() }; save(); render(); }
  function sdSetNote(ref, text) { const notes = SDP().notes; if (text && text.trim()) notes[ref] = text; else delete notes[ref]; save(); }
  function sdNote(ref) { return SDP().notes[ref] || ''; }
  function sdConcept(id) { return SD().concepts.find((c) => c.id === id); }
  function sdQuestion(id) { return SD().questions.find((q) => q.id === id); }
  function sdWeekStats(w) { const items = w.days.flatMap((d) => d.items); const done = items.filter((it) => sdDone(it.id)).length; return { total: items.length, done, pct: items.length ? Math.round(100 * done / items.length) : 0 }; }
  function sdDateOf(w, d) { return addDays(SD().startDate, (w - 1) * 7 + (d - 1)); }
  // Where a concept / question is scheduled, and whether that session is done.
  function sdStatus(ref) {
    const its = sdItems().filter((it) => it.ref === ref);
    const done = its.filter((it) => sdDone(it.id));
    return { items: its, done, first: its[0] || null, lastDone: done.length ? SDP().items[done[done.length - 1].id].done : null };
  }
  const SD_KIND = { concept: ['concept', 'sd'], design: ['design', 'amber'], mock: ['mock', 'red'], recall: ['recall', 'green'] };
  const SD_SHAPE = { concept: 'Concept day', design: 'Design day', mock: 'Mock day', recall: 'Recall day' };

  function renderSDItem(it, opts = {}) {
    const done = sdDone(it.id);
    const [label, cls] = SD_KIND[it.kind] || [it.kind, ''];
    const ref = it.ref;
    const dateTxt = done ? fmt(SDP().items[it.id].done) : (opts.date ? fmt(sdDateOf(it.week, it.day)) : '');
    const isC = ref && ref.startsWith('c');
    return `<div class="item sd ${done ? 'done' : ''}">
      <input type="checkbox" data-sdtask="${it.id}" ${done ? 'checked' : ''} title="${done ? 'Unmark' : 'Mark this session done'}">
      <span class="name">${esc(it.name)}</span>
      <span class="meta"><span class="badge ${cls}">${label}</span>${it.minutes ? `<span class="date">${it.minutes} min</span>` : ''}${dateTxt ? `<span class="date">${dateTxt}</span>` : ''}
        ${ref ? `<button class="chip btn note-chip ${sdNote(ref) ? 'has-note' : ''}" data-sd-open="${ref}" title="Open the ${isC ? 'concept' : 'question'}: what to master, probes, your notes">${isC ? 'concept' : 'question'} →</button>` : ''}</span></div>`;
  }

  // ----- SD dashboard -----
  function renderSDDash() {
    const el = $('#view-sd');
    const sd = SD();
    if (!sd) { el.innerHTML = '<div class="page-head"><div><h1>System Design</h1><div class="sub">No systemDesign section in data.json.</div></div></div>'; return; }
    const pos = sdPosition();
    if (UI.sdWeek === null) UI.sdWeek = pos.week;
    const items = sdItems();
    const concepts = items.filter((it) => it.kind === 'concept');
    const designs = items.filter((it) => it.kind === 'design');
    const mocks = items.filter((it) => it.kind === 'mock');
    const recalls = items.filter((it) => it.kind === 'recall');
    const doneAll = items.filter((it) => sdDone(it.id)).length;
    const wk = sdWeek(pos.week);
    const wkStats = sdWeekStats(wk);
    const todayItems = pos.day <= 6 && !pos.before && !pos.after ? items.filter((it) => it.week === pos.week && it.day === pos.day) : [];
    const isRest = pos.day === 7;
    const sel = sdWeek(UI.sdWeek);
    const selStats = sdWeekStats(sel);
    const idx = sd.weeks.indexOf(sel);
    const prev = sd.weeks[idx - 1], next = sd.weeks[idx + 1];
    const d = new Date();
    const longDate = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const posLine = pos.before ? `Starts ${fmt(sd.startDate)} (in ${pos.daysUntil} day${pos.daysUntil === 1 ? '' : 's'})` : pos.after ? 'Track complete — keep doing mocks' : `SD week ${pos.week}, day ${pos.day} · ${esc(wk.title)}`;
    const shape = todayItems.length ? (sd.sessionShapes || []).find((s) => s.kind.startsWith(SD_SHAPE[todayItems[0].kind] || '')) : null;
    const strip = sd.weeks.map((w) => { const s = sdWeekStats(w); return `<button class="week-pill ${w.week === UI.sdWeek ? 'active' : ''} ${w.week === pos.week ? 'current' : ''} ${w.phase === 2 ? 'ph2' : ''}" data-sd-week="${w.week}" title="Week ${w.week} — ${esc(w.title)} · ${s.pct}%">${w.week}<div class="bar thin ${s.pct === 100 ? 'green' : ''}"><span style="width:${s.pct}%"></span></div></button>`; }).join('');
    const days = sel.days.map((day) => `
      <div class="card day-card ${sel.week === pos.week && day.day === pos.day ? 'today' : ''}">
        <div class="day-head"><span class="dn">Day ${day.day}${sel.week === pos.week && day.day === pos.day ? ' <span class="badge accent">today</span>' : ''}</span><span class="df">${fmt(sdDateOf(sel.week, day.day))} · ${esc(SD_SHAPE[day.items[0] && day.items[0].kind] || '')}</span></div>
        <div class="items">${day.items.map((it) => renderSDItem({ ...it, week: sel.week, day: day.day })).join('')}</div>
      </div>`).join('');
    el.innerHTML = `
      <div class="page-head">
        <div><h1>System Design</h1><div class="sub">${longDate} · ${posLine} · ${esc(sd.budget || '')}</div></div>
        <div class="actions"><button class="btn small" data-go-view="sd-concepts">Concepts</button><button class="btn small" data-go-view="sd-questions">Questions</button><button class="btn small" data-go-view="sd-guide">Guide</button></div>
      </div>
      <div class="stack">
        <div class="grid grid-4">
          <div class="card stat"><div class="label">Concepts mastered</div><div class="value">${concepts.filter((it) => sdDone(it.id)).length}<small>/ ${concepts.length}</small></div><div class="sub">card written + probes answered</div><div class="bar thin"><span style="width:${concepts.length ? Math.round(100 * concepts.filter((it) => sdDone(it.id)).length / concepts.length) : 0}%"></span></div></div>
          <div class="card stat"><div class="label">Designs done</div><div class="value">${designs.filter((it) => sdDone(it.id)).length}<small>/ ${designs.length}</small></div><div class="sub">design days · compared with a reference</div></div>
          <div class="card stat"><div class="label">Mocks</div><div class="value">${mocks.filter((it) => sdDone(it.id)).length}<small>/ ${mocks.length}</small></div><div class="sub">recorded and scored · ${recalls.filter((it) => sdDone(it.id)).length}/${recalls.length} recall drills</div></div>
          <div class="card stat ${wkStats.done === wkStats.total && wkStats.total ? 'good' : ''}"><div class="label">This week</div><div class="value">${wkStats.done}<small>/ ${wkStats.total}</small></div><div class="sub">sessions · week ${pos.week}</div><div class="bar thin ${wkStats.pct === 100 ? 'green' : ''}"><span style="width:${wkStats.pct}%"></span></div></div>
        </div>
        <div class="grid grid-21">
          <div class="card today-card">
            <div class="today-head"><h3>Today · SD week ${pos.week}, day ${pos.day}</h3><span class="hint muted small">${isRest ? 'rest day' : shape ? esc(shape.kind) : '1 hour'}</span></div>
            <div class="focus">${isRest ? 'Rest day. No system design today.' : esc(wk.title)}</div>
            <div class="items">${todayItems.length ? todayItems.map(renderSDItem).join('') : isRest ? '' : '<div class="empty">Nothing scheduled</div>'}</div>
            ${shape ? `<p class="muted small" style="margin-top:12px"><b>${esc(shape.kind)}:</b> ${esc(shape.shape)}</p>` : ''}
          </div>
          <div class="card progress-card">
            <div class="card-title"><h3>Progress</h3><span class="hint">${sd.weeks.length}-week track</span></div>
            <div class="pc-top">
              <canvas id="c-sd-overall" class="chart"></canvas>
              <div class="pc-nums">
                <div class="pc-num"><span class="muted">Sessions</span><b>${doneAll} / ${items.length}</b></div>
                <div class="pc-num"><span class="muted">Concept cards written</span><b>${sd.concepts.filter((c) => sdNote(c.id)).length} / ${sd.concepts.length}</b></div>
                <div class="pc-num"><span class="muted">Question notes</span><b>${sd.questions.filter((q) => sdNote(q.id)).length} / ${sd.questions.length}</b></div>
                <div class="pc-num"><span class="muted">Phase</span><b>${esc((sd.phases || {})[wk.phase] || '')}</b></div>
              </div>
            </div>
          </div>
        </div>
        <div class="card"><div class="card-title"><h3>Completion by week</h3><span class="hint">% of each week's sessions</span></div><canvas id="c-sd-weeks" class="chart short"></canvas></div>
        <div class="card">
          <div class="week-head">
            <div class="wh-title"><span class="badge ${sel.phase === 2 ? 'red' : 'sd'}">${esc((sd.phases || {})[sel.phase] || 'Phase ' + sel.phase)}</span><h2>Week ${sel.week} — ${esc(sel.title)}</h2>${sel.week === pos.week ? '<span class="badge">current</span>' : ''}</div>
            <div class="actions"><button class="btn small" data-sd-week="${prev ? prev.week : sel.week}" ${prev ? '' : 'disabled'}>← Week ${prev ? prev.week : ''}</button><button class="btn small" data-sd-week="${next ? next.week : sel.week}" ${next ? '' : 'disabled'}>Week ${next ? next.week : ''} →</button><span class="muted small">${selStats.done} of ${selStats.total} · ${selStats.pct}%</span></div>
          </div>
          <div class="week-strip" style="margin-top:12px">${strip}</div>
        </div>
        <div class="days-grid">${days}</div>
        ${sel.notes && sel.notes.length ? `<div class="card"><div class="card-title"><h3>Week notes</h3><span class="hint">from the plan</span></div><div class="notes-list">${sel.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}</div></div>` : ''}
      </div>`;
    Charts.donut($('#c-sd-overall'), [{ value: doneAll, color: cssVar('--blue') }, { value: items.length - doneAll, color: 'transparent' }], `${items.length ? Math.round(100 * doneAll / items.length) : 0}%`, 'done');
    Charts.bars($('#c-sd-weeks'), sd.weeks.map((w) => ({ label: 'W' + w.week, value: sdWeekStats(w).pct, color: w.phase === 2 ? cssVar('--red') : cssVar('--blue'), highlight: w.week === pos.week ? cssVar('--green') : null })), { yMax: 100, yFormat: (v) => v + '%' });
  }

  // ----- SD concepts -----
  function renderSDConcepts() {
    const el = $('#view-sd-concepts');
    const sd = SD(); if (!sd) { el.innerHTML = ''; return; }
    const groups = [...new Set(sd.concepts.map((c) => c.group))];
    const mastered = sd.concepts.filter((c) => sdStatus(c.id).done.length).length;
    const card = (c, n) => {
      const st = sdStatus(c.id);
      const open = UI.sdOpen.has(c.id);
      const done = st.done.length > 0;
      const where = st.first ? `W${st.first.week} D${st.first.day} · ${fmt(sdDateOf(st.first.week, st.first.day))}` : 'unscheduled';
      const note = sdNote(c.id);
      return `<div class="card sd-ch ${done ? 'complete' : ''} ${open ? 'open' : ''}">
        <div class="ch-head" data-sd-toggle="${c.id}" style="cursor:pointer">
          <h3><span class="ch-num">${n}</span>${esc(c.name)}</h3>
          <span class="row" style="gap:8px">${note ? '<span class="badge accent">card written</span>' : ''}<span class="badge ${done ? 'green' : ''}">${done ? 'mastered ' + fmt(st.lastDone) : where}</span><span class="muted small">${open ? '▾' : '▸'}</span></span>
        </div>
        ${open ? `
        <div class="grid grid-2" style="margin-top:12px;gap:12px">
          <div><div class="muted small" style="font-weight:600;margin-bottom:4px">Master</div><ul style="margin:0 0 0 18px;font-size:13px;color:var(--text-2)">${c.master.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>
          <div><div class="muted small" style="font-weight:600;margin-bottom:4px">Interviewer probes</div><ol style="margin:0 0 0 18px;font-size:13px;color:var(--text-2)">${c.probes.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>
            <div class="muted small" style="font-weight:600;margin:10px 0 4px">Learn from (35 min)</div><div style="font-size:13px;color:var(--text-2)">${esc(c.read)}</div></div>
        </div>
        <div class="muted small" style="font-weight:600;margin:12px 0 4px">Your card <span style="font-weight:400">· written from memory, then corrected · template in the SD guide</span></div>
        <textarea class="note-input" data-sdnote="${c.id}" rows="8" placeholder="What it is · when / when not · mechanism → buys → costs · two failure modes + fixes · one real system · the three probes answered">${esc(note)}</textarea>
        ${st.items.length ? `<div class="items" style="margin-top:10px">${st.items.map((it) => renderSDItem(it, { date: true })).join('')}</div>` : ''}` : ''}
      </div>`;
    };
    let n = 0;
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Concepts</h1><div class="sub">${sd.concepts.length} concepts to master, one per day in phase 1. Click a concept for what to master, the interviewer probes, where to learn it and your card.</div></div>
        <div class="actions"><span class="badge ${mastered === sd.concepts.length ? 'green' : 'sd'}">${mastered} / ${sd.concepts.length} mastered</span><button class="btn small" data-go-view="sd">SD dashboard</button></div>
      </div>
      <div class="stack">
        ${groups.map((g) => { const cs = sd.concepts.filter((c) => c.group === g); const dn = cs.filter((c) => sdStatus(c.id).done.length).length; return `<div class="card-title" style="margin:6px 0 -6px"><h3>${esc(g)}</h3><span class="hint">${dn} / ${cs.length}</span></div>${cs.map((c) => card(c, ++n)).join('')}`; }).join('')}
      </div>`;
  }

  // ----- SD questions -----
  function renderSDQuestions() {
    const el = $('#view-sd-questions');
    const sd = SD(); if (!sd) { el.innerHTML = ''; return; }
    const tiers = { 1: 'Tier 1 — fundamentals', 2: 'Tier 2 — infrastructure and correctness', 3: 'Tier 3 — open-ended, Google-style' };
    const designed = sd.questions.filter((q) => sdStatus(q.id).done.length).length;
    const row = (q) => {
      const st = sdStatus(q.id);
      const open = UI.sdOpen.has(q.id);
      const done = st.done.length > 0;
      const kinds = [...new Set(st.items.map((it) => it.kind))].join(' + ');
      const where = st.first ? `W${st.first.week} D${st.first.day} · ${kinds}` : 'spare';
      const note = sdNote(q.id);
      return `<div class="card sd-ch ${done ? 'complete' : ''}">
        <div class="ch-head" data-sd-toggle="${q.id}" style="cursor:pointer">
          <h3><span class="ch-num">${q.id.slice(1).replace(/^0/, '')}</span>${esc(q.name)}</h3>
          <span class="row" style="gap:8px">${note ? '<span class="badge accent">notes</span>' : ''}<span class="badge ${done ? 'green' : ''}">${done ? 'done ' + fmt(st.lastDone) : where}</span><span class="muted small">${open ? '▾' : '▸'}</span></span>
        </div>
        <div class="ch-use">${esc(q.focus)}</div>
        <div class="row wrap" style="gap:6px">${(q.concepts || []).map((cid) => { const c = sdConcept(cid); return c ? `<button class="chip btn ${sdStatus(cid).done.length ? 'done' : ''}" data-sd-open="${cid}" title="Open concept">${esc(c.name.split(':')[0].split(',')[0])}</button>` : ''; }).join('')}<span class="chip">ref · ${esc(q.reference)}</span></div>
        ${open ? `
        <div class="muted small" style="font-weight:600;margin:12px 0 4px">Post-mortem and score <span style="font-weight:400">· missed concepts, hand-waved numbers, rubric score, the one fix</span></div>
        <textarea class="note-input" data-sdnote="${q.id}" rows="6" placeholder="Design date · what I missed vs the reference · numbers I hand-waved · rubric: navigation / design / depth / scaling / communication · the one fix">${esc(note)}</textarea>
        ${st.items.length ? `<div class="items" style="margin-top:10px">${st.items.map((it) => renderSDItem(it, { date: true })).join('')}</div>` : ''}` : ''}
      </div>`;
    };
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Design questions</h1><div class="sub">${sd.questions.length} questions scheduled across design days and mocks, tiered by difficulty. Design first, compare with the reference second, write the post-mortem third.</div></div>
        <div class="actions"><span class="badge ${designed === sd.questions.length ? 'green' : 'sd'}">${designed} / ${sd.questions.length} designed</span><button class="btn small" data-go-view="sd">SD dashboard</button></div>
      </div>
      <div class="stack">
        ${[1, 2, 3].map((t) => { const qs = sd.questions.filter((q) => q.tier === t); return qs.length ? `<div class="card-title" style="margin:6px 0 -6px"><h3>${esc(tiers[t])}</h3><span class="hint">${qs.filter((q) => sdStatus(q.id).done.length).length} / ${qs.length}</span></div>${qs.map(row).join('')}` : ''; }).join('')}
        ${sd.spareQuestions ? `<div class="card"><div class="card-title"><h3>Spare prompts</h3><span class="hint">for extra mocks and peer sessions</span></div><div class="row wrap" style="gap:6px">${sd.spareQuestions.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div></div>` : ''}
      </div>`;
  }

  // ----- SD guide -----
  function renderSDGuide() {
    const el = $('#view-sd-guide');
    const sd = SD(); if (!sd) { el.innerHTML = ''; return; }
    const ol = (arr) => `<ol style="margin-top:8px">${(arr || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`;
    const ul = (arr) => `<ul style="margin-top:8px">${(arr || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
    el.innerHTML = `
      <div class="page-head"><div><h1>System design guide</h1><div class="sub">${esc(sd.intro || '')}</div></div><div class="actions"><button class="btn small" data-go-view="sd">SD dashboard</button></div></div>
      <div class="stack">
        <div class="card"><div class="card-title"><h3>Session shapes</h3><span class="hint">${esc(sd.budget || '')}</span></div>
          <table style="margin-top:8px"><tr><th>Day type</th><th>The hour</th></tr>${(sd.sessionShapes || []).map((s) => `<tr><td><b>${esc(s.kind)}</b></td><td>${esc(s.shape)}</td></tr>`).join('')}</table></div>
        <div class="grid grid-2">
          <div class="card"><div class="card-title"><h3>The 45-minute framework</h3><span class="hint">every design and mock</span></div>${ol(sd.framework)}</div>
          <div class="stack">
            <div class="card"><div class="card-title"><h3>Concept card template</h3><span class="hint">from memory, then corrected</span></div>${ol(sd.cardTemplate)}</div>
            <div class="card"><div class="card-title"><h3>Numbers card</h3><span class="hint">orders of magnitude</span></div>${ul(sd.numbers)}</div>
          </div>
        </div>
        <div class="grid grid-2">
          <div class="card"><div class="card-title"><h3>Scoring rubric</h3><span class="hint">every mock, 1–4 per axis</span></div>${ol(sd.rubric)}</div>
          <div class="card"><div class="card-title"><h3>The Google design round</h3><span class="hint">as reported · confirm with your recruiter</span></div>${ol(sd.googleRound)}</div>
        </div>
        <div class="grid grid-2">
          <div class="card"><h3>Exit criteria</h3>${ol(sd.exitCriteria)}</div>
          <div class="card"><h3>Failure modes</h3>${ol(sd.failureModes)}</div>
        </div>
        <div class="card"><h3>Resources</h3><table style="margin-top:8px"><tr><th>Resource</th><th>Use it for</th></tr>${(sd.resources || []).map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.use)}</td></tr>`).join('')}</table></div>
      </div>`;
  }

  // ----- Notes -----
  function renderNotes() {
    const n = DATA.notes;
    const byId = Object.fromEntries(allItems().map((x) => [x.id, x]));
    const probNotes = Object.entries(DATA.progress).filter(([, p]) => p.note && p.note.trim()).map(([id, p]) => ({ id, item: byId[id], note: p.note })).filter((x) => x.item)
      .sort((a, b) => a.item.week - b.item.week || a.item.day - b.item.day || a.item.idx - b.item.idx);
    const journal = (n.journal || []).map((e, i) => ({ ...e, i })).sort((a, b) => b.date.localeCompare(a.date));
    $('#view-notes').innerHTML = `
      <div class="page-head">
        <div><h1>Notes</h1><div class="sub">Trigger notes, contest post-mortems and per-problem notes. All saved in data.json.</div></div>
      </div>
      <div class="grid grid-2">
      <div class="stack">
        <div class="card"><div class="card-title"><h3>Trigger notes</h3><span class="hint">your triggers.md</span></div>
          <p class="muted small" style="margin-bottom:8px">One line per pattern: <em>cue → pattern</em>. Add a line every time an editorial teaches you a shape you should have recognised.</p>
          <textarea class="note-input mono" data-triggers rows="14" placeholder="${esc(DATA.guide.triggers.map((t) => `${t.cue}  →  ${t.pattern}`).join('\n'))}">${esc(n.triggers || '')}</textarea>
          <div class="muted small" style="margin-top:6px">Saved automatically to data.json.</div></div>
        <div class="card"><div class="card-title"><h3>Problem notes</h3><span class="hint">${probNotes.length} note${probNotes.length === 1 ? '' : 's'}</span></div>
          ${probNotes.length ? probNotes.map((x) => `<div class="pnote"><div class="row spread"><b>${esc(x.item.name)}</b><button class="btn small ghost" data-go-week="${x.item.week}" data-open-note="${x.id}">W${x.item.week} D${x.item.day} →</button></div><div class="pnote-text">${esc(x.note)}</div></div>`).join('')
            : '<div class="empty">Use the ✎ button on any problem in the Roadmap to attach a note. They all show up here.</div>'}</div>
      </div>
      <div class="card"><div class="card-title"><h3>Journal</h3><button class="btn small primary" id="btn-add-journal">+ Today</button></div>
        <p class="muted small" style="margin-bottom:10px">Post-mortems, contest notes, what to fix tomorrow.</p>
        ${journal.length ? journal.map((e) => `<div class="jentry">
            <div class="row spread"><input type="date" value="${e.date}" data-journal-date="${e.i}"><button class="btn small ghost" data-del-journal="${e.i}" title="Delete entry">✕</button></div>
            <textarea class="note-input" rows="4" data-journal="${e.i}" placeholder="What happened, what to change…">${esc(e.text || '')}</textarea></div>`).join('')
          : '<div class="empty">No entries yet</div>'}</div>
    </div>`;
  }

  // ----- Guide -----
  function renderGuide() {
    const g = DATA.guide;
    const ol = (arr) => `<ol style="margin-top:8px">${arr.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`;
    const tbl = (rows) => `<table style="margin-top:8px"><tr><th>Block</th><th>Time</th><th>Content</th></tr>${rows.map((b) => `<tr><td><b>${esc(b.block)}</b></td><td>${esc(b.duration)}</td><td>${esc(b.content)}</td></tr>`).join('')}</table>`;
    $('#view-guide').innerHTML = `
      <div class="page-head"><div><h1>Guide</h1><div class="sub">${esc(g.intro)}</div></div></div>
      <div class="stack">
      ${g.research ? `<div class="card"><div class="card-title"><h3>What the research says</h3><span class="hint">read before the schedule</span></div>
        <div class="grid grid-2" style="gap:12px">${g.research.map((r) => `<div class="note"><b>${esc(r.title)}</b><div style="margin-top:4px">${esc(r.text)}</div></div>`).join('')}</div></div>` : ''}
      <div class="grid grid-2">
        <div class="card"><h3>The rules</h3>${ol(g.rules)}</div>
        ${g.topicFrequency ? `<div class="card"><div class="card-title"><h3>Topic frequency</h3><span class="hint">~600 reported Google problems, 2022–2025</span></div>
          <table><tr><th>Topic</th><th>Share</th><th>Difficulty</th><th>Here</th></tr>${g.topicFrequency.map((t) => `<tr><td>${esc(t.topic)}</td><td><b>${esc(t.share)}</b></td><td>${esc(t.difficulty)}</td><td class="muted">${esc(t.weeks)}</td></tr>`).join('')}</table></div>`
          : `<div class="card"><h3>Trigger notes</h3><div class="trig" style="margin-top:8px">${g.triggers.map((t) => `<span class="cue">${esc(t.cue)}</span><span>${esc(t.pattern)}</span>`).join('')}</div></div>`}
      </div>
      <div class="card"><div class="card-title"><h3>Daily template — Phase 1</h3><span class="hint">5 full days + contest half-day + rest day</span></div>${tbl(g.dailyTemplate)}
        <ul style="margin-top:10px">${g.dailyNotes.map((n) => `<li class="muted">${esc(n)}</li>`).join('')}</ul></div>
      <div class="card"><div class="card-title"><h3>Daily template — Phase 2</h3><span class="hint">no new patterns</span></div>${tbl(g.phase2Template)}</div>
      ${g.drills ? `<div class="card"><div class="card-title"><h3>The drills</h3><span class="hint">details and logging in the Drills tab</span></div>
        <div class="grid grid-2" style="gap:12px">${g.drills.map((d) => `<div class="note ${d.star ? 'checkpoint' : ''}" style="${d.star ? '' : ''}"><b>${esc(d.name)}</b> <span class="muted small">· ${esc(d.when)}</span><div style="margin-top:4px">${esc(d.text)}</div></div>`).join('')}</div></div>` : ''}
      <div class="grid grid-2">
        <div class="card"><h3>Trigger notes</h3><div class="trig" style="margin-top:8px">${g.triggers.map((t) => `<span class="cue">${esc(t.cue)}</span><span>${esc(t.pattern)}</span>`).join('')}</div>
          ${g.triage ? `<p class="muted small" style="margin-top:12px"><b>Triage card</b> (90 s per problem): ${g.triage.map(esc).join(' · ')}</p>` : ''}</div>
        <div class="card"><h3>The verbal protocol</h3><p class="muted small" style="margin-top:4px">From week 9, every problem. Record yourself and watch it back.</p>${ol(g.verbalProtocol)}</div>
      </div>
      <div class="grid grid-2">
        <div class="card"><h3>Exit criteria</h3>${ol(g.exitCriteria)}</div>
        <div class="card"><h3>Failure modes, ranked</h3>${ol(g.failureModes)}</div>
      </div>
      ${g.googleyness ? `<div class="grid grid-2">
        <div class="card"><div class="card-title"><h3>Googleyness — ten STAR stories</h3><span class="hint">45 min/day from week 11</span></div>${ol(g.googleyness)}</div>
        <div class="card"><h3>Confirm with your recruiter</h3>${ol(g.recruiter || [])}${g.scope ? `<p class="muted small" style="margin-top:12px">${esc(g.scope)}</p>` : ''}</div>
      </div>` : ''}
      <div class="card"><h3>Resources</h3><table style="margin-top:8px"><tr><th>Resource</th><th>Use it for</th></tr>${g.resources.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.use)}</td></tr>`).join('')}</table>
        ${g.excluded ? `<p class="muted small" style="margin-top:10px">${esc(g.excluded)}</p>` : ''}</div>
    </div>`;
  }

  // ----- Settings -----
  function renderSettings() {
    const s = DATA.settings;
    const solvedCount = Object.values(DATA.progress).filter((p) => p.solved).length;
    $('#view-settings').innerHTML = `
      <div class="page-head"><div><h1>Settings</h1><div class="sub">Plan dates, re-do schedule and the linked data.json.</div></div></div>
      <div class="grid grid-2">
      <div class="card"><h3>Plan</h3>
        <div class="field" style="margin-top:12px"><label>Plan start date (Monday of week 1)</label><input type="date" id="set-start" value="${s.startDate}"></div>
        <div class="field"><label>Re-do offsets (days, comma-separated)</label><input type="text" id="set-offsets" value="${(s.redoOffsets || [3, 14]).join(', ')}"></div>
        ${DATA.systemDesign ? `<div class="field"><label>System design start date (Monday of SD week 1 — separate from the DSA plan)</label><input type="date" id="set-sd-start" value="${DATA.systemDesign.startDate || ''}"></div>` : ''}
        <button class="btn primary" id="set-save">Save settings</button>
      </div>
      <div class="stack">
        <div class="card"><h3>Storage</h3>
          <p class="muted small" style="margin-top:6px">Linked file: <b>${fileHandle && writable ? esc(fileHandle.name) : 'none — changes are not being saved'}</b>${DATA.updatedAt ? ` · last saved ${new Date(DATA.updatedAt).toLocaleString()}` : ''}.
            Every change is written straight into <code>data.json</code> next to <code>index.html</code>. Nothing is kept in the browser, so copy or sync the folder and open it anywhere.
            If Chrome asks for access again, choose <b>“Allow on every visit”</b>.</p>
          <div class="row wrap" style="margin-top:10px">
            <button class="btn ${writable ? '' : 'primary'}" id="btn-switch">${writable ? 'Link a different file' : 'Link data.json'}</button>
            <button class="btn" id="btn-reload" ${writable ? '' : 'disabled'}>Reload from file</button>
            <button class="btn ghost" id="btn-export">Download a copy</button>
          </div></div>
        <div class="card"><h3>Danger zone</h3>
          <p class="muted small" style="margin-top:6px">${solvedCount} problems marked solved, ${Object.keys(DATA.progress).length} progress entries, ${(DATA.drillLog || []).length} drill logs, ${Object.keys((DATA.sdProgress || {}).items || {}).length} system-design sessions.</p>
          <button class="btn danger" id="btn-reset" style="margin-top:10px">Reset all progress</button></div>
      </div></div>`;
  }

  // ---------- events (delegated) ----------
  document.getElementById('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item'); if (!b || !DATA) return;
    UI.view = b.dataset.view; render();
  });

  let resetArmed = false;
  document.getElementById('app').addEventListener('click', (e) => {
    const t = e.target;
    if (!writable) { e.preventDefault(); return linkOnGesture(); }
    const goWeek = t.closest('[data-go-week]'); if (goWeek) { UI.week = Number(goWeek.dataset.goWeek); UI.view = 'roadmap'; if (goWeek.dataset.openNote) UI.openNotes.add(goWeek.dataset.openNote); return render(); }
    const nt = t.closest('[data-note-toggle]'); if (nt) { const id = nt.dataset.noteToggle; if (UI.openNotes.has(id)) UI.openNotes.delete(id); else UI.openNotes.add(id); render(); const ta = document.querySelector(`[data-note="${id}"]`); if (ta) ta.focus(); return; }
    if (t.id === 'btn-add-journal') { DATA.notes.journal.push({ date: today(), text: '' }); save(); render(); const ta = document.querySelector(`[data-journal="${DATA.notes.journal.length - 1}"]`); if (ta) ta.focus(); return; }
    const dj = t.closest('[data-del-journal]'); if (dj) { DATA.notes.journal.splice(Number(dj.dataset.delJournal), 1); save(); return render(); }
    const goView = t.closest('[data-go-view]'); if (goView) { UI.view = goView.dataset.goView; return render(); }
    const sdw = t.closest('[data-sd-week]'); if (sdw && !sdw.disabled) { UI.sdWeek = Number(sdw.dataset.sdWeek); return render(); }
    const sdo = t.closest('[data-sd-open]'); if (sdo) { const ref = sdo.dataset.sdOpen; UI.sdOpen.add(ref); UI.view = ref.startsWith('c') ? 'sd-concepts' : 'sd-questions'; render(); const card = document.querySelector(`[data-sd-toggle="${ref}"]`); if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    const sdt = t.closest('[data-sd-toggle]'); if (sdt) { const ref = sdt.dataset.sdToggle; if (UI.sdOpen.has(ref)) UI.sdOpen.delete(ref); else UI.sdOpen.add(ref); return render(); }
    const wk = t.closest('[data-week]'); if (wk && !wk.disabled) { UI.week = Number(wk.dataset.week); return render(); }
    const redo = t.closest('[data-redo]'); if (redo) return toggleRedo(redo.dataset.redo, Number(redo.dataset.redoIdx));
    const skip = t.closest('[data-skip]'); if (skip) return toggleRedo(skip.dataset.skip, Number(skip.dataset.redoIdx), true);
    const rq = t.closest('[data-requeue]'); if (rq) return requeue(rq.dataset.requeue);
    const drill = t.closest('[data-drill]'); if (drill) {
      const inp = document.querySelector(`[data-minutes="${CSS.escape(drill.dataset.drill)}"]`);
      return logDrill(drill.dataset.drill, inp && inp.value);
    }
    const dd = t.closest('[data-del-drill]'); if (dd) { DATA.drillLog.splice(Number(dd.dataset.delDrill), 1); save(); return render(); }
    if (t.id === 'set-save') {
      const start = $('#set-start').value; if (start) DATA.settings.startDate = start;
      const offs = $('#set-offsets').value.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0);
      if (offs.length) DATA.settings.redoOffsets = offs;
      const sdStart = $('#set-sd-start'); if (sdStart && sdStart.value && DATA.systemDesign) { DATA.systemDesign.startDate = sdStart.value; UI.sdWeek = null; }
      save(); toast('Settings saved'); return render();
    }
    if (t.id === 'btn-export') return downloadCopy();
    if (t.id === 'btn-switch') { pickFile().then(() => { toast('Switched to ' + fileHandle.name); render(); }).catch((err) => { if (err.name !== 'AbortError') toast(err.message); }); return; }
    if (t.id === 'btn-reload') { readFromHandle().then(() => { toast('Reloaded from ' + fileHandle.name); render(); }).catch((err) => toast(err.message)); return; }
    if (t.id === 'btn-reset') {
      if (!resetArmed) { resetArmed = true; t.textContent = 'Click again to confirm reset'; setTimeout(() => { resetArmed = false; if (document.body.contains(t)) t.textContent = 'Reset all progress'; }, 4000); return; }
      DATA.progress = {}; DATA.drillLog = []; DATA.sdProgress = { items: {}, notes: {} }; resetArmed = false; save(); toast('Progress reset'); return render();
    }
  });

  document.getElementById('app').addEventListener('change', (e) => {
    const t = e.target;
    if (!writable) { render(); return linkOnGesture(); }
    if (t.dataset.solve) return toggleSolved(t.dataset.solve);
    if (t.dataset.task) return toggleTask(t.dataset.task);
    if (t.dataset.sdtask) return sdToggle(t.dataset.sdtask);
    if (t.dataset.solvedDate) return setSolvedDate(t.dataset.solvedDate, t.value);
    if (t.dataset.journalDate !== undefined) { const e = DATA.notes.journal[Number(t.dataset.journalDate)]; if (e && t.value) { e.date = t.value; save(); } return; }
  });

  // Typing in any note: save (debounced) without re-rendering, so focus and caret are kept.
  document.getElementById('app').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.note !== undefined) {
      setNote(t.dataset.note, t.value);
      const chip = document.querySelector(`[data-note-toggle="${t.dataset.note}"]`);
      if (chip) { chip.classList.toggle('has-note', !!t.value.trim()); chip.innerHTML = '✎' + (t.value.trim() ? ' note' : ''); }
      return;
    }
    if (t.dataset.triggers !== undefined) { DATA.notes.triggers = t.value; return save(); }
    if (t.dataset.sdnote !== undefined) return sdSetNote(t.dataset.sdnote, t.value);
    if (t.dataset.journal !== undefined) { const en = DATA.notes.journal[Number(t.dataset.journal)]; if (en) { en.text = t.value; save(); } }
  });

  document.getElementById('app').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.minutes) {
      logDrill(e.target.dataset.minutes, e.target.value);
    }
  });

  boot();
})();
