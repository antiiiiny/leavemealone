// Small DOM helpers shared by the on-page drawer (content.js) and the toolbar popup (popup.js).
// Loaded after plan.js and before content.js / popup.js (both manifest.json and popup.html list it).
const UI = (() => {
  // h("div", {class: "x", onclick: fn}, child, "text", ...)
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
    return el;
  };

  const plural = (n, word) => `${n} ${n === 1 ? word : word + (word.endsWith("s") ? "es" : "s")}`; // 1 class, 2 classes
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  // Semester labels end in a Roman numeral ("... VI"): its value, for picking the latest one (0 if none).
  const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };
  const semRank = (label) => ROMAN[/\b(VIII|VII|VI|V|IV|III|II|I)\s*$/.exec(label.toUpperCase().replace(/\s*\[[^\]]*\]\s*$/, ""))?.[1]] || 0;
  // Below 75% the university detains you, whatever minimum you set in the extension.
  const DETAIN = 75; // = Calc.DETAIN (ui.js also loads alone on the welcome page, where Calc isn't there)
  const detain = (pct) => pct < DETAIN;
  // 85% and up: the ESE overall bar is cleared, nothing to worry about. Susegad (Goan: laid-back, relaxed).
  const SUSEGAD = 85; // = Calc.ESE
  const susegad = (pct, thr = 0) => pct >= SUSEGAD && pct >= thr; // never beside "below your minimum": with a 90% minimum, 87% is not relaxed
  // The tag next to a course: "pakka detain" below 75%, "susegad" at 85% or more, nothing in between.
  // Styled as a quiet italic aside (.vibe), never as a chip: the can-bunk / attend chip stays the loudest thing.
  const vibeTag = (pct, thr) => detain(pct)
    ? h("span", { class: "vibe bad", title: `Below ${DETAIN}%: not allowed to write the exams unless it comes back up` }, "pakka detain")
    : susegad(pct, thr) ? h("span", { class: "vibe good", title: `${SUSEGAD}% or more: relax` }, "susegad") : null;
  // The same aside as a lead-in for a headline ("pakka detain · ..."), or null. The real message stays the main text.
  const vibeLead = (pct, thr) => { const t = vibeTag(pct, thr); return t ? [t, " "] : null; };
  // Below the official ESE overall the user can still choose their own target, but it is flagged in red.
  const eseFlag = (pct, official) => (pct < official ? h("div", { class: "sub bad eseflag", role: "status" }, "fine you will pay uh?") : null);
  const tone = (pct, thr) => (pct < thr ? "bad" : pct < thr + 10 ? "warn" : "good");
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayLabel = (d) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; // Thu 12 Nov

  // Dates, periods and times the way the design shows them. The portal's formats vary, so fall back to the raw text.
  const niceDate = (raw) => { // "NOV 12 Thursday" -> "Thu 12 Nov"; without the weekday: "12 Nov"
    const m = /^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2})(?:\s+([A-Za-z]{3}))?/.exec((raw || "").trim());
    if (!m) return raw;
    const cap = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
    return `${m[3] ? cap(m[3]) + " " : ""}${+m[2]} ${cap(m[1])}`;
  };
  const nicePeriod = (raw) => (raw || "").replace(/^Period-?\s*/i, "P"); // "Period-5" -> "P5"
  const startTime = (raw) => { // "9:00 – 10:00 AM" -> "9:00", "14:00:00 - 15:00:00" -> "14:00"
    const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:[–-]\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?)?/i.exec(raw || "");
    if (!m) return raw || "";
    let sh = +m[1];
    const ap = (m[5] || "").toUpperCase();
    if (ap && m[3] != null) { // AM/PM is only on the end time: put the start on the same side unless that puts it after the end
      const to24 = (x) => (ap === "PM" ? (x % 12) + 12 : x % 12);
      sh = to24(sh) > to24(+m[3]) ? to24(sh) - 12 : to24(sh);
    }
    return `${sh}:${m[2]}`;
  };

  const PATHS = {
    chev: "M6 3l5 5-5 5",
    close: "M4 4l8 8M12 4l-8 8",
    right: "M3 8h10M9 4l4 4-4 4",
    out: "M5 11l6-6M6 5h5v5",
    lock: "M4.5 7V5.5a3.5 3.5 0 017 0V7M3.5 7h9v6.5h-9z",
    cal: "M3 4.5h10v8.5H3zM3 7.5h10M6 2.5v2.5M10 2.5v2.5",
    list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
    userx: "M8 2a6 6 0 100 12A6 6 0 008 2zM5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2",
    clock: "M8 2a6 6 0 100 12A6 6 0 008 2zM8 4.8V8l2.2 1.4",
    sliders: "M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6M10 3.2v3.6M5.5 9.2v3.6",
    checks: "M3 4.5l1.5 1.5L7 3.5M3 10.5l1.5 1.5L7 9.5M9.5 5h4M9.5 11h4",
    gauge: "M2.5 11a5.5 5.5 0 1111 0M8 11l2.5-3.5",
  };
  // Inline SVG icon (parsed through a template so it gets the SVG namespace).
  const ico = (name, cls = "ic") => {
    const t = document.createElement("template");
    t.innerHTML = `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="${PATHS[name]}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    return t.content.firstChild;
  };

  const sep = () => h("span", { class: "sep", "aria-hidden": "true" }, "|");
  // "attend next N", or a plain "out of reach" when no number of classes can get you back (a 100% minimum after a missed class).
  const mustText = (n) => (Number.isFinite(n) ? `attend next ${n}` : "out of reach");
  // The label for a run of days off around a day you could skip. n counts the skipped day too, so the break itself is n - 1.
  const breakTag = (n) => n >= 4 ? [`${n - 1}-day break`, `${n - 1} days off in a row. Bunking this day makes it ${n}.`] : n === 3 ? ["long weekend", "Bunking this day gives you 3 days off in a row."] : null;
  const TAGLINE = "Unofficially vibecoded UI just like this website, but better."; // the footer under every drawer, panel and the popup
  // Who makes it and how to chip in (welcome page, popup Settings, the later support card).
  // UPI is the public Paytm ID shown with support-qr.png; empty = the pay section stays hidden until it is set.
  // Lines for a bug report: versions, counts and which view was read. Never course names, hours, percentages or the student.
  const diag = ({ version, page, via, courses, hasCc, sem, syncedAt, ttDays, absentRows, found } = {}) => [
    `version ${version || "?"}`, page && `page ${page}`, via && `last read via ${via} view`,
    Number.isFinite(courses) && `${courses} courses`, typeof hasCc === "boolean" && `co-curricular column: ${hasCc ? "yes" : "no"}`,
    sem && `semester label: ${sem}`, syncedAt && `last read ${Math.max(0, Math.round((Date.now() - syncedAt) / 3600000))}h ago`,
    Number.isFinite(ttDays) && `timetable days: ${ttDays}`, Number.isFinite(absentRows) && `absent rows saved: ${absentRows}`, found,
  ].filter(Boolean);
  const ABOUT = { by: "Alicia & Antony Co.", repo: "https://github.com/antiiiiny/leavemealone", upi: "antonyjoyukken@ptyes", notAffiliated: "Unofficial. Not affiliated with CHRIST (Deemed to be University)." };
  const chip = (kind, text, title) => h("span", { class: `chip ${kind}`, title }, text);
  const bar = (pct, thr) =>
    h("div", { class: "bar" },
      h("i", { style: `width:${Math.min(100, Math.max(0, pct))}%;background:var(--${tone(pct, thr)})` }),
      h("u", { style: `left:${thr}%` }));

  // Sliding thumb under a segmented control. Positions are remembered per key, so a control that is rebuilt
  // on every render still slides from where the thumb was instead of jumping.
  const thumbs = new Map();
  const placeThumb = (box, key) => {
    const on = box.querySelector("button.on");
    if (!on || !on.offsetWidth) return;
    let th = box.querySelector(".thumb");
    const fresh = !th;
    if (fresh) { th = h("i", { class: "thumb" }); box.prepend(th); box.classList.add("has-thumb"); }
    const to = { x: on.offsetLeft, w: on.offsetWidth };
    const from = fresh ? thumbs.get(key) || to : null;
    const set = (p) => { th.style.width = `${p.w}px`; th.style.transform = `translateX(${p.x}px)`; };
    thumbs.set(key, to);
    if (fresh) { th.style.transition = "none"; set(from); th.getBoundingClientRect(); th.style.transition = ""; }
    set(to);
  };

  // Count a number towards a new value (320ms), or up from 0 the first time it is shown (700ms).
  // `animate` false (drawer closed) just sets the text and remembers nothing, so the count-up plays on open.
  const lastNum = new Map();
  const tween = (el, key, to, format, { animate = true, countUp = false } = {}) => {
    el.textContent = format(to);
    if (!animate) return;
    const prev = lastNum.get(key);
    lastNum.set(key, to);
    const from = prev ?? (countUp ? 0 : to);
    if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ms = prev == null ? 700 : 320, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = format(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // Segmented control: opts = [[value, label], ...]. Used for "Safe means" (the drawer's tabs are built by hand in content.js).
  const pills = (opts, value, onpick, { label, keyPrefix } = {}) => {
    const box = h("div", { class: "pills", role: "group", "aria-label": label },
      opts.map(([v, text]) =>
        h("button", { class: v === value ? "on" : "", "aria-pressed": String(v === value), "data-key": keyPrefix ? `${keyPrefix}-${v}` : null, onclick: () => v !== value && onpick(v) }, text)));
    requestAnimationFrame(() => placeThumb(box, keyPrefix || label)); // after it is in the page
    return box;
  };

  // Number stepper: - n +
  // It keeps its own current value, so quick repeated clicks count every click even before the caller redraws.
  // The number can be typed too: digits only, clamped to min..max. It commits on Enter or blur and, with `live`,
  // also 400ms after typing stops (the popup uses that, so a typed value survives the popup closing).
  // Escape puts the last committed value back.
  const stepper = (value, { min = 0, max = 999, onchange, label, key, live = false, decimals = 0 }) => {
    const rnd = (n) => (decimals ? Math.round(n * 10 ** decimals) / 10 ** decimals : Math.round(n)); // decimals: 1 allows 74.5
    let cur = value, timer = 0;
    const dec = h("button", { "aria-label": `Decrease ${label || ""}`.trim(), "data-key": key ? `${key}-dec` : null, onclick: () => set(rnd(cur - 1)) }, "−");
    const inc = h("button", { "aria-label": `Increase ${label || ""}`.trim(), "data-key": key ? `${key}-inc` : null, onclick: () => set(rnd(cur + 1)) }, "+");
    const sync = () => { input.value = String(cur); dec.disabled = cur <= min; inc.disabled = cur >= max; };
    function set(n) {
      const v = Math.min(max, Math.max(min, n));
      if (v === cur) { sync(); return; }
      cur = v; sync(); onchange(v);
    }
    const commitTyped = (fromBlur) => {
      clearTimeout(timer);
      const n = decimals ? parseFloat(input.value) : parseInt(input.value, 10);
      if (Number.isNaN(n)) { if (fromBlur) sync(); return; }
      const v = Math.min(max, Math.max(min, rnd(n)));
      if (fromBlur) input.value = String(v); // while typing, leave the text alone: "8" on the way to "85" must not jump
      if (v !== cur) { cur = v; dec.disabled = cur <= min; inc.disabled = cur >= max; onchange(v); }
    };
    const input = h("input", { class: "stv", type: "text", inputmode: "numeric", autocomplete: "off", "aria-label": label || "value", "data-key": key ? `${key}-val` : null, value: String(value),
      onfocus: (e) => e.target.select(),
      oninput: (e) => {
        e.target.value = decimals ? e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 5) : e.target.value.replace(/\D/g, "").slice(0, 3);
        if (live) { clearTimeout(timer); timer = setTimeout(() => commitTyped(false), 400); }
      },
      onkeydown: (e) => { if (e.key === "Enter") e.target.blur(); else if (e.key === "Escape") { clearTimeout(timer); sync(); e.target.blur(); } e.stopPropagation(); },
      onblur: () => commitTyped(true) });
    sync();
    return h("span", { class: "stp", role: "group", "aria-label": label }, dec, input, inc);
  };

  const toggle = (on, onchange, label, key) =>
    h("button", { class: `sw${on ? " on" : ""}`, role: "switch", "aria-checked": String(on), "aria-label": label, "data-key": key, onclick: () => onchange(!on) });

  // Accordion row: title + one-line explanation + chevron that turns when open. The caller keeps `open` state.
  // An icon tile on the left says what the card is at a glance (`icon` is a PATHS name, `tone` a colour name).
  const tile = (icon, tone = "mute") => h("span", { class: `ai t-${tone}` }, ico(icon));
  // The accordion flips in place (class, aria-expanded, inert) so its height transition plays; callers only record the state and must not rebuild the screen.
  const acc = ({ title, sub, open, ontoggle, key, icon, tone }, ...body) => {
    const btn = h("button", { class: "ah", "aria-expanded": String(!!open), "data-key": key, onclick: () => flip() },
      h("span", { class: "ahl" }, icon ? tile(icon, tone) : null, h("span", {}, h("b", {}, title), sub ? h("small", {}, sub) : null)), ico("chev", "ic chev"));
    const wrap = h("div", { class: "ab-wrap", inert: open ? null : "" }, h("div", { class: "ab" }, h("div", { class: "abp" }, body)));
    const root = h("div", { class: `acc${open ? " open" : ""}` }, btn, wrap);
    const flip = () => {
      const now = !root.classList.contains("open");
      root.classList.toggle("open", now);
      btn.setAttribute("aria-expanded", String(now));
      wrap.toggleAttribute("inert", !now);
      ontoggle(now);
    };
    return root;
  };

  // Absent hours from the all-courses list (rows saved by content.js), shown day by day with the kind of absence.
  const KIND = { abs: ["bad", "absent"], cc: ["gold", "co-curricular"], med: ["blue", "medical"] };
  const hrsOf = (rows, k) => rows.filter((r) => r.kind === k).reduce((n, r) => n + r.h, 0);
  const absentSummary = (rows) => { const si = (t) => h("span", { class: "si" }, t); return [si(`${fmt(hrsOf(rows, "abs"))}h absent`), hrsOf(rows, "cc") ? [sep(), si(`${fmt(hrsOf(rows, "cc"))}h co-curricular`)] : null, hrsOf(rows, "med") ? [sep(), si(`${fmt(hrsOf(rows, "med"))}h medical`)] : null]; };
  // opts (optional) turns the plain-absent rows into A / C / M / L controls: { on, choices, selOf(r), canMark(r), pick(r, choice) }.
  const MARKED = { later: ["mute", "later"], cc: ["gold", "co-curricular"], med: ["blue", "medical"] };
  // Whole-day A / C / M / L: one pick for every markable hour of a day. cur = the choice all of them share (lit), else null.
  // onpick(choice) always fires; the caller skips it when nothing would change.
  const daySeg = ({ choices, cur, label, key, onpick }) => h("span", { class: "dayseg" }, h("span", { class: "sub" }, "Whole day"),
    h("span", { class: "seg", role: "group", "aria-label": `Mark all of ${label}` },
      choices.map((c) => h("button", { class: `${c.cls}${cur === c.s ? " on" : ""}`, "data-s": c.s, "data-key": key ? `${key}-${c.s}` : null, "aria-pressed": String(cur === c.s), title: `Whole day: ${c.tip}`, "aria-label": `${c.label}: every hour of ${label}`, onclick: () => onpick(c.s) }, c.letter))));
  // The one choice every row shares, or null.
  const sharedOf = (vals) => (vals.length && vals.every((v) => v === vals[0]) ? vals[0] : null);
  const absentDays = (rows, opts) => {
    const groups = [];
    for (const r of rows) { // the portal lists them newest first, so a day's rows are next to each other
      let g = groups[groups.length - 1];
      if (!g || g.date !== r.date) groups.push((g = { date: r.date, label: niceDate(`${r.date} ${r.day}`), rows: [] }));
      g.rows.push(r);
    }
    return groups.map((g) => {
      const hrs = h("span", { class: "sub" }, `${fmt(g.rows.reduce((n, r) => n + r.h, 0))}h`);
      const free = opts && opts.on ? g.rows.filter((r) => r.kind === "abs" && opts.canMark(r)) : [];
      const head = free.length > 1 && opts.pickDay
        ? h("div", { class: "pday mk" }, h("span", {}, h("b", {}, g.label), " ", hrs),
            daySeg({ choices: opts.choices, cur: sharedOf(free.map(opts.selOf)), label: g.label, key: `mkd-${g.date}`, onpick: (s) => { if (free.some((r) => opts.selOf(r) !== s)) opts.pickDay(free, s); } }))
        : h("div", { class: "pday" }, h("b", {}, g.label), hrs);
      return [
      head,
      g.rows.map((r) => {
        const sel = opts && r.kind === "abs" ? opts.selOf(r) : "abs";
        const when = `${niceDate(`${r.date} ${r.day}`)}, ${nicePeriod(r.period)}`;
        const cell = opts && opts.on && r.kind === "abs" && opts.canMark(r)
          ? h("span", { class: "seg", role: "group", "aria-label": `Mark ${when}` },
              opts.choices.map((c) => h("button", { class: `${c.cls}${sel === c.s ? " on" : ""}`, "data-key": `mk-${r.date}-${r.period}-${c.s}`, "aria-pressed": String(sel === c.s), title: c.tip, "aria-label": `${c.label}: ${when}`, onclick: () => { if (sel !== c.s) opts.pick(r, c.s); } }, c.letter)))
          : sel !== "abs" ? chip(...MARKED[sel]) : chip(KIND[r.kind][0], KIND[r.kind][1]);
        return h("div", { class: `arow${opts && opts.on ? " mk" : ""}` }, h("span", {}, nicePeriod(r.period)), h("span", { class: "pt" }, startTime(r.time)), h("span", { class: "ac", title: r.name }, h("b", {}, r.code), r.name ? h("small", {}, r.name) : null), cell);
      }),
      ];
    });
  };


  // Guided tour: dims everything but one element per step, with a card saying what it is (Back / Next / Skip, Done at the end).
  // steps: [{ target?: () => Element|null, title, text, before?: () => void|Promise }]. `text` is a string or an array of strings and nodes. No `target` = a centred card.
  // A step whose target function returns null is skipped. `mount` is where the overlay lives: document.body in the popup,
  // the shadow root on CUE (outside #app / .dock, so the caller's redraws don't remove it). Call refresh() after a redraw.
  // A step with `next: { label, run }` shows that label instead of Next/Done; clicking it ends the tour (completed) and runs it.
  // onEnd(completed) runs once, on Done (true) or Skip / Escape (false).
  const tour = ({ mount, steps, onEnd }) => {
    let i = -1, target = null, live = true, busy = false;
    const hole = h("div", { class: "tour-hole" });
    const count = h("span", { class: "tour-n", "aria-live": "polite" });
    const prog = h("div", { class: "tour-prog", "aria-hidden": "true" }, ...steps.map(() => h("i")));
    const title = h("div", { class: "h3" });
    const text = h("p", { class: "sub" });
    const back = h("button", { class: "btn sm", onclick: () => go(-1) }, "Back");
    const advance = () => { const a = steps[i]?.next; if (a) { end(true); a.run(); } else go(1); };
    const next = h("button", { class: "btn solid sm", onclick: advance }, "Next");
    const card = h("div", { class: "tour-card", role: "dialog", "aria-modal": "true", "aria-label": "Quick tour" },
      count, prog, title, text,
      h("div", { class: "tour-act" }, h("button", { class: "link", onclick: () => end(false) }, "Skip tour"), h("span", { class: "tour-btns" }, back, next)));
    const root = h("div", { class: "tour cue" }, h("div", { class: "tour-block" }), hole, card);
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    function place() {
      if (!live) return;
      const vw = window.innerWidth, vh = window.innerHeight, pad = 6, gap = 12, edge = 16;
      const r = target && target.isConnected ? target.getBoundingClientRect() : null;
      const box = r ? { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 } : { x: vw / 2, y: vh / 2, w: 0, h: 0 };
      Object.assign(hole.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
      hole.classList.toggle("none", !r);
      const cw = card.offsetWidth, ch = card.offsetHeight;
      let top;
      if (!r) top = (vh - ch) / 2;
      else if (box.y + box.h + gap + ch <= vh - edge) top = box.y + box.h + gap; // below
      else if (box.y - gap - ch >= edge) top = box.y - gap - ch; // above
      else top = vh - edge - ch; // no room either side: keep it on screen
      const left = r ? box.x + box.w / 2 - cw / 2 : (vw - cw) / 2;
      card.style.left = `${Math.round(Math.min(vw - edge - cw, Math.max(edge, left)))}px`;
      card.style.top = `${Math.round(Math.max(edge, top))}px`;
    }

    // Re-place every frame for ~1s after a step starts, so a drawer or dock that is still animating can't leave the box offset.
    let followId = 0;
    function follow() {
      const id = ++followId, until = performance.now() + 1000;
      const tick = () => { if (!live || id !== followId) return; place(); if (performance.now() < until) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }

    async function go(d) {
      if (busy || !live) return;
      busy = true;
      let j = i + d;
      for (; j >= 0 && j < steps.length; j += d || 1) {
        const s = steps[j];
        await s.before?.();
        if (!live) return;
        await frame();
        const t = s.target ? s.target() : null;
        if (s.target && !t) continue; // not on screen right now: skip it
        target = t;
        break;
      }
      busy = false;
      if (j >= steps.length) return end(true);
      if (j < 0) return; // nothing earlier to go back to
      i = j;
      const s = steps[i];
      count.textContent = `${i + 1} of ${steps.length}`;
      [...prog.children].forEach((e, k) => e.classList.toggle("on", k <= i));
      title.textContent = s.title;
      text.replaceChildren(...[s.text].flat());
      back.disabled = i === 0;
      next.textContent = s.next?.label || (i === steps.length - 1 ? "Done" : "Next");
      target?.scrollIntoView({ block: "nearest" });
      place();
      follow(); // the drawer, dock and scrolling may still be moving: keep the box on the target until they settle
      next.focus({ preventScroll: true });
    }

    const onKey = (e) => {
      if (!live) return;
      const inCard = e.composedPath().includes(card);
      if (e.key === "Escape") end(false);
      else if (e.key === "ArrowRight" || (e.key === "Enter" && !inCard)) advance();
      else if (e.key === "ArrowLeft") go(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    function end(completed) {
      if (!live) return;
      live = false;
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      mount.removeEventListener("scroll", place, true);
      root.remove();
      onEnd?.(completed);
    }

    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    mount.addEventListener("scroll", place, true); // the drawer scrolls inside the shadow root, and scroll doesn't cross it
    mount.append(root);
    go(1);
    return { refresh: place, end: () => end(false), get active() { return live; } };
  };

  return { h, diag, eseFlag, semRank, DETAIN, detain, SUSEGAD, susegad, vibeTag, vibeLead, tour, absentSummary, absentDays, daySeg, hrsOf, plural, fmt, tone, dayLabel, niceDate, nicePeriod, startTime, ico, sep, chip, bar, TAGLINE, mustText, breakTag, ABOUT, placeThumb, tween, pills, stepper, toggle, acc };
})();
