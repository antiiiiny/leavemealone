// Daily check against the last snapshot saved by the content script.
// It cannot fetch from the portal itself (login required).
// Scripts are imported up front: importScripts is only reliable while the worker starts.
importScripts("calc.js", "calendar.js", "plan.js");

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // A fresh install opens the bundled welcome page once (how to start, who makes it, how to chip in). Updates don't.
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  chrome.alarms.create("daily-check", { periodInMinutes: 24 * 60, delayInMinutes: 1 });
  // Timetables saved before 0.5.0 could keep weekdays from an older semester. Drop them once; the tour asks for a fresh one.
  chrome.storage.local.get({ ttSchema: 0 }, (d) => {
    if (d.ttSchema >= 2) return;
    chrome.storage.local.remove(["timetable", "timetableSavedAt"], () => chrome.storage.local.set({ ttSchema: 2 }));
  });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== "daily-check") return;
  chrome.storage.local.get({ threshold: 75, snapshots: {}, latest: null, adjust: {}, excused: {}, alerts: true, timetable: null, medBeforeMse: true }, (d) => {
    if (d.alerts === false) return; // turned off in the popup settings
    const snap = d.snapshots[d.latest];
    const eff = snap ? Calc.actual(snap, d.adjust[d.latest], d.excused[d.latest], { medInCourse: Plan.medInCourse(d.medBeforeMse) }) : null; // your actual attendance, the same numbers as the drawer
    if (snap) snap.courses = eff.courses;
    let title = "Attendance check";
    let message;
    if (!snap) {
      message = "No attendance data yet. Open the CUE attendance page once.";
    } else {
      const low = snap.courses.filter((c) => (c.attended / c.scheduled) * 100 < Plan.minOf(d.threshold));
      const ageDays = (Date.now() - snap.syncedAt) / 86400000;
      if (low.length) {
        const detained = low.filter((c) => (c.attended / c.scheduled) * 100 < Calc.DETAIN).length; // the university's detain line
        title = detained ? `Pakka detain: ${detained} course${detained > 1 ? "s" : ""} below 75%` : `Low attendance in ${low.length} course(s)`;
        message = low.map((c) => `${c.code || c.name} ${((c.attended / c.scheduled) * 100).toFixed(0)}%`).join(", ");
      } else if (ageDays > Calc.STALE_DAYS) {
        message = `Data is ${Math.floor(ageDays)} days old. Open the CUE attendance page to refresh.`;
      }
      if (low.length && ageDays > Calc.STALE_DAYS) message += ` (data is ${Math.floor(ageDays)} days old: open CUE attendance to refresh)`;
      // MSE needs 75%: warn about courses that can't get there or have no spare classes left.
      const risks = d.timetable ? Plan.mseRisks({ eff, tt: d.timetable, from: Cal.addDays(Cal.day0(), 1) }) : [];
      if (risks.length) {
        const names = (st) => risks.filter((r) => r.state === st).map((r) => r.code || r.name).join(", ");
        const parts = [names("out") && `out of reach: ${names("out")}`, names("zero") && `no spare classes: ${names("zero")}`].filter(Boolean);
        if (message) message += ` · MSE: ${parts.join(" · ")}`;
        else { title = "MSE attendance risk"; message = parts.join(" · "); }
      }
      if (!message) return;
    }
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title,
      message,
    });
  });
});
