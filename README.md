# Gradescope DueDates Planner

Gradescope DueDates Planner is a Manifest V3 Chrome extension that opens a side panel on Gradescope, scans the logged-in user's course pages, caches assignments in `chrome.storage.local`, and shows them in compact Todo and Calendar views.

## What It Does

- Opens automatically on Gradescope tabs and closes when you leave Gradescope.
- Collects assignments by visiting real Gradescope course pages instead of relying only on the homepage.
- Normalizes assignment fields such as title, course name, due date, status, points, and direct URL when available.
- Keeps Todo and Calendar views in sync with search, course filters, and urgency chips.
- Groups unfinished work into planner sections like Due Today, Due Tomorrow, Due This Week, Later, Overdue, and No Due Date.
- Caches the latest scrape in local extension storage and refreshes automatically when the cache is stale or on first use.
- Handles Gradescope assignment rows that may not have a normal assignment link yet, including future `No Submission` items.

## Files

- `manifest.json`: Chrome extension configuration.
- `service-worker.js`: side panel opening, cache management, and course-by-course scraping orchestration.
- `content-scripts/gradescope.js`: defensive Gradescope parser for dashboard pages and course assignment pages.
- `sidepanel.html`: side panel markup.
- `sidepanel.css`: compact light side-panel styling.
- `sidepanel.js`: calendar, filters, grouped assignment rendering, and UI messaging.
- `icons/`: SVG placeholder artwork used inside the side panel.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select this folder: `/Users/aweso/Desktop/projects/GradeScope Extension`
5. Pin the extension if you want quicker access from the toolbar.

## Test

1. Log into [Gradescope](https://www.gradescope.com/) in Chrome.
2. Open the normal Gradescope dashboard so your course cards are visible.
3. Switch to a Gradescope tab and the side panel should open on the right automatically.
4. Press **Refresh** if you want to force a new scan immediately.
6. Confirm that:
   - the calendar shows due-date counts on the correct days
   - the Todo and Calendar views respond to the same search and filters
   - the course dropdown lists your Gradescope courses
   - assignments appear in grouped sections
   - clicking an assignment opens the correct Gradescope page when a direct URL exists
   - refreshing updates the "Last updated" timestamp

## Notes

- The extension uses only `storage`, `tabs`, `sidePanel`, and host access to `https://www.gradescope.com/*`.
- Some Gradescope pages vary by course type or account state. The scraper uses fallback selectors, table parsing, and partial-success handling so one course failure does not block the rest.
- If a course page does not expose a visible due date, the assignment is still shown under **No Due Date** when possible.

## Troubleshooting

- If the panel says login is required, open Gradescope in a normal tab and confirm you are signed in.
- If no courses are found, refresh the Gradescope homepage first and try again.
- If only some courses appear, the banner will note that partial results were saved; try Refresh again while those course pages are accessible.
- If the side panel does not open from the toolbar icon, reload the extension once from `chrome://extensions` and try again.
