/* DSA 16-Week Tracker — plain JS, no framework, no backend, no browser storage.
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
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- roadmap helpers ----------
  function itemId(w, d, i) { return `w${w}d${d}i${i}`; }
  function norm(item) { return typeof item === 'string' ? { name: item, type: 'problem' } : { name: item.name, type: item.type || 'problem' }; }
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
    if (n < 0) return { week: 1, day: 1, before: true, daysUntil: -n };
    const week = Math.min(16, Math.floor(n / 7) + 1);
    const day = (n % 7) + 1;
    return { week, day, after: n >= 16 * 7 };
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
    p.redos.push(...makeRedos(today(), 'R'));
    toast('Re-queued for +3 and +14 days from today');
    save(); render();
  }
  function toggleTask(id) {
    if (isTaskDone(id)) delete DATA.progress[id]; else DATA.progress[id] = { done: today() };
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
      : pos.after ? 'Plan complete — keep revising' : `Week ${pos.week} · Day ${pos.day}\n${DATA.weeks[pos.week - 1].title}`;
    const due = allRedos().filter((r) => !r.done && r.due <= today()).length;
    const pill = $('#pill-due'); pill.textContent = due; pill.classList.toggle('zero', due === 0);
    document.querySelectorAll('.nav-item').forEach((t) => t.classList.toggle('active', t.dataset.view === UI.view));
    document.querySelectorAll('.view').forEach((v) => {
      const active = v.id === 'view-' + UI.view;
      v.classList.toggle('active', active);
      if (!active) v.innerHTML = ''; // only one view lives in the DOM at a time
    });
    ({ dashboard: renderDashboard, roadmap: renderRoadmap, revision: renderRevision, drills: renderDrills, notes: renderNotes, guide: renderGuide, settings: renderSettings })[UI.view]();
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

    const wk = DATA.weeks[pos.week - 1];
    const todayDay = wk.days.find((d) => d.day === pos.day);
    const dueList = redos.filter((r) => !r.done && r.due <= today()).sort((a, b) => a.due.localeCompare(b.due));

    const wkStats = weekStats(wk);
    const pct = Math.round(100 * solved / probs.length);
    const d = new Date();
    const longDate = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const isDrillDay = pos.day === 1 || pos.day === 4;
    const isContest = pos.day === 7;
    const posLine = pos.before ? `Plan starts ${fmt(DATA.settings.startDate)}` : pos.after ? 'Plan complete' : `Week ${pos.week}, day ${pos.day} · ${esc(wk.title)}`;

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
              <button class="chip btn ${dueList.length ? (overdue ? 'overdue' : 'due') : 'done'}" data-go-view="revision">Block B · ${dueList.length ? `${dueList.length} re-solve${dueList.length === 1 ? '' : 's'} due` : 'queue clear'}</button>
              <span class="chip">Block C · editorials, triggers, one variant</span>
              ${isContest ? '<span class="chip">Contest day · 90 min + post-mortem</span>' : `<button class="chip btn" data-go-view="drills">Block D · ${isDrillDay ? 'blind primitives' : 'one hard, unrushed'}</button>`}
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
      return { label: 'W' + w.week, value: s.pct, color: w.phase === 2 ? cssVar('--blue') : cssVar('--accent'), highlight: w.week === pos.week ? cssVar('--green') : null };
    }), { yMax: 100, yFormat: (v) => v + '%' });

    const cells = [];
    const start = DATA.settings.startDate;
    for (let w = 0; w < 16; w++) for (let d = 0; d < 7; d++) {
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
      <span class="name">${esc(it.name)}</span>
      <span class="meta">${meta}</span></div>
      ${open ? `<div class="note-row"><textarea class="note-input" data-note="${id}" rows="3" placeholder="Approach · trigger phrase · what went wrong · variant to try">${esc(note)}</textarea></div>` : ''}`;
  }

  // ----- Roadmap -----
  function renderRoadmap() {
    const el = $('#view-roadmap');
    const pos = currentPosition();
    const wk = DATA.weeks[UI.week - 1];
    const stats = weekStats(wk);
    const strip = DATA.weeks.map((w) => {
      const s = weekStats(w);
      return `<button class="week-pill ${w.week === UI.week ? 'active' : ''} ${w.week === pos.week ? 'current' : ''} ${w.phase === 2 ? 'p2' : ''}" data-week="${w.week}" title="Week ${w.week} — ${esc(w.title)} · ${s.pct}%">
        ${w.week}<div class="bar thin ${s.pct === 100 ? 'green' : ''}"><span style="width:${s.pct}%"></span></div></button>`;
    }).join('');

    const days = wk.days.map((day) => `
      <div class="card day-card ${wk.week === pos.week && day.day === pos.day ? 'today' : ''}">
        <div class="day-head"><span class="dn">Day ${day.day}${wk.week === pos.week && day.day === pos.day ? ' <span class="badge accent">today</span>' : ''}</span><span class="df">${esc(day.focus)}</span></div>
        <div class="items">${day.items.map((it, i) => renderItem(wk.week, day.day, i, it)).join('')}</div>
      </div>`).join('');

    el.innerHTML = `
      <div class="page-head">
        <div><h1>Roadmap</h1><div class="sub">Phase 1 · pattern consolidation, weeks 1–13 &nbsp;·&nbsp; Phase 2 · interview conversion, weeks 14–16</div></div>
        <div class="actions">
          <button class="btn small" data-week="${Math.max(1, wk.week - 1)}" ${wk.week === 1 ? 'disabled' : ''}>← Week ${Math.max(1, wk.week - 1)}</button>
          <button class="btn small" data-week="${Math.min(16, wk.week + 1)}" ${wk.week === 16 ? 'disabled' : ''}>Week ${Math.min(16, wk.week + 1)} →</button>
        </div>
      </div>
      <div class="week-strip">${strip}</div>
      <div class="stack">
        <div class="card">
          <div class="week-head">
            <div class="wh-title"><span class="badge ${wk.phase === 1 ? 'accent' : 'green'}">Phase ${wk.phase}</span><h2>Week ${wk.week} — ${esc(wk.title)}</h2>${wk.week === pos.week ? '<span class="badge">current</span>' : ''}</div>
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
    const rows = DATA.guide.primitives.map((p) => {
      const mine = log.filter((l) => l.name === p.name);
      const last = mine.length ? mine[mine.length - 1] : null;
      const best = mine.filter((l) => l.minutes).reduce((b, l) => (b === null || l.minutes < b ? l.minutes : b), null);
      const locked = pos.week < p.from;
      const key = esc(p.name);
      return `<div class="prim ${locked ? 'locked' : ''}">
        <div><div class="pname">${key}</div><div class="pmeta">${locked ? `From week ${p.from}` : mine.length ? `${mine.length}× · last ${fmt(last.date)}${best !== null ? ` · best ${best} min` : ''}` : 'Not drilled yet'}</div></div>
        ${best !== null ? `<span class="badge ${best <= 10 ? 'green' : 'amber'}">${best <= 10 ? 'under 10' : 'over 10'}</span>` : '<span></span>'}
        <input type="number" min="1" max="120" placeholder="min" data-minutes="${key}">
        <button class="btn small" data-drill="${key}">Log today</button></div>`;
    }).join('');
    const recent = log.slice(-12).reverse();
    const perWeek = [];
    for (let w = 0; w < 16; w++) {
      const a = addDays(DATA.settings.startDate, w * 7), b = addDays(a, 6);
      perWeek.push({ label: 'W' + (w + 1), value: log.filter((l) => l.date >= a && l.date <= b).length, highlight: w + 1 === pos.week ? cssVar('--green') : null });
    }
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Drills</h1><div class="sub">Blind primitives on Mon & Thu (45 min). ${esc(DATA.guide.primitivesGoal)}</div></div>
      </div>
      <div class="stack">
      <div class="grid grid-2">
        <div class="card"><div class="card-title"><h3>Blind primitives</h3><span class="hint">blank file, timed</span></div>${rows}</div>
        <div class="stack">
          <div class="card"><div class="card-title"><h3>Drills per week</h3></div><canvas id="c-drills" class="chart short"></canvas></div>
          <div class="card"><h3>Variant generation</h3><p class="muted small" style="margin:4px 0 8px">After solving anything, ask <em>what if</em> and solve it. Highest-leverage habit in the plan.</p>
            <ul>${DATA.guide.variantPrompts.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></div>
          <div class="card"><h3>Recent drill log</h3>${recent.length ? `<table style="margin-top:8px"><tr><th>Date</th><th>Primitive</th><th>Min</th><th></th></tr>
            ${recent.map((l) => `<tr><td>${fmt(l.date)}</td><td>${esc(l.name)}</td><td>${l.minutes || '—'}</td><td><button class="btn small ghost" data-del-drill="${log.indexOf(l)}">✕</button></td></tr>`).join('')}</table>` : '<div class="empty" style="margin-top:8px">No drills logged yet</div>'}</div>
        </div>
      </div></div>`;
    Charts.bars($('#c-drills'), perWeek, { yMax: Math.max(4, ...perWeek.map((p) => p.value)), ticks: 2 });
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
    $('#view-guide').innerHTML = `
      <div class="page-head"><div><h1>Guide</h1><div class="sub">${esc(g.intro)}</div></div></div>
      <div class="stack">
      <div class="grid grid-2">
        <div class="card"><h3>The four rules</h3><ol style="margin-top:8px">${g.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ol></div>
        <div class="card"><h3>Trigger notes (triggers.md)</h3><div class="trig" style="margin-top:8px">${g.triggers.map((t) => `<span class="cue">${esc(t.cue)}</span><span>${esc(t.pattern)}</span>`).join('')}</div>
          <p class="muted small" style="margin-top:10px">Keep exactly two files: <code>triggers.md</code> (one line per pattern) and <code>failures.md</code> (this site's revision queue). Elaborate note systems are procrastination.</p></div>
      </div>
      <div class="card"><h3>Daily template — Phase 1 (5.5h × 6 days)</h3>
        <table style="margin-top:8px"><tr><th>Block</th><th>Duration</th><th>Content</th></tr>${g.dailyTemplate.map((b) => `<tr><td><b>${esc(b.block)}</b></td><td>${esc(b.duration)}</td><td>${esc(b.content)}</td></tr>`).join('')}</table>
        <ul style="margin-top:10px">${g.dailyNotes.map((n) => `<li class="muted">${esc(n)}</li>`).join('')}</ul></div>
      <div class="card"><h3>Daily template — Phase 2 (weeks 14–16)</h3>
        <table style="margin-top:8px"><tr><th>Block</th><th>Duration</th><th>Content</th></tr>${g.phase2Template.map((b) => `<tr><td><b>${esc(b.block)}</b></td><td>${esc(b.duration)}</td><td>${esc(b.content)}</td></tr>`).join('')}</table></div>
      <div class="grid grid-2">
        <div class="card"><h3>The verbal protocol</h3><ol style="margin-top:8px">${g.verbalProtocol.map((r) => `<li>${esc(r)}</li>`).join('')}</ol></div>
        <div class="card"><h3>Exit criteria — done when all five hold</h3><ol style="margin-top:8px">${g.exitCriteria.map((r) => `<li>${esc(r)}</li>`).join('')}</ol></div>
      </div>
      <div class="grid grid-2">
        <div class="card"><h3>Failure modes, ranked</h3><ol style="margin-top:8px">${g.failureModes.map((r) => `<li>${esc(r)}</li>`).join('')}</ol></div>
        <div class="card"><h3>Resources</h3><table style="margin-top:8px"><tr><th>Resource</th><th>Use it for</th></tr>${g.resources.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.use)}</td></tr>`).join('')}</table></div>
      </div>
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
          <p class="muted small" style="margin-top:6px">${solvedCount} problems marked solved, ${Object.keys(DATA.progress).length} progress entries, ${(DATA.drillLog || []).length} drill logs.</p>
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
      if (chip) { chip.classList.toggle('has-note', !!t.value.trim()); chip.innerHTML = '✎' + (t.value.trim() ? ' note' : ''); }
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

  boot();
})();
