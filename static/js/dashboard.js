const chartInstances = {};
const REFRESH_MS = 5000;
const PALETTE = ['#22d3ee', '#818cf8', '#fbbf24', '#f87171', '#34d399', '#f472b6'];

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function tickClock() {
  setText('clock', new Date().toLocaleTimeString('fr-FR'));
}
setInterval(tickClock, 1000);
tickClock();

function setConnectionStatus(ok) {
  const wrap = document.getElementById('conn-status');
  if (!wrap) return;
  wrap.classList.toggle('conn-status--down', !ok);
  setText('conn-label', ok ? 'Données en direct' : 'Connexion perdue');
}

function tankStatusFromAlerts(tank, alerts) {
  const relevant = alerts.filter((a) => a.tank === tank);
  if (relevant.some((a) => a.severity === 'major')) return 'critical';
  if (relevant.some((a) => a.severity === 'minor')) return 'warn';
  return 'ok';
}

async function loadDashboard() {
  try {
    const [dashResp, kpisResp, alertsResp] = await Promise.all([
      fetch('/api/dashboard'),
      fetch('/api/kpis'),
      fetch('/api/alerts'),
    ]);
    if (!dashResp.ok || !kpisResp.ok || !alertsResp.ok) throw new Error('HTTP error');

    const dashboard = await dashResp.json();
    const kpis = await kpisResp.json();
    const alertsPayload = await alertsResp.json();
    const alerts = alertsPayload.alerts || [];

    renderKpis(kpis);
    renderProcessSummary(dashboard.latest_process || {});
    renderAlertPill(alerts);
    renderAlertTicker(alerts);
    renderAlertsPanel(alerts);
    renderTankGrid(dashboard.live_charts?.per_tank || [], kpis.per_tank || [], alerts);

    setConnectionStatus(true);
  } catch (err) {
    console.warn('Erreur de chargement du tableau de bord', err);
    setConnectionStatus(false);
  }
}

function renderKpis(kpis) {
  setText('kpi-tanks', kpis.nombre_cuves ?? '--');
  setText('kpi-sensors', kpis.nombre_capteurs ?? '--');
  setText('kpi-current', kpis.courant_moyen != null ? `${kpis.courant_moyen} A` : '--');
  setText('kpi-temp', kpis.temperature_moyenne != null ? `${kpis.temperature_moyenne} °C` : '--');
}

function renderProcessSummary(process) {
  const recipe = process.recipe_number ?? '--';
  const segment = process.segment_number ?? '--';
  const total = process.total_segments ?? '--';
  const remaining = formatDuration(process.time_remaining);

  setText('kpi-recipe', recipe);
  setText('kpi-segment', `${segment} / ${total}`);
  setText('kpi-remaining', remaining);
  setText('process-summary', `Recette ${recipe} · Segment ${segment}/${total} · ${remaining} restant`);
}

function renderAlertPill(alerts) {
  const pill = document.getElementById('alert-pill');
  if (!pill) return;
  if (alerts.length === 0) {
    pill.hidden = true;
    return;
  }
  const majorCount = alerts.filter((a) => a.severity === 'major').length;
  pill.hidden = false;
  pill.classList.toggle('alert-pill--critical', majorCount > 0);
  setText('alert-pill-count', alerts.length);
}

function renderAlertTicker(alerts) {
  const ticker = document.getElementById('alert-ticker');
  const track = document.getElementById('alert-ticker-track');
  if (!ticker || !track) return;

  if (alerts.length === 0) {
    ticker.hidden = true;
    track.innerHTML = '';
    return;
  }

  const items = alerts
    .slice(0, 8)
    .map((a) => {
      const severity = a.severity || 'info';
      const location = a.tank ? ` (${a.tank})` : '';
      return `<span class="ticker-item ticker-item--${severity}">${severity.toUpperCase()} · ${a.message}${location}</span>`;
    })
    .join('');

  track.innerHTML = items + items;
  ticker.hidden = false;
  ticker.classList.toggle('alert-ticker--critical', alerts.some((a) => a.severity === 'major'));
}

function renderAlertsPanel(alerts) {
  const container = document.getElementById('alerts-list');
  setText('alerts-subtitle', alerts.length ? `${alerts.length} alerte(s) active(s)` : 'Aucune alerte');
  if (!container) return;

  if (alerts.length === 0) {
    container.innerHTML = '<p class="muted">Tout est nominal.</p>';
    return;
  }

  container.innerHTML = alerts
    .map(
      (a) => `
    <div class="alert-row alert-row--${a.severity || 'info'}">
      <strong>${(a.severity || 'info').toUpperCase()}</strong>
      <span>${a.message}</span>
      <span class="muted">${[a.tank, a.sensor].filter(Boolean).join(' · ')}</span>
    </div>`
    )
    .join('');
}

function renderTankGrid(tankViews, tankStats, alerts) {
  const grid = document.getElementById('tank-grid');
  if (!grid) return;

  const statsByTank = Object.fromEntries((tankStats || []).map((t) => [t.tank, t]));

  if (tankViews.length === 0) {
    grid.innerHTML = '<p class="muted">Aucune cuve disponible.</p>';
    return;
  }

  grid.innerHTML = tankViews
    .map((view) => {
      const stats = statsByTank[view.tank] || {};
      const status = tankStatusFromAlerts(view.tank, alerts);
      const hasData = (view.series || []).some((s) => s.points.length > 0);

      return `
      <article class="tank-card status-${status}" id="tank-card-${view.tank}">
        <header class="tank-card-header">
          <div>
            <h3>${view.tank}</h3>
            <p class="tank-automation">${view.automation || 'Aucun automate associé'}</p>
          </div>
          <span class="status-dot" title="${status}"></span>
        </header>
        <div class="tank-chart">
          ${hasData ? `<canvas id="chart-${view.tank}"></canvas>` : '<div class="tank-empty">Données de courant non disponibles</div>'}
        </div>
        <footer class="tank-card-footer">
          <div class="tank-stat">
            <span class="tank-stat-label">Courant moy.</span>
            <span class="tank-stat-value">${stats.avg_current ?? '--'} A</span>
          </div>
          <div class="tank-stat">
            <span class="tank-stat-label">Tension moy.</span>
            <span class="tank-stat-value">${stats.avg_voltage ?? '--'} V</span>
          </div>
          <div class="tank-stat">
            <span class="tank-stat-label">Capteurs</span>
            <span class="tank-stat-value">${view.sensors.length}</span>
          </div>
        </footer>
      </article>`;
    })
    .join('');

  tankViews.forEach((view) => {
    const canvas = document.getElementById(`chart-${view.tank}`);
    if (!canvas) return;

    const labels = Array.from(new Set((view.series || []).flatMap((s) => s.points.map((p) => p.time)))).sort((a, b) => {
      const [ah, am, as] = a.split(':').map(Number);
      const [bh, bm, bs] = b.split(':').map(Number);
      return ah - bh || am - bm || as - bs;
    });

    const datasets = (view.series || []).map((series, index) => {
      const byTime = Object.fromEntries(series.points.map((p) => [p.time, p.value]));
      return {
        label: series.label,
        data: labels.map((t) => byTime[t] ?? null),
        borderColor: PALETTE[index % PALETTE.length],
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
      };
    });

    chartInstances[view.tank]?.destroy();
    chartInstances[view.tank] = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#cbd5f5', boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.formattedValue} A` } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 6 } },
          y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        },
      },
    });
  });
}

loadDashboard();
setInterval(loadDashboard, REFRESH_MS);
