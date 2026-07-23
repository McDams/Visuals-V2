const chartInstances = {};
const REFRESH_MS = 5000;

// Reads a live CSS custom property so canvas-drawn charts use the same palette as the
// rest of the UI and stay correct across theme switches (Chart.js can't read var(...)
// itself, it needs a resolved color string at chart-creation time).
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function chartSensorPalette() {
  return [cssVar('--accent-2'), cssVar('--accent'), cssVar('--warn'), cssVar('--ok')];
}
function chartAutomateColor() {
  return cssVar('--job-text');
}

// Fixed current axis (A) shared by every tank chart. Keep in sync with
// services/tank_config.py CHART_CURRENT_AXIS_MAX.
const CURRENT_AXIS_MAX = 220;
// A "last seen" timestamp older than this is flagged stale in the UI. Keep in sync with
// services/tank_config.py SENSOR_STALE_SECONDS.
const STALE_MS = 60000;

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
  openTanks: [],
  openAlertPopoverTank: null,
  // Checkboxes selected in the table, offered to "Comparer" into a multi-tank modal.
  compareTanks: new Set(),
  // Chart period per open tank: 'live' (uses the already-loaded real-time series) or '6'/'24'
  // (hours, fetched on demand from /api/tank/<tank>/history).
  chartPeriod: new Map(),
  // Last-fetched history payload per tank, so the periodic 5s refresh redraws from cache
  // instead of re-fetching a wide window every cycle.
  historyData: new Map(),
};

// ---------- Theme (light/dark) ----------
function isLightTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}
function chartAxisColor() {
  return isLightTheme() ? '#475569' : '#64748b';
}
function chartGridColor() {
  return isLightTheme() ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.06)';
}
function chartLegendColor() {
  return isLightTheme() ? '#1e293b' : '#cbd5f5';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.themeChoice === theme);
  });
  // Chart.js bakes colors in at creation time, so re-render anything currently visible.
  if (state.openTanks.length) renderTankModal();
  renderTankTable();
}

document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
});
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

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

function alertItemHtml(a) {
  const meta = [a.alert_type, a.sensor, a.last_seen ? formatDateTime(a.last_seen) : null].filter(Boolean).join(' · ');
  return `
    <div class="alert-item alert-item--${a.severity || 'info'}">
      <span class="alert-item-icon">${iconForAlert(a)}</span>
      <div class="alert-item-content">
        <p class="alert-item-message">${a.message}</p>
        ${meta ? `<p class="alert-item-meta">${meta}</p>` : ''}
      </div>
    </div>`;
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

function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString('fr-FR');
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
  const missing = node.sensor_count - node.reporting_count;
  const rows = node.sensors
    .map((s) => {
      const delta = s.delta != null ? ` <span class="muted">(${s.delta > 0 ? '+' : ''}${s.delta})</span>` : '';
      const valueHtml = s.reporting
        ? `${s.current != null ? s.current + ' A' : '--'}${delta}`
        : '<span class="node-sensor-down">pas de données</span>';
      return `<div class="node-table-row"><span><span class="sensor-dot ${s.reporting ? 'sensor-dot--ok' : 'sensor-dot--down'}"></span>${s.name}</span><span>${valueHtml}</span></div>`;
    })
    .join('');
  return `
    <div class="node-table${node.balanced === false ? ' node-table--imbalanced' : ''}${missing > 0 ? ' node-table--missing' : ''}">
      <p class="node-table-title">
        <span>${title}</span>
        <span>${node.avg_current != null ? node.avg_current + ' A moy.' : '--'}${missing > 0 ? ` · ${node.reporting_count}/${node.sensor_count} capteurs` : ''}</span>
      </p>
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
    renderTankTable();

    if (state.openTanks.length) renderTankModal();
    if (state.openAlertPopoverTank) refreshAlertPopover();

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

function alertsForTank(tank) {
  return state.alerts.filter((a) => a.tank === tank);
}

function popoverContentHtml(tank) {
  const tankAlerts = alertsForTank(tank);
  return tankAlerts.length
    ? tankAlerts.map((a) => alertItemHtml(a)).join('')
    : '<p class="muted alert-popover-empty">Tout fonctionne correctement.</p>';
}

function openAlertPopover(tank, anchorEl) {
  const popover = document.getElementById('alert-popover');
  const body = document.getElementById('alert-popover-body');
  const title = document.getElementById('alert-popover-title');
  if (!popover || !body || !title || !anchorEl) return;

  state.openAlertPopoverTank = tank;
  const tankAlerts = alertsForTank(tank);
  title.textContent = `${tank} · ${tankAlerts.length ? tankAlerts.length + ' alerte(s)' : 'Aucune alerte'}`;
  body.innerHTML = popoverContentHtml(tank);

  popover.hidden = false;
  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left;
  if (left + popRect.width > window.innerWidth - 16) left = window.innerWidth - popRect.width - 16;
  if (top + popRect.height > window.innerHeight - 16) top = rect.top - popRect.height - 8;
  popover.style.top = `${Math.max(8, top)}px`;
  popover.style.left = `${Math.max(8, left)}px`;
}

function closeAlertPopover() {
  state.openAlertPopoverTank = null;
  const popover = document.getElementById('alert-popover');
  if (popover) popover.hidden = true;
}

function refreshAlertPopover() {
  if (!state.openAlertPopoverTank) return;
  const tank = state.openAlertPopoverTank;
  const tankAlerts = alertsForTank(tank);
  setText('alert-popover-title', `${tank} · ${tankAlerts.length ? tankAlerts.length + ' alerte(s)' : 'Aucune alerte'}`);
  const body = document.getElementById('alert-popover-body');
  if (body) body.innerHTML = popoverContentHtml(tank);
}

function renderSparkline(canvasId, series, color) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  chartInstances[canvasId]?.destroy();
  if (!series || !series.points.length) return;

  const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 34);
  gradient.addColorStop(0, `${color}38`);
  gradient.addColorStop(1, `${color}00`);

  chartInstances[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: series.points.map((p) => p.time),
      datasets: [
        {
          data: series.points.map((p) => p.value),
          borderColor: color,
          backgroundColor: gradient,
          fill: true,
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
    tbody.innerHTML = '<tr><td colspan="12" class="muted table-empty">Aucune cuve disponible.</td></tr>';
    renderCompareBar();
    return;
  }

  const statsByTank = Object.fromEntries(state.tankStats.map((t) => [t.tank, t]));
  const nodeCell = (node) => {
    if (!node) return '<span class="muted">Non assigné</span>';
    const missing = node.sensor_count - node.reporting_count;
    const dotClass = missing > 0 ? 'node-cell-dot--warn' : node.balanced === false ? 'node-cell-dot--warn' : 'node-cell-dot--ok';
    const suffix = missing > 0 ? ` <span class="muted">(${node.reporting_count}/${node.sensor_count})</span>` : '';
    return `<span class="node-cell-dot ${dotClass}"></span>${node.avg_current != null ? node.avg_current + ' A' : '--'}${suffix}`;
  };

  tbody.innerHTML = state.tankViews
    .map((view) => {
      const stats = statsByTank[view.tank] || {};
      const visual = statusVisual(view, state.alerts);
      const statusLabel = STATUS_LABELS[view.status] || 'Inconnu';
      const tankAlerts = alertsForTank(view.tank);
      const hasMajor = tankAlerts.some((a) => a.severity === 'major');
      const hasProblem = tankAlerts.length > 0;
      const process = view.process || {};

      const jobCell = !view.job
        ? '<span class="muted">--</span>'
        : view.job.name
          ? `<span class="job-pill${view.job.overrun ? ' job-pill--overrun' : ''}">${view.job.name} · ${formatTime(view.job.start_time)} → ${formatTime(view.job.predicted_end)}</span>`
          : `<span class="job-pill job-pill--stopped">Arrêt depuis ${formatTime(view.job.not_running_since)}</span>`;

      const processCell =
        process.recipe_number != null || process.segment_number != null
          ? `Rec. ${process.recipe_number ?? '--'} · Seg. ${process.segment_number ?? '--'}/${process.total_segments ?? '--'} · ${formatDuration(process.time_remaining)}`
          : '<span class="muted">--</span>';

      const lastSeenMs = view.last_seen ? new Date(view.last_seen).getTime() : NaN;
      const isStale = Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > STALE_MS;

      return `
      <tr class="tank-row${hasMajor ? ' tank-row--alert' : ''}" data-tank="${view.tank}" tabindex="0">
        <td class="select-cell"><input type="checkbox" class="tank-select" data-tank="${view.tank}" aria-label="Sélectionner ${view.tank}"${state.compareTanks.has(view.tank) ? ' checked' : ''} /></td>
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
        <td>
          <div class="alert-dot-cell">
            <span class="alert-dot${hasProblem ? ' alert-dot--problem' : ''}" data-tank="${view.tank}" title="${hasProblem ? tankAlerts.length + ' alerte(s)' : 'Aucune alerte'}"></span>
            ${hasProblem ? `<span class="alert-dot-count alert-dot-count--problem">${tankAlerts.length}</span>` : ''}
          </div>
        </td>
        <td class="sparkline-cell">${view.status === 'arret' ? '<span class="muted">À l\'arrêt</span>' : `<canvas id="spark-${view.tank}"></canvas>`}</td>
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
    if (view.status === 'arret') return;
    const visual = statusVisual(view, state.alerts);
    const color = visual === 'critical' ? cssVar('--critical') : visual === 'warn' ? cssVar('--warn') : cssVar('--accent-2');
    renderSparkline(`spark-${view.tank}`, primarySeriesFor(view), color);
  });

  const selectAll = document.getElementById('select-all-tanks');
  if (selectAll) selectAll.checked = state.tankViews.every((v) => state.compareTanks.has(v.tank));

  renderCompareBar();
}

function renderCompareBar() {
  const bar = document.getElementById('compare-bar');
  if (!bar) return;
  const count = state.compareTanks.size;
  bar.hidden = count === 0;
  if (count > 0) setText('compare-count', `${count} cuve(s) sélectionnée(s)`);
}

function openTankModal(tanks) {
  const list = (Array.isArray(tanks) ? tanks : [tanks]).filter(Boolean);
  if (!list.length) return;
  state.openTanks = list;
  list.forEach((tank) => {
    if (!state.chartPeriod.has(tank)) state.chartPeriod.set(tank, 'live');
  });
  renderTankModal();
  const backdrop = document.getElementById('tank-modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  document.body.classList.add('modal-open');
}

function closeTankModal() {
  state.openTanks.forEach((tank) => {
    const id = `tank-modal-chart-${tank}`;
    chartInstances[id]?.destroy();
    delete chartInstances[id];
  });
  state.openTanks = [];
  const backdrop = document.getElementById('tank-modal-backdrop');
  if (backdrop) backdrop.hidden = true;
  document.body.classList.remove('modal-open');
}

function removeTankFromModal(tank) {
  state.openTanks = state.openTanks.filter((t) => t !== tank);
  state.compareTanks.delete(tank);
  const id = `tank-modal-chart-${tank}`;
  chartInstances[id]?.destroy();
  delete chartInstances[id];
  if (!state.openTanks.length) {
    closeTankModal();
  } else {
    renderTankModal();
  }
  renderTankTable();
}

function renderTankModal() {
  const body = document.getElementById('tank-modal-body');
  const modal = document.querySelector('.tank-modal');
  if (!body) return;

  const validTanks = state.openTanks.filter((t) => state.tankViews.some((v) => v.tank === t));
  if (!validTanks.length) {
    closeTankModal();
    return;
  }
  state.openTanks = validTanks;

  const multi = state.openTanks.length > 1;
  if (modal) modal.classList.toggle('tank-modal--wide', multi);

  const statsByTank = Object.fromEntries(state.tankStats.map((t) => [t.tank, t]));

  const plans = state.openTanks.map((tank) => {
    const view = state.tankViews.find((v) => v.tank === tank);
    const stats = statsByTank[tank] || {};
    const period = state.chartPeriod.get(tank) || 'live';
    const cachedHistory = period !== 'live' ? state.historyData.get(tank) : null;
    return { tank, view, stats, period, cachedHistory, multi };
  });

  body.innerHTML = `
    ${multi ? `<p class="modal-compare-title">Comparaison de ${state.openTanks.length} cuves</p>` : ''}
    <div class="modal-tanks-grid${multi ? ' modal-tanks-grid--multi' : ''}">${plans.map(tankDetailBlockHtml).join('')}</div>
  `;

  plans.forEach((plan) => {
    const canvasId = `tank-modal-chart-${plan.tank}`;
    const hasLiveData = plan.view.status !== 'arret' && (plan.view.series || []).some((s) => s.points.length > 0);
    if (plan.period === 'live') {
      if (hasLiveData) initTankModalChart(plan.view, canvasId);
    } else if (plan.cachedHistory && String(plan.cachedHistory.hours) === plan.period) {
      initHistoryChart(plan.cachedHistory, canvasId);
    } else {
      loadAndRenderHistory(plan.tank, plan.period, canvasId);
    }
  });
}

function tankDetailBlockHtml({ tank, view, stats, period, cachedHistory, multi }) {
  const visual = statusVisual(view, state.alerts);
  const statusLabel = STATUS_LABELS[view.status] || 'Inconnu';
  const nodesHtml = `<div class="tank-nodes">${renderNodeTable('Noeud Gauche', view.nodes?.left)}${renderNodeTable('Noeud Droite', view.nodes?.right)}</div>`;

  const lastSeenMs = view.last_seen ? new Date(view.last_seen).getTime() : NaN;
  const isStale = Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > STALE_MS;
  const lastSeenHtml = view.last_seen
    ? `<p class="tank-last-seen${isStale ? ' tank-last-seen--stale' : ''}">Dernière mesure : ${formatDateTime(view.last_seen)}</p>`
    : '<p class="tank-last-seen">Dernière mesure : --</p>';

  const process = view.process || {};
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

  const jobHtml = !view.job
    ? '<div class="tank-job tank-job--none"><div class="tank-job-main">Aucun job identifié (pas de données de courant)</div></div>'
    : view.job.name
      ? `
      <div class="tank-job${view.job.overrun ? ' tank-job--overrun' : ''}">
        <div class="tank-job-main">
          <span class="tank-job-name">Job : ${view.job.name}</span>
          <span class="tank-job-time">${view.job.elapsed_hours} h / ${view.job.max_hours} h${view.job.overrun ? ' · dépassé' : ''}</span>
        </div>
        <p class="tank-job-schedule">Début : ${formatDateTime(view.job.start_time)} · Fin prévue : ${formatDateTime(view.job.predicted_end)}</p>
      </div>`
      : `
      <div class="tank-job tank-job--none">
        <div class="tank-job-main">Aucun job en cours (courant hors plage Porteur/Cliché)</div>
        <p class="tank-job-schedule">À l'arrêt depuis ${formatDateTime(view.job.not_running_since)}</p>
      </div>`;

  const relatedAlerts = alertsForTank(view.tank);
  const alertsHtml = relatedAlerts.length
    ? `
      <p class="modal-alerts-title">Alertes liées</p>
      <div class="modal-alerts">${relatedAlerts.map((a) => alertItemHtml(a)).join('')}</div>`
    : '';

  const canvasId = `tank-modal-chart-${tank}`;
  const hasLiveData = view.status !== 'arret' && (view.series || []).some((s) => s.points.length > 0);
  const showLoadingPlaceholder = period !== 'live' && !cachedHistory;
  const chartInner = showLoadingPlaceholder
    ? `<div class="tank-empty">Chargement de l'historique (${period}h)...</div>`
    : period === 'live' && !hasLiveData
      ? `<div class="tank-empty">${view.status === 'arret' ? 'Cuve à l\'arrêt — pas de tendance à afficher' : 'Données de courant non disponibles'}</div>`
      : `<canvas id="${canvasId}"></canvas>`;

  const periodSelectorHtml = `
    <div class="chart-period" data-tank="${tank}">
      <button type="button" class="chart-period-btn${period === 'live' ? ' is-active' : ''}" data-period="live">Direct</button>
      <button type="button" class="chart-period-btn${period === '6' ? ' is-active' : ''}" data-period="6">6h</button>
      <button type="button" class="chart-period-btn${period === '24' ? ' is-active' : ''}" data-period="24">24h</button>
    </div>`;

  return `
    <article class="modal-tank-block">
      <header class="modal-header">
        <div>
          <p class="modal-eyebrow">Cuve</p>
          <h2>${tank}</h2>
          <p class="tank-automation">${view.automation || 'Aucun automate associé'}</p>
          ${lastSeenHtml}
        </div>
        <div class="modal-header-actions">
          <span class="status-badge status-badge--${visual}">${statusLabel}</span>
          ${multi ? `<button type="button" class="modal-tank-remove" data-remove-tank="${tank}" aria-label="Retirer ${tank}">&times;</button>` : ''}
        </div>
      </header>
      ${view.setpoint?.total != null
        ? `<p class="modal-setpoint-caption">Consigne automate : ${view.setpoint.total} A · Consigne par capteur actif : ${view.setpoint.per_sensor ?? '--'} A/capteur (${view.sensors_reporting}/${view.sensors_total} capteurs)</p>`
        : ''}
      <div class="modal-chart-wrap">
        ${periodSelectorHtml}
        <div class="modal-chart">${chartInner}</div>
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
          <span class="tank-stat-label">Capteurs actifs</span>
          <span class="tank-stat-value${view.sensors_reporting < view.sensors_total ? ' tank-stat-value--warn' : ''}">${view.sensors_reporting} / ${view.sensors_total}</span>
        </div>
      </footer>
      ${alertsHtml}
    </article>`;
}

async function loadAndRenderHistory(tank, hours, canvasId) {
  try {
    const resp = await fetch(`/api/tank/${encodeURIComponent(tank)}/history?hours=${hours}`);
    if (!resp.ok) throw new Error('HTTP error');
    const history = await resp.json();
    state.historyData.set(tank, history);
    // The period/tank selection may have changed while the request was in flight.
    if (state.chartPeriod.get(tank) !== String(hours) || !state.openTanks.includes(tank)) return;
    if (!document.getElementById(canvasId)) {
      // The block was rebuilt (e.g. by the 5s poll) while loading; re-render now that the
      // history is cached so the chart appears instead of staying on the loading placeholder.
      renderTankModal();
      return;
    }
    initHistoryChart(history, canvasId);
  } catch (err) {
    console.warn("Erreur de chargement de l'historique", err);
    const wrap = document.getElementById(canvasId)?.closest('.modal-chart');
    if (wrap) wrap.innerHTML = "<div class=\"tank-empty\">Impossible de charger l'historique.</div>";
  }
}

function initTankModalChart(view, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const labels = Array.from(new Set((view.series || []).flatMap((s) => s.points.map((p) => p.time)))).sort((a, b) => {
    const [ah, am, as] = a.split(':').map(Number);
    const [bh, bm, bs] = b.split(':').map(Number);
    return ah - bh || am - bm || as - bs;
  });

  let sensorIndex = 0;
  const hasAutomate = (view.series || []).some((s) => s.isAutomate);
  const sensorPalette = chartSensorPalette();
  const automateColor = chartAutomateColor();
  const datasets = (view.series || []).map((series) => {
    const byTime = Object.fromEntries(series.points.map((p) => [p.time, p.value]));
    const isAutomate = Boolean(series.isAutomate);
    const color = isAutomate ? automateColor : sensorPalette[sensorIndex % sensorPalette.length];
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

  const setpointPerSensor = view.setpoint?.per_sensor;
  if (setpointPerSensor != null && labels.length) {
    datasets.push({
      label: `Consigne (${setpointPerSensor} A/capteur)`,
      data: labels.map(() => setpointPerSensor),
      // Full-contrast foreground color + thick long dashes so the target line reads
      // unmistakably as a reference threshold, distinct from the softer data-line palette.
      borderColor: cssVar('--text'),
      backgroundColor: 'transparent',
      borderWidth: 2.5,
      borderDash: [10, 6],
      pointRadius: 0,
      yAxisID: 'y',
    });
  }

  const scales = {
    x: { grid: { display: false }, ticks: { color: chartAxisColor(), maxTicksLimit: 6 } },
    // Fixed, shared axis (0..CURRENT_AXIS_MAX) so every tank reads at the same scale, and
    // so a large real automate value never squashes the manual sensor lines near zero.
    y: { min: 0, max: CURRENT_AXIS_MAX, ticks: { color: chartAxisColor() }, grid: { color: chartGridColor() } },
  };
  if (hasAutomate) {
    scales.y1 = { position: 'right', min: 0, ticks: { color: automateColor }, grid: { display: false } };
  }

  chartInstances[canvasId]?.destroy();
  chartInstances[canvasId] = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: chartLegendColor(), boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.formattedValue} A` } },
      },
      scales,
    },
  });
}

function initHistoryChart(history, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !history) return;

  const labels = Array.from(new Set((history.series || []).flatMap((s) => s.points.map((p) => p.time)))).sort(
    (a, b) => new Date(a).getTime() - new Date(b).getTime()
  );
  const spanHours = history.hours || 1;
  const displayLabels = labels.map((iso) => {
    const d = new Date(iso);
    return spanHours > 6
      ? d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  });

  let sensorIndex = 0;
  const hasAutomate = (history.series || []).some((s) => s.isAutomate);
  const sensorPalette = chartSensorPalette();
  const automateColor = chartAutomateColor();
  const datasets = (history.series || []).map((series) => {
    const byTime = Object.fromEntries(series.points.map((p) => [p.time, p.value]));
    const isAutomate = Boolean(series.isAutomate);
    const color = isAutomate ? automateColor : sensorPalette[sensorIndex % sensorPalette.length];
    if (!isAutomate) sensorIndex += 1;
    return {
      label: series.label,
      data: labels.map((t) => byTime[t] ?? null),
      borderColor: color,
      backgroundColor: 'transparent',
      tension: 0.25,
      pointRadius: 0,
      borderWidth: isAutomate ? 3 : 2,
      borderDash: isAutomate ? [6, 4] : undefined,
      yAxisID: isAutomate ? 'y1' : 'y',
      spanGaps: true,
    };
  });

  const scales = {
    x: { grid: { display: false }, ticks: { color: chartAxisColor(), maxTicksLimit: 8 } },
    y: { min: 0, max: CURRENT_AXIS_MAX, ticks: { color: chartAxisColor() }, grid: { color: chartGridColor() } },
  };
  if (hasAutomate) {
    scales.y1 = { position: 'right', min: 0, ticks: { color: automateColor }, grid: { display: false } };
  }

  chartInstances[canvasId]?.destroy();
  chartInstances[canvasId] = new Chart(canvas, {
    type: 'line',
    data: { labels: displayLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: chartLegendColor(), boxWidth: 10, font: { size: 11 } } },
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
  if (event.key === 'Escape' && state.openTanks.length) closeTankModal();
});

// Delegated click handlers: attached once to containers that are never replaced (only their
// children are re-rendered every poll), so a click always lands on a live listener even if
// the table/ticker/alerts re-render mid-click.
document.getElementById('tank-table-body')?.addEventListener('click', (event) => {
  const checkbox = event.target.closest('.tank-select');
  if (checkbox) {
    event.stopPropagation();
    const tank = checkbox.dataset.tank;
    if (checkbox.checked) state.compareTanks.add(tank);
    else state.compareTanks.delete(tank);
    renderCompareBar();
    const selectAll = document.getElementById('select-all-tanks');
    if (selectAll) selectAll.checked = state.tankViews.every((v) => state.compareTanks.has(v.tank));
    return;
  }
  const dot = event.target.closest('.alert-dot');
  if (dot) {
    event.stopPropagation();
    const tank = dot.dataset.tank;
    if (state.openAlertPopoverTank === tank) {
      closeAlertPopover();
    } else {
      openAlertPopover(tank, dot);
    }
    return;
  }
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
document.getElementById('alert-ticker-track')?.addEventListener('click', (event) => {
  const item = event.target.closest('.ticker-item--clickable');
  if (item && item.dataset.tank) openTankModal(item.dataset.tank);
});

document.getElementById('select-all-tanks')?.addEventListener('change', (event) => {
  if (event.target.checked) state.tankViews.forEach((v) => state.compareTanks.add(v.tank));
  else state.compareTanks.clear();
  renderTankTable();
});
document.getElementById('compare-clear-btn')?.addEventListener('click', () => {
  state.compareTanks.clear();
  renderTankTable();
});
document.getElementById('compare-open-btn')?.addEventListener('click', () => {
  if (state.compareTanks.size) openTankModal(Array.from(state.compareTanks));
});

document.getElementById('tank-modal-body')?.addEventListener('click', (event) => {
  const removeBtn = event.target.closest('[data-remove-tank]');
  if (removeBtn) {
    removeTankFromModal(removeBtn.dataset.removeTank);
    return;
  }
  const periodBtn = event.target.closest('.chart-period-btn');
  if (periodBtn) {
    const tank = periodBtn.closest('.chart-period')?.dataset.tank;
    if (tank) {
      state.chartPeriod.set(tank, periodBtn.dataset.period);
      renderTankModal();
    }
  }
});

document.getElementById('alert-popover-close')?.addEventListener('click', closeAlertPopover);
document.addEventListener('click', (event) => {
  if (!state.openAlertPopoverTank) return;
  const popover = document.getElementById('alert-popover');
  if (popover && (popover.contains(event.target) || event.target.closest('.alert-dot'))) return;
  closeAlertPopover();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.openAlertPopoverTank) closeAlertPopover();
});
window.addEventListener(
  'scroll',
  () => {
    if (state.openAlertPopoverTank) closeAlertPopover();
  },
  true
);

loadDashboard();
setInterval(loadDashboard, REFRESH_MS);
