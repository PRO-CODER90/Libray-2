// Entry Analytics charts (Chart.js), each with a "Show as table" fallback.
const COLORS = {
  navy: '#10244F', gold: '#F5B800', blue: '#3B6FD8', pink: '#E5649B', grey: '#B9C3D6', green: '#2E9E6A',
};
const charts = {};

if (window.Chart) {
  Chart.defaults.font.family = 'Roboto, "Segoe UI", system-ui, sans-serif';
  Chart.defaults.color = '#5A6785';
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
}

function drawChart(name, config, table) {
  const card = document.querySelector(`.chart-card[data-chart="${name}"]`);
  charts[name]?.destroy();
  if (window.Chart) charts[name] = new Chart(card.querySelector('canvas'), config);
  const head = el('tr', {}, ...table.head.map((h) => el('th', { textContent: h })));
  const body = table.rows.map((r) => el('tr', {}, ...r.map((c) => el('td', { textContent: c ?? '' }))));
  card.querySelector('.chart-table').replaceChildren(el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-table');
  if (!btn) return;
  const card = btn.closest('.chart-card');
  const showTable = card.querySelector('.chart-table').hidden;
  card.querySelector('.chart-table').hidden = !showTable;
  card.querySelector('.chart-box').hidden = showTable;
  btn.textContent = showTable ? 'Show as chart' : 'Show as table';
});

function renderAnalytics(data) {
  const { series, range } = data;
  const period = range.period;
  const peakIndex = series.reduce((best, s, i) => (s.entries > series[best].entries ? i : best), 0);
  const labels = series.map((s) => s.label);
  const titles = { day: 'Entries per hour', week: 'Entries per day', month: 'Entries per day of the month' };
  document.getElementById('an-main-title').textContent = titles[period];

  const integerY = { beginAtZero: true, ticks: { precision: 0 } };
  drawChart('main', period === 'month'
    ? {
      type: 'line',
      data: { labels, datasets: [{ label: 'Entries', data: series.map((s) => s.entries), borderColor: COLORS.navy, backgroundColor: 'rgba(16,36,79,.12)', fill: true, tension: .3, pointRadius: 3 }] },
      options: { maintainAspectRatio: false, scales: { y: integerY }, plugins: { legend: { display: false } } },
    }
    : {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Entries', data: series.map((s) => s.entries), backgroundColor: series.map((s, i) => (i === peakIndex && s.entries ? COLORS.gold : COLORS.navy)), borderRadius: 6 }] },
      options: { maintainAspectRatio: false, scales: { y: integerY }, plugins: { legend: { display: false } } },
    }, { head: [period === 'day' ? 'Hour' : 'Day', 'Entries'], rows: series.map((s) => [s.range || s.label, s.entries]) });

  drawChart('role', {
    type: 'doughnut',
    data: { labels: ['Students', 'Faculty'], datasets: [{ data: [data.by_role.Student, data.by_role.Faculty], backgroundColor: [COLORS.navy, COLORS.gold], borderWidth: 0 }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom' } } },
  }, { head: ['Role', 'Entries'], rows: [['Students', data.by_role.Student], ['Faculty', data.by_role.Faculty]] });

  drawChart('exits', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Manual exit', data: series.map((s) => s.manual), backgroundColor: COLORS.blue },
        { label: 'AUTO-LOGOUT', data: series.map((s) => s.auto), backgroundColor: COLORS.pink },
        { label: 'Still inside', data: series.map((s) => s.inside), backgroundColor: COLORS.grey },
      ],
    },
    options: { maintainAspectRatio: false, scales: { x: { stacked: true }, y: { ...integerY, stacked: true } }, plugins: { legend: { position: 'bottom' } } },
  }, { head: [period === 'day' ? 'Hour' : 'Day', 'Manual exit', 'AUTO-LOGOUT', 'Still inside'], rows: series.map((s) => [s.range || s.label, s.manual, s.auto, s.inside]) });

  drawChart('branch', {
    type: 'bar',
    data: { labels: data.by_branch.map((b) => b.branch), datasets: [{ label: 'Entries', data: data.by_branch.map((b) => b.entries), backgroundColor: COLORS.navy, borderRadius: 6 }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, scales: { x: integerY }, plugins: { legend: { display: false } } },
  }, { head: ['Branch', 'Entries'], rows: data.by_branch.map((b) => [b.branch, b.entries]) });
}
