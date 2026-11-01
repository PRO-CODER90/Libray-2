# Poornima University Library Entry System

A web-based entry/exit management system for the Poornima University Library. A student or faculty member enters their **enrollment / employee number**; the system looks them up in the database, records the entry, and shows live occupancy and analytics on a home screen.

---

## 1. Goals

- Replace manual registers with a fast, one-field entry flow.
- Auto-fetch the person's details from the database.
- Automatically record entry/exit timestamps.
- Auto-close open sessions at library closing time.
- Derive the library's peak hour from entry data.
- Show live status (occupancy, who is inside, clock, timings) on a display screen.

---

## 2. Data Format (from sample `daily_logs_2026-08-19.xlsx`)

Sheet name: `Daily Logs`

| Column | Example | Notes |
|---|---|---|
| `full_reg_no` | `2026/29917` | Enrollment no. (student) or employee no. (faculty). **Primary lookup key.** |
| `name` | Yuvraj Soni | Auto-fetched |
| `branch` | B.Tech. (Mechanical) | Auto-fetched |
| `year` | FET2026-2027 | Auto-fetched (batch / session) |
| *(blank column E)* | – | Empty in the sample; ignore on import |
| `entry_date` | 2026-08-19 | Auto-filled on entry |
| `entry_time` | 10:42:15 | Auto-filled on entry |
| `exit_date` | | Auto-filled on exit |
| `exit_time` | | Auto-filled on exit |
| `role` | Student / Faculty | Auto-fetched |

**Additional field to add:** `exit_reason`, which is `"DO NOT LOGOUT"` for auto-exited records and blank otherwise (see §3.2).

### Database tables (suggested)

```sql
CREATE TABLE members (
  full_reg_no TEXT PRIMARY KEY,   -- enrollment / employee no.
  name        TEXT NOT NULL,
  branch      TEXT,
  year        TEXT,
  role        TEXT CHECK (role IN ('Student','Faculty'))
);

CREATE TABLE library_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_reg_no TEXT NOT NULL REFERENCES members(full_reg_no),
  entry_date  DATE NOT NULL,
  entry_time  TIME NOT NULL,
  exit_date   DATE,
  exit_time   TIME,
  exit_reason TEXT               -- 'DO NOT LOGOUT' or NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,           -- e.g. opening_time, closing_time
  value TEXT NOT NULL
);
```

The `members` table is loaded from the Excel/university master data. `library_logs` replaces the empty entry/exit columns in the sheet.

---

## 3. Functional Requirements

### 3.1 Entry and auto timestamps
1. User types their enrollment / employee no. and submits.
2. System looks it up in `members`.
3. On match, a new `library_logs` row is created with the current **entry date and time** recorded automatically (server time, never user-entered).
4. If the member already has an open session (no exit yet), submitting their number again is treated as a **manual exit**. The exit date/time is recorded, and `exit_reason` stays **blank**.

### 3.2 Auto-exit at closing time
At the scheduled closing time, a scheduler job runs once and:

| Situation | Action | `exit_reason` |
|---|---|---|
| Member **has not** logged out | Auto-exit with exit date/time = closing time (or job run time) | **`DO NOT LOGOUT`** |
| Member **already** logged out manually | No change | **blank** (never set) |

Rules:
- Only rows where `exit_date IS NULL` are touched.
- The reason is written **only** on auto-exited rows.
- The job must be idempotent. Running it twice must not change anything.

```sql
UPDATE library_logs
SET exit_date = :today, exit_time = :closing_time, exit_reason = 'DO NOT LOGOUT'
WHERE exit_date IS NULL;
```

### 3.3 Peak time detection
- Computed from entry data, with no manual input.
- Group entries by hour of `entry_time`. The hour bucket with the most entries is the **peak time**, shown as a range such as `12:00 – 1:00 PM`.
- Computed for **today** (live) and, if wanted, across all historical logs ("overall peak").
- Ties are broken by the earlier hour.

```sql
SELECT strftime('%H', entry_time) AS hr, COUNT(*) AS entries
FROM library_logs
GROUP BY hr ORDER BY entries DESC, hr ASC LIMIT 1;
```

### 3.4 Pop-up messages
| Case | Pop-up | Type |
|---|---|---|
| Number found (entry) | `"<NAME> Entered"` (e.g. `20070` → **"HERO Entered"**) | Success (green) |
| Number found (manual exit) | `"<NAME> Exited"` | Info |
| Number not found | **"Student/Faculty is not found"** | Error (red) |
| Empty input | "Please enter an enrollment / employee number" | Warning |

Pop-ups auto-dismiss after about 3 seconds, and the input field clears and refocuses for the next person.

### 3.5 Home screen: summary panel
- **People currently in the library** (count of rows where `exit_date IS NULL`)
- **Peak time** (§3.3)
- **Library opening time** and **closing time** (from `settings`)

### 3.6 Home screen: live list and clock
- A live list of **names of everyone currently inside** (with branch/role and entry time). It refreshes without a page reload, via polling every 5 seconds or WebSocket.
- A **live clock** showing time (HH:MM:SS), full **date**, and **day of the week**. The day and date update automatically at midnight.

---

## 4. Non-functional Requirements
- **Speed:** lookup and response in under 1 second.
- **Reliability:** the closing-time job survives restarts (persisted schedule or cron).
- **Time source:** all timestamps come from the server clock (timezone `Asia/Kolkata`).
- **Input handling:** trim whitespace, tolerate `2026/29917` formatting, and keep the field auto-focused for barcode/ID-card scanners.
- **Security:** parameterized queries only, and input validated server-side. An admin area for importing data and changing timings requires login.
- **Display:** responsive, readable on a wall-mounted screen or a kiosk.

---

## 5. Suggested Tech Stack

| Layer | Choice |
|---|---|
| Backend | Python **Flask** (or FastAPI) |
| Database | SQLite (dev) → PostgreSQL/MySQL (production) |
| Scheduler | APScheduler (closing-time job) |
| Frontend | HTML + CSS + JavaScript (or React) |
| Data import | `pandas` / `openpyxl` to load Excel into `members` |

---

## 6. API Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/entry` | Body `{ "reg_no": "..." }`. Entry, or manual exit if a session is open. |
| GET | `/api/status` | Occupancy count, peak time, opening/closing times. |
| GET | `/api/inside` | List of members currently in the library. |
| GET | `/api/peak` | Peak hour details and the hourly histogram. |
| POST | `/api/admin/import` | Upload the Excel member list. |
| GET/PUT | `/api/admin/settings` | Read or update opening/closing time. |
| GET | `/api/admin/export?date=YYYY-MM-DD` | Download daily logs as `daily_logs_<date>.xlsx` in the sample format. |

---

## 7. Screens

**Home / Entry screen**
```
+----------------------------------------------------------+
|  POORNIMA UNIVERSITY LIBRARY        Sunday, 1 Nov 2026   |
|                                          09:21:45 AM     |
+----------------------------------------------------------+
|  Enter Enrollment / Employee No:  [______________] [GO]  |
+----------------------------------------------------------+
|  In Library: 42   | Peak Time: 12-1 PM | Open 8:30 AM    |
|                   |                    | Close 5:00 PM   |
+----------------------------------------------------------+
|  Currently Inside                                        |
|  - Yuvraj Soni    B.Tech. (Mechanical)   10:42 AM        |
|  - Rahul Beniwal  B.Tech. (Mechanical)   10:45 AM        |
+----------------------------------------------------------+
```

**Admin screen:** import members, set timings, view or export logs, and see peak-hour chart.

---

## 8. Daily Workflow
1. **Opening:** the system starts the day with an empty "inside" list.
2. **During the day:** members enter their number → entry or exit is recorded → the home screen updates.
3. **Closing time:** the scheduler auto-exits everyone still inside with reason `DO NOT LOGOUT`.
4. **After closing:** the day's log can be exported in the Excel format above, and the peak-time stats are updated.

---

## 9. Edge Cases
- Number scanned twice within a few seconds: debounce, so it is not mistaken for an exit.
- Member left an open session from a previous day: the auto-exit job, or a start-of-day cleanup, closes it with `DO NOT LOGOUT`.
- Entry after closing time: reject with the message "Library is closed".
- Duplicate or malformed numbers in the import file: report them and skip the rows.

---

## 10. Acceptance Criteria
- [ ] Valid number shows `"<NAME> Entered"` and creates a log row with the correct auto entry date/time.
- [ ] Invalid number shows `"Student/Faculty is not found"` and creates no log row.
- [ ] At closing time, only still-open sessions are closed, with `exit_reason = "DO NOT LOGOUT"`.
- [ ] Manually logged-out members have a blank `exit_reason`.
- [ ] Peak time matches the hour with the most entries.
- [ ] Home screen shows count, peak time, opening and closing time, names inside, and a live clock with the day and date.
- [ ] Day and date roll over correctly at midnight.
