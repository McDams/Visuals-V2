// Instances Chart.js vivantes, indexées par id de canvas (pour pouvoir les détruire avant
// de redessiner). REFRESH_MS = intervalle de rafraîchissement du dashboard (5 s).
const chartInstances = {};
const REFRESH_MS = 5000;

// Lit une variable CSS en direct : les graphiques dessinés sur canvas utilisent ainsi la même
// palette que le reste de l'UI et restent corrects au changement de thème (Chart.js ne sait
// pas lire var(...), il lui faut une couleur résolue au moment de la création du graphe).
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
// Palette des 4 lignes de capteurs et couleur de la ligne automate.
function chartSensorPalette() {
  return [cssVar('--chart-1'), cssVar('--chart-2'), cssVar('--chart-3'), cssVar('--chart-4')];
}
function chartAutomateColor() {
  return cssVar('--job-text');
}

// Axe de courant (A) fixe et partagé par tous les graphes. À garder synchronisé avec
// services/tank_config.py CHART_CURRENT_AXIS_MAX.
const CURRENT_AXIS_MAX = 220;
// Un horodatage "dernière mesure" plus ancien que ceci est signalé comme périmé dans l'UI.
// À garder synchronisé avec services/tank_config.py SENSOR_STALE_SECONDS.
const STALE_MS = 60000;

// Libellés lisibles des statuts combinés d'une cuve.
const STATUS_LABELS = {
  en_cours: 'En cours',
  noeud_g: 'Noeud-G',
  noeud_d: 'Noeud-D',
  arret: 'Arrêt',
  inconnu: 'Inconnu',
};

// Instantané des dernières données reçues, conservé pour pouvoir ouvrir/rafraîchir le modal
// sans nouvelle requête, et pour qu'il reste à jour pendant le cycle de polling suivant.
const state = {
  tankViews: [],
  tankStats: [],
  alerts: [],
  openTanks: [],
  openAlertPopoverTank: null,
  // Cases cochées dans le tableau, proposées à la comparaison multi-cuves via "Comparer".
  compareTanks: new Set(),
  // Période du graphe par cuve ouverte : 'live' (série temps réel déjà chargée) ou '6'/'24'
  // (heures, récupérées à la demande via /api/tank/<tank>/history).
  chartPeriod: new Map(),
  // Dernier historique récupéré par cuve, pour que le rafraîchissement de 5 s redessine depuis
  // ce cache au lieu de refaire une requête sur une large fenêtre à chaque cycle.
  historyData: new Map(),
};

// ---------- Thème (clair/sombre) ----------
function isLightTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}
// Couleurs des axes/grille/légende des graphes selon le thème actif.
function chartAxisColor() {
  return isLightTheme() ? '#475569' : '#64748b';
}
function chartGridColor() {
  return isLightTheme() ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.06)';
}
function chartLegendColor() {
  return isLightTheme() ? '#1e293b' : '#cbd5f5';
}

// Applique un thème : pose l'attribut data-theme, le mémorise, met à jour le bouton actif, et
// redessine ce qui est visible (les graphes figent leurs couleurs à la création, d'où le
// re-render).
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.themeChoice === theme);
  });
  if (state.openTanks.length) renderTankModal();
  renderTankTable();
}

// Câblage des boutons de bascule de thème + application du thème initial (celui déjà posé par
// le petit script inline du <head>, ou "dark" par défaut).
document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
});
applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

// Icône (emoji) par type d'alerte, pour un repère visuel rapide.
const ALERT_ICONS = {
  'Arrêt Programmé': '⏸',
  'Écart Ampérage': '⚡',
  'Temps de production': '⏱',
  'Alerte pH': '🧪',
};

// Choisit l'icône d'une alerte selon son type, sa métrique ou son message.
function iconForAlert(a) {
  if (a.alert_type && ALERT_ICONS[a.alert_type]) return ALERT_ICONS[a.alert_type];
  if (a.metric === 'current') return '🔥';
  if (a.message === 'Pas de données récentes') return '📡';
  return a.severity === 'major' ? '⚠️' : 'ℹ️';
}

// Génère le HTML d'une alerte (icône + message + méta), réutilisé dans le popover et le modal.
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

// Écrit du texte dans un élément par son id (sans planter si l'élément n'existe pas).
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// Formate une durée en secondes -> "H:MM:SS" (ou "MM:SS" si moins d'une heure).
function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// Formate une date ISO en date+heure locale complète (jj/mm/aaaa hh:mm:ss).
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

// Formate une date ISO en heure locale seule (hh:mm:ss), pour l'affichage compact du tableau.
function formatTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString('fr-FR');
}

// Met à jour l'horloge du bandeau (date + heure) chaque seconde.
function tickClock() {
  const now = new Date();
  setText('clock-date', now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  setText('clock-time', now.toLocaleTimeString('fr-FR'));
}
setInterval(tickClock, 1000);
tickClock();

// Bascule l'indicateur de connexion "Données en direct" / "Connexion perdue".
function setConnectionStatus(ok) {
  const wrap = document.getElementById('conn-status');
  if (!wrap) return;
  wrap.classList.toggle('conn-status--down', !ok);
  setText('conn-label', ok ? 'Données en direct' : 'Connexion perdue');
}

// Traduit le statut d'une cuve en code couleur visuel (ok/warn/critical/unknown), en tenant
// compte d'une éventuelle alerte majeure.
function statusVisual(view, alerts) {
  const hasMajorAlert = alerts.some((a) => a.tank === view.tank && a.severity === 'major');
  if (hasMajorAlert) return 'critical';
  if (view.status === 'en_cours') return 'ok';
  if (view.status === 'noeud_g' || view.status === 'noeud_d') return 'warn';
  if (view.status === 'arret') return 'critical';
  return 'unknown';
}

// Génère le HTML d'un tableau de répartition d'un côté (capteurs, écarts, équilibre, santé).
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

// Boucle principale : récupère les 3 endpoints en parallèle, met à jour l'état et redessine
// tout. Rappelée toutes les REFRESH_MS.
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

    // Si le modal ou un popover est ouvert, on le garde à jour avec les nouvelles données.
    if (state.openTanks.length) renderTankModal();
    if (state.openAlertPopoverTank) refreshAlertPopover();

    setConnectionStatus(true);
  } catch (err) {
    console.warn('Erreur de chargement du tableau de bord', err);
    setConnectionStatus(false);
  }
}

// Pastille d'alertes du bandeau supérieur (compteur + rouge si alerte majeure).
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

// Bandeau défilant des alertes (les 8 premières). Le contenu est dupliqué pour un défilement
// sans couture (voir l'animation CSS .ticker-track).
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

// Alertes d'une cuve donnée.
function alertsForTank(tank) {
  return state.alerts.filter((a) => a.tank === tank);
}

// Contenu HTML du popover d'une cuve (liste d'alertes, ou message rassurant si aucune).
function popoverContentHtml(tank) {
  const tankAlerts = alertsForTank(tank);
  return tankAlerts.length
    ? tankAlerts.map((a) => alertItemHtml(a)).join('')
    : '<p class="muted alert-popover-empty">Tout fonctionne correctement.</p>';
}

// Ouvre le petit popover d'alertes ancré près du point cliqué (repositionné pour rester dans
// l'écran).
function openAlertPopover(tank, anchorEl) {
  const popover = document.getElementById('alert-popover');
  const body = document.getElementById('alert-popover-body');
  const title = document.getElementById('alert-popover-title');
  if (!popover || !body || !title || !anchorEl) return;

  state.openAlertPopoverTank = tank;
  const tankAlerts = alertsForTank(tank);
  title.textContent = `${tank} · ${tankAlerts.length ? tankAlerts.length + ' alerte(s)' : 'Aucune alerte'}`;
  body.innerHTML = popoverContentHtml(tank);

  // Positionnement : sous le point par défaut, décalé si ça déborde à droite/en bas.
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

// Ferme le popover d'alertes.
function closeAlertPopover() {
  state.openAlertPopoverTank = null;
  const popover = document.getElementById('alert-popover');
  if (popover) popover.hidden = true;
}

// Rafraîchit le contenu du popover ouvert (sans le repositionner) au fil des mises à jour.
function refreshAlertPopover() {
  if (!state.openAlertPopoverTank) return;
  const tank = state.openAlertPopoverTank;
  const tankAlerts = alertsForTank(tank);
  setText('alert-popover-title', `${tank} · ${tankAlerts.length ? tankAlerts.length + ' alerte(s)' : 'Aucune alerte'}`);
  const body = document.getElementById('alert-popover-body');
  if (body) body.innerHTML = popoverContentHtml(tank);
}

// Construit le tableau principal des cuves (une ligne par cuve) et déclenche la barre de
// comparaison. Rappelé à chaque cycle de rafraîchissement.
function renderTankTable() {
  const tbody = document.getElementById('tank-table-body');
  if (!tbody) return;

  setText('table-subtitle', state.tankViews.length ? `${state.tankViews.length} cuve(s) suivie(s) · cliquez une ligne pour le détail` : 'Aucune cuve');

  if (state.tankViews.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="muted table-empty">Aucune cuve disponible.</td></tr>';
    renderCompareBar();
    return;
  }

  // Index cuve -> KPI (courant/tension actuels, etc.).
  const statsByTank = Object.fromEntries(state.tankStats.map((t) => [t.tank, t]));
  // Rendu compact d'une cellule de côté : pastille (équilibre/santé) + courant moyen.
  const nodeCell = (node) => {
    if (!node) return '<span class="muted">Non assigné</span>';
    const missing = node.sensor_count - node.reporting_count;
    const dotClass = missing > 0 ? 'node-cell-dot--warn' : node.balanced === false ? 'node-cell-dot--warn' : 'node-cell-dot--ok';
    const suffix = missing > 0 ? ` <span class="muted">(${node.reporting_count}/${node.sensor_count})</span>` : '';
    return `<span class="node-cell-dot ${dotClass}"></span>${node.avg_current != null ? node.avg_current + ' A' : '--'}${suffix}`;
  };

  // Cadran 4 zones du statut : chaque zone représente un capteur et sa couleur indique s'il est
  // en marche. Disposition 2×2 : colonne gauche = capteurs du côté gauche, colonne droite = côté
  // droit. Vert = en marche, rouge = à l'arrêt, gris = pas de données, pointillé = non assigné.
  const quadClass = (sensor) => {
    if (!sensor) return 'sensor-quad--empty';
    if (!sensor.reporting) return 'sensor-quad--nodata';
    return sensor.running ? 'sensor-quad--running' : 'sensor-quad--stopped';
  };
  const quadTitle = (sensor) => {
    if (!sensor) return 'Non assigné';
    const etat = !sensor.reporting ? 'pas de données' : sensor.running ? 'en marche' : 'à l’arrêt';
    return `${sensor.name} : ${etat}`;
  };
  const statusCadran = (view) => {
    const left = view.nodes?.left?.sensors || [];
    const right = view.nodes?.right?.sensors || [];
    // Ordre des zones : G1, D1, G2, D2 (rempli ligne par ligne dans la grille 2×2).
    const cells = [left[0], right[0], left[1], right[1]];
    const zones = cells
      .map((s) => `<span class="sensor-quad ${quadClass(s)}" title="${quadTitle(s)}"></span>`)
      .join('');
    return `<div class="status-cadran" role="img" aria-label="État des 4 capteurs">${zones}</div>`;
  };

  tbody.innerHTML = state.tankViews
    .map((view) => {
      const stats = statsByTank[view.tank] || {};
      const visual = statusVisual(view, state.alerts);
      const statusLabel = STATUS_LABELS[view.status] || 'Inconnu';
      const tankAlerts = alertsForTank(view.tank);
      const hasMajor = tankAlerts.some((a) => a.severity === 'major');
      const hasProblem = tankAlerts.length > 0;

      // Colonne Job masquée temporairement : pas encore de valeurs fiables à afficher. Le job
      // reste calculé côté backend (alertes de dépassement de durée) ; on n'affiche que "--" ici.
      // À réactiver quand les données de job seront correctes.
      const jobCell = '<span class="muted">--</span>';

      // Temps restant remonté par l'automate (time_remaining, en secondes). Affiché uniquement
      // si la cuve est EN MARCHE (au moins un côté actif) : un temps restant sur une cuve à
      // l'arrêt n'a pas de sens. '--' sinon (cuve arrêtée, inconnue, ou sans automate KS1/KS3).
      const tankRunning =
        view.status === 'en_cours' || view.status === 'noeud_g' || view.status === 'noeud_d';
      const timeRemaining =
        tankRunning && view.process?.time_remaining != null
          ? formatDuration(view.process.time_remaining)
          : '--';

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
        <td>
          <div class="status-cell">
            ${statusCadran(view)}
            <span class="status-badge status-badge--${visual}">${statusLabel}</span>
          </div>
        </td>
        <td>
          <div class="alert-dot-cell">
            <span class="alert-dot${hasProblem ? ' alert-dot--problem' : ''}" data-tank="${view.tank}" title="${hasProblem ? tankAlerts.length + ' alerte(s)' : 'Aucune alerte'}"></span>
            ${hasProblem ? `<span class="alert-dot-count alert-dot-count--problem">${tankAlerts.length}</span>` : ''}
          </div>
        </td>
        <td class="tabular">${stats.latest_current ?? '--'} A<br /><span class="muted">${stats.latest_voltage ?? '--'} V</span></td>
        <td class="tabular">${nodeCell(view.nodes?.left)}</td>
        <td class="tabular">${nodeCell(view.nodes?.right)}</td>
        <td>${jobCell}</td>
        <td class="tabular">${timeRemaining}</td>
        <td class="row-action">›</td>
      </tr>`;
    })
    .join('');

  // Synchronise la case "tout sélectionner" avec l'état réel des sélections.
  const selectAll = document.getElementById('select-all-tanks');
  if (selectAll) selectAll.checked = state.tankViews.every((v) => state.compareTanks.has(v.tank));

  renderCompareBar();
}

// Affiche/masque la barre de comparaison selon le nombre de cuves cochées.
function renderCompareBar() {
  const bar = document.getElementById('compare-bar');
  if (!bar) return;
  const count = state.compareTanks.size;
  bar.hidden = count === 0;
  if (count > 0) setText('compare-count', `${count} cuve(s) sélectionnée(s)`);
}

// Ouvre le modal de détail pour une cuve (string) ou plusieurs (tableau = mode comparaison).
function openTankModal(tanks) {
  const list = (Array.isArray(tanks) ? tanks : [tanks]).filter(Boolean);
  if (!list.length) return;
  state.openTanks = list;
  // Période par défaut = 'live' pour chaque cuve nouvellement ouverte.
  list.forEach((tank) => {
    if (!state.chartPeriod.has(tank)) state.chartPeriod.set(tank, 'live');
  });
  renderTankModal();
  const backdrop = document.getElementById('tank-modal-backdrop');
  if (backdrop) backdrop.hidden = false;
  document.body.classList.add('modal-open');
}

// Ferme le modal et détruit tous les graphes qu'il contenait (un par cuve ouverte).
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

// Retire une seule cuve de la comparaison (bouton × d'un bloc). Ferme le modal s'il ne reste
// plus rien, sinon le redessine.
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

// Redessine le contenu du modal pour toutes les cuves ouvertes (1 = détail simple, 2+ = grille
// de comparaison), puis (re)crée le graphe de chaque bloc selon sa période choisie.
function renderTankModal() {
  const body = document.getElementById('tank-modal-body');
  const modal = document.querySelector('.tank-modal');
  if (!body) return;

  // On ne garde que les cuves encore présentes dans les données ; sinon on ferme.
  const validTanks = state.openTanks.filter((t) => state.tankViews.some((v) => v.tank === t));
  if (!validTanks.length) {
    closeTankModal();
    return;
  }
  state.openTanks = validTanks;

  const multi = state.openTanks.length > 1;
  if (modal) modal.classList.toggle('tank-modal--wide', multi);

  const statsByTank = Object.fromEntries(state.tankStats.map((t) => [t.tank, t]));

  // On prépare un "plan" par cuve (vue, stats, période, historique en cache) puis on génère
  // tout le HTML d'un coup.
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

  // Après avoir posé le HTML, on initialise le graphe de chaque cuve : temps réel, historique
  // depuis le cache, ou récupération à la demande.
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

// Génère le HTML complet du bloc de détail d'une cuve (en-tête, consigne, sélecteur de
// période, graphe, coupures, tableaux de côté, job, process, pied de stats, alertes liées).
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

  // Contenu de la zone graphe : placeholder de chargement (historique non encore récupéré),
  // message si à l'arrêt / pas de données, sinon le canvas où sera dessiné le graphe.
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

  // Les coupures ne sont calculées que par l'endpoint d'historique, sur la chronologie réelle
  // (non synthétique) récupérée — pas pertinent pour la courte fenêtre "Direct" temps réel.
  const outagesHtml = (() => {
    if (period === 'live' || !cachedHistory?.outages) return '';
    const o = cachedHistory.outages;
    const eventsHtml = o.events.length
      ? o.events
          .slice()
          .reverse()
          .map(
            (e) =>
              `<div class="tank-outage-row">${formatDateTime(e.start)} → ${formatTime(e.end)} <span class="muted">(${formatDuration(e.duration_seconds)})</span></div>`
          )
          .join('')
      : '<p class="muted tank-outages-empty">Aucune coupure détectée sur cette période.</p>';
    return `
      <div class="tank-outages">
        <div class="tank-outages-summary">
          <div class="tank-stat">
            <span class="tank-stat-label">Coupures (${period}h)</span>
            <span class="tank-stat-value${o.count > 0 ? ' tank-stat-value--warn' : ''}">${o.count}</span>
          </div>
          <div class="tank-stat">
            <span class="tank-stat-label">Durée moyenne</span>
            <span class="tank-stat-value">${formatDuration(o.avg_duration_seconds)}</span>
          </div>
        </div>
        <div class="tank-outages-list">${eventsHtml}</div>
      </div>`;
  })();

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
        ? `<p class="modal-setpoint-caption">Consigne automate : ${view.setpoint.total} A · Consigne par capteur actif : ${view.setpoint.per_sensor ?? '--'} A/capteur (${view.sensors_active}/${view.sensors_total} capteurs en marche)</p>`
        : ''}
      <div class="modal-chart-wrap">
        ${periodSelectorHtml}
        <div class="modal-chart">${chartInner}</div>
      </div>
      ${outagesHtml}
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

// Récupère l'historique (6h/24h) d'une cuve, le met en cache, puis dessine le graphe. Gère les
// cas où la sélection a changé pendant la requête, ou où le bloc a été reconstruit entre-temps.
async function loadAndRenderHistory(tank, hours, canvasId) {
  try {
    const resp = await fetch(`/api/tank/${encodeURIComponent(tank)}/history?hours=${hours}`);
    if (!resp.ok) throw new Error('HTTP error');
    const history = await resp.json();
    state.historyData.set(tank, history);
    // La sélection période/cuve a pu changer pendant la requête : on abandonne dans ce cas.
    if (state.chartPeriod.get(tank) !== String(hours) || !state.openTanks.includes(tank)) return;
    if (!document.getElementById(canvasId)) {
      // Le bloc a été reconstruit (p.ex. par le poll de 5 s) pendant le chargement ; on
      // redessine maintenant que l'historique est en cache, pour que le graphe apparaisse.
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

// Crée le graphe "temps réel" d'une cuve (séries capteurs + automate sur axe secondaire +
// ligne de consigne). Les libellés d'axe X sont des HH:MM:SS triés chronologiquement.
function initTankModalChart(view, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Union triée de tous les horodatages (les points sont alignés par libellé de temps).
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

  // Ligne de consigne (courant attendu par capteur actif) : couleur pleine contraste + gros
  // tirets, pour qu'elle se lise clairement comme un seuil de référence, distincte des courbes.
  const setpointPerSensor = view.setpoint?.per_sensor;
  if (setpointPerSensor != null && labels.length) {
    datasets.push({
      label: `Consigne (${setpointPerSensor} A/capteur)`,
      data: labels.map(() => setpointPerSensor),
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
    // Axe fixe et partagé (0..CURRENT_AXIS_MAX) pour que chaque cuve se lise à la même échelle,
    // et pour qu'une grande valeur réelle d'automate n'écrase pas les lignes des capteurs.
    y: { min: 0, max: CURRENT_AXIS_MAX, ticks: { color: chartAxisColor() }, grid: { color: chartGridColor() } },
  };
  if (hasAutomate) {
    // L'automate garde sa propre échelle interne (pour ne pas écraser les capteurs) mais sans
    // graduation visible, afin d'éviter une 2e échelle de chiffres déroutante sur le graphe.
    scales.y1 = { position: 'right', min: 0, ticks: { display: false }, grid: { display: false } };
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

// Crée le graphe "historique" (6h/24h) d'une cuve. Contrairement au temps réel, les points
// portent un horodatage ISO complet : on trie par date réelle et on formate les libellés selon
// l'étendue (heure seule si <= 6h, sinon jour + heure car la plage peut franchir minuit).
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
    // Idem que pour le graphe temps réel : échelle interne conservée, graduation masquée.
    scales.y1 = { position: 'right', min: 0, ticks: { display: false }, grid: { display: false } };
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

// Fermeture du modal : bouton ×, clic sur le fond, ou touche Échap.
document.getElementById('tank-modal-close')?.addEventListener('click', closeTankModal);
document.getElementById('tank-modal-backdrop')?.addEventListener('click', (event) => {
  if (event.target.id === 'tank-modal-backdrop') closeTankModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.openTanks.length) closeTankModal();
});

// Gestionnaires de clic délégués : attachés une seule fois à des conteneurs jamais remplacés
// (seuls leurs enfants sont redessinés à chaque poll), pour qu'un clic tombe toujours sur un
// écouteur vivant même si le tableau/bandeau/alertes se redessinent en plein clic.
document.getElementById('tank-table-body')?.addEventListener('click', (event) => {
  // Case à cocher : ajoute/retire la cuve de la comparaison (sans ouvrir le modal).
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
  // Point d'alerte : ouvre/ferme le popover de la cuve (sans ouvrir le modal).
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
  // Sinon, un clic n'importe où sur la ligne ouvre le modal de détail.
  const row = event.target.closest('.tank-row');
  if (row) openTankModal(row.dataset.tank);
});
// Accessibilité clavier : Entrée/Espace sur une ligne ouvre aussi le modal.
document.getElementById('tank-table-body')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.tank-row');
  if (row) {
    event.preventDefault();
    openTankModal(row.dataset.tank);
  }
});
// Clic sur un item du bandeau défilant -> ouvre le modal de la cuve concernée.
document.getElementById('alert-ticker-track')?.addEventListener('click', (event) => {
  const item = event.target.closest('.ticker-item--clickable');
  if (item && item.dataset.tank) openTankModal(item.dataset.tank);
});

// Barre de comparaison : tout sélectionner / effacer / ouvrir la comparaison.
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

// Clics à l'intérieur du modal : retirer une cuve, ou changer la période d'un graphe.
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

// Fermeture du popover d'alertes : bouton ×, clic en dehors, Échap, ou défilement.
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
// Au défilement, on ferme le popover (sa position est figée au moment de l'ouverture).
window.addEventListener(
  'scroll',
  () => {
    if (state.openAlertPopoverTank) closeAlertPopover();
  },
  true
);

// Premier chargement immédiat, puis rafraîchissement automatique toutes les REFRESH_MS.
loadDashboard();
setInterval(loadDashboard, REFRESH_MS);
