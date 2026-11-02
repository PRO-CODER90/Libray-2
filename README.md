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

Put local settings in a `.env` file next to `server.js` (it is not committed), e.g. `ADMIN_PASSWORD=...`.
On Windows, `start.bat` asks for the admin password on first run and creates it.

On Windows, double-click `start.bat`. It checks Node.js, installs dependencies on first run,
starts the server and opens the browser. Close the "Library Server" window to stop it.

- Home screen: http://localhost:5000
- Admin panel: http://localhost:5000/admin.html

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `DB_FILE` | `data/library.db` | SQLite database file |
| `ADMIN_USER` | `PU01A` | Admin ID |
| `ADMIN_PASSWORD` | – | Admin password (required for admin login) |
| `ADMIN_PASSWORD_HASH` | – | Alternative to `ADMIN_PASSWORD`, as `scrypt:<salt>:<hash>` |
| `TURSO_DATABASE_URL` | – | Use Turso instead of the local file |
| `TURSO_AUTH_TOKEN` | – | Turso token |
| `SESSION_SECRET` | derived from admin login | Signs admin login cookies |
| `CRON_SECRET` | – | Protects `/api/cron/auto-exit` |

## Home page images

`public/assets/` holds the building photo (`campus.jpg`), the university logo (`logo.png`) and the
partner logo (`partner.png`). Replace any of them with a higher-resolution file of the same name.

## Deploy to Vercel (testing phase)

1. Create a database at [turso.tech](https://turso.tech) and copy its URL (`libsql://...`) and an auth token.
2. On [vercel.com](https://vercel.com), import this GitHub repo. No build settings needed; `vercel.json` covers them.
3. In the Vercel project, under **Settings → Environment Variables**, add `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, `ADMIN_USER`, `ADMIN_PASSWORD` and a random `CRON_SECRET`. Redeploy.
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

## Admin panel

Sidebar sections after login:

| Section | What it does |
|---|---|
| Dashboard | Live clock (synced to the server, IST), people inside, entries today, peak hour, timings |
| Entry Analytics | Day / week / month charts: entries, students vs faculty, manual exits vs auto-logouts, top branches, plus a table view |
| Reports | Excel or CSV for a day, week (Mon–Sun) or month; Daily Logs layout; Reason `DO NOT LOGOUT` only on visits the system closed; optional email to the admin |
| Share Report | Saved recipient list; send by email (summary only or full detail), download, Gmail draft, or the device share sheet |
| Backups | Daily automatic backup after closing time and **Backup now**; kept 30 days; download and restore (asks for the password, takes a safety backup first) |
| Members & Settings | Import members, library timings, daily logs |
| Contact Developer | Developer details (from `DEV_*` settings) and a form that posts to Formspree |
| Security & Privacy | Change password, privacy policy, audit log (90 days) |

Security: 5 failed logins in 15 minutes lock the ID and IP for 15 minutes; sessions end after 20 idle minutes or 8 hours, and logout or a password change revokes old sessions; security headers (CSP, frame blocking, no-sniff, HSTS on HTTPS); admin calls need an `X-Requested-With` header; `/api/inside` returns no registration numbers; the server listens on this PC only unless `HOST=0.0.0.0`.

### More settings (`.env` offline, Environment Variables on Vercel)

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL` | Where reports go |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Email sending. For Gmail: `smtp.gmail.com`, `465`, and an App Password |
| `AUTO_REPORTS=1` | Email yesterday's report each morning, last week's on Monday, last month's on the 1st |
| `BACKUP_KEEP_DAYS` | Days of backups to keep (default 30) |
| `BACKUP_DIR` | Backup folder offline (default `data/backups`) |
| `ADMIN_ALLOWED_IPS` | Comma-separated IPs allowed into the admin area |
| `HOST` | `0.0.0.0` to allow other PCs on the network (default this PC only) |
| `DEV_NAME`, `DEV_EMAIL`, `DEV_PHONE`, `DEV_HOURS`, `DEV_RESPONSE`, `DEV_ROLE` | Contact Developer card |

Offline backups live in `data/backups/`; copy that folder to a USB drive or cloud folder regularly.

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
| GET | `/api/admin/export?date=` | Quick daily CSV |
| GET | `/api/admin/analytics?period=&date=` | Chart data |
| GET | `/api/admin/report?period=&date=&format=` | Report download |
| POST | `/api/admin/report/email`, `/api/admin/report/share` | Email a report |
| GET/POST/PUT/DELETE | `/api/admin/recipients` | Share list |
| GET/POST | `/api/admin/backups`, `/api/admin/backups/:name`, `.../restore` | Backups |
| GET | `/api/admin/audit` | Audit log |
| POST | `/api/admin/password` | Change password |

## Tests

```
npm test
```
