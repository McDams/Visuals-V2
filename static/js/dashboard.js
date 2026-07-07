const chartInstances = {};

const dashboardState = {
  tankViews: [],
  filters: {
    tank: 'all',
    automation: 'all',
  },
};

async function loadDashboard() {
  const response = await fetch('/api/dashboard');
  const data = await response.json();

  dashboardState.tankViews = data.live_charts.per_tank || [];

  document.getElementById('active-tanks').textContent = data.summary.active_tanks;
  document.getElementById('sensor-count').textContent = data.summary.sensor_count;
  document.getElementById('measurement-points').textContent = data.summary.measurement_points;
  document.getElementById('selected-sensor').textContent = data.summary.selected_sensor;

  renderLineChart('tankCurrentChart', data.live_charts.by_tank.current, 'Courant mesuré');
  renderLineChart('tankVoltageChart', data.live_charts.by_tank.voltage, 'Tension mesurée');
  renderLineChart('automationChart', data.live_charts.by_automation.current, 'Automates vs capteurs');
  renderLineChart('sensorChart', data.live_charts.by_sensor.current, 'Capteurs');
  renderProcessState(data.latest_process);
  renderTankTable(data.by_tank);
  renderFilterPanel(dashboardState.tankViews);
  renderTankViews(applyTankFilter(dashboardState.tankViews));
  renderSensorList(data.sensors);
}

function renderLineChart(canvasId, series, title) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  if (chartInstances[canvasId]) {
    chartInstances[canvasId].destroy();
  }

  const palette = ['#4f46e5', '#06b6d4', '#f59e0b', '#ef4444', '#8b5cf6', '#10b981'];
  const datasets = (series || []).map((item, index) => ({
    label: item.label,
    data: item.points.map(point => point.value),
    borderColor: palette[index % palette.length],
    backgroundColor: 'transparent',
    tension: 0.25,
    pointRadius: 1.2,
    pointHoverRadius: 3,
  }));

  const labels = (series[0]?.points || []).map(point => point.time);

  chartInstances[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        title: { display: true, text: title },
      },
      scales: {
        y: { beginAtZero: false },
      },
    },
  });
}

function renderProcessState(processState) {
  const container = document.getElementById('process-state');
  if (!container) return;
  const items = [
    ['Recette', processState.recipe_number || '—'],
    ['Segment', processState.segment_number || '—'],
    ['Total segments', processState.total_segments || '—'],
    ['Temps restant', processState.time_remaining || '—'],
    ['Temps restant total', processState.time_remaining_total || '—'],
  ];

  container.innerHTML = items.map(([label, value]) => `
    <div class="process-item">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join('');
}

function renderTankTable(rows) {
  const container = document.getElementById('tank-table');
  if (!container) return;
  const rowsHtml = rows.map(row => `
    <div class="table-row">
      <span>${row.tank}</span>
      <span>${row.current_measured} A</span>
      <span>${row.voltage_measured} V</span>
    </div>
  `).join('');
  container.innerHTML = `
    <div class="table-head">
      <span>Cuve</span>
      <span>Courant</span>
      <span>Tension</span>
    </div>
    ${rowsHtml}
  `;
}

function renderTankViews(tankViews) {
  const container = document.getElementById('tank-views');
  if (!container) return;

  container.innerHTML = (tankViews || []).map((view) => `
      <article class="tank-view-card">
        <div class="tank-view-header">
          <div>
            <h4>${view.title || view.tank}</h4>
            <p class="tank-chart-meta">${view.automation || 'Aucun automate associé'}</p>
          </div>
          <span>${view.sensors.length} capteurs</span>
        </div>
        <div class="tank-chart-full" id="tank-card-${view.tank}">
          ${((view.series || []).flatMap(series => series.points).length === 0)
            ? '<div class="tank-empty">Données de courant non disponibles pour cette cuve.</div>'
            : `<canvas id="tank-chart-${view.tank}"></canvas>`}
        </div>
      </article>
    `).join('');

  (tankViews || []).forEach((view) => {
    const canvasId = `tank-chart-${view.tank}`;
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    const labels = Array.from(new Set((view.series || []).flatMap(series => series.points.map(point => point.time))));
    labels.sort((a, b) => {
      const [ah, am, as] = a.split(':').map(Number);
      const [bh, bm, bs] = b.split(':').map(Number);
      return ah - bh || am - bm || as - bs;
    });

    const palette = ['#4f46e5', '#06b6d4', '#f59e0b', '#ef4444', '#8b5cf6', '#10b981'];
    const datasets = (view.series || []).map((series, index) => {
      const valuesByTime = series.points.reduce((acc, point) => {
        acc[point.time] = point.value;
        return acc;
      }, {});
      return {
        label: series.label,
        data: labels.map((time) => valuesByTime[time] ?? null),
        borderColor: palette[index % palette.length],
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: 2,
        borderWidth: 2,
      };
    });

    chartInstances[canvasId]?.destroy();
    chartInstances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' },
          title: {
            display: true,
            text: view.title || `Capteurs par cuve — ${view.tank}`,
            font: { size: 14 },
          },
        },
        scales: {
          y: { beginAtZero: false },
          x: { grid: { display: false } },
        },
      },
    });
  });
}

function renderSensorList(sensors) {
  const container = document.getElementById('sensor-list');
  if (!container) return;
  container.innerHTML = sensors.map(sensor => `
    <li><strong>${sensor.name}</strong><span>${sensor.tank}${sensor.is_auto ? ' · Auto' : ''}</span></li>
  `).join('');
}

function renderFilterPanel(tankViews) {
  const container = document.getElementById('filter-panel');
  if (!container) return;

  const tanks = ['all', ...new Set(tankViews.map(view => view.tank))];
  container.innerHTML = `
    <div class="filter-item">
      <label for="tank-filter">Filtrer par cuve</label>
      <select id="tank-filter">
        ${tanks.map(tank => `<option value="${tank}">${tank === 'all' ? 'Toutes les cuves' : tank}</option>`).join('')}
      </select>
    </div>
    <div class="filter-item">
      <label for="automation-filter">Automate</label>
      <select id="automation-filter">
        <option value="all">Tous</option>
        <option value="with">Avec automate</option>
        <option value="without">Sans automate</option>
      </select>
    </div>
  `;

  document.getElementById('tank-filter').value = dashboardState.filters.tank;
  document.getElementById('automation-filter').value = dashboardState.filters.automation;

  document.getElementById('tank-filter').onchange = (event) => {
    dashboardState.filters.tank = event.target.value;
    renderTankViews(applyTankFilter(dashboardState.tankViews));
  };

  document.getElementById('automation-filter').onchange = (event) => {
    dashboardState.filters.automation = event.target.value;
    renderTankViews(applyTankFilter(dashboardState.tankViews));
  };
}

function applyTankFilter(tankViews) {
  return (tankViews || []).filter((view) => {
    const matchesTank = dashboardState.filters.tank === 'all' || view.tank === dashboardState.filters.tank;
    const isAutomated = Boolean(view.automation);
    const matchesAutomation =
      dashboardState.filters.automation === 'all' ||
      (dashboardState.filters.automation === 'with' && isAutomated) ||
      (dashboardState.filters.automation === 'without' && !isAutomated);
    return matchesTank && matchesAutomation;
  });
}

loadDashboard();
setInterval(loadDashboard, 5000);
