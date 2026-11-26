// Bunk planning: pure functions shared by the on-page drawer and the popup.
// timetable = { "1": [{ period: "Period-1", time, name, type }], ... "6": [...] } (keys = Date.getDay())
// selection = Map(dayKey "YYYY-MM-DD" -> Set of periods, or null for the whole day)
const Plan = (() => {
  const C = typeof Calc !== "undefined" ? Calc : require("./calc.js");
  const K = typeof Cal !== "undefined" ? Cal : require("./calendar.js");
  // Timetable entries are matched to attendance courses by upper-cased, trimmed name. Everything goes through
  // courseOf / keyOf so "not in your table" means the same thing everywhere.
  const norm = (s) => (s || "").trim().toUpperCase();
  const byName = new WeakMap(); // courses array -> Map(norm name -> course). Each render builds a new array, so it can't go stale.
  function namesOf(courses) {
    let m = byName.get(courses);
    if (!m) byName.set(courses, (m = new Map(courses.map((c) => [norm(c.name), c]))));
    return m;
  }
  const courseOf = (courses) => (name) => namesOf(courses).get(norm(name)); // name -> course | undefined
  const keyOf = (courses) => { const of = courseOf(courses); return (name) => { const c = of(name); return c && (c.code || c.name); }; }; // name -> course key | undefined
  const periodNum = (p) => parseInt(/\d+/.exec(p || "")?.[0], 10) || 0; // "Period-5" -> 5

  function classesOn(date, tt) {
    if (!tt || !K.dayInfo(date).classDay) return [];
    return tt[String(date.getDay())] || [];
  }
  const sortedClassesOn = (date, tt) => [...classesOn(date, tt)].sort((a, b) => periodNum(a.period) - periodNum(b.period));

  // Hours missed per course key for a selection.
  function missedFor(selection, tt, courses) {
    const km = keyOf(courses);
    const missed = {};
    const unknown = new Set();
    for (const [k, periods] of selection) {
      for (const c of classesOn(K.parse(k), tt)) {
        if (periods && !periods.has(c.period)) continue;
        const key = km(c.name);
        if (!key) { unknown.add(c.name); continue; }
        missed[key] = (missed[key] || 0) + 1;
      }
    }
    return { missed, unknown: [...unknown] };
  }

  // The next n class slots on the timetable from `from` on (class days only, periods in order), charged to
  // the course each one belongs to: { missed: {courseKey: hours}, known: slots that belong to a table course,
  // taken: slots found, last: date of the last one }. Slots of courses not in the table count as taken only.
  function nextClasses(tt, courses, from, n, limit = 400) {
    const km = keyOf(courses), missed = {};
    let known = 0, taken = 0, last = null;
    if (!tt || !(n > 0)) return { missed, known, taken, last };
    for (let d = from, i = 0; taken < n && i < limit; d = K.addDays(d, 1), i++) {
      for (const c of sortedClassesOn(d, tt)) {
        if (taken >= n) break;
        taken++; last = d;
        const key = km(c.name);
        if (key) { missed[key] = (missed[key] || 0) + 1; known++; }
      }
    }
    return { missed, known, taken, last };
  }

  // The next n classes of ONE course on the timetable from `from` on: [{ date, period }]. Matched by upper-cased name.
  function courseClasses(tt, course, from, n, limit = 400) {
    const out = [];
    if (!tt || !course || !(n > 0)) return out;
    const want = norm(course.name);
    for (let d = from, i = 0; out.length < n && i < limit; d = K.addDays(d, 1), i++) {
      for (const c of sortedClassesOn(d, tt)) {
        if (out.length >= n) break;
        if (norm(c.name) === want) out.push({ date: d, period: c.period });
      }
    }
    return out;
  }

  // Minutes after midnight at which a period ends: "9:00 – 10:00 AM" -> 600, "14:00:00 - 15:00:00" -> 900. NaN if unreadable.
  function endMinutes(time) {
    const all = [...(time || "").matchAll(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/gi)];
    if (!all.length) return NaN;
    const m = all[all.length - 1];
    let h = +m[1];
    if (m[3]) { const pm = m[3].toUpperCase() === "PM"; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    return h * 60 + +m[2];
  }

  // Where "what is still ahead" starts: today while a class of today has not ended yet, else tomorrow.
  function upcomingFrom(tt, now) {
    const today = K.day0(now);
    const left = classesOn(today, tt).some((c) => { const e = endMinutes(c.time); return !(e <= now.getHours() * 60 + now.getMinutes()); });
    return left ? today : K.addDays(today, 1);
  }

  // Classes still to come per course key, from `from` to `to` inclusive.
  function remainingHours(tt, courses, from, to) {
    const km = keyOf(courses);
    const out = {};
    if (!to) return out;
    for (let d = from; d <= to; d = K.addDays(d, 1)) {
      for (const c of classesOn(d, tt)) {
        const key = km(c.name);
        if (key) out[key] = (out[key] || 0) + 1;
      }
    }
    return out;
  }

  // basis "now": % right after the bunk.  basis "mse" / "end": % on the cutoff day (last class day
  // before MSE / last instruction day) if you attend everything else.
  function project(a, s, k, R, basis) {
    return basis !== "now"
      ? { before: C.percent(a + R, s + R), after: C.percent(a + R - k, s + R) }
      : { before: C.percent(a, s), after: C.percent(a, s + k) };
  }

  function impact(eff, missed, basis, remaining, t) {
    const thr = t * 100, cthr = courseLine(basis, t) * 100, cr = criteria(basis);
    const rows = eff.courses
      .filter((c) => missed[c.key])
      .map((c) => {
        const k = missed[c.key], R = remaining[c.key] || 0;
        const p = project(c.attended, c.scheduled, k, R, basis);
        const safe = p.after >= cthr;
        // How many classes to attend afterwards to get back to the minimum (right-now view).
        const recover = safe ? 0 : C.mustAttend(c.attended, c.scheduled + k, t);
        return { key: c.key, name: c.name, code: c.code, k, R, ...p, safe, recover };
      });
    const o = eff.overall;
    const kAll = Object.values(missed).reduce((n, x) => n + x, 0);
    const RAll = Object.values(remaining).reduce((n, x) => n + x, 0);
    const op = project(o.attended, o.scheduled, kAll, RAll, basis);
    const overallSafe = op.after >= thr;
    return { rows, overall: { k: kAll, ...op, safe: overallSafe }, safe: (!cr.course || rows.every((r) => r.safe)) && (!cr.overall || overallSafe) };
  }

  const MSE_MIN = 0.75; // MSE: every course needs this much (there is no overall criterion)
  const ESE_MIN = C.FLOOR; // the lowest ESE target the user can pick (the medical-leave floor); below the official ESE_OVERALL is allowed but flagged
  const ESE_OVERALL = C.ESE; // ESE: the overall attendance needed, in percent (courses are not the criterion); medical leave helps the overall get there
  // Which numbers decide "safe" for a basis: now = courses and overall, mse = every course, end (ESE) = the overall.
  const minOf = (v) => Math.min(100, Math.max(ESE_MIN, Number.isFinite(Number(v)) && v != null ? Number(v) : 75)); // the saved minimum, never below 74.5
  const eseOf = (v) => Math.min(100, Math.max(ESE_MIN, Number.isFinite(Number(v)) && v != null ? Number(v) : ESE_OVERALL)); // the stored target, or the default
  const CRITERIA = { now: { course: true, overall: true }, mse: { course: true, overall: false }, end: { course: false, overall: true } };
  const criteria = (basis) => CRITERIA[basis] || CRITERIA.now;
  // The line a single course is held to (a fraction). For ESE the line t is the overall target, so courses keep the plain minimum.
  const courseLine = (basis, t) => (basis === "end" ? Math.min(t, MSE_MIN) : t);

  // The percentage line (fraction) that "safe" is measured against for a basis.
  // t = the user's minimum (fraction), esePct = their ESE target (percent).
  function thresholdFor(basis, t, esePct) {
    return basis === "mse" ? MSE_MIN : basis === "end" ? esePct / 100 : t;
  }

  // Last day that counts for a basis (null if unknown). "now" looks as far as semester end.
  function horizonDate(basis, from) {
    return K.cutoffRef(basis === "mse" ? "mse" : "ese", from); // may be in the past: then the planner is a reference, nothing is left to plan
  }

  // A saved "mse" basis only holds while MSE is still ahead and has class days left.
  function resolveBasis(basis, from) {
    if (basis === "end") return K.cutoffRef("ese", from) ? "end" : "now";
    return basis === "mse" && K.cutoffRef("mse", from) ? "mse" : "now";
  }

  // Drop selected days that fall after the cutoff.
  function clipSelection(selection, cutoff) {
    if (!cutoff) return selection;
    const last = K.key(cutoff);
    return new Map([...selection].filter(([k]) => k <= last));
  }

  // Classes each course can still miss before the basis' cutoff and stay on the line t (a fraction).
  // Null for "now", without a timetable, or when the cutoff is unknown.
  function budgets({ eff, tt, basis, t, from }) {
    if (basis === "now" || !tt) return null;
    const end = horizonDate(basis, from);
    if (!end) return null;
    const remaining = remainingHours(tt, eff.courses, from, end);
    // Courses are matched to the timetable by name; one that never matches has no known classes left,
    // so its best case would just be today's % (a false "out of reach"). Flag it instead.
    const km = keyOf(eff.courses), inTimetable = new Set();
    for (const day of Object.values(tt)) for (const c of day) if (km(c.name)) inTimetable.add(km(c.name));
    const row = (key, name, code, a, s, R, matched = true) => {
      const bestCase = C.bestCase(a, s, R);
      const line = key === "overall" ? t : courseLine(basis, t); // a course is held to the course line, the overall to the basis line
      return { key, name, code, pct: C.percent(a, s), R, budget: C.budget(a, s, R, line), bestCase, reachable: bestCase >= line * 100 - 1e-9, matched };
    };
    const rows = eff.courses.filter((c) => c.scheduled > 0).map((c) => row(c.key, c.name, c.code, c.attended, c.scheduled, remaining[c.key] || 0, inTimetable.has(c.key)));
    const RAll = Object.values(remaining).reduce((n, x) => n + x, 0);
    const o = eff.overall;
    const overall = row("overall", "Overall", "", o.attended, o.scheduled, RAll);
    // What decides it for this basis: every (known) course for MSE, the overall for ESE.
    const cr = criteria(basis), judged = rows.filter((r) => r.matched);
    const unreachable = cr.course ? judged.filter((r) => !r.reachable) : [];
    const reachable = (!cr.course || !unreachable.length) && (!cr.overall || overall.reachable);
    const tightest = cr.course && judged.length ? judged.reduce((m, r) => (r.budget < m.budget ? r : m)) : null;
    const spare = cr.course ? { n: tightest ? tightest.budget : 0, row: tightest } : { n: overall.budget, row: overall };
    return { end, rows, overall, scope: cr, reachable, unreachable, spare };
  }

  // Courses heading below the MSE line: "out" = can't reach 75% even attending everything,
  // "zero" = exactly on it with MSE within `days` days.
  function mseRisks({ eff, tt, from, days = 7 }) {
    if (!K.cutoff("mse", from)) return []; // once the cutoff has passed there is nothing left to warn about
    const b = budgets({ eff, tt, basis: "mse", t: MSE_MIN, from });
    if (!b) return [];
    const left = Math.round((b.end - from) / 86400000);
    const out = [];
    for (const r of b.rows) {
      if (!r.matched) continue;
      const state = !r.reachable ? "out" : r.budget === 0 && left <= days ? "zero" : null;
      if (state) out.push({ key: r.key, code: r.code, name: r.name, state, bestCase: r.bestCase, budget: r.budget, R: r.R });
    }
    return out;
  }

  // Consecutive days off around d if you skip d (counts d itself).
  function breakLength(d) {
    let n = 1;
    const names = [];
    const walk = (step) => { // days off in a row on one side of d (up to 10)
      for (let x = K.addDays(d, step), i = 0; i < 10; x = K.addDays(x, step), i++) {
        const info = K.dayInfo(x);
        if (info.classDay) break;
        n++;
        if (info.holiday) names.push(info.reason);
      }
    };
    walk(-1);
    walk(1);
    return { n, names: [...new Set(names)] };
  }

  // Next class days ranked for bunking: safe first, then longest break created, then fewest classes.
  // t = the line for this basis (see thresholdFor).
  function bestDays({ eff, tt, courses, basis, t, from, horizon = 14, limit = 5 }) {
    const end = horizonDate(basis, from);
    if (basis === "mse" && !end) return { days: [], remaining: {}, end: null };
    const remaining = remainingHours(tt, courses, from, end);
    const out = [];
    for (let d = from, seen = 0; seen < horizon && (!end || d <= end); d = K.addDays(d, 1)) {
      const cls = classesOn(d, tt);
      if (!cls.length) continue;
      seen++;
      const { missed } = missedFor(new Map([[K.key(d), null]]), tt, courses);
      const imp = impact(eff, missed, basis, remaining, t);
      const lowest = imp.rows.reduce((m, r) => Math.min(m, r.after), Infinity);
      const br = breakLength(d);
      out.push({ date: d, key: K.key(d), classes: cls.length, safe: imp.safe, lowest: Number.isFinite(lowest) ? lowest : null, breakDays: br.n, breakNames: br.names, impact: imp });
    }
    out.sort((a, b) => (b.safe - a.safe) || (b.breakDays - a.breakDays) || (a.classes - b.classes) || ((b.lowest ?? 0) - (a.lowest ?? 0)));
    return { days: out.slice(0, limit), remaining, end };
  }

  // Tick a period as attended (or untick it = skipped) on a picked day. `cur` is the day's skipped set
  // (null = the whole day is skipped), `periods` the day's period ids. Returns the new skipped set,
  // null when everything is skipped, or undefined when nothing is skipped any more (drop the day).
  function setAttend(periods, cur, period, attending) {
    const skipped = new Set(cur || periods);
    if (attending) skipped.delete(period); else skipped.add(period);
    return !skipped.size ? undefined : skipped.size === periods.length ? null : skipped;
  }

  // Medical hours count in their own course until the MSE is over (the semester's MSE window has ended), when the
  // `medBeforeMse` setting is on (unset = on). After that, per course they reset and only the overall's band rule applies.
  const medInCourse = (setting, d = new Date()) => setting !== false && !!K.cutoffRef("mse", d);

  return { MSE_MIN, ESE_OVERALL, ESE_MIN, minOf, eseOf, medInCourse, criteria, courseLine, courseOf, periodNum, classesOn, sortedClassesOn, courseClasses, endMinutes, upcomingFrom, nextClasses, missedFor, setAttend, remainingHours, impact, bestDays, breakLength, thresholdFor, horizon: horizonDate, resolveBasis, clipSelection, budgets, mseRisks };
})();

if (typeof module !== "undefined") module.exports = Plan;
