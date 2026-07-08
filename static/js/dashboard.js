const chartInstances = {};
const REFRESH_MS = 5000;
const PALETTE = ['#22d3ee', '#818cf8', '#fbbf24', '#34d399'];
const AUTOMATE_COLOR = '#f472b6';
// Fixed current axis (A) shared by every tank chart. Keep in sync with
// services/tank_config.py CHART_CURRENT_AXIS_MAX.
const CURRENT_AXIS_MAX = 220;

const STATUS_LABELS = {
  en_cours: 'En cours',
  noeud_g: 'Noeud-G',
  noeud_d: 'Noeud-D',
  arret: 'Arrêt',
  inconnu: 'Inconnu',
};

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

function formatDateTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function tickClock() {
  const now = new Date();
  setText('clock-date', now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  setText('clock-time', now.toLocaleTimeString('fr-FR'));
}
setInterval(tickClock, 1000);
tickClock();

function setConnectionStatus(ok) {
  const wrap = document.getElementById('conn-status');
  if (!wrap) return;
  wrap.classList.toggle('conn-status--down', !ok);
  setText('conn-label', ok ? 'Données en direct' : 'Connexion perdue');
}

function statusVisual(view, alerts) {
  const hasMajorAlert = alerts.some((a) => a.tank === view.tank && a.severity === 'major');
  if (hasMajorAlert) return 'critical';
  if (view.status === 'en_cours') return 'ok';
  if (view.status === 'noeud_g' || view.status === 'noeud_d') return 'warn';
  if (view.status === 'arret') return 'critical';
  return 'unknown';
}

function renderNodeTable(title, node) {
  if (!node) {
    return `
      <div class="node-table">
        <p class="node-table-title"><span>${title}</span></p>
        <p class="node-table-empty">Non assigné</p>
      </div>`;
  }
  const rows = node.sensors
    .map((s) => {
      const delta = s.delta != null ? ` <span class="muted">(${s.delta > 0 ? '+' : ''}${s.delta})</span>` : '';
      return `<div class="node-table-row"><span>${s.name}</span><span>${s.current != null ? s.current + ' A' : '--'}${delta}</span></div>`;
    })
    .join('');
  return `
    <div class="node-table${node.balanced === false ? ' node-table--imbalanced' : ''}">
      <p class="node-table-title"><span>${title}</span><span>${node.avg_current != null ? node.avg_current + ' A moy.' : '--'}</span></p>
      ${rows}
    </div>`;
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

    setText('process-summary', `Dernière synchronisation : ${new Date().toLocaleTimeString('fr-FR')}`);
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
    .map((a) => {
      const location = [a.tank, a.sensor].filter(Boolean).join(' · ');
      const lastSeen = a.last_seen ? `Dernière donnée : ${formatDateTime(a.last_seen)}` : '';
      return `
    <div class="alert-row alert-row--${a.severity || 'info'}">
      <strong>${(a.severity || 'info').toUpperCase()}</strong>
      <span>${a.message}</span>
      <span class="muted">${[location, lastSeen].filter(Boolean).join(' · ')}</span>
    </div>`;
    })
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
      const visual = statusVisual(view, alerts);
      const statusLabel = STATUS_LABELS[view.status] || 'Inconnu';
      const hasData = (view.series || []).some((s) => s.points.length > 0);
      const process = view.process || {};
      const nodesHtml = `<div class="tank-nodes">${renderNodeTable('Noeud Gauche', view.nodes?.left)}${renderNodeTable('Noeud Droite', view.nodes?.right)}</div>`;

      const lastSeenMs = view.last_seen ? new Date(view.last_seen).getTime() : NaN;
      const isStale = Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > 20000;
      const lastSeenHtml = view.last_seen
        ? `<p class="tank-last-seen${isStale ? ' tank-last-seen--stale' : ''}">Dernière mesure : ${formatDateTime(view.last_seen)}</p>`
        : '<p class="tank-last-seen">Dernière mesure : --</p>';

      const processHtml = process.recipe_number != null || process.segment_number != null
        ? `
        <div class="tank-process">
          <div class="tank-stat">
            <span class="tank-stat-label">Recette</span>
            <span class="tank-stat-value">${process.recipe_number ?? '--'}</span>
          </div>
          <div class="tank-stat">
            <span class="tank-stat-label">Segment</span>
            <span class="tank-stat-value">${process.segment_number ?? '--'} / ${process.total_segments ?? '--'}</span>
          </div>
          <div class="tank-stat">
            <span class="tank-stat-label">Temps restant</span>
            <span class="tank-stat-value">${formatDuration(process.time_remaining)}</span>
          </div>
          <p class="tank-process-updated">Process mis à jour : ${formatDateTime(process.updated_at)}</p>
        </div>`
        : '<div class="tank-process--empty">Aucune donnée de process (pas d\'automate)</div>';

      const jobHtml = view.job
        ? `
        <div class="tank-job${view.job.overrun ? ' tank-job--overrun' : ''}">
          <span class="tank-job-name">Job : ${view.job.name}</span>
          <span class="tank-job-time">${view.job.elapsed_hours} h / ${view.job.max_hours} h${view.job.overrun ? ' · dépassé' : ''}</span>
        </div>`
        : '<div class="tank-job tank-job--none">Aucun job identifié (courant hors plage Porteur/Cliché)</div>';

      return `
      <article class="tank-card status-${visual}" id="tank-card-${view.tank}">
        <header class="tank-card-header">
          <div>
            <h3>${view.tank}</h3>
            <p class="tank-automation">${view.automation || 'Aucun automate associé'}</p>
            ${lastSeenHtml}
          </div>
          <span class="status-badge status-badge--${visual}">${statusLabel}</span>
        </header>
        <div class="tank-chart">
          ${hasData ? `<canvas id="chart-${view.tank}"></canvas>` : '<div class="tank-empty">Données de courant non disponibles</div>'}
        </div>
        ${nodesHtml}
        ${jobHtml}
        ${processHtml}
        <footer class="tank-card-footer">
          <div class="tank-stat">
            <span class="tank-stat-label">Courant actuel</span>
            <span class="tank-stat-value">${stats.latest_current ?? '--'} A</span>
          </div>
          <div class="tank-stat">
            <span class="tank-stat-label">Tension actuelle</span>
            <span class="tank-stat-value">${stats.latest_voltage ?? '--'} V</span>
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

    let sensorIndex = 0;
    const hasAutomate = (view.series || []).some((s) => s.isAutomate);
    const datasets = (view.series || []).map((series) => {
      const byTime = Object.fromEntries(series.points.map((p) => [p.time, p.value]));
      const isAutomate = Boolean(series.isAutomate);
      const color = isAutomate ? AUTOMATE_COLOR : PALETTE[sensorIndex % PALETTE.length];
      if (!isAutomate) sensorIndex += 1;
      return {
        label: series.label,
        data: labels.map((t) => byTime[t] ?? null),
        borderColor: color,
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: 0,
        borderWidth: isAutomate ? 3 : 2,
        borderDash: isAutomate ? [6, 4] : undefined,
        yAxisID: isAutomate ? 'y1' : 'y',
      };
    });

    const scales = {
      x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 6 } },
      // Fixed, shared axis (0..CURRENT_AXIS_MAX) so every tank reads at the same scale, and
      // so a large real automate value never squashes the manual sensor lines near zero.
      y: { min: 0, max: CURRENT_AXIS_MAX, ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.06)' } },
    };
    if (hasAutomate) {
      scales.y1 = {
        position: 'right',
        min: 0,
        ticks: { color: AUTOMATE_COLOR },
        grid: { display: false },
      };
    }

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
        scales,
      },
    });
  });
}

loadDashboard();
setInterval(loadDashboard, REFRESH_MS);
