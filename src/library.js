const { transaction, getSettings } = require('./db');
const { dateStr, timeStr, toFullTime, hourRangeLabel } = require('./time');

const AUTO_EXIT_REASON = 'DO NOT LOGOUT';
// A second scan within this window is treated as an accidental double scan.
const DEBOUNCE_SECONDS = 10;

function normalizeRegNo(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/\s+/g, '').toUpperCase();
}

function isValidRegNo(regNo) {
  return /^[A-Z0-9][A-Z0-9/_-]{0,39}$/.test(regNo);
}

function isOpenAt(settings, time) {
  return time >= toFullTime(settings.opening_time) && time < toFullTime(settings.closing_time);
}

function secondsBetween(date, time, now) {
  return (now.getTime() - new Date(`${date}T${time}`).getTime()) / 1000;
}

// Closes every session that should no longer be open. Safe to run any number
// of times: it only touches rows whose exit_date is still NULL.
function runAutoExit(db, now = new Date()) {
  const settings = getSettings(db);
  const closing = toFullTime(settings.closing_time);
  const today = dateStr(now);

  return transaction(db, () => {
    // Sessions left open from a previous day close at that day's closing time.
    const stale = db.prepare(`
      UPDATE library_logs
      SET exit_date = entry_date, exit_time = max(entry_time, ?), exit_reason = ?
      WHERE exit_date IS NULL AND entry_date < ?
    `).run(closing, AUTO_EXIT_REASON, today);

    let todayClosed = 0;
    if (timeStr(now) >= closing) {
      todayClosed = db.prepare(`
        UPDATE library_logs
        SET exit_date = ?, exit_time = max(entry_time, ?), exit_reason = ?
        WHERE exit_date IS NULL AND entry_date = ?
      `).run(today, closing, AUTO_EXIT_REASON, today).changes;
    }
    return Number(stale.changes) + Number(todayClosed);
  });
}

// Handles one scan: entry, or manual exit when a session is already open.
// Returns { status, type, message, ... } where status is the HTTP status.
function recordScan(db, rawRegNo, now = new Date()) {
  const regNo = normalizeRegNo(rawRegNo);
  if (!regNo) {
    return { status: 400, type: 'warning', message: 'Please enter an enrollment / employee number' };
  }
  if (!isValidRegNo(regNo)) {
    return { status: 404, type: 'error', message: 'Student/Faculty is not found' };
  }

  // Close anything left over from earlier days before deciding entry vs exit.
  runAutoExit(db, now);

  return transaction(db, () => {
    const member = db.prepare('SELECT * FROM members WHERE full_reg_no = ?').get(regNo);
    if (!member) {
      return { status: 404, type: 'error', message: 'Student/Faculty is not found' };
    }

    const today = dateStr(now);
    const time = timeStr(now);
    const last = db.prepare(
      'SELECT * FROM library_logs WHERE full_reg_no = ? ORDER BY id DESC LIMIT 1'
    ).get(regNo);

    if (last) {
      const lastAt = last.exit_date
        ? secondsBetween(last.exit_date, last.exit_time, now)
        : secondsBetween(last.entry_date, last.entry_time, now);
      if (lastAt >= 0 && lastAt < DEBOUNCE_SECONDS) {
        return {
          status: 200, type: 'info', action: 'ignored', member,
          message: `${member.name} already recorded`,
        };
      }
    }

    if (last && last.exit_date === null) {
      db.prepare('UPDATE library_logs SET exit_date = ?, exit_time = ? WHERE id = ?')
        .run(today, time, last.id);
      return { status: 200, type: 'info', action: 'exit', member, message: `${member.name} Exited` };
    }

    if (!isOpenAt(getSettings(db), time)) {
      return { status: 403, type: 'error', message: 'Library is closed' };
    }

    db.prepare('INSERT INTO library_logs (full_reg_no, entry_date, entry_time) VALUES (?, ?, ?)')
      .run(regNo, today, time);
    return { status: 201, type: 'success', action: 'entry', member, message: `${member.name} Entered` };
  });
}

function listInside(db) {
  return db.prepare(`
    SELECT m.full_reg_no, m.name, m.branch, m.year, m.role, l.entry_date, l.entry_time
    FROM library_logs l JOIN members m ON m.full_reg_no = l.full_reg_no
    WHERE l.exit_date IS NULL
    ORDER BY l.entry_date DESC, l.entry_time DESC, l.id DESC
  `).all();
}

function insideCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM library_logs WHERE exit_date IS NULL').get().n;
}

// Entries per hour; date = null means across all logs.
function hourlyHistogram(db, date = null) {
  const rows = date
    ? db.prepare(`
        SELECT CAST(substr(entry_time, 1, 2) AS INTEGER) AS hr, COUNT(*) AS entries
        FROM library_logs WHERE entry_date = ? GROUP BY hr`).all(date)
    : db.prepare(`
        SELECT CAST(substr(entry_time, 1, 2) AS INTEGER) AS hr, COUNT(*) AS entries
        FROM library_logs GROUP BY hr`).all();
  const counts = new Array(24).fill(0);
  for (const r of rows) counts[r.hr] = Number(r.entries);
  return counts;
}

// Busiest hour; ties go to the earlier hour. null when there are no entries.
function peakFromHistogram(counts) {
  let best = -1;
  for (let h = 0; h < 24; h++) {
    if (counts[h] > 0 && (best === -1 || counts[h] > counts[best])) best = h;
  }
  if (best === -1) return null;
  return { hour: best, entries: counts[best], label: hourRangeLabel(best) };
}

function peakInfo(db, date) {
  const histogram = hourlyHistogram(db, date);
  return { date, peak: peakFromHistogram(histogram), histogram };
}

function logsForDate(db, date) {
  return db.prepare(`
    SELECT l.full_reg_no, m.name, m.branch, m.year, l.entry_date, l.entry_time,
           l.exit_date, l.exit_time, m.role, l.exit_reason
    FROM library_logs l JOIN members m ON m.full_reg_no = l.full_reg_no
    WHERE l.entry_date = ?
    ORDER BY l.entry_time, l.id
  `).all(date);
}

module.exports = {
  AUTO_EXIT_REASON, DEBOUNCE_SECONDS,
  normalizeRegNo, isValidRegNo, isOpenAt,
  runAutoExit, recordScan, listInside, insideCount,
  hourlyHistogram, peakFromHistogram, peakInfo, logsForDate,
};
