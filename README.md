# leavemealone

leavemealone is an extension that reads your attendance portal and shows you exactly where you stand. 100+ students tried it in the first 2 days.

Nothing leaves your browser, and it's completely free (unless you feel generous enough to contribute to keep it going).

**We don't promote bunking. Just accurate attendance.**

> **Unofficial.** Not affiliated with, endorsed by, or connected to CHRIST (Deemed to be University) or the ESPro / CUE portal. The numbers here are estimates; the portal is always the source of truth.

## Get it

**Chrome:** search **"leavemealone"** on the [Chrome Web Store](https://chromewebstore.google.com/detail/leavemealone/komhapklhkoicjaklcanacmnfgcffceb) (yes, it is a fred again reference). One click, and it updates itself.

**Edge, or the latest build before the store has it:** install from the ZIP.
1. Download [leavemealone.zip](https://github.com/antiiiiny/leavemealone/releases/latest/download/leavemealone.zip) and unzip it. The `leavemealone` folder is the whole extension.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and choose that folder.
4. To update later: download the ZIP again, replace the folder, and press the reload icon on the extension's card.

**First run:** log in to the CUE portal and open **Attendance**. A small pill with your percentage appears at the bottom right; click it. The quick tour starts, and its last step opens your Timetable once so the extension has everything it needs.

## What it does

- **Where you stand.** Every course and your overall, from the portal's numbers plus the hours you mark, to two decimals like the portal.
- **Can bunk N, or attend next N.** For every course and the overall, against your own minimum.
- **Put a bunk.** Pick days on a calendar, see what they cost, and get the best days to bunk. Your plan is saved and never touches your real numbers.
- **Mark absent hours.** Absent, Co-curricular, Medical or Later, one hour at a time or a whole day, on the all-courses page and on each course's own page.
- **Add what the portal missed.** Extra classes it hasn't counted yet go in by hand.
- **MSE and ESE plans.** MSE needs 75% in every course; ESE needs 85% overall (you can set your own target).
- **Slang tags.** pakka detain, eda mone, mastundhi, susegad: one word beside every number. Hover one to see what it means.
- **Toolbar popup.** The same numbers, exam countdowns, best days to bunk and the holiday list.
- **Daily alert.** A nudge when a course gets low (you can turn it off), and a warning when your data is over 3 days old.
- **Profiles.** Friends who log in on the same browser each get their own.
- **Backup.** Export everything to a file, import it on a new browser.

Every rule behind the maths is in [docs/attendance_rules.md](docs/attendance_rules.md).

## Privacy

Full policy: [PRIVACY.md](PRIVACY.md).

- **Everything stays in your browser** (`chrome.storage.local`).
- **No requests to any server.** It only loads its own bundled stylesheet and font.
- **It only runs on** `https://cue.christuniversity.in/*`.
- **Profiles** are picked by the name the portal shows; only the first name is kept, as the label.

| Permission | Why |
|---|---|
| `https://cue.christuniversity.in/*` | Read the attendance table and Absent Details page you are viewing |
| `storage` | Keep your last snapshot, marks and settings locally |
| `alarms` | Run the once-a-day low-attendance check |
| `notifications` | Show that alert |

## Support and contribute

It's free and stays free. If it saved your attendance:
- **Chip in.** The UPI QR is on the extension's welcome page (toolbar popup, Help & support, Chip in).
- **Build it with us.** Star the repo, send a fix, or read [CONTRIBUTING.md](CONTRIBUTING.md).
- **Something off?** Use the form on the welcome page (Help & support, Report a bug) or [open an issue](https://github.com/antiiiiny/leavemealone/issues). Skip your name and real numbers.

The most useful contributions:
- **Portal changes.** The portal's markup can change, so selector fixes matter most.
- **New academic years.** Add an entry to `YEARS` in `extension/calendar.js` (holidays, vacations, MSE and ESE dates, working Saturdays) from the university's public calendar PDF.
- **Other browsers, fonts and screen sizes.** Testing and fixes.

## For developers

- `extension/content.js` parses the portal tables and draws the UI inside a Shadow DOM, so the portal's CSS can't interfere.
- `extension/calc.js` and `extension/plan.js` hold the pure maths; `extension/calendar.js` the academic calendar.
- `extension/popup.*` is the toolbar popup, `extension/background.js` the daily alert, `extension/welcome.*` the about page.
- Plain JS, no build step, no dependencies. Check with `node --check extension/*.js`; `calc.js`, `calendar.js` and `plan.js` also load from Node for quick tests.
- How it all fits together: [CLAUDE.md](CLAUDE.md).

**Ground rules**
- **Never commit real portal pages or screenshots.** They contain a student's name and attendance. Anonymise or invent the data first.
- Keep it dependency-free and buildless unless there's a clear need.
- The extension makes no network requests; our privacy promise depends on it.

---

Developed by **Alicia & Antony Co.** · MIT, see [LICENSE](LICENSE).
