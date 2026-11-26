// The welcome / about page (welcome.html): who makes it, the UPI section (once UI.ABOUT.upi is set) with its QR shown big
// in a dialog, and a report form that opens a pre-filled GitHub issue. The extension sends nothing itself.
const A = UI.ABOUT;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const version = (() => { try { return chrome.runtime.getManifest().version; } catch { return ""; } })();
$$("[data-ver]").forEach((e) => (e.textContent = version ? `v${version}` : ""));
$$("[data-by]").forEach((e) => (e.textContent = A.by));
$$("[data-na]").forEach((e) => (e.textContent = A.notAffiliated));
$$("[data-repo]").forEach((e) => (e.href = A.repo));
$$("[data-contrib]").forEach((e) => (e.href = `${A.repo}/blob/main/CONTRIBUTING.md`));
$$("[data-privacy]").forEach((e) => (e.href = `${A.repo}/blob/main/PRIVACY.md`));
$$("[data-out]").forEach((e) => e.append(UI.ico("out"))); // the open-in-a-new-tab arrow
// Links out of the extension open in a new tab, so this page stays.
$$("a[href^='http']").forEach((e) => { e.target = "_blank"; e.rel = "noopener"; });

if (A.upi) {
  $("[data-pay]").hidden = false;
  $$("[data-upi]").forEach((e) => (e.textContent = A.upi));
  const copy = $("[data-copy]");
  copy.addEventListener("click", () => navigator.clipboard.writeText(A.upi).then(() => {
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  }));
  // The QR, centre stage: a modal dialog. Esc, Done or a click on the dimmed backdrop closes it.
  const dlg = $("[data-qr]");
  $("[data-qr-open]").addEventListener("click", () => dlg.showModal());
  $("[data-qr-close]").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { // only a click outside the white box (on the backdrop), not on its padding
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}
// Arriving from the popup's "Chip in" (#support): open the QR straight away. (No element has that id, so the page doesn't jump.)
if (location.hash === "#support" && A.upi) $("[data-qr]").showModal();

// The demo: a cursor marks a missed day as C (co-curricular), the overall counts up past 75% and the chip flips.
// Invented numbers: 63 of 85 hours, +2 co-curricular = 65 of 85. Loops while the tab is visible; a still end state under reduced motion.
(() => {
  const demo = $("[data-demo]");
  if (!demo) return;
  const num = $("[data-d-num]"), fill = $("[data-d-fill]"), chip = $("[data-d-chip]"), line = $("[data-d-line]"), vibe = $("[data-d-vibe]"), box = $("[data-d-days]"), cur = $("[data-d-cursor]");
  const FROM = 74.12, TO = 76.47, MIN = 75;
  const fmt = (v) => `${v.toFixed(2)}%`;
  const setChip = (cls, text) => { chip.className = `chip ${cls}`; chip.textContent = text; };
  const setVibe = (pct) => { // the real slang tag and line from the Overview, so the demo reads exactly like the extension
    const d = pct - MIN;
    vibe.replaceChildren(UI.vibeTag(pct, MIN, true), " ", d >= 0 ? `${d.toFixed(2)} points above your ${MIN}% minimum` : `${(-d).toFixed(2)} points below your ${MIN}% minimum`);
  };
  // The absent drawer's own day group (UI.absentDays), invented rows, Thu 14 Mar.
  const CHOICES = [
    { s: "abs", letter: "A", cls: "a", label: "Absent", tip: "Stays absent" },
    { s: "cc", letter: "C", cls: "c", label: "Co-curricular", tip: "Co-curricular" },
    { s: "med", letter: "M", cls: "m", label: "Medical", tip: "Medical" },
    { s: "later", letter: "L", cls: "l", label: "Later", tip: "Was present" },
  ];
  const ROWS = [
    { date: "MAR 14", day: "Thursday", period: "Period-3", time: "11:00:00 - 12:00:00", code: "CSEAM632P", name: "COMPUTER NETWORKS", type: "Theory", kind: "abs", h: 1 },
    { date: "MAR 14", day: "Thursday", period: "Period-4", time: "12:00:00 - 13:00:00", code: "CSEAM633", name: "DATA STRUCTURES", type: "Theory", kind: "abs", h: 1 },
  ];
  let picked = "abs";
  const drawDays = () => box.replaceChildren(...UI.absentDays(ROWS, { on: true, choices: CHOICES, selOf: () => picked, canMark: () => true, pick() {}, pickDay() {} }).flat(Infinity));
  const mark = (s) => { picked = s; drawDays(); };
  const end = () => { mark("cc"); demo.classList.add("up"); num.textContent = fmt(TO); fill.style.transform = `scaleX(${TO / 100})`; setChip("good", "can bunk 1"); line.textContent = "65 of 85 hours · 2 co-curricular"; setVibe(TO); };
  drawDays();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { end(); return; }

  const reset = () => { mark("abs"); demo.classList.remove("up"); num.textContent = fmt(FROM); fill.style.transform = `scaleX(${FROM / 100})`; setChip("bad", "attend next 3"); line.textContent = "63 of 85 hours"; setVibe(FROM); };
  const at = (el, dx = 0, dy = 0) => { // the cursor tip over an element, in the demo's own coordinates
    const d = demo.getBoundingClientRect(), r = el.getBoundingClientRect();
    return `translate(${r.left - d.left + r.width / 2 + dx - 5}px, ${r.top - d.top + r.height / 2 + dy - 3}px)`;
  };
  const count = () => {
    const t0 = performance.now(), dur = 900;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), v = FROM + (TO - FROM) * (1 - (1 - k) ** 3);
      num.textContent = fmt(v);
      if (v >= MIN && !demo.classList.contains("up")) { demo.classList.add("up"); setChip("good", "can bunk 1"); setVibe(v); }
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const run = async () => {
    for (;;) {
      if (document.hidden) { await wait(500); continue; }
      reset();
      cur.style.transition = "none"; cur.style.transform = at(box, 40, 20); cur.style.opacity = "0";
      await wait(900);
      const btnC = box.querySelector(".pday .seg .c") || box.querySelector(".seg .c");
      cur.style.transition = ""; cur.style.opacity = "1"; cur.style.transform = at(btnC);
      await wait(950);
      cur.classList.add("tap"); btnC.classList.add("press");
      await wait(120);
      cur.classList.remove("tap");
      mark("cc");
      await wait(350);
      fill.style.transform = `scaleX(${TO / 100})`; count();
      line.textContent = "65 of 85 hours · 2 co-curricular";
      await wait(900);
      cur.style.opacity = "0";
      await wait(3200);
    }
  };
  run();
})();

// Report options -> github.com/<repo>/issues/new with the type, version and safe diagnostics filled in. The extension sends nothing itself.
const WHERE = { Bug: "A page looks wrong or the pill is missing", "Wrong number": "Which number, and what the portal shows", "Feature idea": "What you wish it did" };
const form = $("[data-report]");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const title = String(f.get("title") || "").trim();
  form.elements.title.setAttribute("aria-invalid", title ? "false" : "true");
  $("[data-err]").hidden = !!title;
  if (!title) { $("[data-status]").textContent = "Add a short title first."; form.elements.title.focus(); return; }
  $("[data-status]").textContent = "";
  const ua = navigator.userAgentData?.brands?.filter((b) => !/not.a.brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`).join(", ") || navigator.userAgent;
  let tech = [];
  if (form.elements.tech?.checked) { // counts and view names from local storage, never names, hours or percentages
    try {
      const d = await chrome.storage.local.get({ snapshots: {}, latest: null, timetable: null, absentList: null });
      const s = d.snapshots[d.latest];
      tech = UI.diag({ version, via: s?.via, courses: s?.courses?.length, hasCc: s ? !!s.hasCc : undefined, sem: d.latest, syncedAt: s?.syncedAt,
        ttDays: d.timetable ? Object.keys(d.timetable).length : undefined, absentRows: d.absentList?.rows?.length });
    } catch { tech = []; }
  }
  const body = [
    `**Type:** ${f.get("kind")}`,
    `**Where:** ${f.get("where")}`,
    "",
    String(f.get("details") || "").trim() || "_(no details)_",
    "",
    "---",
    `leavemealone ${version || "?"} · ${ua}`,
    ...(tech.length ? ["", "Technical details (counts and view names only, no numbers or names):", ...tech.map((l) => `- ${l}`)] : []),
  ].join("\n");
  $("[data-status]").textContent = "GitHub is open in a new tab. Press Submit there.";
  window.open(`${A.repo}/issues/new?title=${encodeURIComponent(`[${f.get("kind")}] ${title}`)}&body=${encodeURIComponent(body)}`, "_blank", "noopener");
});
