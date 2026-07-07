const chartInstances = {};

async function loadDashboard() {
  const response = await fetch('/api/dashboard');
  const data = await response.json();

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

function renderSensorList(sensors) {
  const container = document.getElementById('sensor-list');
  if (!container) return;
  container.innerHTML = sensors.map(sensor => `
    <li><strong>${sensor.name}</strong><span>${sensor.tank}${sensor.is_auto ? ' · Auto' : ''}</span></li>
  `).join('');
}

loadDashboard();
setInterval(loadDashboard, 5000);
