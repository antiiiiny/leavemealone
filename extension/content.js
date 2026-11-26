// CUE attendance helper. Runs on the whole portal host (it is a single-page app, so
// pages change without a reload) and acts by route:
//   /main/attendence    -> parse the course table, save a snapshot, show a pill + drawer,
//                          remember which course's "View Details" you click
//   /main/AbsentDetails -> mark each absent hour as absent / co-curricular / medical / later
//   /main/absence       -> the all-courses absent list: a summary pill; with one course picked in the filter, the same marking panel
//   /main/timeTable     -> save the weekly timetable for the "Put a bunk" tab
// All UI lives in one Shadow DOM host so the portal's CSS and ours never touch.
(() => {
  // After the extension is reloaded or updated, tabs that were already open keep this script but lose the chrome.* APIs.
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const store = {
    get: (d) => (alive() ? chrome.storage.local.get(d) : Promise.resolve(d)),
    set: (o) => (alive() ? chrome.storage.local.set(o) : Promise.resolve()),
  };
  const route = () => {
    const p = location.pathname.toLowerCase();
    return p.includes("/main/attendence") ? "att" : p.includes("/main/absentdetails") ? "abs" : p.includes("/main/absence") ? "absall" : p.includes("/main/timetable") ? "tt" : null;
  };
  const pair = (txt) => {
    const m = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(txt || "");
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  };
  const semester = () => (document.querySelector('[role="combobox"]')?.textContent.trim() || "unknown").replace(/\s*\[[^\]]*\]\s*$/, ""); // the portal adds "[On Roll]" / "[Semester Completed]"
  const plain = (k) => k.replace(/\s*\[[^\]]*\]\s*$/, "");
  // Data saved while the label still carried the bracket moves to the plain label. `merge(plainCopy, bracketedCopy)` combines the two when both
  // exist (marks are per course: the newer bracketed copy wins for ITS courses but must not wipe the plain copy's other courses); without it the bracketed copy replaces.
  function plainKeys(o, merge) {
    let moved = false;
    for (const k of Object.keys(o || {})) if (plain(k) !== k) { const p = plain(k); o[p] = merge && o[p] ? merge(o[p], o[k]) : o[k]; delete o[k]; moved = true; }
    return moved;
  }
  const MERGE = {
    excused: (a, b) => ({ ...a, ...b }),
    adjust: (a, b) => ({ ...a, ...b, courses: { ...(a.courses || {}), ...(b.courses || {}) } }),
  };
  const COURSE_TABLE = 'table[aria-label="coursewise attendance table"]';
  const { h, plural, fmt, tone, mustText, bar, dayLabel, niceDate, nicePeriod, startTime, ico, sep, chip, pills, stepper, acc, tween, placeThumb, absentSummary, absentDays, hrsOf } = UI;

  // ---------------------------------------------------------------- parsing
  function parseRow(tr) {
    const th = tr.querySelector("th");
    const tds = tr.querySelectorAll("td");
    if (!th || tds.length < 3) return null;
    const spans = th.querySelectorAll("span.MuiTypography-root");
    const p = pair(tds[0].textContent);
    if (!p) return null;
    let code = (spans[1]?.textContent || "").trim();
    if (code.toUpperCase() === "N/A") code = "";
    const name = (spans[0]?.textContent || "").trim();
    const absent = parseFloat(tds[1].textContent);
    return {
      name, code, key: code || name,
      type: (th.querySelector(".MuiChip-label")?.textContent || "").trim(),
      attended: p[0], scheduled: p[1], absent: Number.isFinite(absent) ? absent : null,
    };
  }

  // Grid view: one card per course (role=button, aria-label "NAME (CODE): 87.5% attendance, 14 of 16 classes attended. ...").
  // It has no absent or Co-curricular column; absent = scheduled - attended, the same as the table's own sums.
  const CARD = '[role="button"][aria-label$="Click to view absence details."]';
  function parseCard(card) {
    const name = (card.querySelector('[role="heading"]')?.textContent || "").trim();
    const meta = (card.querySelector('[role="heading"]')?.nextElementSibling?.textContent || "").split("•").map((x) => x.trim());
    const p = pair((card.querySelector("p")?.textContent || "").replace(/\s+of\s+/, " / "));
    if (!name || !p) return null;
    const code = /^(n\/a|null)?$/i.test(meta[0] || "") ? "" : meta[0];
    return { name, code, key: code || name, type: meta[1] || "", attended: p[0], scheduled: p[1], absent: Math.max(0, p[1] - p[0]) };
  }

  function parseCourses() {
    const table = document.querySelector(COURSE_TABLE);
    const cards = table ? [] : [...document.querySelectorAll(CARD)];
    if (!table && !cards.length) return null;
    const courses = table ? [...table.querySelectorAll("tbody tr")].map(parseRow).filter(Boolean) : cards.map(parseCard).filter(Boolean);
    if (!courses.length) return null;
    const overallText = document.querySelector('[aria-label^="Overall attendance"]')?.textContent;
    // At semester end the portal adds a "Co-curricular" column and folds those hours into attended (grid view: unknown here, tickAtt keeps what the table said).
    const hasCc = table ? [...table.querySelectorAll("thead th")].some((x) => /co-?\s*curricular/i.test(x.textContent)) : null;
    return { semester: semester(), syncedAt: Date.now(), overall: pair(overallText), courses, hasCc, via: table ? "table" : "grid" };
  }

  // Remember which course's details the user is opening (the Absent Details page doesn't say).
  document.addEventListener(
    "click",
    (e) => {
      if (route() !== "att") return;
      const b = e.target.closest?.('button,[role="button"]');
      if (!b) return;
      const label = b.getAttribute("aria-label") || b.textContent || "";
      const tr = b.closest(`${COURSE_TABLE} tr`);
      const card = b.closest(CARD);
      if ((tr && /view details/i.test(label)) || card) {
        const c = card ? parseCard(card) : parseRow(tr);
        if (c) store.set({ lastCourse: { semester: semester(), key: c.key, name: c.name, at: Date.now() } });
      } else if (/^view absent details/i.test(label)) {
        store.set({ lastCourse: null }); // overall list: not tied to one course
      }
    },
    true
  );

  // ---------------------------------------------------------------- shadow host
  let host, dock, hostPromise, cssText = "";
  async function buildHost() {
    if (!alive()) return; // the extension was reloaded under this tab: tick() shows the notice
    if (!cssText) {
      try { cssText = await (await fetch(chrome.runtime.getURL("ui.css"))).text(); } catch { cssText = ""; }
    }
    // A shadow root cannot load fonts, so declare the bundled Space Grotesk in the page itself (no network, own file).
    if (!document.getElementById("cue-att-font")) {
      const f = document.createElement("style");
      f.id = "cue-att-font";
      f.textContent = `@font-face{font-family:"LMA Space Grotesk";font-weight:300 700;font-style:normal;font-display:swap;src:url("${chrome.runtime.getURL("fonts/SpaceGrotesk.woff2")}") format("woff2")}`;
      document.head.append(f);
    }
    host = document.createElement("div");
    host.id = "cue-att-host";
    const shadow = host.attachShadow({ mode: "open" });
    dock = h("div", { class: "cue dock" });
    const style = document.createElement("style");
    style.textContent = cssText;
    shadow.append(style, dock);
    document.body.append(host);
    syncGutter();
  }
  // The portal scrolls inside its own container, so its scrollbar sits inside the viewport. Measure it and keep
  // the dock the same 16px from it as from the bottom edge.
  function syncGutter() {
    if (!host?.isConnected) return;
    let w = 0;
    for (let el = document.elementFromPoint(innerWidth - 3, Math.round(innerHeight / 2)); el && !w; el = el.parentElement) w = el.offsetWidth - el.clientWidth;
    host.style.setProperty("--sb", `${Math.max(0, Math.round(w || innerWidth - document.documentElement.clientWidth))}px`);
  }
  addEventListener("resize", syncGutter);
  function ensureHost() {
    if (host?.isConnected) return Promise.resolve();
    hostPromise ||= buildHost().finally(() => { hostPromise = null; });
    return hostPromise;
  }
  // ---------------------------------------------------------------- attendance page
  // A = everything the drawer needs: { snap, threshold, adj, exc, open, sortBy, tt, basis }
  let attOpen = false;
  let attSig = "";
  let A = null;
  let effPortal = null;          // what the portal itself shows (nothing of yours added), for the Overview's "Portal" line
  let effMarks = null;           // your actual numbers (same object as `eff` in renderAtt), used by the review notice and the extras block
  let tab = "overview";          // "overview" | "plan"
  let planKey = null, planSaved = ""; // which semester's saved bunk plan planSel holds, and what was last written for it
  let planSel = new Map();       // dayKey -> Set(periods SKIPPED) | null (whole day skipped). The view shows ticked = attending.
  let planMonth = 0;             // months after the first plannable month
  let todayPick = new Set();     // periods ticked on the "skip today?" card
  let todayFor = "";             // which day that selection belongs to
  const courseOpen = new Set();  // Overview rows opened to show what each course needs
  const accOpen = new Set();     // which accordions are open ("per", "budget")
  let growBars = true;           // bars grow once when the drawer opens or the tab changes, not on every click
  let calShown = null;           // month the calendar last drew, to slide when it changes
  let lastPicked = null;         // day just picked, for the springy pop

  // one-shot ring on the pill's status dot when it is clicked (re-triggerable)
  const ping = (pill) => { pill.classList.remove("clicked"); void pill.offsetWidth; pill.classList.add("clicked"); };
  // The floating pill of the attendance and absent drawers: the click runs `onclick`, then the status dot's ring plays once.
  function makePill(attrs, onclick) {
    const pill = h("button", { class: "pill", ...attrs, onclick: () => { onclick(); ping(pill); } });
    pill.addEventListener("animationend", (e) => { if (e.animationName === "dotOrbit") pill.classList.remove("clicked"); });
    return pill;
  }
  const rerender = () => { if (A) { attSig = ""; renderAtt(A); } };
  function setOpen(v) {
    if (!v && shell && host?.shadowRoot?.activeElement && shell.drawer.contains(host.shadowRoot.activeElement)) shell.pill.focus(); // don't strand focus in a hidden drawer
    if (v && !attOpen && shell) shell.drawer.scrollTop = 0; // opening always starts at the top, not where it was left
    attOpen = v;
    if (v) growBars = true;
    if (A) { A.open = v; rerender(); }
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (attOpen) setOpen(false); else if (absOpen) setAbsOpen(false); } });
  document.addEventListener("click", (e) => {
    if (host && !e.composedPath().includes(host)) { if (attOpen) setOpen(false); else if (absOpen) setAbsOpen(false); }
  });

  // Sort options for the course list (default: same order as the portal's table).
  const SORTS = [
    { v: "portal", label: "Portal order" },
    { v: "low", label: "Lowest % first" },
    { v: "high", label: "Highest % first" },
    { v: "az", label: "Course name (A-Z)" },
  ];
  function sortCourses(list, by) {
    const pct = (c) => Calc.percent(c.attended, c.scheduled);
    const out = [...list];
    if (by === "low") out.sort((a, b) => pct(a) - pct(b));
    else if (by === "high") out.sort((a, b) => pct(b) - pct(a));
    else if (by === "az") out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  const today0 = () => Cal.day0();
  const courseIn = (snap, key) => snap?.courses.find((x) => (x.code || x.name) === key); // course key = code || name

  // A course as "NAME / code" (students know the subject, not the code). `extra` goes after the code.
  const nameCell = (c, ...extra) => h("span", {}, h("b", { class: "nm", title: c.name }, c.name || c.code),
    c.code || extra.length ? h("div", { class: "cl" }, c.code ? h("span", { class: "sub" }, c.code) : null, extra) : null);

  // "Put a bunk today?": the next class day's classes, which of them you can skip, and what ticking some would cost.
  function todayCard(eff, threshold, t) {
    if (!A.tt) return h("div", { class: "blk today" }, h("div", { class: "thead" }, h("b", { class: "h3" }, "Put a bunk today?")), h("p", { class: "sub" }, "Open your timetable once and this will tell you which classes you can bunk"));
    const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes(), t0 = today0();
    let date = Plan.upcomingFrom(A.tt, now), cls = [];
    for (let i = 0; i < 30; i++, date = Cal.addDays(date, 1)) {
      cls = Plan.sortedClassesOn(date, A.tt).filter((x) => +date !== +t0 || !(Plan.endMinutes(x.time) <= nowMin));
      if (cls.length) break;
    }
    if (!cls.length) return null;
    const dkey = Cal.key(date);
    if (todayFor !== dkey) { todayFor = dkey; todayPick = new Set(); }
    const ofName = Plan.courseOf(eff.courses), courseOf = (x) => ofName(x.name);
    const impactOf = (list) => { const m = {}; for (const x of list) { const c = courseOf(x); if (c) m[c.key] = (m[c.key] || 0) + 1; } return Plan.impact(eff, m, "now", {}, t); };
    const okAlone = (x) => { const c = courseOf(x); if (!c) return null; const r = impactOf([x]).rows[0]; return !r || r.safe; };
    const picked = cls.filter((x) => todayPick.has(x.period));
    const nOk = cls.filter((x) => okAlone(x)).length;
    const when = +date === +t0 ? "Today" : +date === +Cal.addDays(t0, 1) ? "Tomorrow" : "Next class day";
    const flip = (period) => { todayPick.has(period) ? todayPick.delete(period) : todayPick.add(period); rerender(); };

    let result;
    if (!picked.length) result = h("p", { class: "sub" }, nOk ? `You can bunk ${nOk} of ${plural(cls.length, "class")} and stay at ${threshold}% or more. Tap classes to see what a bunk costs.` : `Bunking any of these would put a course below ${threshold}%.`);
    else {
      const im = impactOf(picked), bad = im.rows.filter((r) => !r.safe);
      result = h("div", { class: "tres" },
        h("div", { class: "row" }, h("span", {}, `Bunk ${plural(picked.length, "class")}`), h("span", {}, h("span", { class: "sub" }, `${im.overall.before.toFixed(2)}% to `), h("b", { class: bad.length ? "bad" : "good" }, `${im.overall.after.toFixed(2)}%`))),
        h("p", { class: "sub" }, bad.length ? `${bad.map((r) => `${r.code || r.name} drops to ${r.after.toFixed(0)}%`).join(", ")}: below ${threshold}%.` : `Every course stays at ${threshold}% or more.`));
    }
    const canPlan = +date > +t0;
    return h("div", { class: "blk today" },
      h("div", { class: "thead" }, h("b", { class: "h3" }, when), h("span", { class: "sub" }, `${plural(cls.length, "class")}, ${dayLabel(date)}`)),
      cls.map((x) => {
        const c = courseOf(x), ok = okAlone(x), on = todayPick.has(x.period);
        return h("button", { class: `trow${on ? " on" : ""}`, role: "checkbox", "aria-checked": String(on), "data-key": `today-${x.period}`, onclick: () => flip(x.period) },
          h("span", {}, nicePeriod(x.period)),
          h("span", { class: "ac", title: x.name }, h("b", {}, c ? (c.code || c.name) : x.name), c && c.code ? h("small", {}, c.name) : null),
          ok === null ? chip("mute", "not in table") : chip(ok ? "good" : "bad", ok ? "can bunk" : "attend"),
          h("span", { class: "bx" }));
      }),
      result,
      h("div", { class: "tact" },
        nOk && picked.length < nOk ? h("button", { class: "btn sm", "data-key": "today-safe", onclick: () => { todayPick = new Set(cls.filter((x) => okAlone(x)).map((x) => x.period)); rerender(); } }, "Pick the ones I can bunk") : null,
        picked.length ? h("button", { class: "btn sm", "data-key": "today-clear", onclick: () => { todayPick = new Set(); rerender(); } }, "Clear") : null,
        canPlan ? h("button", { class: "btn sm", "data-key": "today-plan", onclick: () => { planSel = new Map([[dkey, picked.length ? new Set(picked.map((x) => x.period)) : null]]); planMonth = monthOffset(Cal.addDays(today0(), 1), date); tab = "plan"; growBars = true; calShown = null; rerender(); } }, "Open in planner") : null));
  }

  // What a course needs, in plain words, with the real dates of its next classes when the timetable is saved.
  function needView(c, pct, skip, t, threshold) {
    const day = (x) => `${dayLabel(x.date)} ${nicePeriod(x.period)}`;
    const need = Calc.mustAttend(c.attended, c.scheduled, t);
    const low = pct < threshold;
    const head = low ? (Number.isFinite(need) ? `Attend the next ${plural(need, "class")} to get back to ${threshold}%.` : `${threshold}% is out of reach for this course now.`)
      : skip ? `You can bunk ${plural(skip, "class")} and stay at ${threshold}% or more` : "No bunks left: attend every class to stay at the minimum";
    const lines = [h("p", {}, head)];
    const pc = effPortal.courses.find((x) => x.key === c.key), pa = pc ? Calc.percent(pc.attended, pc.scheduled) : pct;
    if (Math.abs(pct - pa) >= 0.05) {
      const parts = [c.adj.att && `${fmt(c.adj.att)}h you typed in`, c.laterHrs && `${fmt(c.laterHrs)}h marked Later`, c.ccHrs && `${fmt(c.ccHrs)}h co-curricular`, c.medInCourse && `${fmt(c.medHrs)}h medical (until MSE)`].filter(Boolean);
      lines.unshift(h("p", { class: "sub" }, `Portal shows ${pa.toFixed(1)}%.${parts.length ? ` Counted here: ${parts.join(", ")}.` : ""}`));
    }
    if (!A.tt) lines.push(h("p", { class: "sub" }, "Open your timetable once to see the dates"));
    else {
      const n = low ? (Number.isFinite(need) ? need : 0) : 1;
      const dates = n ? Plan.courseClasses(A.tt, c, Plan.upcomingFrom(A.tt, new Date()), Math.min(n, 12)) : [];
      if (!dates.length && n) lines.push(h("p", { class: "sub" }, "This course isn't on your timetable, so there are no dates to show"));
      else if (dates.length) lines.push(h("div", { class: "cdates" }, low ? "" : h("span", { class: "sub" }, "Next class"), dates.map((x) => h("span", { class: "dt" }, day(x))), low && need > dates.length ? h("span", { class: "dt more" }, `+${need - dates.length} more`) : null));
    }
    return lines;
  }

  // ---- Overview tab
  function overviewView(eff, threshold, t) {
    const o = eff.overall;
    const op = Calc.percent(o.attended, o.scheduled);
    const tn = tone(op, threshold);
    const courses = eff.courses.filter((c) => c.scheduled > 0);

    const po = effPortal.overall, pp = Calc.percent(po.attended, po.scheduled);
    const added = o.attended - po.attended;
    const heroNum = h("span", { class: "v", style: `color:var(--${tn})` });
    tween(heroNum, "hero", op, (x) => `${x.toFixed(2)}%`, { animate: A.open, countUp: true });
    const hero = h("div", { class: `hero w-${tn}` },
      h("div", { class: "row" }, heroNum, h("span", { class: "sub" }, `${fmt(o.attended)} / ${o.scheduled}h`)),
      bar(op, threshold),
      h("p", { class: "sub" }, UI.vibeLead(op, threshold), op >= threshold ? h("b", {}, `${(op - threshold).toFixed(2)} points above`) : h("b", {}, `${(threshold - op).toFixed(2)} points below`), ` your ${threshold}% minimum`),
      h("p", { class: "sub" }, op < threshold ? (Number.isFinite(Calc.mustAttend(o.attended, o.scheduled, t)) ? `Attend the next ${plural(Calc.mustAttend(o.attended, o.scheduled, t), "class")} to get back to ${threshold}%` : `${threshold}% is out of reach now: a missed class stays missed`)
        : Calc.canSkip(o.attended, o.scheduled, t) ? `You can bunk ${plural(Calc.canSkip(o.attended, o.scheduled, t), "class")} and stay above it` : "No bunks left: one more would put you below it"),
      Math.abs(added) > 1e-9 ? h("p", { class: "sub" }, `Includes ${fmt(Math.abs(added))}h you added. The portal shows ${pp.toFixed(2)}%.`) : null,
      o.medical ? h("p", { class: "sub" }, `Medical ${fmt(o.medical)}h: ${Calc.medicalText(o)}`) : null,
      o.ccIncluded ? h("p", { class: "sub" }, "Co-curricular is already included by the portal") : null);

    const review = effMarks.courses.filter((c) => c.stale || c.goneHrs);
    const reviewBox = review.length
      ? h("div", { class: "warnbox" }, h("b", {}, "Needs review"),
          review.map((c) => h("div", { class: "sub" }, `${c.code || c.name}: `,
            c.goneHrs ? `${fmt(c.goneHrs)}h updated on the portal. Open View Details and press Confirm present.` : "the portal's numbers changed since you adjusted this. Check it.")))
      : null;

    const sortBar = h("div", { class: "sec" },
      h("span", {}, "Courses"),
      h("label", { class: "sub sortl" }, "Sort by",
        h("select", { "aria-label": "Sort courses", "data-key": "sort", onchange: (e) => { A.sortBy = e.target.value; store.set({ sortBy: A.sortBy }); rerender(); } },
          SORTS.map((s) => h("option", { value: s.v, selected: s.v === A.sortBy }, s.label)))));

    const list = sortCourses(courses, A.sortBy).map((c) => {
      const pct = Calc.percent(c.attended, c.scheduled);
      const vibe = UI.vibeTag(pct, threshold);
      const adjusted = !!(c.adj.att || c.adj.sch || c.excusedHrs);
      const skip = Calc.canSkip(c.attended, c.scheduled, t);
      const tip = adjusted ? `Includes your own changes. Portal ${c.portalAttended}/${c.portalScheduled}, with your marks ${fmt(c.attended)}/${c.scheduled}` : "";
      const open = courseOpen.has(c.key);
      const toggle = () => { open ? courseOpen.delete(c.key) : courseOpen.add(c.key); rerender(); };
      return h("div", { class: `it2 cx${open ? " open" : ""}`, role: "button", tabindex: "0", "aria-expanded": String(open), "data-key": `cx-${c.key}`, onclick: toggle,
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } } },
        h("div", { class: "row" },
          h("span", { class: "cname" }, h("b", { class: "nm", title: c.name }, c.name || c.code),
            c.code || adjusted ? h("div", { class: "cl" }, c.code ? h("span", { class: "sub" }, c.code) : null, adjusted ? chip("mute", "adj", tip) : null) : null),
          h("span", { class: "pcw" }, h("span", { class: "pc" }, h("span", { class: "p", style: `color:var(--${tone(pct, threshold)})` }, `${pct.toFixed(0)}%`),
            pct < threshold ? chip("bad", mustText(Calc.mustAttend(c.attended, c.scheduled, t))) : chip(skip ? "good" : "warn", skip ? `can bunk ${skip}` : "no bunks left")), vibe)), // the slang tag sits under the chip, in the space beside the code
        h("div", { class: "cbar" }, bar(pct, threshold), ico("chev", "ic chev")),
        h("div", { class: "cdet", inert: open ? null : "" }, h("div", {}, needView(c, pct, skip, t, threshold))));
    });

    hero.dataset.tour = "hero";
    const today = todayCard(eff, threshold, t);
    if (today) today.dataset.tour = "today";
    list[0]?.setAttribute("data-tour", "course");
    return [hero, today, reviewBox, sortBar, h("div", { class: "blk" }, list)];
  }

  // ---- Put a bunk tab
  function planView(eff, threshold, t) {
    if (!A.tt) {
      return h("div", { class: "blk free" },
        h("div", { class: "h3" }, "Open your timetable once"),
        h("p", { class: "sub" }, "I need your weekly timetable to know which classes you'd bunk. Open it once and come back."),
        h("button", { class: "btn solid cta", "data-key": "open-tt", onclick: () => location.assign("/main/timeTable") }, "Open timetable", ico("right")));
    }
    const from = Cal.addDays(today0(), 1);
    // A saved "mse" basis only holds while MSE is still ahead; `line` is the fraction that counts as safe.
    const basis = Plan.resolveBasis(A.basis, from);
    const esePct = Plan.eseOf(A.eseTarget); // ESE: the overall target, 85% unless you change it
    const line = Plan.thresholdFor(basis, t, esePct);
    const linePct = +(line * 100).toFixed(1);
    const cr = Plan.criteria(basis), cLinePct = +(Plan.courseLine(basis, line) * 100).toFixed(1); // MSE: every course at the line, no overall; ESE: the overall at the line, courses at the plain minimum
    const end = Plan.horizon(basis, from);
    const examName = basis === "mse" ? "MSE" : "ESE";
    const past = basis !== "now" && !!end && end < from; // the cutoff has gone by (exam window still on): a reference, nothing left to plan
    const picked = planSel.size;
    planSel = Plan.clipSelection(planSel, end);
    const dropped = picked - planSel.size;
    const courses = eff.courses;

    const bud = Plan.budgets({ eff, tt: A.tt, basis, t: line, from });
    const best = basis === "now" ? Plan.bestDays({ eff, tt: A.tt, courses, basis, t: line, from }) : null; // before an exam any safe day is as good as another
    const remaining = basis !== "now" ? Plan.remainingHours(A.tt, courses, from, end) : {};
    const impactFor = (sel) => { const { missed, unknown } = Plan.missedFor(sel, A.tt, courses); return { ...Plan.impact(eff, missed, basis, remaining, line), unknown }; };
    const res = impactFor(planSel);
    // A day gets the coral outline when a currently-safe plan would tip below the line if you added it.
    const riskOf = (k) => res.safe && !impactFor(new Map([...planSel, [k, null]])).safe;
    const clear = () => { planSel = new Map(); rerender(); };

    const out = [];
    const opts = [["now", "After the bunk"]];
    if (Plan.resolveBasis("mse", from) === "mse") opts.push(["mse", "Before MSE"]);
    if (Plan.resolveBasis("end", from) === "end") opts.push(["end", "Before ESE"]);
    if (opts.length > 1) out.push(h("div", { class: "ctl" },
      h("div", { class: "sub" }, "Safe means"),
      pills(opts, basis, (v) => { A.basis = v; store.set({ bunkBasis: v }); rerender(); }, { label: "Safe means", keyPrefix: "basis" }),
      basis === "end" ? h("div", { class: "opt" },
        h("span", { class: "lab" }, "ESE target, overall (%)"),
        h("div", { class: "help" }, UI.eseFlag(esePct, Plan.ESE_OVERALL), `Overall % to sit end-sem exams (${Plan.ESE_OVERALL}% by the rules). Each course still needs your ${threshold}% minimum.`),
        h("div", { class: "ctl-r" }, stepper(esePct, { min: Plan.ESE_MIN, max: 100, decimals: 1, label: "ESE target", key: "ese", onchange: (v) => { A.eseTarget = v; store.set({ eseTarget: v }); rerender(); } }))) : null));
    if (A.basis === "mse" && basis === "now") out.push(h("div", { class: "warnbox top" }, h("div", { class: "sub" }, "MSE isn't open for planning (no class days left before it, or it isn't in the calendar), so these are right-now numbers.")));
    if (dropped) out.push(h("div", { class: "sub note" }, `${plural(dropped, "selected day")} after the ${examName} cutoff ${dropped > 1 ? "were" : "was"} removed.`));
    if (!Cal.known(from)) out.push(h("div", { class: "warnbox top" }, h("div", { class: "sub" }, "This year's academic calendar isn't in the extension yet, so holidays aren't known.")));

    // ---- hero: the answer first, same height in every state so the calendar below never jumps
    const K = res.overall.k;
    const meta = h("div", { class: "meta" },
      h("span", { class: "sub" }, plural(planSel.size, "day"), sep(), `${plural(K, "class")} bunked`),
      h("button", { class: "btn sm", "data-key": "clear", disabled: !planSel.size, onclick: clear }, "Clear selection"));
    let hero;
    if (past && bud) {
      const judged = bud.rows.filter((r) => r.matched), lowest = !cr.overall && judged.length ? judged.reduce((m, r) => (r.pct < m.pct ? r : m)) : null;
      const shown = lowest ? lowest.pct : bud.overall.pct, need = lowest ? cLinePct : linePct, tn = tone(shown, need);
      hero = h("div", { class: `hero plan w-${tn}` },
        h("div", { class: "v", style: `color:var(--${tn})` }, `${shown.toFixed(2)}%`),
        h("p", {}, lowest ? `Your lowest course (${lowest.code || lowest.name}) counted for ${examName} up to ` : `Your attendance counted for ${examName} up to `, h("b", {}, dayLabel(end)), ", against the ", h("b", {}, `${need}%`), lowest ? " every course needs." : " needed."));
    } else if (planSel.size) {
      const after = res.overall.after, gap = Math.abs(after - linePct).toFixed(2);
      const failing = res.rows.filter((r) => !r.safe).length;
      const names = [...planSel.keys()].sort().map((k) => dayLabel(Cal.parse(k)));
      const list = names.length > 2 ? `${names.length} days` : names.join(" and ");
      const lead = basis !== "now" ? `, you reach ${examName} at ` : ", overall drops to ";
      const tail = cr.overall && !res.overall.safe ? [lead, h("b", {}, `${after.toFixed(2)}%`), `, ${gap} points below the ${linePct}% ${basis === "end" ? "needed" : "minimum"}.`]
        : cr.course && failing ? (cr.overall ? [", overall holds at ", h("b", {}, `${after.toFixed(2)}%`), `, but ${plural(failing, "course")} ${failing === 1 ? "falls" : "fall"} below ${cLinePct}%.`]
            : [`, ${plural(failing, "course")} ${failing === 1 ? "falls" : "fall"} below ${cLinePct}% at ${examName}.`])
        : cr.overall ? [lead, h("b", {}, `${after.toFixed(2)}%`), `, ${gap} points above the ${linePct}% ${basis === "end" ? "needed" : "minimum"}.`]
        : [", every course stays at or above ", h("b", {}, `${cLinePct}%`), ` at ${examName}.`];
      hero = h("div", { class: `hero plan ${res.safe ? "ok" : "no"}` },
        h("div", { class: "v", style: `color:var(--${res.safe ? "good" : "bad"})` }, res.safe ? "Safe to bunk" : "Not safe", h("s", {}, ".")),
        h("p", {}, "Bunking ", h("b", {}, list), tail), meta);
    } else if (bud && !bud.reachable) {
      hero = h("div", { class: "hero plan w-bad" },
        h("div", { class: "v" }, "Out of reach", h("s", {}, ".")),
        cr.course ? h("p", {}, "Even attending every class, ", h("b", {}, bud.unreachable.map((r) => r.code || r.name).join(", ")), ` can't reach ${cLinePct}% by ${examName}.`)
          : h("p", {}, `Even if you attend every class you'd reach `, h("b", {}, `${Math.floor(bud.overall.bestCase)}%`), ` at ${examName}, short of the ${linePct}% needed.`));
    } else if (bud) {
      const n = bud.spare.n;
      hero = h("div", { class: "hero plan w-good" },
        h("div", { class: "v" }, n ? `${n} spare` : "No spare", h("s", {}, ".")),
        n ? h("p", {}, cr.course ? "Every course can still bunk " : "You can still bunk ", h("b", {}, plural(n, "class")), cr.course ? ` before ${examName} (the tightest is ${bud.spare.row ? (bud.spare.row.code || bud.spare.row.name) : "one"}) on ` : ` overall before ${examName} on `, h("b", {}, dayLabel(bud.end)), ".")
          : h("p", {}, `Every class counts until ${examName} on `, h("b", {}, dayLabel(bud.end)), "."),
        null);
    } else {
      hero = h("div", { class: "hero plan" },
        h("div", { class: "v" }, "Pick a day", h("s", {}, ".")),
        h("p", {}, "Pick days below to see what bunking them costs"));
    }
    out.push(hero);

    // ---- calendar
    if (!past) {
      out.push(h("div", { class: "sec" }, h("span", {}, "Pick days"), h("span", { class: "sub" }, "tap as many as you like")));
      out.push(calendarView(from, Cal.semesterEnd(from), end, linePct, riskOf));
    }

    if (planSel.size) {
      // ---- ticks: ticked = you will attend. The state stays "periods skipped" (see Plan.setAttend).
      const days = [...planSel.keys()].sort().map((k) => {
        const d = Cal.parse(k), cls = Plan.classesOn(d, A.tt), sk = planSel.get(k);
        return [
          h("div", { class: "pday" }, h("b", {}, dayLabel(d)), h("span", { class: "sub" }, `${sk ? sk.size : cls.length} of ${cls.length} bunked`)),
          cls.map((c) => {
            const ticked = sk ? !sk.has(c.period) : false;
            return h("button", { class: "per", role: "checkbox", "aria-checked": String(ticked), "data-key": `per-${k}-${c.period}`, onclick: () => {
              const next = Plan.setAttend(cls.map((x) => x.period), sk, c.period, !ticked);
              if (next === undefined) planSel.delete(k); else planSel.set(k, next);
              rerender();
            } },
              h("span", { class: `bx${ticked ? " on" : ""}` }), h("span", {}, nicePeriod(c.period)), h("span", { class: "pt" }, startTime(c.time)), h("span", { class: "sub" }, c.name));
          }),
        ];
      });
      out.push(acc({ title: "Classes you will still attend", icon: "checks", tone: "pick", sub: [`${plural(K, "class")} bunked`, sep(), "tick to attend some"], open: accOpen.has("per"), key: "acc-per",
        ontoggle: (v) => { v ? accOpen.add("per") : accOpen.delete("per"); } }, days));

      // ---- result
      const arrow = (r, dp, key) => {
        const after = h("b", { style: `color:var(--${r.safe ? "good" : "bad"})` });
        tween(after, key || `bunk-${r.key}`, r.after, (x) => `${x.toFixed(dp)}%`, { animate: A.open });
        return [`${r.before.toFixed(dp)}% → `, after];
      };
      out.push(h("div", { class: "sec" }, "If you bunk"));
      out.push(h("div", { class: "blk" },
        h("div", { class: "it2 main" }, h("div", { class: "row" }, h("span", {}, h("b", {}, "Overall")), h("span", { class: "big" }, arrow(res.overall, 1)))),
        res.rows.map((r) => h("div", { class: `it2 minor${r.safe ? "" : " fail"}` }, h("div", { class: "row" },
          nameCell(r, h("span", { class: "sub" }, r.code ? [sep(), `−${r.k}h`] : `−${r.k}h`)),
          h("span", { class: "rr" }, h("span", {}, arrow(r, 1)), r.safe ? chip("good", "safe") : chip("bad", basis !== "now" ? `below ${cLinePct}%` : mustText(r.recover)))))),
        res.unknown.length ? h("div", { class: "it2 sub" }, `Not in your attendance table: ${res.unknown.join(", ")}.`) : null,
        basis !== "now" ? h("div", { class: "it2 sub" }, `Assumes you attend every other class until ${end ? dayLabel(end) : "the semester ends"} (${examName}).`) : null));
    }

    // ---- best days to bunk (only for "After the bunk")
    if (best) out.push(h("div", { class: "sec" }, best.days.some((b) => b.safe) || !best.days.length ? "Best days to bunk" : "Least risky days"));
    if (best) out.push(best.days.length
      ? h("div", { class: "blk" }, best.days.map((b) => {
          return h("button", { class: `it2 click${planSel.has(b.key) ? " on" : ""}`, "data-key": `best-${b.key}`,
            onclick: () => { planSel = new Map([[b.key, null]]); planMonth = monthOffset(from, b.date); rerender(); } },
            h("div", { class: "row" }, h("b", { class: "d" }, dayLabel(b.date)), chip(b.safe ? "good" : "bad", b.safe ? "safe" : "risky")),
            b.lowest != null ? h("div", { class: "low" }, "Lowest after ", h("b", { style: `color:var(--${b.safe ? "good" : "bad"})` }, `${b.lowest.toFixed(0)}%`)) : null,
            h("div", { class: "brk" }, h("span", { class: "sub" }, plural(b.classes, "class")), UI.breakTag(b.breakDays) ? chip("mute", ...UI.breakTag(b.breakDays)) : null),
            UI.breakTag(b.breakDays) && b.breakNames.length ? h("div", { class: "sub brkn", title: b.breakNames.join(", ") }, b.breakNames.join(", ")) : null);
        }))
      : h("div", { class: "sub" }, "No class days left this semester"));

    // ---- bunk budget: what each course can still skip before the cutoff
    if (bud) {
      const budChip = (r, lp = linePct) => past ? (r.pct >= lp ? chip("good", `meets ${lp}%`) : chip("bad", `below ${lp}%`)) : !r.matched ? chip("mute", "not in timetable") : !r.reachable ? chip("bad", "out of reach") : r.budget === 0 ? chip("warn", "no bunks left") : chip("good", `can bunk ${r.budget}`);
      const left = (r) => `${plural(r.R, "class")} left until then`;
      const o = bud.overall;
      const rows = [
        !cr.overall ? null : h("div", { class: "it2 main" }, h("div", { class: "row" },
          h("span", {}, h("b", {}, "Overall"), past ? null : h("div", { class: "sub" }, left(o))),
          h("span", { class: "stk" }, h("span", { class: "big", style: `color:var(--${tone(o.pct, linePct)})` }, `${o.pct.toFixed(2)}%`), budChip(o)))),
        ...(cr.course ? bud.rows : []).map((r) => !past && !r.matched
          ? h("div", { class: "it2 minor" }, h("div", { class: "row" }, nameCell(r), budChip(r, cLinePct)))
          : h("div", { class: "it2 minor" }, h("div", { class: "row" },
              h("span", {}, h("b", { class: "nm", title: r.name }, r.name || r.code),
                h("div", { class: "sub" }, r.code && !past ? [r.code, sep(), left(r)] : r.code || (past ? null : left(r))),
                past || r.reachable ? null : h("div", { class: "sub" }, `Best case ${Math.floor(r.bestCase)}%`)),
              h("span", { class: "rr" }, h("span", { class: "p", style: `color:var(--${tone(r.pct, cLinePct)})` }, `${r.pct.toFixed(0)}%`), budChip(r, cLinePct))))),
      ].filter(Boolean);
      if (planSel.size) {
        out.push(acc({ title: `Before ${examName} budget`, icon: "gauge", tone: "warn", sub: !bud.reachable ? "Out of reach" : cr.course ? [`Tightest course can bunk ${bud.spare.n}`, sep(), bud.spare.row ? (bud.spare.row.code || bud.spare.row.name) : "none matched"] : [`Can still bunk ${o.budget} overall`, sep(), left(o).replace(" until then", "")], open: accOpen.has("budget"), key: "acc-budget",
          ontoggle: (v) => { v ? accOpen.add("budget") : accOpen.delete("budget"); } }, rows));
      } else {
        out.push(h("div", { class: "sec" }, h("span", {}, past ? `At the ${examName} cutoff` : `Before ${examName}`), h("span", { class: "sub" }, dayLabel(bud.end))));
        out.push(h("div", { class: "blk" }, rows));
      }
    }
    return out;
  }

  const monthOffset = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();

  // navEnd = last month you can browse to (semester end); last = last day that can be picked (the basis' cutoff).
  function calendarView(from, navEnd, last, linePct, riskOf) {
    const maxOff = navEnd ? Math.max(0, monthOffset(from, navEnd)) : 3;
    planMonth = Math.min(Math.max(0, planMonth), maxOff);
    const first = new Date(from.getFullYear(), from.getMonth() + planMonth, 1);
    const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // Monday-first grid
    const dir = calShown == null || calShown === planMonth ? "" : planMonth > calShown ? "fwd" : "back";
    calShown = planMonth;
    const cells = []; // { el, past }: a week of only past days is dropped from the first month (nothing there can be picked)
    for (let i = 0; i < lead; i++) cells.push({ el: h("span", { class: "cday empty" }), past: true });
    for (let n = 1; n <= daysIn; n++) {
      const d = new Date(first.getFullYear(), first.getMonth(), n);
      const k = Cal.key(d);
      const info = Cal.dayInfo(d);
      const cls = Plan.classesOn(d, A.tt).length;
      const usable = d >= from && (!last || d <= last) && info.classDay && cls > 0;
      const sel = planSel.has(k);
      const risk = usable && !sel && riskOf(k);
      const kind = !usable ? (info.holiday ? "hol" : "off") : sel ? "sel" : "open";
      const title = usable ? `${plural(cls, "class")}${risk ? `. Picking this would drop you below ${linePct}%` : ""}` : info.reason || (d < from ? "Past" : last && d > last ? "After the cutoff" : "No classes");
      cells.push({ past: d < from, el: h(usable ? "button" : "span", {
        class: `cday ${kind}${risk ? " risk" : ""}${sel && k === lastPicked ? " pop" : ""}`, style: `--i:${lead + n}`, title, "aria-label": `${dayLabel(d)}: ${title}`, "aria-pressed": usable ? String(sel) : null, "data-key": usable ? `day-${k}` : null,
        onclick: usable ? () => { if (sel) planSel.delete(k); else { planSel.set(k, null); lastPicked = k; } rerender(); } : null,
      }, String(n), usable ? h("i", {}, "•".repeat(Math.min(cls, 6))) : null) });
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    const shown = (planMonth === 0 ? weeks.filter((w) => w.some((c) => !c.past)) : weeks).flat().map((c) => c.el);
    return h("div", { class: "cardcal" },
      h("div", { class: "calh" },
        h("button", { class: "prev", "aria-label": "Previous month", "data-key": "cal-prev", disabled: planMonth <= 0, onclick: () => { planMonth--; rerender(); } }, ico("chev")),
        h("b", {}, first.toLocaleDateString("en-IN", { month: "long", year: "numeric" })),
        h("button", { class: "next", "aria-label": "Next month", "data-key": "cal-next", disabled: planMonth >= maxOff, onclick: () => { planMonth++; rerender(); } }, ico("chev"))),
      h("div", { class: "dow" }, ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((x) => h("div", {}, x))),
      h("div", { class: `cal${dir ? ` enter ${dir}` : ""}` }, shown),
      h("div", { class: "leg" },
        h("span", {}, h("u", { class: "pk" }), "Your pick"),
        h("span", {}, h("u", { class: "hl" }), "Holiday or no classes"),
        h("span", {}, h("u", { class: "rk" }), `Drops you below ${linePct}%`),
        h("span", {}, "• classes that day")));
  }

  // The plan only feeds the Put a bunk tab: nothing here touches your attendance numbers, the Overview or the popup.
  const planOut = () => JSON.stringify([...planSel].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v && [...v].sort()]));
  function persistPlan() {
    const out = planOut();
    if (out === planSaved || !planKey) return;
    planSaved = out;
    const sem = planKey;
    store.get({ bunkPlan: {} }).then((d) => { const all = { ...d.bunkPlan }; if (out === "[]") delete all[sem]; else all[sem] = JSON.parse(out); return store.set({ bunkPlan: all }); });
  }
  async function renderAtt(state) {
    A = state;
    attOpen = A.open;
    const { snap, threshold } = A;
    // The Put a bunk selection is a saved plan: first render for a semester (or after switching student) brings it back; past days are dropped.
    if (planKey !== snap.semester) {
      planKey = snap.semester;
      const today = Cal.key(today0());
      planSel = new Map((A.bunkPlan?.[planKey] || []).filter(([k]) => k >= today).map(([k, v]) => [k, v && new Set(v)]));
      planSaved = planOut();
    }
    const eff = Calc.actual(snap, A.adj, A.exc, { medInCourse: Plan.medInCourse(A.medBeforeMse) }); // your actual attendance: everything in the drawer uses it
    effMarks = eff;
    effPortal = Calc.effective(snap, {}, {}); // what the portal itself shows, for the "portal" line
    const sig = JSON.stringify([eff, A.exc, threshold, A.open, snap.semester, A.sortBy, A.basis, A.eseTarget, A.tt, tab, [...courseOpen], [...todayPick], [...planSel].map(([k, v]) => [k, v && [...v]]), planMonth, [...accOpen]]);
    if (sig === attSig && host?.isConnected) return;
    await ensureHost();
    attSig = sig;
    const t = threshold / 100;
    const o = eff.overall;
    const op = Calc.percent(o.attended, o.scheduled);
    const lowN = eff.courses.filter((c) => c.scheduled > 0 && Calc.percent(c.attended, c.scheduled) < threshold).length;

    // Persistent shell: the dock, drawer, tabs and pill are built once and only their contents change,
    // so the open/close transition can play and keyboard focus survives a click.
    if (!shell || !dock.contains(shell.drawer)) shell = buildShell();
    const { drawer, pill, sub, body, tabs } = shell;
    const focused = host.shadowRoot.activeElement;
    const focusKey = focused && drawer.contains(focused) ? focusKeyOf(focused) : null;

    pill.className = `pill ${tone(op, threshold)}${pill.classList.contains("clicked") ? " clicked" : ""}`;
    pill.setAttribute("aria-expanded", String(A.open));
    const tag = UI.vibeTag(op, threshold, true); tag.classList.add("sub");
    pill.replaceChildren(h("i"), `${op.toFixed(2)}%`, UI.detain(op) ? tag : lowN ? h("span", { class: "sub" }, `${lowN} low`) : tag); // overall low: say so; else "N low" if some course is; else the overall's tag
    sub.replaceChildren(snap.semester, sep(), `minimum ${threshold}%`);
    for (const [id, btn] of tabs) {
      btn.classList.toggle("on", tab === id);
      btn.setAttribute("aria-selected", String(tab === id));
    }
    body.setAttribute("aria-labelledby", `cue-tab-${tab}`); // the panel is named by the tab that is showing
    drawer.classList.toggle("open", A.open);
    body.classList.toggle("grow", growBars && A.open);
    if (A.open) growBars = false;
    body.replaceChildren(...[tab === "plan" ? planView(eff, threshold, t) : overviewView(eff, threshold, t)].flat(Infinity).filter((x) => x != null && x !== false)); // views return arrays
    lastPicked = null;
    persistPlan(); // after planView has clipped the selection
    placeThumb(shell.tabsBox, "tabs");
    if (focusKey) restoreFocus(focusKey);
    if (drawerTour?.active) drawerTour.refresh();
    else if (!tourChecked) maybeTour();
  }

  // ---- first-run setup: the timetable and the all-courses absent list only reach the extension when their pages are opened.
  // `setup` in storage says which page we are on the way to; each page's tick calls setupStep() once it has saved its data,
  // which moves to the next page in this same tab and finally returns to Attendance.
  const runSetup = async (needTt) => { await store.set({ setup: { s: needTt ? "tt" : "abs", at: Date.now() } }); location.assign(needTt ? "/main/timeTable" : "/main/absence"); };
  async function setupStep(expect, nextUrl, nextState) {
    const { setup } = await store.get({ setup: null });
    if (setup?.s !== expect || Date.now() - setup.at > 10 * 60 * 1000) return; // a half-finished setup from long ago must not redirect later
    await store.set({ setup: nextState && { s: nextState, at: Date.now() } });
    setTimeout(() => location.assign(nextUrl), 900); // long enough to see the page load
  }
  let absEmptyAt = 0;

  // ---- guided tour of the pill and drawer: the first time the attendance page shows data (once; the popup can replay it)
  let drawerTour = null, tourChecked = false;
  async function maybeTour() {
    tourChecked = true;
    const { tour, absentList } = await store.get({ tour: {}, absentList: null });
    if (tour.drawer || !shell || drawerTour) return;
    // Two portal pages feed the extension and only show their data once opened: the timetable and the all-courses absent list.
    const needTt = !A?.tt, needAbs = !(absentList && absentList.rows?.length);
    const q = (k) => host?.shadowRoot?.querySelector(`[data-tour="${k}"]`);
    const show = (id) => () => { tab = id; if (!attOpen) setOpen(true); else rerender(); };
    // The portal's own first "View Details" button (page DOM, outside our shadow root), or null: the step then shows as a centred card.
    const viewDetailsBtn = () => [...document.querySelectorAll("button,a")].find((e) => e.textContent.trim().toLowerCase() === "view details" && e.getClientRects().length) || null;
    drawerTour = UI.tour({
      mount: host.shadowRoot,
      steps: [
        { before: () => { if (attOpen) setOpen(false); }, target: () => shell?.pill, title: "Your attendance", text: "This pill shows your overall %. Click it to open the full breakdown." },
        { before: show("overview"), target: () => q("hero"), title: "Where you stand", text: "Your overall %, with the hours you've marked added in. Below it: how many classes you can bunk, or need to attend." },
        { before: show("overview"), target: () => q("course"), title: "Every course", text: "Each course shows its own % and how many classes you can bunk. Tap one to see what it needs." },
        { before: show("plan"), target: () => shell?.tabs.get("plan"), title: "Put a bunk", text: "Pick days on the calendar to see where each course would land. 'Safe means' sets the line: right after the bunk, before MSE, or before ESE." },
        { before: () => { if (attOpen) setOpen(false); }, target: viewDetailsBtn, title: "Fix an absent hour", text: ["Was an absent hour really co-curricular or medical? Click ", h("span", { class: "tour-em" }, "View Details"), " on that course and mark it. Your numbers update at once."] },
        needTt || needAbs ? { title: "Last step: finish setting up", text: `I'll open ${needTt ? "your Timetable, then " : ""}Absence Details for a moment so the extension can read them, then bring you back here.`,
          next: { label: "Start setup", run: () => runSetup(needTt) } } : null,
      ].filter(Boolean),
      onEnd: async () => {
        drawerTour = null;
        const cur = await store.get({ tour: {} });
        await store.set({ tour: { ...cur.tour, drawer: true } });
      },
    });
  }

  // Drawer shell, built once per mount of the attendance page.
  let shell = null;
  function buildShell() {
    const pill = makePill({ "aria-label": "Attendance summary", "data-key": "pill" }, () => setOpen(!attOpen));
    const sub = h("div", { class: "sub" });
    const tabs = new Map();
    for (const [id, label] of [["overview", "Overview"], ["plan", "Put a bunk"]]) {
      tabs.set(id, h("button", { role: "tab", id: `cue-tab-${id}`, "aria-controls": "cue-panel", "data-key": `tab-${id}`, onclick: () => { tab = id; growBars = true; calShown = null; rerender(); } }, label));
    }
    const tabsBox = h("div", { class: "pills", role: "tablist" }, ...tabs.values());
    const body = h("div", { class: "dbody", role: "tabpanel", id: "cue-panel" });
    const drawer = h("div", { class: "drawer", role: "dialog", "aria-label": "Attendance details" },
      h("div", { class: "top" },
        h("div", {}, h("b", { role: "heading", "aria-level": "2" }, "Attendance"), sub),
        h("button", { class: "xb", "aria-label": "Close", "data-key": "close", onclick: () => setOpen(false) }, ico("close"))),
      tabsBox,
      body,
      h("div", { class: "tagline" }, UI.TAGLINE));
    dock.replaceChildren(drawer, pill);
    return { drawer, pill, sub, body, tabs, tabsBox };
  }
  // Views are rebuilt on every change, so remember the focused control by data-key, else by its position among the controls.
  const FOCUSABLE = "button,select,input,summary,[tabindex]";
  function focusKeyOf(el) {
    if (el.dataset.key) return { key: el.dataset.key };
    return { index: [...shell.drawer.querySelectorAll(FOCUSABLE)].indexOf(el), tag: el.tagName };
  }
  function restoreFocus(k) {
    const el = k.key ? shell.drawer.querySelector(`[data-key="${k.key}"]`) : [...shell.drawer.querySelectorAll(FOCUSABLE)][k.index];
    if (el && (k.key || el.tagName === k.tag)) el.focus({ preventScroll: true });
  }

  // When the page has no readable course table for 5 seconds (grid view, or the portal changed its markup), say so instead of
  // leaving a stale pill or nothing at all. In grid view the notice can flip the portal's own toggle back to table view.
  let unreadSince = 0, unreadShown = false;
  async function noteUnread() {
    if (!unreadSince) { unreadSince = Date.now(); setTimeout(tick, 5200); return; } // no DOM change may come to re-check us
    if (unreadShown || Date.now() - unreadSince < 5000) return;
    unreadShown = true;
    await ensureHost();
    const grid = !!document.querySelector('[role="progressbar"][aria-label$=" attendance"]') && !!document.querySelector('[aria-label="table view"]');
    // The Daily Log tab has no course table: offer a way back to Course Overview instead of calling it broken.
    const overview = [...document.querySelectorAll('button,[role="tab"]')].find((b) => /^course overview$/i.test(b.textContent.trim()));
    const daily = !grid && !!overview;
    attSig = ""; shell = null; // the next successful read must rebuild the drawer
    const title = grid ? "Grid view isn't supported yet" : daily ? "Nothing to read on this tab" : "Couldn't read this page";
    const text = grid ? "Switch to table view and your numbers will show here."
      : daily ? "leavemealone reads the Course Overview table. Go back to it and your numbers will show here."
      : "The portal page may have changed. Try one of these; if it keeps happening, please report it so it can be fixed.";
    const btns = grid ? [h("button", { class: "btn solid cta", onclick: () => document.querySelector('[aria-label="table view"]')?.click() }, "Switch to table view")]
      : daily ? [h("button", { class: "btn solid cta", onclick: () => overview.click() }, "Open Course Overview"), h("button", { class: "btn cta", onclick: () => location.reload() }, "Reload page")]
      : [h("button", { class: "btn solid cta", onclick: () => location.reload() }, "Reload page"),
         h("button", { class: "btn cta", onclick: () => window.open("https://cue.christuniversity.in/main/attendence", "_self") }, "Go to Attendance"),
         h("button", { class: "btn cta", onclick: () => reportUnread() }, "Report it on GitHub")];
    dock.replaceChildren(h("div", { class: "panel" }, h("div", { class: "h3" }, title), h("p", { class: "sub" }, text), ...btns));
  }
  // The observer fires on every portal DOM change (MUI animations, ripples). When the table reads the same as last time and the
  // drawer is already drawn, there is nothing to do, so skip the storage round trip. The 30s cap still refreshes "synced".
  let lastRead = "", lastReadAt = 0;
  // Marks the numbers can't use: Calc never counts more marked hours than the portal's own absent hours for the course. That used to be
  // silent, so "nothing updates" looked like a broken extension. Say how much is left out and offer a report (counts only, no hours or names).
  const markedHrs = (rows, hasCc) => (rows || []).filter((r) => !r.gone && !(hasCc && r.p && r.s === "cc")).reduce((n, r) => n + r.h, 0);
  function markNote(marked, counted, hasCc) {
    const lost = marked - counted;
    if (!(lost > 0.01)) return null;
    const report = () => {
      const lines = UI.diag({ version: chrome.runtime.getManifest().version, page: location.pathname, found: `some marked hours are not counted: yes; co-curricular column: ${hasCc ? "yes" : "no"}` });
      const body = ["**Type:** Bug", "**Where:** Absent details, Mark hours", "", "My marked hours are not all counted in my attendance.", "", "---", "Added automatically (no hours, names or numbers):", ...lines.map((l) => `- ${l}`)].join("\n");
      window.open(`${UI.ABOUT.repo}/issues/new?title=${encodeURIComponent("[Bug] Marked hours are not counted")}&body=${encodeURIComponent(body)}`, "_blank", "noopener");
    };
    return h("div", { class: "warnbox" }, h("b", {}, `${fmt(lost)}h of your marks aren't counted`),
      h("div", { class: "sub" }, "The portal lists fewer absent hours for this course than you marked, so the extra can't be added to your attendance. If that looks wrong, "),
      h("button", { class: "link", onclick: report }, "report it"));
  }
  // Opens a pre-filled GitHub issue (the person reviews it and presses Submit). It says what the page looked like, never what it said.
  function reportUnread() {
    const found = `found: table ${document.querySelector(COURSE_TABLE) ? "yes" : "no"}, grid cards ${document.querySelectorAll(CARD).length}, view toggle ${document.querySelector('[aria-label="table view"]') ? "yes" : "no"}, tabs ${document.querySelectorAll('[role="tab"]').length}`;
    const lines = UI.diag({ version: chrome.runtime.getManifest().version, page: location.pathname, sem: semester(), found });
    const body = ["**Type:** Bug", "**Where:** Attendance page", "", "The pill could not read the attendance page.", "", "---", "Added automatically (counts and view names only, no numbers or names):", ...lines.map((l) => `- ${l}`)].join("\n");
    window.open(`${UI.ABOUT.repo}/issues/new?title=${encodeURIComponent("[Bug] Couldn't read the attendance page")}&body=${encodeURIComponent(body)}`, "_blank", "noopener");
  }
  async function tickAtt() {
    const snap = parseCourses();
    const readKey = snap ? JSON.stringify([snap.semester, snap.overall, snap.courses]) : "";
    if (snap && attSig && readKey === lastRead && Date.now() - lastReadAt < 30000 && dock?.isConnected && shell && dock.contains(shell.drawer)) return;
    const d = await store.get({ threshold: 75, latest: null, snapshots: {}, adjust: {}, excused: {}, sortBy: "portal", timetable: null, timetableSem: null, bunkBasis: "now", eseTarget: null, medBeforeMse: true, bunkPlan: {}, absentList: null });
    const fix = {};
    for (const k of ["snapshots", "adjust", "excused", "bunkPlan"]) if (plainKeys(d[k], MERGE[k])) fix[k] = d[k];
    if (d.timetableSem && plain(d.timetableSem) !== d.timetableSem) fix.timetableSem = plain(d.timetableSem);
    if (d.absentList?.sem && plain(d.absentList.sem) !== d.absentList.sem) fix.absentList = { ...d.absentList, sem: plain(d.absentList.sem) };
    if (Object.keys(fix).length) await store.set(fix);
    let view = snap;
    if (!snap) {
      // The Daily Log tab has no course data: show the last Course Overview read instead of an error.
      const onDaily = !!document.querySelector('[role="tab"][aria-controls="daily-panel"][aria-selected="true"]');
      const saved = onDaily && (d.snapshots[semester()] || d.snapshots[d.latest]);
      if (!saved) { noteUnread(); return; }
      view = saved;
    } else if (snap.hasCc == null) snap.hasCc = !!d.snapshots[snap.semester]?.hasCc;
    unreadSince = 0; unreadShown = false;
    if (snap) {
      lastRead = readKey; lastReadAt = Date.now();
      const prev = d.snapshots[snap.semester];
      const same = prev && JSON.stringify([prev.overall, prev.courses, prev.hasCc]) === JSON.stringify([snap.overall, snap.courses, snap.hasCc]);
      if (same && Date.now() - prev.syncedAt < 60000) snap.syncedAt = prev.syncedAt; // unchanged: don't rewrite storage on every tick
      d.snapshots[snap.semester] = snap;
      const latest = UI.semOrder(d.snapshots)[0];
      if (!same || snap.syncedAt !== prev.syncedAt || d.latest !== latest) await store.set({ snapshots: d.snapshots, latest });
    }
    renderAtt({
      snap: view, threshold: Plan.minOf(d.threshold), adj: d.adjust[view.semester], exc: d.excused[view.semester],
      open: attOpen, sortBy: d.sortBy, tt: d.timetable, basis: d.bunkBasis, eseTarget: d.eseTarget, medBeforeMse: d.medBeforeMse, bunkPlan: d.bunkPlan,
    });
  }

  // ---------------------------------------------------------------- timetable page
  const DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  function parseTimetable() {
    const table = [...document.querySelectorAll("main table")].find((x) => /monday/i.test(x.querySelector("thead")?.textContent || ""));
    if (!table) return null;
    const heads = [...table.querySelectorAll("thead th")].map((th) => {
      const m = /(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i.exec(th.textContent);
      return m ? DOW[m[1].toLowerCase()] : null;
    });
    const days = {};
    for (const tr of table.querySelectorAll("tbody tr")) {
      const tds = tr.querySelectorAll("td");
      const ps = tds[0]?.querySelectorAll("p") || [];
      const period = ps[0]?.textContent.trim();
      if (!period) continue;
      const time = (ps[1]?.textContent || "").replace(/\s+/g, " ").trim();
      tds.forEach((td, i) => {
        const dow = heads[i];
        if (i === 0 || dow == null) return;
        td.querySelectorAll('[role="button"][aria-label]').forEach((el) => {
          const label = el.getAttribute("aria-label");
          if (!label || label === "null") return;
          const name = label.split(", Faculty")[0].trim();
          if (name) (days[dow] ||= []).push({ period, time, name, type: (el.querySelector(".MuiChip-label")?.textContent || "").trim() });
        });
      });
    }
    return Object.keys(days).length ? days : null;
  }

  let ttSig = "", ttSeen = "", ttSeenAt = 0;
  async function tickTt() {
    const seen = parseTimetable();
    if (!seen) return;
    const seenKey = JSON.stringify(seen);
    if (ttSig && seenKey === ttSeen && Date.now() - ttSeenAt < 30000 && host?.isConnected && dock?.querySelector(".panel")) return; // same page as last tick: skip the storage round trip
    ttSeen = seenKey; ttSeenAt = Date.now();
    const d = await store.get({ timetable: null, timetableSem: null, snapshots: {}, latest: null });
    // The page shows one week. A holiday week has empty days, so a weekday with no classes in view keeps what was saved
    // before, but only from this semester's timetable: a weekday kept from an older one shows courses you no longer take.
    const same = d.timetable && d.timetableSem && d.timetableSem === d.latest;
    const days = { ...(same ? d.timetable : {}), ...seen };
    if (JSON.stringify(days) !== JSON.stringify(d.timetable) || d.timetableSem !== d.latest) await store.set({ timetable: days, timetableSem: d.latest });
    const count = Object.values(days).reduce((n, x) => n + x.length, 0);
    if (count) setupStep("tt", "/main/absence", "abs");
    const courses = d.snapshots[d.latest]?.courses || [], ofName = Plan.courseOf(courses);
    const unknown = courses.length ? [...new Set(Object.values(days).flat().map((c) => c.name))].filter((n) => !ofName(n)) : [];
    const sig = JSON.stringify([count, unknown]);
    if (sig === ttSig && host?.isConnected) return;
    await ensureHost();
    ttSig = sig;
    dock.replaceChildren(h("div", { class: "panel" },
      h("div", { class: "h3 good" }, "✓ Timetable saved for planning"),
      h("div", { class: "sub" }, `${count} classes a week. Open Attendance → Put a bunk to use it.`),
      unknown.length ? h("div", { class: "warnbox" }, h("div", { class: "sub" }, `Not in your attendance table: ${unknown.join(", ")}`)) : null,
      h("button", { class: "btn solid cta", onclick: () => location.assign("/main/attendence") }, "Put a bunk", ico("right"))));
  }

  // ---------------------------------------------------------------- absent details page
  // Each absent hour gets one of four marks. Only the last three change anything:
  //   later = counted as attended now (the portal will be updated), cc = attended in its course and the overall, med = its course until the MSE is over (a setting), and the overall only at 74.5% to 84.49%.
  const CHOICES = [
    { s: "abs", letter: "A", cls: "a", color: "var(--bad)", label: "Absent", tip: "Stays absent" },
    { s: "cc", letter: "C", cls: "c", color: "var(--gold)", label: "Co-curricular", tip: "Co-curricular: counts as attended in this course and the overall now" },
    { s: "med", letter: "M", cls: "m", color: "var(--blue)", label: "Medical", tip: "Medical leave: counts in this course until the MSE is over (Settings), and in the overall when it is 74.5-84.49%" },
    { s: "later", letter: "L", cls: "l", color: "var(--good)", label: "Later", tip: "Was present: the portal will be updated, count as attended now" },
  ];
  let absSig = "";

  // What the portal's status cell says: the hours ("1 Hr Medical Leave") and whether it already labelled the hour medical / co-curricular, else plain absent.
  const statusOf = (status) => ({
    h: parseFloat(/(\d+(?:\.\d+)?)/.exec(status)?.[1] ?? "1") || 1,
    kind: /medical/i.test(status) ? "med" : /co-?\s*curricular|on\s*duty/i.test(status) ? "cc" : "abs",
  });
  function parseAbsentRows() {
    return [...document.querySelectorAll("main table tbody tr")]
      .map((tr) => {
        const tds = tr.querySelectorAll("td");
        if (tds.length < 4) return null;
        const date = tds[0].querySelector("p")?.textContent.trim();
        const period = tds[1].querySelector("p")?.textContent.trim();
        const time = tds[1].querySelector("span")?.textContent.trim() || "";
        if (!date || !period) return null;
        const { h: hrs, kind: portal } = statusOf(tds[3].textContent); // what the portal already says about this hour
        const day = tds[0].querySelector("span")?.textContent.trim() || ""; // the weekday sits in its own element
        return { k: `${date}|${period}`, date, day, period, time, type: tds[2].textContent.trim(), h: hrs, portal };
      })
      .filter(Boolean);
  }

  const sigOf = (key, rows, saved) =>
    [key, ...rows.map((r) => r.k + r.portal), "|", ...saved.map((r) => `${r.k}:${r.s}:${r.gone ? 1 : 0}`)].join(",");

  // Bring one course's saved marks in line with what the portal lists as absent now (rows: [{ k, h, portal }]).
  // A portal label that is gone or changed is dropped; a marked hour the portal no longer lists is "gone" (updated there,
  // waiting for "Confirm present"); an hour the portal labels itself (medical / co-curricular) becomes a locked row.
  // complete = false (a list that may be partial) only applies what is on the list and never marks anything gone.
  function reconcileMarks(savedRows, rows, complete = true) {
    const byK = new Map(rows.map((r) => [r.k, r]));
    const saved = savedRows
      .filter((r) => !(r.p && (complete || byK.has(r.k)) && byK.get(r.k)?.portal !== r.s)) // portal label gone or changed -> drop
      .map((r) => (r.p || !complete ? r : { ...r, gone: !byK.has(r.k) })) // marked hour no longer absent -> "updated on portal"
      .filter((r) => r.p || !byK.has(r.k) || byK.get(r.k).portal === "abs"); // portal now labels it itself -> portal wins
    for (const r of rows) {
      if (r.portal === "abs") continue;
      const row = { k: r.k, h: r.h, s: r.portal, p: true }; // auto-record medical / co-curricular set by the portal
      const i = saved.findIndex((x) => x.k === r.k);
      if (i >= 0) saved[i] = row; else saved.push(row);
    }
    return saved;
  }

  // forced = the course picked in the filter on /main/absence; without it the course is the one whose View Details was clicked.
  // The marking uses the same pill + drawer as the all-courses list (renderAbsDrawer), for this one course.
  let absQuick = "", absQuickAt = 0; // what the table looked like when the drawer was last built (skips the storage read on idle ticks)
  async function tickAbs(forced) {
    const rows = parseAbsentRows();
    if (!rows.length) return;
    const quick = `${forced?.key || ""}#${rows.map((r) => r.k + r.portal).join(",")}`;
    if (absSig && absSig !== "noctx" && quick === absQuick && Date.now() - absQuickAt < 30000 && host?.isConnected && absShell && dock?.contains(absShell.drawer)) return;
    const d = await store.get({ lastCourse: null, snapshots: {}, excused: {}, adjust: {}, medBeforeMse: true, absentList: null });
    const ctx0 = forced || d.lastCourse;
    let ctx = ctx0 && { ...ctx0, semester: plain(ctx0.semester || "") }; // a course remembered before 1.0.1 carries the portal's "[On Roll]" label: marks would be saved under a key the attendance page never reads
    if (ctx && !forced && d.absentList?.sem === ctx.semester) { // the remembered course can be stale (page opened by URL or Back): trust the all-courses list
      const key = courseOwning(rows, d.absentList.rows), c = key && courseIn(d.snapshots[ctx.semester], key);
      if (c && (c.code || c.name) !== ctx.key) { ctx = { semester: ctx.semester, key: c.code || c.name, name: c.name, at: Date.now() }; store.set({ lastCourse: ctx }); }
    }
    await ensureHost();

    if (!ctx) {
      if (absSig === "noctx") return;
      absSig = "noctx"; absShell = null; absCourse = null;
      dock.replaceChildren(
        h("div", { class: "panel" },
          h("div", { class: "h3" }, "Which course is this?"),
          h("p", { class: "sub" }, 'This page doesn\'t say. Go back, switch the course list to table view and open a course with its "View Details" button.'),
          h("button", { class: "btn solid cta", onclick: () => history.back() }, "Back to attendance"),
          h("div", { class: "tagline" }, UI.TAGLINE)));
      return;
    }

    const m = (d.excused[ctx.semester] = d.excused[ctx.semester] || {});
    const e0 = m[ctx.key];
    const courseNow = courseIn(d.snapshots[ctx.semester], ctx.key);

    // Reconcile what we saved with what the portal shows now.
    const saved = reconcileMarks(e0?.rows || [], rows);
    if (JSON.stringify(saved) !== JSON.stringify(e0?.rows || [])) {
      if (saved.length) m[ctx.key] = { rows: saved, baseAbsent: e0?.baseAbsent ?? courseNow?.absent ?? undefined };
      else delete m[ctx.key];
      await store.set({ excused: d.excused });
    }

    const sig = sigOf(ctx.key, rows, saved);
    if (sig === absSig && absShell && dock.contains(absShell.drawer)) return;
    absSig = sig;
    absQuick = quick; absQuickAt = Date.now();
    absCourse = { semester: ctx.semester, key: ctx.key, name: ctx.name || courseNow?.name || ctx.key };
    // The same row shape as the all-courses list, so the same drawer draws and marks it.
    absRows = rows.map((r) => ({ date: r.date, day: r.day, period: r.period, time: r.time, code: courseNow ? courseNow.code : ctx.key, name: absCourse.name, type: r.type, kind: r.portal, h: r.h }));
    await renderAbsDrawer();
  }

  // The all-courses list (/main/absence): save its rows for the toolbar popup's summary and show just a pill.
  // Marking happens on the per-course page, because the marks are stored per course.
  function parseAllAbsences() {
    return [...document.querySelectorAll("main table tbody tr")].map((tr) => {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 5) return null;
      const txt = (td, sel) => td.querySelector(sel)?.textContent.trim() || "";
      const { h: hrs, kind } = statusOf(tds[4].textContent);
      return { date: txt(tds[0], "p"), day: txt(tds[0], "span"), period: txt(tds[1], "p"), time: txt(tds[1], "span"), code: txt(tds[2], "p"), name: txt(tds[2], "span"), type: tds[3].textContent.trim(), kind, h: hrs };
    }).filter((r) => r && r.date && r.period);
  }
  let absOpen = false, absShell = null;
  let absMark = false;           // the "Mark hours" toggle of the all-courses drawer
  let absRows = [], absData = null;
  let absCourse = null;          // { semester, key, name } on a single course's page (Absent Details, or /main/absence filtered to one course); null for the all-courses list
  const legendEl = (grid) => h("div", { class: `lg${grid ? " grid" : ""}` }, CHOICES.map((c) => h("span", { title: c.tip }, h("b", { style: `background:${c.color}` }, c.letter), c.label))); // A / C / M / L key, shared by both marking views
  const absKey = (r) => (r.code && r.code.toUpperCase() !== "N/A" ? r.code : r.name);
  // The Absent Details page doesn't say which course it shows. The all-courses list does (one class per period), so if EVERY hour on
  // the page is on that list and they all belong to one course, that is the course (the remembered one can be stale). Else null.
  function courseOwning(rows, list) {
    const owners = new Set();
    for (const r of rows) {
      const x = (list || []).find((y) => y.date === r.date && y.period === r.period);
      if (!x) return null;
      owners.add(absKey(x));
    }
    return owners.size === 1 ? [...owners][0] : null;
  }
  // With the filter on "All courses" the list has every course's absent hours, so every course's marks are brought up to
  // date here, the same way its own Absent Details page would (portal medical / co-curricular labels, hours updated on
  // the portal). If the list may be partial (a page control, or a row whose course isn't in the snapshot), nothing is
  // marked "gone", so a part of the list can't wipe marks.
  async function syncMarksFromList(list) {
    const d = await store.get({ latest: null, snapshots: {}, excused: {} });
    const snap = d.snapshots[d.latest];
    if (!snap) return;
    const courseOf = new Map(list.map((r) => [r, courseIn(snap, absKey(r))]));
    const complete = !document.querySelector(".MuiTablePagination-root") && [...courseOf.values()].every(Boolean);
    const m = (d.excused[d.latest] = d.excused[d.latest] || {});
    let changed = false;
    for (const c of snap.courses) {
      const key = c.code || c.name;
      const rows = list.filter((r) => courseOf.get(r) === c).map((r) => ({ k: `${r.date}|${r.period}`, h: r.h, portal: r.kind }));
      const before = m[key]?.rows || [];
      const after = reconcileMarks(before, rows, complete);
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      changed = true;
      if (after.length) m[key] = { rows: after, baseAbsent: m[key]?.baseAbsent ?? c.absent ?? undefined }; else delete m[key];
    }
    if (changed) await store.set({ excused: d.excused });
  }
  async function refreshAbsData() {
    const d = await store.get({ latest: null, snapshots: {}, excused: {}, adjust: {}, medBeforeMse: true });
    const sem = absCourse?.semester || d.latest; // a course page can be an older semester than the latest
    absData = { sem, snap: d.snapshots[sem], excused: d.excused[sem] || {}, adjust: d.adjust[sem], med: d.medBeforeMse };
  }
  // The record both pages share: excused[sem][courseKey].rows = [{ k: "date|period", h, s, gone }].
  // list = one or more rows (a whole day can span courses); one read and one write for all of them.
  async function markAbs(list, choice) {
    const d = await store.get({ latest: null, snapshots: {}, excused: {} });
    const sem = absCourse?.semester || d.latest;
    const m = (d.excused[sem] = d.excused[sem] || {});
    for (const r of list) {
      const c = courseIn(d.snapshots[sem], absKey(r));
      if (!c) continue;
      const k = `${r.date}|${r.period}`;
      const rows = (m[c.code || c.name]?.rows || []).filter((x) => x.k !== k);
      if (choice !== "abs") rows.push({ k, h: r.h, s: choice, gone: false });
      if (rows.length) m[c.code || c.name] = { rows, baseAbsent: c.absent ?? undefined }; else delete m[c.code || c.name];
    }
    await store.set({ excused: d.excused });
  }
  function absBodyNodes(on) { // everything in the drawer body, for the Mark hours switch on or off
    const snap = absData.snap;
    const selOf = (r) => { const u = (absData.excused[absKey(r)]?.rows || []).find((x) => x.k === `${r.date}|${r.period}` && !x.gone); return u ? (u.s === "cc" || u.s === "med" ? u.s : "later") : "abs"; };
    const opts = { on, choices: CHOICES, selOf, canMark: (r) => !!courseIn(snap, absKey(r)),
      pick: async (r, choice) => { await markAbs([r], choice); await refreshAbsData(); drawAbsBody(false); },
      pickDay: async (list, choice) => { await markAbs(list, choice); await refreshAbsData(); drawAbsBody(false); } };
    let preview = null;
    if (snap) { // the numbers show with Mark hours off too; the hint and legend only matter while marking
      const base = Calc.effective(snap, {}, {});
      // One course: the numbers the drawer shows (co-curricular and medical count in the course too); all courses: the overall only.
      const now = absCourse ? Calc.actual(snap, absData.adjust, absData.excused, { medInCourse: Plan.medInCourse(absData.med) }) : Calc.effective(snap, absData.adjust, absData.excused);
      const bp = Calc.percent(base.overall.attended, base.overall.scheduled), np = Calc.percent(now.overall.attended, now.overall.scheduled);
      const note = markNote(snap.courses.reduce((n, c) => n + markedHrs(absData.excused[c.code || c.name]?.rows, snap.hasCc), 0), now.courses.reduce((n, c) => n + c.excusedHrs, 0), snap.hasCc);
      const cb = absCourse && base.courses.find((c) => c.key === absCourse.key), cn = absCourse && now.courses.find((c) => c.key === absCourse.key);
      const pc = (c) => Calc.percent(c.attended, c.scheduled);
      preview = h("div", { class: "it2 main" }, h("div", { class: "row" }, h("span", {}, h("b", {}, "With your marks")), h("span", { class: "big" }, `${bp.toFixed(2)}% to `, h("b", { class: np > bp ? "good" : "" }, `${np.toFixed(2)}%`))),
        cb && cn ? h("div", { class: "row" }, h("span", { class: "sub" }, "This course"), h("span", { class: "sub" }, `${pc(cb).toFixed(2)}% to `, h("b", { class: pc(cn) > pc(cb) ? "good" : "" }, `${pc(cn).toFixed(2)}%`))) : null,
        on ? h("p", { class: "sub" }, "Each mark saves straight away. Tap A to undo one. Whole day marks every hour of that day.") : null, on ? legendEl(true) : null, on ? note : null);
    }
    // Hours you marked that the portal has since updated (one course only): confirm they are really present now.
    const gone = absCourse ? (absData.excused[absCourse.key]?.rows || []).filter((r) => r.gone) : [];
    const goneBox = gone.length
      ? h("div", { class: "updated" }, h("b", { class: "good" }, "Updated on the portal"), h("div", { class: "sub" }, "No longer listed as absent. Confirm they are present now."),
          gone.map((r) => { const [date, period] = r.k.split("|"); return h("div", { class: "row", style: "margin-top:12px" }, h("span", {}, `${niceDate(date)}, ${nicePeriod(period)} (${fmt(r.h)}h)`), h("button", { class: "btn sm", onclick: () => confirmPresent(r.k) }, "Confirm present")); }))
      : null;
    return [goneBox, preview, absentDays(absRows, opts)];
  }
  function drawAbsBody(measure = true) { // measure = false after a mark: rows keep their size, so only this view is drawn and the drawer keeps its height
    if (!absShell || !absData) return;
    const drawer = absShell.drawer;
    const focused = host.shadowRoot.activeElement;
    const fk = focused && drawer.contains(focused) ? focused.dataset.key : null;
    const top = drawer.scrollTop;
    absShell.markBtn.setAttribute("aria-checked", String(absMark));
    absShell.markBtn.classList.toggle("on", absMark);
    const put = (on) => absShell.body.replaceChildren(...absBodyNodes(on).flat(Infinity).filter(Boolean));
    // The drawer keeps the height of the taller of its two views (switch on / off), so flipping the switch or marking an hour never moves its top edge, where the switch is.
    if (!measure) put(absMark);
    else {
      drawer.style.minHeight = "0px";
      put(true); const hOn = drawer.scrollHeight;
      put(false); const hOff = drawer.scrollHeight;
      if (absMark) put(true);
      const max = parseFloat(getComputedStyle(drawer).maxHeight) || Infinity;
      drawer.style.minHeight = `${Math.min(Math.max(hOn, hOff) + 2, max)}px`; // + its 1px borders
    }
    drawer.scrollTop = top;
    if (fk) drawer.querySelector(`[data-key="${fk}"]`)?.focus({ preventScroll: true });
  }
  async function confirmPresent(k) {
    const d = await store.get({ excused: {}, snapshots: {} });
    const e = d.excused[absCourse.semester]?.[absCourse.key];
    if (!e) return;
    e.rows = e.rows.filter((x) => x.k !== k);
    const c = courseIn(d.snapshots[absCourse.semester], absCourse.key);
    if (e.rows.length) e.baseAbsent = c?.absent ?? e.baseAbsent; else delete d.excused[absCourse.semester][absCourse.key];
    await store.set({ excused: d.excused });
    await refreshAbsData();
    drawAbsBody();
  }
  function setAbsOpen(v) {
    if (v && !absOpen && absShell) absShell.drawer.scrollTop = 0;
    const changed = v !== absOpen;
    absOpen = v;
    if (!absShell) return;
    const ae = host.shadowRoot.activeElement, inside = !!ae && absShell.drawer.contains(ae);
    absShell.drawer.classList.toggle("open", v); absShell.pill.setAttribute("aria-expanded", String(v));
    // Keyboard: opening puts focus on the first control; closing from inside (Esc, X) hands it back to the pill. An outside click leaves focus where the click put it.
    if (changed && v) { // every opening starts with Mark hours off (just the list), never in the marking view left over from last time
      if (absMark) { absMark = false; drawAbsBody(false); }
      absShell.markBtn.focus({ preventScroll: true });
    }
    else if (changed && inside) absShell.pill.focus({ preventScroll: true });
  }
  async function tickAbsAll() {
    // A single course picked in the filter ("CSEAM633 (4)"): the table is then the same 4-column layout as Absent Details, so mark it there too.
    const code = /^([^\s(]+)\s*\(\d+\)/.exec(document.querySelector('[role="combobox"]')?.textContent.trim() || "")?.[1];
    if (code && code.toLowerCase() !== "all") {
      const d = await store.get({ latest: null, snapshots: {} });
      const c = courseIn(d.snapshots[d.latest], code);
      if (c) return tickAbs({ semester: d.latest, key: code, name: c.name });
    }
    const rows = parseAllAbsences();
    if (!rows.length) { // no absences at all (or not drawn yet): during setup, give the table a few seconds, then carry on
      absEmptyAt ||= Date.now();
      if (Date.now() - absEmptyAt > 5000) setupStep("abs", "/main/attendence", null);
      return;
    }
    const sig = JSON.stringify(rows);
    if (absSig === sig && host?.isConnected && absShell && dock.contains(absShell.drawer)) return;
    absSig = sig;
    const allCourses = /^all courses/i.test(document.querySelector('[role="combobox"]')?.textContent.trim() || "");
    if (allCourses) { // a single-course filter would overwrite the full list with a part of it
      const d = await store.get({ latest: null });
      await store.set({ absentList: { sem: d.latest, at: Date.now(), rows } });
      await syncMarksFromList(rows);
      setupStep("abs", "/main/attendence", null);
    }
    absCourse = null;
    absRows = rows;
    await renderAbsDrawer();
  }

  // The pill + drawer for absent hours, shared by the all-courses list (absRows = every course, absCourse null) and a single course's page.
  async function renderAbsDrawer() {
    await ensureHost();
    if (!absShell || !dock.contains(absShell.drawer)) {
      const pill = makePill({ "aria-label": "Absent hours summary", "aria-expanded": "false" }, () => setAbsOpen(!absOpen));
      const sub = h("div", { class: "sub sumline" });
      const title = h("b", { role: "heading", "aria-level": "2" }, "Absent hours");
      const body = h("div", { class: "blk" });
      // A real on/off switch: the label and track change colour when marking is on.
      const markBtn = h("button", { class: "mkt", role: "switch", "aria-checked": "false", "data-key": "mark-toggle", onclick: () => { absMark = !absMark; drawAbsBody(); } }, h("span", {}, "Mark hours"), h("span", { class: "trk" }));
      const drawer = h("div", { class: "drawer abs", role: "dialog", "aria-label": "Absent hours" },
        h("div", { class: "top" }, h("div", {}, title, sub), h("span", { class: "topa" }, markBtn, h("button", { class: "xb", "aria-label": "Close", onclick: () => setAbsOpen(false) }, ico("close")))),
        body, h("div", { class: "tagline" }, UI.TAGLINE));
      dock.replaceChildren(drawer, pill);
      absShell = { pill, sub, body, drawer, markBtn, title };
    }
    absShell.title.textContent = absCourse ? absCourse.name : "Absent hours";
    const extra = [hrsOf(absRows, "cc") ? `${fmt(hrsOf(absRows, "cc"))}h co-curricular` : null, hrsOf(absRows, "med") ? `${fmt(hrsOf(absRows, "med"))}h medical` : null].filter(Boolean).join(", ");
    absShell.pill.replaceChildren(...[h("i", { class: "bad-dot" }), `${fmt(hrsOf(absRows, "abs"))}h absent`, extra ? h("span", { class: "sub" }, extra) : null].filter(Boolean)); // a null child would print "null"
    absShell.sub.replaceChildren(...absentSummary(absRows).flat(Infinity).filter(Boolean));
    await refreshAbsData();
    drawAbsBody();
    setAbsOpen(absOpen);
  }


  // ---------------------------------------------------------------- driver
  let timer, lastRoute = null;
  // Who is logged in (Profile.who) decides whose data the top-level keys hold. Nothing is read or saved for a page
  // until that's settled, so one student's portal data never lands in another's profile.
  let profileId = null, switching = false;
  function syncProfile() {
    const w = Profile.who();
    if (!w) return true; // header not found: carry on with whoever is active
    const id = Profile.idOf(w.name);
    if (id === profileId) return true;
    if (!switching) {
      switching = true;
      Profile.activate(id, Profile.labelOf(w.name)).then((swapped) => {
        profileId = id;
        switching = false;
        if (swapped) { // another student's data: drop what this tab was showing for the last one
          planSel = new Map(); planKey = null; todayPick = new Set(); courseOpen.clear(); planMonth = 0;
          attSig = ""; absSig = ""; ttSig = ""; absData = null; absQuick = ""; absCourse = null; absRows = []; lastRead = ""; // the absent drawer, too: nothing of the last student stays on screen
        }
        tick();
      }, () => { switching = false; });
    }
    return false;
  }
  function tick() {
    if (!alive()) { expire(); return; }
    if (!syncProfile()) return;
    const r = route();
    syncGutter();
    if (r !== lastRoute) { // page changed: clear the old UI, and a drawer left open on the last page shrinks back to its pill
      if (lastRoute !== null) { absOpen = false; attOpen = false; absShell = null; absCourse = null; shell = null; drawerTour?.end(); tourChecked = false; }
      dock?.replaceChildren(); attSig = ""; absSig = ""; ttSig = ""; unreadSince = 0; unreadShown = false; lastRoute = r;
    }
    if (!r) {
      host?.remove();
      host = null;
      return;
    }
    if (r === "att") tickAtt();
    else if (r === "abs") tickAbs();
    else if (r === "absall") tickAbsAll();
    else tickTt();
  }
  // React quickly to the first change (the portal's table appearing), then at most once per 600ms while it keeps mutating.
  let lastTick = 0;
  const mo = new MutationObserver((muts) => {
    if (muts.every((mu) => mu.target === host || host?.contains(mu.target))) return; // ignore our own DOM changes
    if (timer) return;
    timer = setTimeout(() => { timer = 0; lastTick = Date.now(); tick(); }, Math.max(30, lastTick + 600 - Date.now()));
  });
  mo.observe(document.body, { childList: true, subtree: true });
  // Settings changed in the popup (or another tab) show up here straight away. Only keys this script never writes on its
  // own render path are watched, and renderAtt's signature check makes a repeat render a no-op, so this can't loop.
  const LIVE = ["threshold", "eseTarget", "bunkBasis", "medBeforeMse", "adjust", "excused", "timetable", "sortBy", "tour"];
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && "profile" in ch && ch.profile.newValue !== profileId) profileId = null; // changed elsewhere: check again before the next save
    // The absent pages show marks, so they follow changes made elsewhere (the popup clearing marks, another tab). Not absentList / lastCourse:
    // these pages write them themselves, and reacting to our own write would loop.
    if (area === "local" && chrome.runtime?.id && (route() === "abs" || route() === "absall") && ["excused", "adjust", "snapshots", "medBeforeMse"].some((k) => k in ch)) {
      absQuick = ""; absSig = "";
      clearTimeout(timer);
      timer = setTimeout(() => { timer = 0; tick(); }, 50);
      return;
    }
    if (area !== "local" || !chrome.runtime?.id || route() !== "att" || !LIVE.some((k) => k in ch)) return;
    if ("tour" in ch && !ch.tour.newValue?.drawer && !drawerTour) { tourChecked = false; attSig = ""; } // "Replay" in the popup: show the drawer tour again
    lastRead = ""; // a setting changed: the next tick must re-read storage even if the table looks the same
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; tick(); }, 50);
  });
  // The extension was reloaded under this tab: say so once and stop, instead of throwing on every page change.
  function expire() {
    mo.disconnect();
    clearTimeout(timer);
    if (!dock?.isConnected) { host?.remove(); return; }
    dock.replaceChildren(h("div", { class: "panel" },
      h("div", { class: "h3" }, "leavemealone was updated"),
      h("p", { class: "sub" }, "Reload this page to keep using it"),
      h("button", { class: "btn solid cta", onclick: () => location.reload() }, "Reload page")));
  }
  tick();
})();
