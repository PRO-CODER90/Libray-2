# Poornima University Library Entry System

Entry/exit kiosk for the library. A student or faculty member scans or types their
enrollment / employee number; the system records entry or exit, auto-exits everyone
still inside at closing time (`exit_reason = DO NOT LOGOUT`), and shows live occupancy,
peak time and a clock on the home screen.

Stack: Node.js + Express, SQLite, plain HTML/CSS/JS.

The same code runs in two modes:

| Mode | Database | Use |
|---|---|---|
| Offline (`start.bat`) | Local SQLite file `data/library.db` | Final click-and-run setup on the library PC |
| Online (Vercel) | [Turso](https://turso.tech), hosted SQLite | Testing phase |

## Run

Requires **Node.js 22.13+**.

```
npm install
npm start
```

On Windows, double-click `start.bat`. It checks Node.js, installs dependencies on first run,
starts the server and opens the browser. Close the "Library Server" window to stop it.

- Home screen: http://localhost:5000
- Admin panel: http://localhost:5000/admin.html (default `admin` / `admin123`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `DB_FILE` | `data/library.db` | SQLite database file |
| `ADMIN_USER` | `admin` | Admin username |
| `ADMIN_PASSWORD` | `admin123` | Admin password, **change this** |
| `TURSO_DATABASE_URL` | – | Use Turso instead of the local file |
| `TURSO_AUTH_TOKEN` | – | Turso token |
| `SESSION_SECRET` | derived from admin login | Signs admin login cookies |
| `CRON_SECRET` | – | Protects `/api/cron/auto-exit` |

## Deploy to Vercel (testing phase)

1. Create a database at [turso.tech](https://turso.tech) and copy its URL (`libsql://...`) and an auth token.
2. On [vercel.com](https://vercel.com), import this GitHub repo. No build settings needed; `vercel.json` covers them.
3. In the Vercel project, under **Settings → Environment Variables**, add `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, `ADMIN_PASSWORD`, and a random `CRON_SECRET`. Redeploy.
4. Load members from the admin panel, or from your PC with the Turso variables set:
   `npm run seed -- daily_logs_2026-08-19.xlsx`.

Auto-exit runs whenever the home screen polls (every 5 s), plus a daily Vercel Cron at 11:59 PM IST.

## Switch back to offline SQLite (final setup)

1. Run `start.bat pull` from a command prompt and paste the Turso URL and token. It copies all members, logs and
   timings into `data/library.db` (`npm run pull-db` does the same).
2. Double-click `start.bat`. The app now runs fully offline on the local SQLite file.

## Load test data

Drag a member file such as `daily_logs_2026-08-19.xlsx` onto `start.bat`, or run:

```
npm run seed -- daily_logs_2026-08-19.xlsx
npm run seed -- daily_logs_2026-08-19.xlsx --demo-logs 2026-08-19   # also add sample visits
npm run seed -- daily_logs_2026-08-19.xlsx --reset                  # wipe members and logs first
```

`--demo-logs` adds random visits on that date, some left open, so peak time,
auto-exit and the CSV report can be tested. Use `--reset` before going live.

## Admin

- **Import members** from `.xlsx` or `.csv` with columns `full_reg_no, name, branch, year, role`
  (the `Daily Logs` sheet format works as is). Bad or duplicate rows are skipped and listed.
- **Timings**: set opening and closing time.
- **Daily logs**: view any date and download it as `daily_logs_<date>.csv`.
- **Entries by hour** chart with the peak hour highlighted.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/entry` | `{ "reg_no": "..." }`: entry, or exit if already inside |
| GET | `/api/status` | Occupancy, peak time, timings |
| GET | `/api/inside` | Members currently inside |
| GET | `/api/peak?date=YYYY-MM-DD\|overall` | Peak hour and hourly histogram |
| POST | `/api/admin/import` | Raw file body, `X-Filename` header |
| GET/PUT | `/api/admin/settings` | Opening / closing time |
| GET | `/api/admin/logs?date=` | Logs for a date |
| GET | `/api/admin/export?date=` | CSV report |

## Tests

```
npm test
```
