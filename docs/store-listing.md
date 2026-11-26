# Chrome Web Store listing (copy to paste into the developer dashboard)

## Name
leavemealone

## Summary (132 chars max; comes from `description` in extension/manifest.json, so it changes with a new package)
Your real CUE attendance, with co-curricular and medical hours counted, and where you stand for MSE and ESE. Unofficial.

## Description
Unofficial. Not affiliated with CHRIST (Deemed to be University) or the ESPro / CUE portal.

leavemealone reads your attendance on the CUE portal and shows you exactly where you stand. Mark the hours you spent on co-curricular activities or medical leave, and see your attendance with them counted, per course and overall.

• Actual attendance: the portal's numbers plus the hours you mark as co-curricular or medical
• Medical leave counted the way the university's policy says (74.5% to 85% overall)
• Where you stand for MSE (75% in every course) and ESE (85% overall), with countdowns
• Mark absent hours one at a time, or a whole day at once
• Flags hours the portal has since updated, so nothing is counted twice
• Plan ahead: see how a day off would change each course before you take it
• Toolbar popup with your numbers and the next holidays
• Optional daily alert when a course gets close to the line
• Separate profiles if friends log in on the same browser

We don't promote bunking. Just accurate attendance.

Private by design: everything stays in your browser. No account, no analytics, nothing is sent anywhere.

Free and open source: https://github.com/antiiiiny/leavemealone
Developed by Alicia & Antony Co.

## Category
Productivity (or Education)

## Single purpose
Shows CUE portal users their attendance, including co-curricular and medical hours they mark, and where they stand against the university's attendance requirements, from the portal pages they open.

## Permission justifications
- storage: saves the attendance numbers, marks, timetable and settings locally in the browser so the popup and alerts work without reopening the portal.
- alarms: schedules the once-a-day attendance check.
- notifications: shows the optional daily low-attendance alert.
- Host permission (https://cue.christuniversity.in/*): reads the attendance, absence and timetable pages the user opens on the portal and shows the calculator on them. No other site is accessed.

## Remote code
No, all code is bundled.

## Data usage (privacy tab)
- Tick: "Personally identifiable information" (first name, for profile labels) and "Website content" (attendance data from the portal).
- Certify: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used for creditworthiness or lending.
- Privacy policy URL: https://github.com/antiiiiny/leavemealone/blob/main/PRIVACY.md

## Assets
- Icon 128×128: extension/icons/icon-128.png
- Screenshots 1280×800 (3–5), invented data only, never a real student's page
- Small promo tile 440×280
