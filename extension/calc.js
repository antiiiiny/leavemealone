// Pure attendance maths. t is a fraction (0.75), a = attended, s = scheduled/conducted.
const Calc = {
  // The university's lines, in percent. Everything that needs one reads it from here.
  FLOOR: 74.5,      // medical leave is only considered from here up; also the lowest minimum / ESE target the user can set
  DETAIN: 75,       // below this: detained, whatever minimum the user sets
  ESE: 85,          // the overall needed for ESE; medical leave stops being added at this point
  STALE_DAYS: 3,    // saved numbers older than this are called out (popup banner, daily alert)
  percent(a, s) {
    return s > 0 ? (a / s) * 100 : 0;
  },
  // Classes you can still miss and stay at or above t.
  canSkip(a, s, t) {
    return Math.max(0, Math.floor(a / t - s + 1e-9));
  },
  // Classes you can still miss out of the R still to come (already scheduled) and stay at or
  // above t. Not the same as canSkip, which adds extra classes on top of those held so far.
  budget(a, s, R, t) {
    return Math.max(0, Math.floor(a + R - t * (s + R) + 1e-9));
  },
  // Best possible percentage if you attend all R remaining classes.
  bestCase(a, s, R) {
    return Calc.percent(a + R, s + R);
  },
  // Consecutive classes you must attend to get back to t (0 if already there).
  mustAttend(a, s, t) {
    if (a / s >= t || s === 0) return 0;
    return Math.ceil((t * s - a) / (1 - t) - 1e-9);
  },
  // The attendance you actually have once your own hours and marks count (what the Overview shows): the portal's numbers plus typed hours,
  // absent hours marked Later, and co-curricular hours, which count in their own course AND the overall. Medical counts in the overall
  // only while it is 74.5% to 84.49% (see effective). `exc` = your absent-hour marks. opts.medInCourse (until the MSE is over, a setting:
  // Plan.medInCourse) also counts medical hours in their own course; the overall keeps the band rule either way.
  actual(snap, adj, exc, opts) {
    const e = Calc.effective(snap, adj, exc);
    const med = !!(opts && opts.medInCourse);
    return { ...e, courses: e.courses.map((c) => ({ ...c, medInCourse: med && c.medHrs > 0, attended: c.attended + c.ccHrs + (med ? c.medHrs : 0) })) };
  },
  // Percentage after skipping n more classes.
  afterSkipping(a, s, n) {
    return Calc.percent(a, s + n);
  },
  medicalText(o) {
    if (o.medicalState === "applies") {
      const before = Calc.percent(o.withoutMedical, o.scheduled).toFixed(1);
      return `added, since the aggregate (${before}%) is below ${Calc.ESE}% → ${Calc.percent(o.attended, o.scheduled).toFixed(1)}%`;
    }
    if (o.medicalState === "not-needed") return `not added, aggregate is already ${Calc.ESE}% or more`;
    return `not added, aggregate is below ${Calc.FLOOR}% so medical leave isn't considered`;
  },
  // Portal snapshot + your own adjustments for that semester:
  // adj = { cocurricular: hrs, courses: { [code]: { att, sch, baseSch } } }
  // att/sch are hours not yet on the portal. baseSch is the portal's scheduled
  // count when you entered them; if the portal's count has since changed the
  // adjustment is flagged stale (the portal may now include those hours).
  // exc = { [courseKey]: { rows: [{k, h}], baseAbsent } }: absent hours you ticked as
  // actually present on the Absent Details page. They are already in "scheduled", so they
  // only add to attended, never more than the portal's own absent hours for that course.
  effective(snap, adj, exc) {
    const m = (adj && adj.courses) || {};
    const courses = snap.courses.map((c) => {
      const key = c.code || c.name;
      const x = m[key] || { att: 0, sch: 0 };
      const has = x.att || x.sch;
      const e = exc && exc[key];
      // Per absent hour you chose: s = "later" (portal will update it to present), "cc"
      // (co-curricular claim) or "med" (medical). Unmarked hours stay absent. Rows saved
      // before this choice existed have no s and count as "later".
      const sums = { later: 0, cc: 0, med: 0 };
      // r.p = the portal itself labelled the hour (e.g. "Medical Leave"). r.gone = the portal
      // stopped listing it as absent (it was updated); it is already in the portal's numbers,
      // so it is not counted here and just waits for you to "Confirm present".
      let goneHrs = 0;
      if (e) for (const r of e.rows) {
        if (r.gone) { goneHrs += r.h; continue; }
        // Once the portal shows a Co-curricular column (semester end) its attended already includes the hours IT labelled
        // co-curricular (r.p), so those must not be added again. Hours only you marked C are still plain absent there,
        // so they count: dropping them made every co-curricular mark a no-op for students whose table has the column.
        if (snap.hasCc && r.p && r.s === "cc") continue;
        sums[r.s === "cc" || r.s === "med" ? r.s : "later"] += r.h;
      }
      const total = sums.later + sums.cc + sums.med;
      const f = c.absent != null && total > c.absent ? c.absent / total : 1; // never more than the portal's absent hrs
      const later = sums.later * f, cc = sums.cc * f, med = sums.med * f;
      const excusedHrs = later + cc + med;
      const absentMoved = !!e && c.absent != null && e.baseAbsent !== undefined && e.baseAbsent !== c.absent;
      return {
        ...c,
        key,
        adj: x,
        excusedHrs, goneHrs, laterHrs: later, ccHrs: cc, medHrs: med,
        portalAttended: c.attended,
        portalScheduled: c.scheduled,
        attended: c.attended + (x.att || 0) + later,
        scheduled: c.scheduled + (x.sch || 0),
        stale: (!!has && x.baseSch !== undefined && x.baseSch !== c.scheduled) || absentMoved,
      };
    });
    // Co-curricular claims (typed or marked on Absent Details) add to the overall aggregate only.
    const sum = (k) => courses.reduce((n, c) => n + c[k], 0);
    const cc = (snap.hasCc ? 0 : (adj && adj.cocurricular) || 0) + sum("ccHrs"); // typed co-curricular hours: ignored once the portal has the column
    const withCc = sum("attended") + cc, scheduled = sum("scheduled");
    // Medical leave (policy text): only considered when the aggregate with co-curricular is
    // at least 74.5%, and only applied when it is below 85%. In that band the hours are
    // added to the overall attended; otherwise they are just reported.
    const medical = sum("medHrs");
    const pct = Calc.percent(withCc, scheduled);
    const medicalState = !medical ? "none" : pct < Calc.FLOOR ? "below" : pct < Calc.ESE ? "applies" : "not-needed";
    const medicalAdded = medicalState === "applies" ? medical : 0;
    return {
      courses,
      overall: {
        attended: withCc + medicalAdded, scheduled, cocurricular: cc,
        medical, medicalState,
        withoutMedical: withCc, ccIncluded: !!snap.hasCc, goneHrs: sum("goneHrs"),
      },
    };
  },
};

if (typeof module !== "undefined") module.exports = Calc;
