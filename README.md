# Poornima University Library Entry System

Entry/exit kiosk for the library. A student or faculty member scans or types their
enrollment / employee number; the system records entry or exit, auto-exits everyone
still inside at closing time (`exit_reason = DO NOT LOGOUT`), and shows live occupancy,
peak time and a clock on the home screen.

Stack: Node.js + Express, built-in `node:sqlite`, plain HTML/CSS/JS.

## Run

Requires **Node.js 22.13+**.

```
npm install
npm start
```

On Windows, double-click `start.bat`.

- Home screen: http://localhost:5000
- Admin panel: http://localhost:5000/admin.html (default `admin` / `admin123`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `DB_FILE` | `data/library.db` | SQLite database file |
| `ADMIN_USER` | `admin` | Admin username |
| `ADMIN_PASSWORD` | `admin123` | Admin password, **change this** |

## Load test data

Drag a member file such as `daily_logs_2026-08-19.xlsx` onto `seed.bat`, or run:

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
