// Toolbar popup: overall status first, then what needs attention, what-if, pending items, settings.
const CUE_URL = "https://cue.christuniversity.in/main/attendence";
const { h, plural, fmt, tone, mustText, bar, dayLabel, ico, sep, chip, stepper, toggle, acc, absentSummary, absentDays } = UI;
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

const STALE_DAYS = Calc.STALE_DAYS; // the daily alert uses the same limit (background.js)
const WELCOME = chrome.runtime.getURL("welcome.html");
let D = null;        // storage
let viewSem = null;  // semester shown (defaults to the highest one)
let skip = 0;        // what-if: classes skipped
let wi = null;       // what-if result from the timetable (null without one)
const confirming = new Set(); // keys of inline "are you sure?" prompts
const accOpen = new Set();    // open accordions ("all", "adj", "settings")
let tourRun = null;          // the guided tour while it is showing
let tourTried = false;       // offered once per popup open
let pendingDraw = false;     // a redraw waiting for the user to leave a number box
let dataMsg = null;          // [tone, text] after an export / import
let importing = null;        // a parsed backup waiting for "yes"

const save = (patch) => chrome.storage.local.set(patch).then(load);

function load() {
  return chrome.storage.local
    .get({ threshold: 75, alerts: true, snapshots: {}, latest: null, adjust: {}, excused: {}, timetable: null, bunkBasis: "now", eseTarget: null, absentList: null, tour: {}, medBeforeMse: true, profile: null, profiles: {}, supportAsk: null })
    .then((d) => {
      D = d;
      d.threshold = Plan.minOf(d.threshold);
      if (!viewSem || !d.snapshots[viewSem]) viewSem = d.latest || UI.semOrder(d.snapshots)[0];
      draw();
      // First popup open with data: a short guided tour (once; Settings can replay it).
      if (viewSem && !d.tour.popup && !tourRun && !tourTried) { tourTried = true; startTour(); }
    });
}

// ---- guided tour
const q = (k) => document.querySelector(`[data-tour="${k}"]`);
function startTour() {
  tourRun?.end();
  accOpen.delete("settings");
  draw();
  tourRun = UI.tour({
    mount: document.body,
    steps: [
      { target: () => q("hero"), title: "Your attendance", text: "Your overall %, with the hours you've marked added in. The tick on the bar is your minimum." },
      { target: () => q("whatif"), title: "What if I put a bunk?", text: "Choose how many of your next classes to bunk and see where your overall would land." },
      { target: () => q("exam"), title: "Exam countdown", text: `Days left to MSE and ESE. MSE needs ${Math.round(Plan.MSE_MIN * 100)}% in every course. ESE needs your overall target.` },
      { target: () => q("best"), title: "Best days to bunk", text: "The safest days to bunk, worked out from your timetable. Open the CUE timetable once to unlock this." },
      { before: () => { accOpen.add("settings"); draw(); }, target: () => q("settings"), title: "Settings and backup", text: "Set your minimum, ESE target and daily alert. You can also export a backup, or import one on a new browser." },
      D.timetable && D.absentList?.rows?.length
        ? { title: "You're all set", text: "On CUE, the pill at the bottom right shows the same numbers, plus Put a bunk. To mark absent hours, use View Details on a course." }
        : { title: "Last step: finish setting up", text: `On CUE I'll open ${D.timetable ? "" : "your Timetable, then "}Absence Details for a moment so the extension can read them, then take you back to Attendance.`,
            next: { label: "Start setup", run: () => chrome.storage.local.set({ setup: { s: D.timetable ? "abs" : "tt", at: Date.now() } }).then(() => chrome.tabs.create({ url: `https://cue.christuniversity.in/main/${D.timetable ? "absence" : "timeTable"}` })) } },
    ],
    onEnd: () => { tourRun = null; save({ tour: { ...D.tour, popup: true } }); },
  });
}

// ---- profiles: one per student who logs in on CUE in this browser (Profile in profile.js)
const profileCount = () => Object.keys(D.profiles || {}).length;
function profilesRow() {
  const ids = Object.keys(D.profiles || {});
  const label = (id) => D.profiles[id]?.label || "Profile";
  const help = ids.length > 1
    ? "Each student who logs in on CUE here gets their own attendance, marks and timetable. This popup shows whoever logged in last; to see someone else's, log in as them."
    : `Saved as ${D.profile ? label(D.profile) : "the next student to log in"}. Another student logging in on CUE in this browser gets their own profile, so your data doesn't mix.`;
  return h("div", { class: "it2 set" },
    h("div", { class: "row" }, h("span", {}, "Profiles"), h("span", { class: "sub" }, plural(ids.length, "profile"))),
    h("div", { class: "sub", style: "margin-top:4px" }, help),
    ids.length > 1 ? ids.map((id) => {
      const key = `prof:${id}`;
      return h("div", { class: "row", style: "margin-top:8px" }, h("span", {}, h("b", {}, label(id))),
        id === D.profile ? h("span", { class: "sub" }, "showing now")
          : confirming.has(key)
            ? h("span", {}, h("span", { class: "bad" }, "Remove their data? "), h("button", { class: "link", onclick: () => { confirming.delete(key); Profile.remove(id).then(load); } }, "yes"), sep(), h("button", { class: "link", onclick: () => { confirming.delete(key); draw(); } }, "no"))
            : h("button", { class: "link", onclick: () => { confirming.add(key); draw(); } }, "Remove"));
    }) : null);
}
// A CUE tab switched profiles while the popup is open: show the new person.
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && "profile" in ch && D && ch.profile.newValue !== D.profile) { viewSem = null; load(); } });

// ---- backup: export / import everything the extension keeps
const KEYS = ["snapshots", "latest", "adjust", "excused", "lastCourse", "timetable", "timetableSem", "absentList", "bunkPlan", "profile", "profiles", "threshold", "alerts", "sortBy", "bunkBasis", "eseTarget", "medBeforeMse", "tour"];
async function exportData() {
  const data = await chrome.storage.local.get(KEYS);
  const n = new Date(), ymd = Cal.key(n);
  const file = { app: "leavemealone", schema: 1, version: chrome.runtime.getManifest().version, exportedAt: n.toISOString(), data };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: `leavemealone-backup-${ymd}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  dataMsg = ["good", "Backup saved to your downloads"];
  draw();
}
// Pure check of a parsed file: the known keys it carries, or null if it isn't a leavemealone backup.
function readBackup(file) {
  if (!file || file.app !== "leavemealone" || !file.data || typeof file.data !== "object" || Array.isArray(file.data)) return null;
  const data = Object.fromEntries(KEYS.filter((k) => k in file.data).map((k) => [k, file.data[k]]));
  if (data.snapshots && (typeof data.snapshots !== "object" || Array.isArray(data.snapshots))) return null;
  if (data.snapshots) { // a snapshot without a readable course list would stop the popup from drawing at all
    const ok = (s) => s && Array.isArray(s.courses) && Number.isFinite(s.syncedAt) && s.courses.every((c) => c && Number.isFinite(c.attended) && Number.isFinite(c.scheduled));
    for (const k of Object.keys(data.snapshots)) if (!ok(data.snapshots[k])) delete data.snapshots[k];
    if (data.latest && !data.snapshots[data.latest]) delete data.latest;
  }
  const at = new Date(file.exportedAt);
  return { data, sems: Object.keys(data.snapshots || {}).length, at: Number.isNaN(at.getTime()) ? null : at };
}
function pickBackup() {
  const input = h("input", { type: "file", accept: ".json,application/json", style: "display:none", onchange: async () => {
    const f = input.files[0];
    input.remove();
    if (!f) return;
    let b = null;
    try { b = readBackup(JSON.parse(await f.text())); } catch { b = null; }
    if (b) { importing = b; dataMsg = null; } else { importing = null; dataMsg = ["bad", "That file isn't a leavemealone backup"]; }
    draw();
  } });
  document.body.append(input);
  input.click();
}
async function applyBackup() {
  const { data } = importing;
  importing = null;
  await chrome.storage.local.remove(KEYS.filter((k) => !(k in data))); // replace, not merge: keys the backup lacks go too
  await chrome.storage.local.set(data);
  viewSem = null;
  tourTried = true; // don't start the tour over an import (an imported tour flag decides next time)
  dataMsg = ["good", "Backup imported"];
  load();
}

function dataRows() {
  return h("div", { class: "it2 set" },
    h("div", { class: "row" }, h("span", {}, "Backup"),
      h("span", { class: "tour-btns" }, h("button", { class: "btn sm", "data-key": "export", onclick: exportData }, "Export"), h("button", { class: "btn sm", "data-key": "import", onclick: pickBackup }, "Import"))),
    importing
      ? h("div", { class: "sub", style: "margin-top:6px" },
          h("span", { class: "warn" }, `Replace your data with this backup (${plural(importing.sems, "semester")}${importing.at ? `, saved ${dayLabel(importing.at)}` : ""})? `),
          h("button", { class: "link", onclick: applyBackup }, "yes"), sep(), h("button", { class: "link", onclick: () => { importing = null; draw(); } }, "no"))
      : h("div", { class: "sub", style: "margin-top:4px" }, "Export saves a file. Import replaces your data with one"),
    dataMsg ? h("div", { class: `sub ${dataMsg[0]}`, style: "margin-top:4px" }, dataMsg[1]) : null);
}

// Redraws rebuild the whole popup. Don't rebuild under someone typing in a number box; do it once they leave it.
document.addEventListener("focusout", (e) => {
  if (pendingDraw && e.target.classList?.contains("stv")) { pendingDraw = false; setTimeout(draw); }
});

function setCourseAdj(sem, c, field, val) {
  const adjust = D.adjust;
  const s = (adjust[sem] = adjust[sem] || { cocurricular: 0, courses: {} });
  const x = (s.courses[c.key] = s.courses[c.key] || { att: 0, sch: 0 });
  x[field] = Math.max(0, parseFloat(val) || 0);
  x.baseSch = c.portalScheduled; // remember what the portal showed when this was entered
  save({ adjust });
}
function draw() {
  const active = document.activeElement;
  if (active?.classList?.contains("stv")) { pendingDraw = true; return; }
  const focusKey = active?.dataset?.key; // keep keyboard focus on the same control across the rebuild
  try { drawAll(); } catch { drawBroken(); }
  byKey(focusKey)?.focus({ preventScroll: true });
  tourRun?.refresh();
}
// What the user last touched. A redraw can change the height of cards above it (the minimum decides which courses are low),
// so the scroll position is kept by this control's place on screen, not by a fixed offset.
let lastKey = null;
document.addEventListener("pointerdown", (e) => { lastKey = e.target.closest?.("[data-key]")?.dataset.key || null; }, true);
document.addEventListener("focusin", (e) => { lastKey = e.target.dataset?.key || lastKey; });
const byKey = (k) => (k ? document.querySelector(`[data-key="${CSS.escape(k)}"]`) : null); // escaped: a course name can hold a quote

// Saved data in a shape the popup can't draw (a hand-edited backup, say): say so and offer the way out, instead of a blank popup.
function drawBroken() {
  document.getElementById("app").replaceChildren(
    h("div", { class: "blk free", style: "margin-top:12px" }, h("div", { class: "h3" }, "Couldn't read saved data"),
      h("p", { class: "sub" }, "Something saved here isn't in the shape the popup expects (or the popup hit a bug). Export a backup first if you want to keep it, then erase to start fresh. The portal is untouched, and the next CUE visit saves a fresh copy."),
      confirming.has("wipe")
        ? h("div", { class: "row" }, h("span", { class: "bad" }, "Erase everything saved here?"), h("span", {},
            h("button", { class: "link", onclick: () => { confirming.delete("wipe"); viewSem = null; chrome.storage.local.remove([...Profile.DATA, "profile", "profiles"]).then(load); } }, "yes"), sep(),
            h("button", { class: "link", onclick: () => { confirming.delete("wipe"); draw(); } }, "no")))
        : h("button", { class: "btn danger", onclick: () => { confirming.add("wipe"); draw(); } }, "Erase saved data")),
    h("div", { class: "blk", style: "margin-top:12px" }, dataRows()));
}
function drawAll() {
  const app = document.getElementById("app");
  const y = document.documentElement.scrollTop; // a redraw rebuilds everything: keep the scroll position
  const anchorTop = byKey(lastKey)?.getBoundingClientRect().top; // where the control you touched sits on screen now
  const snap = D.snapshots[viewSem];
  if (!snap) {
    app.replaceChildren(...[
      supportCard(),
      h("div", { class: "blk free", style: "margin-top:12px" }, h("div", { class: "h3" }, "No attendance data yet"), h("p", { class: "sub" }, "Open the CUE attendance page once (table view) and it will appear here."), openBtn()),
      h("div", { class: "blk", style: "margin-top:12px" }, dataRows()), // a new browser can bring its data in before syncing
      helpBlock(false), creditBlock(),
    ].filter(Boolean));
    return;
  }
  const thr = D.threshold, t = thr / 100;
  const adj = D.adjust[viewSem] || { cocurricular: 0, courses: {} };
  const eff = Calc.actual(snap, adj, D.excused[viewSem], { medInCourse: Plan.medInCourse(D.medBeforeMse) }); // your actual attendance (portal + typed hours + marks), the same numbers as the drawer's Overview
  const effP = Calc.effective(snap, {}, {}); // what the portal itself shows, for the Reclassified card
  const portalPct = Calc.percent(effP.overall.attended, effP.overall.scheduled);
  const o = eff.overall;
  const op = Calc.percent(o.attended, o.scheduled);
  const courses = eff.courses.filter((c) => c.scheduled > 0); // portal order, on purpose
  const pc = (c) => Calc.percent(c.attended, c.scheduled);
  const low = courses.filter((c) => pc(c) < thr);
  const detained = courses.filter((c) => UI.detain(pc(c)));
  const sems = UI.semOrder(D.snapshots);
  const tn = tone(op, thr);
  const toggleAcc = (id) => (v) => { v ? accOpen.add(id) : accOpen.delete(id); }; // the accordion flips itself in place (UI.acc); a redraw would skip its animation

  // ---- 1. overall
  const stale = Date.now() - snap.syncedAt > STALE_DAYS * 86400000;
  const header = h("div", { class: "top" },
    sems.length > 1
      ? h("select", { "aria-label": "Semester", onchange: (e) => { viewSem = e.target.value; draw(); } }, sems.map((s) => h("option", { value: s, selected: s === viewSem }, s)))
      : h("span", { class: "t" }, viewSem),
    h("span", { class: `sub${stale ? " warn" : ""}` }, `${profileCount() > 1 ? `${D.profiles[D.profile]?.label} · ` : ""}synced ${ago(snap.syncedAt)}`));
  // The numbers only change when the portal is opened, so say so once they are more than STALE_DAYS old.
  const staleBox = stale ? h("div", { class: "stale", role: "status" },
    h("span", {}, h("b", {}, `These numbers are ${Math.floor((Date.now() - snap.syncedAt) / 86400000)} days old.`), " Open CUE attendance to refresh them."),
    h("button", { class: "btn sm", onclick: () => chrome.tabs.create({ url: CUE_URL }) }, "Refresh")) : null;
  const supportBox = stale ? null : supportCard(); // never on top of the stale warning
  // what-if: with a timetable the next `skip` classes are charged to their own courses; without one only the overall is known
  const wiFrom = Cal.addDays(Cal.day0(), 1);
  wi = skip && D.timetable ? Plan.nextClasses(D.timetable, eff.courses, wiFrom, skip) : null;
  const after = wi ? Calc.percent(o.attended, o.scheduled + wi.known) : Calc.afterSkipping(o.attended, o.scheduled, skip);
  // what-if lives in the big card, right above the number it changes
  const whatIf = h("div", { class: "whatif" },
    h("div", { class: "row" }, h("span", {}, "If I bunk the next"),
      h("span", { class: "row" }, stepper(skip, { min: 0, max: 999, label: "classes to skip", key: "skip", onchange: (v) => { skip = v; draw(); } }), h("span", {}, "classes"))),
    skip ? h("p", { class: "sub" }, wi && wi.taken ? `Bunking the next ${plural(wi.taken, "class")}${wi.taken < skip ? " (all that are left)" : ""}, until ${dayLabel(wi.last)}: ` : "Overall would be ", h("b", { class: tone(after, thr) }, `${after.toFixed(2)}%`), wi && wi.taken ? " overall." : ".") : null);
  const overall = h("div", { class: `hero w-${tn}` },
    h("div", { class: "row" }, h("span", { class: "v", style: `color:var(--${tn})` }, `${op.toFixed(2)}%`), h("span", { class: "sub" }, `${fmt(o.attended)} / ${o.scheduled}h`)),
    bar(op, thr),
    detained.length ? h("p", {}, UI.detain(op) ? UI.vibeLead(op) : null, h("b", {}, plural(detained.length, "course")), ` below ${UI.DETAIN}%.`)
      : low.length ? h("p", {}, h("b", {}, plural(low.length, "course")), ` ${low.length > 1 ? "are" : "is"} below ${thr}%.`) : h("p", {}, UI.vibeLead(op, thr), `All courses are at or above ${thr}%.`),
    Math.abs(o.attended - effP.overall.attended) > 1e-9 ? h("p", { class: "sub" }, `Includes ${fmt(Math.abs(o.attended - effP.overall.attended))}h you added. The portal shows ${portalPct.toFixed(2)}%.`) : null,
    o.medical ? h("p", { class: "sub" }, `Medical ${fmt(o.medical)}h: ${Calc.medicalText(o)}`) : null,
    o.ccIncluded ? h("p", { class: "sub" }, "Co-curricular is already included by the portal") : null,
    whatIf);

  // ---- exam countdown, best days to bunk (top 3; the full planner lives in the drawer on CUE)
  let examCard = null, bestCard = null;
  if (viewSem === D.latest) {
    const today = Cal.day0();
    const from = Cal.addDays(today, 1);
    const basis = Plan.resolveBasis(D.bunkBasis, from);
    const esePct = Plan.eseOf(D.eseTarget);
    const line = Plan.thresholdFor(basis, t, esePct);

    const days = (d) => plural(Math.round((d - today) / 86400000), "day");
    const mse = Cal.mseWindow(today), mseCut = Cal.cutoff("mse", from), eseEnd = Cal.semesterEnd(from), eseWin = Cal.eseWindow(today);
    const tiles = [];
    if (mse && mse.from > today) tiles.push(h("div", {}, h("b", {}, days(mse.from)), h("span", {}, "to MSE", sep(), `need ${Math.round(Plan.MSE_MIN * 100)}%`)));
    const eseStart = eseWin && eseWin.from > today ? eseWin.from : eseEnd; // the exams start after the last class day
    if (eseStart) tiles.push(h("div", {}, h("b", {}, days(eseStart)), h("span", {}, "to ESE", sep(), h("span", { class: esePct < Plan.ESE_OVERALL ? "bad" : null }, `target ${esePct}%`))));
    const notes = [];
    if (eseStart) { const gap = op - esePct; notes.push(`ESE: your overall is ${Math.abs(gap).toFixed(2)} points ${gap >= 0 ? "above" : "below"} the ${esePct}% target${esePct < Plan.ESE_OVERALL ? `, which is under the official ${Plan.ESE_OVERALL}%` : ""}.`); }
    if (mse && mse.from > today && mseCut) notes.push(`MSE starts ${dayLabel(mse.from)}, attendance counts till ${dayLabel(mseCut)}.`);
    const mb = D.timetable && mseCut ? Plan.budgets({ eff, tt: D.timetable, basis: "mse", t: Plan.MSE_MIN, from }) : null;
    if (mb) {
      const sure = mb.rows.filter((r) => r.matched); // courses missing from the timetable can't be judged
      const none = sure.filter((r) => r.reachable && r.budget === 0).length, out = sure.filter((r) => !r.reachable).length;
      if (none) notes.push(`${plural(none, "course")} with no spare classes before MSE.`);
      if (out) notes.push(`${plural(out, "course")} out of reach for MSE.`);
    }
    if (tiles.length || notes.length) examCard = h("div", {}, tiles.length ? h("div", { class: "exam" }, tiles) : null, notes.map((x) => h("div", { class: "sub note" }, x)));

    if (!D.timetable) {
      bestCard = h("div", {}, h("div", { class: "sec" }, "Best days to bunk"), h("div", { class: "sub" }, "Open your CUE timetable once to unlock bunk planning"));
    } else if (basis !== "now") { // before an exam any safe day is as good as another, so no list: the Plan on CUE button above covers it
      bestCard = null;
    } else {
      const best = Plan.bestDays({ eff, tt: D.timetable, courses: eff.courses, basis, t: line, from, limit: 3 });
      bestCard = h("div", {},
        h("div", { class: "sec" }, best.days.some((b) => b.safe) ? "Best days to bunk" : "Least risky days"),
        best.days.length
          ? h("div", { class: "blk" }, best.days.map((b) => {
              return h("div", { class: "it2" },
                h("div", { class: "row" }, h("b", {}, dayLabel(b.date)), chip(b.safe ? "good" : "bad", b.safe ? "safe" : "risky")),
                h("div", { class: "brk" }, h("span", { class: "sub" }, plural(b.classes, "class")), UI.breakTag(b.breakDays) ? chip("mute", ...UI.breakTag(b.breakDays)) : null),
                UI.breakTag(b.breakDays) && b.breakNames.length ? h("div", { class: "sub brkn", title: b.breakNames.join(", ") }, b.breakNames.join(", ")) : null);
            }))
          : h("div", { class: "sub" }, basis === "mse" ? "No class days left before MSE" : "No class days left this semester"));
    }
  }

  // ---- needs attention, then safe to skip (top 3) and every course
  const needs = h("div", {},
    h("div", { class: "sec" }, "Needs attention"),
    low.length ? h("div", { class: "blk" }, low.map((c) => courseRow(c, thr, t, false))) : h("div", { class: "sub" }, `Nothing below ${thr}%.`));
  const safe = courses.filter((c) => pc(c) >= thr).map((c) => ({ c, n: Calc.canSkip(c.attended, c.scheduled, t) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
  const safeBox = h("div", {},
    h("div", { class: "sec" }, "Safe to bunk"),
    safe.length ? h("div", { class: "blk" }, safe.map(({ c }) => courseRow(c, thr, t, false))) : h("div", { class: "sub" }, "No bunks left right now"),
    acc({ title: "All courses", icon: "list", tone: "pick", sub: skip && wi ? "Arrows show the courses those classes belong to" : `${plural(courses.length, "course")}, including the ones above`, open: accOpen.has("all"), ontoggle: toggleAcc("all") }, courses.map((c) => courseRow(c, thr, t, true))));

  // ---- your marks (pending on the portal)
  const marked = eff.courses.filter((c) => c.scheduled > 0 && (c.excusedHrs || c.goneHrs));
  const markedHrs = marked.reduce((n, c) => n + (c.excusedHrs || 0) + (c.goneHrs || 0), 0);
  const pending = marked.length
    ? acc({ title: "Reclassified absences", icon: "checks", tone: "blue", sub: [`${fmt(markedHrs)}h moved out of absent`, sep(), plural(marked.length, "course")], open: accOpen.has("marks"), ontoggle: toggleAcc("marks") },
        h("div", { class: "sub", style: "padding: 12px 0 4px" }, "Absent hours you reclassified on the portal. The numbers in this popup already count them.",
          h("div", { style: "margin-top:6px" }, "Overall: ", h("b", { class: tone(op, thr) }, `${op.toFixed(2)}%`), ` with your marks, ${portalPct.toFixed(2)}% on the portal`)),
        marked.map((c) => {
          const parts = [[c.laterHrs, "later"], [c.ccHrs, "co-curricular"], [c.medHrs, "medical"]].filter(([x]) => x).map(([x, n]) => `${fmt(x)}h ${n}`);
          const key = `clear:${c.key}`;
          return h("div", { class: "it2" },
            h("div", { class: "row" }, h("span", {}, h("b", { title: c.code || "" }, c.name || c.code)), c.excusedHrs
              ? confirming.has(key)
                ? h("span", {}, h("span", { class: "bad" }, "Clear marks? "), h("button", { class: "link", onclick: () => { confirming.delete(key); delete D.excused[viewSem][c.key]; save({ excused: D.excused }); } }, "yes"), sep(), h("button", { class: "link", onclick: () => { confirming.delete(key); draw(); } }, "no"))
                : h("button", { class: "link", onclick: () => { confirming.add(key); draw(); } }, "clear")
              : null),
            parts.length ? h("div", { class: "sub" }, parts.join(", "), c.excusedHrs ? [sep(), `${pc(effP.courses.find((x) => x.key === c.key) || c).toFixed(1)}% → `, h("b", { class: tone(pc(c), thr) }, `${pc(c).toFixed(1)}%`)] : null) : null,
            c.goneHrs ? h("div", { class: "sub warn" }, `${fmt(c.goneHrs)}h updated on the portal: open its View Details and press Confirm present.`) : null,
            c.staleMarks ? h("div", { class: "sub warn" }, "The portal shows fewer absent hours than when you marked: open its View Details to check") : null);
        }),
        eff.overall.goneHrs ? openBtn("Open CUE to confirm") : null)
    : null;

  // ---- absent hours day by day (saved when the all-courses absent list is opened on CUE)
  const al = D.absentList && D.absentList.sem === viewSem && D.absentList.rows.length ? D.absentList : null;
  const absBox = acc({
    title: "Absent hours", icon: "userx", tone: "bad", sub: al ? absentSummary(al.rows) : "Not saved yet",
    open: accOpen.has("abs"), ontoggle: toggleAcc("abs") },
    al ? absentDays(al.rows) : h("div", { class: "sub", style: "padding-top:12px" }, "Open the Absent card on the CUE attendance page once and the list will appear here."));

  // ---- holidays and the MSE week, month by month, from today to the end of the semester
  let holBox = null;
  {
    const today = Cal.day0();
    const to = Cal.semesterEnd(today) || Cal.addDays(today, 150);
    const events = Cal.holidays(today, to).map((x) => ({ date: x.date, name: x.name }));
    const mse = Cal.mseWindow(today);
    if (mse && mse.from >= today) events.push({ date: mse.from, name: `MSE begins, until ${dayLabel(mse.to)}`, tag: "MSE" });
    events.sort((a, b) => a.date - b.date);
    if (events.length) {
      const months = [];
      for (const e of events) {
        const label = e.date.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
        let m = months[months.length - 1];
        if (!m || m.label !== label) months.push((m = { label, rows: [] }));
        m.rows.push(e);
      }
      const next = events[0];
      const daysTo = (d) => Math.round((d - today) / 86400000);
      const when = (d) => (daysTo(d) === 0 ? "today" : daysTo(d) === 1 ? "tomorrow" : `in ${daysTo(d)} days`);
      let i = 0;
      holBox = acc({ title: "Holidays", sub: [`Next: ${dayLabel(next.date)}`, sep(), when(next.date)], icon: "cal", tone: "gold",
        open: accOpen.has("hol"), ontoggle: toggleAcc("hol") },
        months.map((m) => [
          h("div", { class: "pday" }, h("b", {}, m.label), h("span", { class: "sub" }, plural(m.rows.length, "date"))),
          m.rows.map((e) => {
            const br = Plan.breakLength(e.date), tn = e.tag ? "blue" : e === next ? "gold" : "mute";
            return h("div", { class: `hrow${e === next ? " next" : ""}`, style: `--i:${i++}` },
              h("span", { class: `dbadge t-${tn}` }, h("small", {}, e.date.toLocaleDateString("en-IN", { month: "short" })), h("b", {}, String(e.date.getDate()))),
              h("span", { class: "hx" }, h("b", {}, e.name), h("span", { class: "sub" }, e.date.toLocaleDateString("en-IN", { weekday: "long" }), e.tag ? chip("blue", e.tag) : br.n >= 3 ? chip("mute", `${br.n}-day break`, `${br.n} days off in a row`) : null)),
              h("span", { class: "hr sub" }, when(e.date)));
          }),
        ]));
    }
  }

  // ---- adjustments (rare path) and settings
  const num = (v, label, onchange) => stepper(v || 0, { min: 0, max: 999, label, key: `adj-${label}`, live: true, onchange });
  const adjBox = acc({ title: "Add hours the portal is missing", icon: "clock", tone: "good", sub: "For a class the portal has not counted", open: accOpen.has("adj"), ontoggle: toggleAcc("adj") },
    h("div", { class: "row", style: "padding-top:12px" }, h("span", { class: "lbl" }, "Co-curricular hours pending"), num(adj.cocurricular, "co-curricular hours", (v) => {
      const adjust = D.adjust; (adjust[viewSem] = adjust[viewSem] || { cocurricular: 0, courses: {} }).cocurricular = v;
      save({ adjust });
    })),
    h("div", { class: "th" }, h("span", {}, "Attended"), h("span", {}, "Held")),
    courses.map((c) => h("div", { class: "row", style: "padding:3px 0" }, h("span", { class: "lbl", title: c.name }, c.code || c.name),
      h("span", { class: "row" }, num(c.adj.att, `${c.code || c.name} attended`, (v) => setCourseAdj(viewSem, c, "att", v)), num(c.adj.sch, `${c.code || c.name} held`, (v) => setCourseAdj(viewSem, c, "sch", v))))),
    h("div", { class: "sub", style: "margin-top:8px" }, "Went to an extra class the portal hasn't counted? Add 1 under Attended and 1 under Held."));

  // Settings are grouped (Targets / Counting / Alerts / Your data); Help & support sits outside, at the end (helpBlock); each row has one short line saying what it changes.
  const setRow = (label, help, control) => h("div", { class: "it2 set opt" },
    h("span", { class: "lab" }, label), help ? h("div", { class: "help" }, help) : null, h("div", { class: "ctl-r" }, control));
  const group = (title, ...rows) => h("div", { class: "setgrp" }, h("div", { class: "setgrp-t" }, title), ...rows.filter(Boolean));
  const settings = acc({ title: "Settings", icon: "sliders", tone: "mute", sub: "Minimum, ESE target, medical, alert, profiles, backup", open: accOpen.has("settings"), ontoggle: toggleAcc("settings") },
    h("div", { "data-tour": "settings" },
      group("Targets",
        setRow("Minimum %", `Drives can bunk, attend next, the colours and the alert. ${Plan.ESE_MIN}% to 100%`,
          stepper(D.threshold, { min: Plan.ESE_MIN, max: 100, decimals: 1, label: "minimum attendance", key: "set-min", live: true, onchange: (v) => save({ threshold: v }) })),
        setRow("ESE target %", [UI.eseFlag(Plan.eseOf(D.eseTarget), Plan.ESE_OVERALL), `Overall % to sit end-sem exams. Official ${Plan.ESE_OVERALL}%, you can set ${Plan.ESE_MIN}% to 100%. `,
          D.eseTarget != null && D.eseTarget !== Plan.ESE_OVERALL ? h("button", { class: "link", onclick: () => chrome.storage.local.remove("eseTarget").then(load) }, `Reset to ${Plan.ESE_OVERALL}%`) : null],
          stepper(Plan.eseOf(D.eseTarget), { min: Plan.ESE_MIN, max: 100, decimals: 1, label: "ESE target", key: "set-ese", onchange: (v) => save({ eseTarget: v }) })), // saved on blur/Enter or +/-: typing "8" on the way to "85" must not save 8
        h("div", { class: "sub setnote" }, `MSE always needs ${Math.round(Plan.MSE_MIN * 100)}% in every course. The slang tags follow fixed lines too: below ${UI.DETAIN}% pakka detain, then eda mone, from ${UI.STEADY}% mastundhi, from ${UI.SUSEGAD}% susegad.`)),
      group("Counting",
        setRow("Medical per course until MSE", "Marked medical hours count in their own course until MSE, then only in the overall (74.5% to 84.49%)",
          toggle(D.medBeforeMse !== false, (v) => save({ medBeforeMse: v }), "Medical per course until MSE", "set-med"))),
      group("Alerts",
        setRow("Daily alert", "A notification once a day if a course is low", toggle(D.alerts !== false, (v) => save({ alerts: v }), "Daily alert", "set-alert"))),
      group("Your data",
        dataRows(),
        setRow("Erase saved data",
          "Clears attendance, marks, adjustments and timetables here, for every profile. The portal is untouched.",
          confirming.has("wipe")
            ? h("span", {}, h("span", { class: "bad" }, "Erase? "), h("button", { class: "link", onclick: () => { confirming.delete("wipe"); viewSem = null; chrome.storage.local.remove([...Profile.DATA, "profile", "profiles"]).then(load); } }, "yes"), sep(), h("button", { class: "link", onclick: () => { confirming.delete("wipe"); draw(); } }, "no"))
            : h("button", { class: "btn danger sm", onclick: () => { confirming.add("wipe"); draw(); } }, "Erase")),
        profilesRow())));

  // anchors for the guided tour
  overall.dataset.tour = "hero";
  whatIf.dataset.tour = "whatif";
  const examTiles = examCard?.querySelector(".exam");
  if (examTiles) examTiles.dataset.tour = "exam";
  if (bestCard) bestCard.dataset.tour = "best";

  app.replaceChildren(...[header, staleBox, supportBox, overall, viewSem === D.latest ? openBtn("Plan on CUE") : null, examCard, bestCard, needs, safeBox, absBox, pending, adjBox, holBox, settings, helpBlock(true), creditBlock(), h("div", { class: "tagline" }, UI.TAGLINE)].filter(Boolean));
  const anchor = byKey(lastKey);
  document.documentElement.scrollTop = anchorTop != null && anchor ? y + anchor.getBoundingClientRect().top - anchorTop : y; // keep that control where it was
}

function courseRow(c, thr, t, showAfter) {
  const pct = Calc.percent(c.attended, c.scheduled);
  const vibe = UI.vibeTag(pct, thr);
  const skipN = Calc.canSkip(c.attended, c.scheduled, t);
  const adjusted = !!(c.adj.att || c.adj.sch || c.excusedHrs);
  const tip = adjusted ? `Includes your own changes. Portal ${c.portalAttended}/${c.portalScheduled}, with your marks ${fmt(c.attended)}/${c.scheduled}` : "";
  const status = pct < thr ? chip("bad", mustText(Calc.mustAttend(c.attended, c.scheduled, t))) : chip(skipN ? "good" : "warn", skipN ? `can bunk ${skipN}` : "no bunks left");
  const num = h("span", { class: "p", style: `color:var(--${tone(pct, thr)})` }, `${pct.toFixed(0)}%`);
  const k = wi ? wi.missed[c.key] || 0 : 0; // classes of THIS course among the ones skipped
  const afterN = skip && showAfter && k ? h("span", { class: "to" }, `→ ${Calc.percent(c.attended, c.scheduled + k).toFixed(0)}%`) : null;
  return h("div", { class: "it2" },
    h("div", { class: "row" },
      h("span", { class: "cname" }, h("b", { class: "nm", title: c.name }, c.name || c.code),
        c.code || adjusted ? h("div", { class: "cl" }, c.code ? h("span", { class: "sub" }, c.code) : null, adjusted ? chip("mute", "adj", tip) : null) : null),
      afterN ? h("span", { class: "rr" }, h("span", {}, num, afterN), status, vibe) : h("span", { class: "pcw" }, h("span", { class: "pc" }, num, status), vibe)), // the slang tag sits under the chip, in the space beside the code
    bar(pct, thr));
}

// The ask to chip in: from the first popup open until either button is pressed, then never again (supportAsk).
function supportCard() {
  if (D.supportAsk) return null;
  return h("div", { class: "support", role: "status" },
    h("span", {}, h("b", {}, "Free, made by two students."), " If it saves your attendance, chip in or star it on GitHub."),
    h("span", { class: "row" },
      h("button", { class: "btn sm", onclick: () => save({ supportAsk: "done" }).then(() => chrome.tabs.create({ url: `${WELCOME}#support` })) }, "Chip in"),
      h("button", { class: "link", onclick: () => save({ supportAsk: "done" }) }, "No thanks")));
}

// Help & support, always the last block of the popup (outside Settings). withTour: the tour needs synced data.
function helpBlock(withTour) {
  const row = (label, help, btn) => h("div", { class: "it2 set opt" }, h("span", { class: "lab" }, label), h("div", { class: "help" }, help), h("div", { class: "ctl-r" }, btn)); // same option row as Settings (setRow)
  const open = (hash, text) => h("button", { class: "btn sm", onclick: () => chrome.tabs.create({ url: WELCOME + hash }) }, text);
  return h("div", { class: "blk helpblk", "data-tour": "help" },
    h("div", { class: "setgrp-t" }, "Help & support"),
    row("Chip in", "UPI or a star on GitHub. It stays free either way.", open("#support", "Open")),
    row("Report a bug", "Opens a short form that files it on GitHub", open("#report", "Report")),
    withTour ? row("Quick tour", "Replays this tour now and the pill tour on your next CUE visit", h("button", { class: "btn sm", onclick: () => chrome.storage.local.set({ tour: {} }).then(() => { D.tour = {}; startTour(); }) }, "Replay")) : null,
    null);
}

// Who made it + the disclaimer: its own block under Help & support, not inside that tile.
function creditBlock() {
  return h("div", { class: "creditblk" }, h("div", { class: "credit" }, "Developed by ", h("b", {}, UI.ABOUT.by)), h("div", { class: "sub" }, UI.ABOUT.notAffiliated));
}

function openBtn(text = "Open CUE") {
  return h("button", { class: "btn solid cta", onclick: () => chrome.tabs.create({ url: CUE_URL }) }, text, ico("out"));
}

load();
