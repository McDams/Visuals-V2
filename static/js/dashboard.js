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

// Latest data snapshot, kept around so the modal can be opened/refreshed without a new
// fetch, and so it stays live-updated while open during the next polling cycle.
const state = {
  tankViews: [],
  tankStats: [],
  alerts: [],
  openTank: null,
  // Tracks user-toggled expand/collapse per tank group in the alerts panel, so the choice
  // survives the next 5s poll re-render instead of resetting every time.
  manualGroupState: new Map(),
};

const ALERT_ICONS = {
  'Arrêt Programmé': '⏸',
  'Écart Ampérage': '⚡',
  'Temps de production': '⏱',
  'Alerte pH': '🧪',
};

function iconForAlert(a) {
  if (a.alert_type && ALERT_ICONS[a.alert_type]) return ALERT_ICONS[a.alert_type];
  if (a.metric === 'current') return '🔥';
  if (a.message === 'Pas de données récentes') return '📡';
  return a.severity === 'major' ? '⚠️' : 'ℹ️';
}

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

function primarySeriesFor(view) {
  const series = view.series || [];
  const automate = series.find((s) => s.isAutomate && s.points.length);
  if (automate) return automate;
  return series.find((s) => s.points && s.points.length) || null;
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

    state.tankViews = dashboard.live_charts?.per_tank || [];
    state.tankStats = kpis.per_tank || [];
    state.alerts = alertsPayload.alerts || [];

    setText('process-summary', `Dernière synchronisation : ${new Date().toLocaleTimeString('fr-FR')}`);
    renderAlertPill(state.alerts);
    renderAlertTicker(state.alerts);
    renderAlertsPanel(state.alerts);
    renderTankTable();

    if (state.openTank) renderTankModal();

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
      const clickable = a.tank ? ' ticker-item--clickable' : '';
      return `<span class="ticker-item ticker-item--${severity}${clickable}" data-tank="${a.tank || ''}">${severity.toUpperCase()} · ${a.message}${location}</span>`;
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
    container.innerHTML = `
      <div class="alerts-empty">
        <div class="alerts-empty-icon">✓</div>
        <p class="alerts-empty-title">Tout est nominal</p>
        <p class="alerts-empty-sub">Aucune alerte active sur les cuves suivies.</p>
      </div>`;
    return;
  }

  const majorCount = alerts.filter((a) => a.severity === 'major').length;
  const minorCount = alerts.filter((a) => a.severity === 'minor').length;

  const grouped = new Map();
  const ungrouped = [];
  alerts.forEach((a) => {
    if (!a.tank) {
      ungrouped.push(a);
      return;
    }
    if (!grouped.has(a.tank)) grouped.set(a.tank, []);
    grouped.get(a.tank).push(a);
  });

  const tanks = Array.from(grouped.keys()).sort((t1, t2) => {
    const hasMajor1 = grouped.get(t1).some((a) => a.severity === 'major');
    const hasMajor2 = grouped.get(t2).some((a) => a.severity === 'major');
    if (hasMajor1 !== hasMajor2) return hasMajor1 ? -1 : 1;
    return t1.localeCompare(t2);
  });

  const alertItemHtml = (a, tank) => {
    const meta = [a.alert_type, a.sensor, a.last_seen ? formatDateTime(a.last_seen) : null].filter(Boolean).join(' · ');
    return `
      <div class="alert-item alert-item--${a.severity || 'info'}"${tank ? ` data-tank="${tank}"` : ''}>
        <span class="alert-item-icon">${iconForAlert(a)}</span>
        <div class="alert-item-content">
          <p class="alert-item-message">${a.message}</p>
          ${meta ? `<p class="alert-item-meta">${meta}</p>` : ''}
        </div>
      </div>`;
  };

  const summaryHtml = `
    <div class="alerts-summary">
      <div class="alert-stat alert-stat--major">
        <span class="alert-stat-count">${majorCount}</span>
        <span class="alert-stat-label">Majeure${majorCount > 1 ? 's' : ''}</span>
      </div>
      <div class="alert-stat alert-stat--minor">
        <span class="alert-stat-count">${minorCount}</span>
        <span class="alert-stat-label">Mineure${minorCount > 1 ? 's' : ''}</span>
      </div>
    </div>`;

  const groupsHtml = tanks
    .map((tank) => {
      const tankAlerts = grouped.get(tank);
      const hasMajor = tankAlerts.some((a) => a.severity === 'major');
      const open = state.manualGroupState.has(tank) ? state.manualGroupState.get(tank) : hasMajor;

      return `
      <div class="alert-group${open ? '' : ' alert-group--collapsed'}${hasMajor ? ' alert-group--major' : ''}">
        <button class="alert-group-header" type="button" data-toggle-tank="${tank}">
          <span class="alert-group-name">${tank}</span>
          <span class="alert-group-count">${tankAlerts.length} alerte${tankAlerts.length > 1 ? 's' : ''}</span>
          <span class="alert-group-chevron">⌄</span>
        </button>
        <div class="alert-group-body">
          <div class="alert-group-body-inner">${tankAlerts.map((a) => alertItemHtml(a, tank)).join('')}</div>
        </div>
      </div>`;
    })
    .join('');

  const ungroupedHtml = ungrouped.map((a) => alertItemHtml(a, null)).join('');

  container.innerHTML = `${summaryHtml}<div class="alert-groups">${groupsHtml}${ungroupedHtml}</div>`;
}

function renderSparkline(canvasId, series, color) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  chartInstances[canvasId]?.destroy();
  if (!series || !series.points.length) return;

  chartInstances[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: series.points.map((p) => p.time),
      datasets: [
        {
          data: series.points.map((p) => p.value),
          borderColor: color,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}

function renderTankTable() {
  const tbody = document.getElementById('tank-table-body');
  if (!tbody) return;

  setText('table-subtitle', state.tankViews.length ? `${state.tankViews.length} cuve(s) suivie(s) · cliquez une ligne pour le détail` : 'Aucune cuve');

  if (state.tankViews.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted table-empty">Aucune cuve disponible.</td></tr>';
    return;
  }

  const statsByTank = Object.fromEntries(state.tankStats.map((t) => [t.tank, t]));
  const nodeCell = (node) =>
    node
      ? `<span class="node-cell-dot ${node.balanced === false ? 'node-cell-dot--warn' : 'node-cell-dot--ok'}"></span>${node.avg_current != null ? node.avg_current + ' A' : '--'}`
      : '<span class="muted">Non assigné</span>';

  tbody.innerHTML = state.tankViews
    .map((view) => {
      const stats = statsByTank[view.tank] || {};
      const visual = statusVisual(view, state.alerts);
      const statusLabel = STATUS_LABELS[view.status] || 'Inconnu';
      const hasMajor = state.alerts.some((a) => a.tank === view.tank && a.severity === 'major');
      const process = view.process || {};

      const jobCell = view.job
        ? `<span class="job-pill${view.job.overrun ? ' job-pill--overrun' : ''}">${view.job.name} · ${view.job.elapsed_hours}h/${view.job.max_hours}h</span>`
        : '<span class="muted">--</span>';

      const processCell =
        process.recipe_number != null || process.segment_number != null
          ? `Rec. ${process.recipe_number ?? '--'} · Seg. ${process.segment_number ?? '--'}/${process.total_segments ?? '--'} · ${formatDuration(process.time_remaining)}`
          : '<span class="muted">--</span>';

      const lastSeenMs = view.last_seen ? new Date(view.last_seen).getTime() : NaN;
      const isStale = Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > 20000;

      return `
      <tr class="tank-row${hasMajor ? ' tank-row--alert' : ''}" data-tank="${view.tank}" tabindex="0">
        <td>
          <div class="tank-row-name">
            <span class="row-status-dot row-status-dot--${visual}"></span>
            <div>
              <strong>${view.tank}</strong>
              <span class="muted">${view.automation || 'Sans automate'}</span>
            </div>
          </div>
        </td>
        <td><span class="status-badge status-badge--${visual}">${statusLabel}</span></td>
        <td class="sparkline-cell"><canvas id="spark-${view.tank}"></canvas></td>
        <td class="tabular">${stats.latest_current ?? '--'} A<br /><span class="muted">${stats.latest_voltage ?? '--'} V</span></td>
        <td class="tabular">${nodeCell(view.nodes?.left)}</td>
        <td class="tabular">${nodeCell(view.nodes?.right)}</td>
        <td>${jobCell}</td>
        <td class="muted process-cell">${processCell}</td>
        <td class="muted${isStale ? ' tank-last-seen--stale' : ''}">${formatDateTime(view.last_seen)}</td>
        <td class="row-action">›</td>
      </tr>`;
    })
    .join('');

  state.tankViews.forEach((view) => {
    const visual = statusVisual(view, state.alerts);
    const color = visual === 'critical' ? '#f87171' : visual === 'warn' ? '#fbbf24' : '#22d3ee';
    renderSparkline(`spark-${view.tank}`, primarySeriesFor(view), color);
  });
}

function openTankModal(tank) {
  if (!tank) return;
  state.openTank = tank;
  renderTankModal();
  const backdrop = document.getElementById('tank-modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  document.body.classList.add('modal-open');
}

function closeTankModal() {
  state.openTank = null;
  const backdrop = document.getElementById('tank-modal-backdrop');
  if (backdrop) backdrop.hidden = true;
  document.body.classList.remove('modal-open');
  chartInstances['tank-modal-chart']?.destroy();
  delete chartInstances['tank-modal-chart'];
}

function renderTankModal() {
  const body = document.getElementById('tank-modal-body');
  if (!body || !state.openTank) return;

  const view = state.tankViews.find((v) => v.tank === state.openTank);
  if (!view) {
    closeTankModal();
    return;
  }

  const statsByTank = Object.fromEntries(state.tankStats.map((t) => [t.tank, t]));
  const stats = statsByTank[view.tank] || {};
  const visual = statusVisual(view, state.alerts);
  const statusLabel = STATUS_LABELS[view.status] || 'Inconnu';
  const hasData = (view.series || []).some((s) => s.points.length > 0);
  const process = view.process || {};
  const nodesHtml = `<div class="tank-nodes">${renderNodeTable('Noeud Gauche', view.nodes?.left)}${renderNodeTable('Noeud Droite', view.nodes?.right)}</div>`;

  const lastSeenMs = view.last_seen ? new Date(view.last_seen).getTime() : NaN;
  const isStale = Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > 20000;
  const lastSeenHtml = view.last_seen
    ? `<p class="tank-last-seen${isStale ? ' tank-last-seen--stale' : ''}">Dernière mesure : ${formatDateTime(view.last_seen)}</p>`
    : '<p class="tank-last-seen">Dernière mesure : --</p>';

  const processHtml =
    process.recipe_number != null || process.segment_number != null
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

  const relatedAlerts = state.alerts.filter((a) => a.tank === view.tank);
  const alertsHtml = relatedAlerts.length
    ? `
      <p class="modal-alerts-title">Alertes liées</p>
      <div class="modal-alerts">${relatedAlerts
        .map((a) => {
          const meta = [a.alert_type, a.sensor].filter(Boolean).join(' · ');
          return `
        <div class="alert-item alert-item--${a.severity || 'info'}">
          <span class="alert-item-icon">${iconForAlert(a)}</span>
          <div class="alert-item-content">
            <p class="alert-item-message">${a.message}</p>
            ${meta ? `<p class="alert-item-meta">${meta}</p>` : ''}
          </div>
        </div>`;
        })
        .join('')}</div>`
    : '';

  body.innerHTML = `
    <header class="modal-header">
      <div>
        <p class="modal-eyebrow">Cuve</p>
        <h2 id="tank-modal-title">${view.tank}</h2>
        <p class="tank-automation">${view.automation || 'Aucun automate associé'}</p>
        ${lastSeenHtml}
      </div>
      <span class="status-badge status-badge--${visual}">${statusLabel}</span>
    </header>
    <div class="modal-chart">
      ${hasData ? '<canvas id="tank-modal-chart"></canvas>' : '<div class="tank-empty">Données de courant non disponibles</div>'}
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
    ${alertsHtml}
  `;

  if (hasData) initTankModalChart(view);
}

function initTankModalChart(view) {
  const canvas = document.getElementById('tank-modal-chart');
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
    scales.y1 = { position: 'right', min: 0, ticks: { color: AUTOMATE_COLOR }, grid: { display: false } };
  }

  chartInstances['tank-modal-chart']?.destroy();
  chartInstances['tank-modal-chart'] = new Chart(canvas, {
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
}

document.getElementById('tank-modal-close')?.addEventListener('click', closeTankModal);
document.getElementById('tank-modal-backdrop')?.addEventListener('click', (event) => {
  if (event.target.id === 'tank-modal-backdrop') closeTankModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.openTank) closeTankModal();
});

// Delegated click handlers: attached once to containers that are never replaced (only their
// children are re-rendered every poll), so a click always lands on a live listener even if
// the table/ticker/alerts re-render mid-click.
document.getElementById('tank-table-body')?.addEventListener('click', (event) => {
  const row = event.target.closest('.tank-row');
  if (row) openTankModal(row.dataset.tank);
});
document.getElementById('tank-table-body')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.tank-row');
  if (row) {
    event.preventDefault();
    openTankModal(row.dataset.tank);
  }
});
document.getElementById('alerts-list')?.addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle-tank]');
  if (toggle) {
    const tank = toggle.dataset.toggleTank;
    const group = toggle.closest('.alert-group');
    const willOpen = group.classList.contains('alert-group--collapsed');
    state.manualGroupState.set(tank, willOpen);
    group.classList.toggle('alert-group--collapsed', !willOpen);
    return;
  }
  const item = event.target.closest('.alert-item[data-tank]');
  if (item && item.dataset.tank) openTankModal(item.dataset.tank);
});
document.getElementById('alert-ticker-track')?.addEventListener('click', (event) => {
  const item = event.target.closest('.ticker-item--clickable');
  if (item && item.dataset.tank) openTankModal(item.dataset.tank);
});

loadDashboard();
setInterval(loadDashboard, REFRESH_MS);
