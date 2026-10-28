/**
 * FreeRAM — logique de l'interface (renderer sandboxé).
 *
 * Aucun accès direct à Node.js, au système de fichiers ou à PowerShell :
 * tout passe par l'API limitée exposée par preload.js. Les valeurs affichées
 * viennent du processus principal ; aucune température n'est inventée.
 */

import {
  clamp,
  formatBytes,
  formatDelta,
  formatPercent,
  formatPidList,
  formatSeconds,
  formatTemperature,
  formatClock,
  hueForName,
  initialForName,
  normalizeSearch
} from './format.js';

const api = window.freeRAM;
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_TOASTS = 4;

const STATUS_LABELS = {
  closed: { label: 'Fermée', icon: '#i-check' },
  active: { label: 'Toujours active', icon: '#i-alert' },
  restarted: { label: 'Relancée automatiquement', icon: '#i-refresh' },
  denied: { label: 'Erreur d’accès', icon: '#i-lock' }
};

const ENGINE_LABELS = {
  '3D': '3D',
  Copy: 'copie',
  VideoDecode: 'décodage vidéo',
  VideoEncode: 'encodage vidéo',
  Compute: 'calcul',
  Other: 'autre moteur'
};

const state = {
  app: null,
  config: null,
  paths: null,
  memory: null,
  cpu: null,
  sensors: null,
  sensorStatus: null,
  processes: null,
  processError: null,
  admin: false,
  protectedCount: 0,
  warnings: [],
  lastTelemetryAt: null,
  lastProcessesAt: null,
  paused: false,
  refreshing: false,
  selection: new Set(),
  expanded: new Set(),
  view: 'grouped',
  search: '',
  maxSelection: 256,
  topCount: 256,
  closeActive: false,
  closeStartedAt: 0,
  closeDeadline: 0,
  closeDelay: 5000,
  closeForce: true,
  countdownFrame: null,
  closeTimer: null,
  pendingClosePids: [],
  pendingTrim: null,
  trimActive: false,
  settingsDirty: false,
  sensorErrorShown: false,
  updateState: null,
  buildCapability: null,
  buildStatus: null,
  buildStarting: false
};

const refs = {};

// ---------------------------------------------------------------------------
// Utilitaires DOM
// ---------------------------------------------------------------------------

function cacheRefs() {
  const ids = [
    'refresh-btn', 'refresh-icon', 'free-btn', 'search-input', 'selection-counter',
    'clear-selection', 'process-list', 'empty-state', 'processes-subtitle',
    'selection-summary', 'selection-hint', 'trim-selected-btn', 'close-selected-btn',
    'cpu-value', 'cpu-sub', 'gpu-value', 'gpu-sub', 'admin-pill', 'admin-label',
    'pill-cpu', 'pill-gpu', 'sensor-cpu-temp', 'sensor-gpu-temp', 'sensor-gpu-info',
    'settings-btn', 'ram-percent', 'gauge-available', 'gauge-total', 'stat-total',
    'stat-total-sub', 'stat-used', 'stat-used-sub', 'stat-available',
    'stat-available-sub', 'stat-processes', 'stat-processes-sub', 'cpu-temp-value',
    'cpu-temp-note', 'gpu-temp-value', 'gpu-temp-note', 'gpu-name', 'gpu-info-note',
    'sensor-help-btn', 'refresh-label', 'live-dot', 'footer-sensors-text',
    'footer-updated', 'footer-version', 'gauge-progress', 'gauge-head', 'gauge',
    'close-dialog', 'close-dialog-subtitle', 'close-confirm-list', 'force-checkbox',
    'force-row', 'close-admin-note', 'confirm-close-btn', 'progress-dialog',
    'progress-eyebrow', 'progress-dialog-title', 'progress-dialog-subtitle',
    'progress-close-x', 'progress-view', 'countdown-value', 'countdown-number',
    'operation-steps', 'progress-message', 'results-view', 'results-summary',
    'results-list', 'memory-delta', 'delta-before', 'delta-after', 'delta-change',
    'result-warnings', 'modal-timer', 'progress-done-btn', 'trim-dialog',
    'trim-dialog-subtitle', 'trim-target-text', 'confirm-trim-btn', 'settings-dialog',
    'settings-version', 'settings-electron', 'settings-windows', 'settings-cpu',
    'settings-memory', 'settings-admin', 'settings-sensors', 'settings-protected',
    'settings-status', 'settings-reload-ui', 'settings-create-shortcut',
    'settings-relaunch-admin', 'settings-relaunch', 'settings-temp-help', 'toast-stack',
    'github-btn', 'settings-update-channel', 'settings-update-status',
    'settings-update-version', 'settings-update-progress-wrap', 'settings-update-progress',
    'settings-update-help', 'settings-update-check', 'settings-update-download',
    'settings-update-install', 'settings-update-github', 'settings-build-help',
    'settings-build-status', 'settings-build', 'settings-build-log'
  ];
  for (const id of ids) refs[id] = $(id);
  refs.stepElements = {};
  if (refs['operation-steps']) {
    for (const li of refs['operation-steps'].querySelectorAll('li[data-step]')) {
      refs.stepElements[li.dataset.step] = li;
    }
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(symbol, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', symbol);
  svg.appendChild(use);
  return svg;
}

function avatar(name) {
  const node = el('span', 'avatar', initialForName(name));
  node.style.setProperty('--hue', String(hueForName(name)));
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function plural(count, singular, pluralForm) {
  const fallback = /[sx]$/i.test(singular) ? singular : `${singular}s`;
  return `${count} ${count === 1 ? singular : pluralForm || fallback}`;
}

function decimals(milliseconds) {
  return (Math.max(0, milliseconds) / 1000).toFixed(1).replace('.', ',');
}

function sortByMemory(a, b) {
  return b.memoryBytes - a.memoryBytes || a.nameLower.localeCompare(b.nameLower);
}

function processMap() {
  const map = new Map();
  if (state.processes?.processes) {
    for (const proc of state.processes.processes) map.set(proc.pid, proc);
  }
  return map;
}

function selectedProcesses() {
  const map = processMap();
  return [...state.selection]
    .map((pid) => map.get(pid))
    .filter(Boolean)
    .sort(sortByMemory);
}

function selectionBytes() {
  return selectedProcesses().reduce((sum, proc) => sum + proc.memoryBytes, 0);
}

function protectedReason(group) {
  const reasons = [...new Set(group.processes.map((proc) => proc.protectionReason).filter(Boolean))];
  return reasons.join(' ');
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(type, title, message = '', timeout = 6000) {
  if (!refs['toast-stack']) return;
  if (refs['toast-stack'].children.length >= MAX_TOASTS) {
    refs['toast-stack'].firstElementChild?.remove();
  }

  const node = el('div', `toast ${type}`);
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  node.appendChild(icon(type === 'success' ? '#i-check' : type === 'error' ? '#i-alert' : '#i-info'));
  const body = el('div');
  body.appendChild(el('strong', '', title));
  if (message) body.appendChild(el('p', '', message));
  node.appendChild(body);
  refs['toast-stack'].appendChild(node);

  const remove = () => {
    if (!node.isConnected) return;
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  };
  setTimeout(remove, timeout);
  node.addEventListener('click', remove);
}

// ---------------------------------------------------------------------------
// Mémoire, CPU, GPU, températures
// ---------------------------------------------------------------------------

function setText(node, value) {
  if (node) node.textContent = value;
}

function renderMemory() {
  const memory = state.memory;
  if (!memory) return;

  const percent = clamp(Number(memory.usedPercent) || 0, 0, 100);
  setText(refs['ram-percent'], formatPercent(percent));
  setText(refs['gauge-available'], formatBytes(memory.availableBytes));
  setText(refs['gauge-total'], formatBytes(memory.totalBytes));

  const circumference = 2 * Math.PI * 104;
  const progress = refs['gauge-progress'];
  if (progress) {
    progress.style.strokeDasharray = String(circumference);
    progress.style.strokeDashoffset = String(circumference * (1 - percent / 100));
  }

  const head = refs['gauge-head'];
  if (head) {
    const angle = ((percent / 100) * 360 - 90) * (Math.PI / 180);
    head.setAttribute('cx', String(130 + 104 * Math.cos(angle)));
    head.setAttribute('cy', String(130 + 104 * Math.sin(angle)));
  }

  if (refs.gauge) {
    refs.gauge.classList.toggle('is-warn', percent >= 78 && percent < 90);
    refs.gauge.classList.toggle('is-critical', percent >= 90);
  }

  setText(refs['stat-total'], formatBytes(memory.totalBytes));
  setText(refs['stat-total-sub'], 'mémoire physique installée');
  setText(refs['stat-used'], formatBytes(memory.usedBytes));
  setText(refs['stat-used-sub'], `${formatPercent(memory.usedPercent)} de la mémoire`);
  setText(refs['stat-available'], formatBytes(memory.availableBytes));
  setText(refs['stat-available-sub'], `${formatPercent(memory.availablePercent)} disponible`);
}

function renderCpu() {
  const cpu = state.cpu;
  setText(refs['cpu-value'], cpu ? formatPercent(cpu.percent) : '—');
  setText(
    refs['cpu-sub'],
    cpu ? `U ${formatPercent(cpu.userPercent)} · S ${formatPercent(cpu.systemPercent)}` : 'échantillon…'
  );
  if (refs['pill-cpu']) {
    refs['pill-cpu'].title = cpu
      ? `Charge CPU moyenne : ${formatPercent(cpu.percent)}\nUtilisateur : ${formatPercent(
          cpu.userPercent
        )}\nSystème : ${formatPercent(cpu.systemPercent)}`
      : 'Charge CPU en cours de mesure';
  }
}

function engineLabel(engine) {
  if (!engine) return 'moteur actif';
  return ENGINE_LABELS[engine] || String(engine);
}

function renderGpu() {
  const gpu = state.sensors?.gpu;
  const utilization = gpu?.utilizationPercent;
  setText(
    refs['gpu-value'],
    Number.isFinite(utilization) ? formatPercent(utilization) : '—'
  );
  setText(refs['gpu-sub'], Number.isFinite(utilization) ? engineLabel(gpu.engine) : 'indisponible');

  const hardware = state.sensors?.hardware;
  const name = hardware?.name || gpu?.name || '—';
  setText(refs['gpu-name'], name || '—');

  if (gpu && Number.isFinite(gpu.dedicatedUsedBytes)) {
    let note = `VRAM dédiée utilisée : ${formatBytes(gpu.dedicatedUsedBytes)}`;
    const total = hardware?.vramTotalBytes ?? gpu.vramTotalBytes;
    if (Number.isFinite(total) && total > 0) {
      note += ` / ${formatBytes(total)}`;
    }
    setText(refs['gpu-info-note'], note);
  } else if (gpu) {
    setText(refs['gpu-info-note'], 'compteurs VRAM indisponibles');
  } else {
    setText(refs['gpu-info-note'], 'en attente des compteurs Windows…');
  }

  if (refs['pill-gpu']) {
    refs['pill-gpu'].title = gpu
      ? `GPU : ${engineLabel(gpu.engine)} (compteurs Windows)${
          Number.isFinite(gpu.dedicatedUsedBytes)
            ? `\nVRAM dédiée utilisée : ${formatBytes(gpu.dedicatedUsedBytes)}`
            : ''
        }`
      : 'Compteurs GPU Windows indisponibles ou en cours de lecture';
  }
}

function setTemperature(nodeValue, nodeNote, celsius, source, fallbackNote) {
  const formatted = formatTemperature(celsius);
  if (formatted) {
    setText(nodeValue, formatted);
    nodeValue?.classList.remove('unavailable');
    setText(nodeNote, source ? `via ${source}` : 'capteur disponible');
  } else {
    setText(nodeValue, 'Indisponible');
    nodeValue?.classList.add('unavailable');
    setText(nodeNote, fallbackNote || 'capteur non exposé');
  }
}

function renderTemperatures() {
  const temperatures = state.sensors?.temperatures;
  const cpu = temperatures?.cpuCelsius;
  const gpu = temperatures?.gpuCelsius;
  const source = temperatures?.source;
  const system = temperatures?.systemCelsius;

  setTemperature(
    refs['cpu-temp-value'],
    refs['cpu-temp-note'],
    cpu,
    source,
    Number.isFinite(system)
      ? `sonde système : ${formatTemperature(system)} (pas le CPU)`
      : 'capteur non exposé par Windows'
  );
  setTemperature(
    refs['gpu-temp-value'],
    refs['gpu-temp-note'],
    gpu,
    source,
    'pilote ou outil tiers requis'
  );

  if (refs['sensor-cpu-temp']) {
    refs['sensor-cpu-temp'].title = Number.isFinite(cpu)
      ? `Température CPU fournie par ${source || 'un capteur local'}`
      : 'Windows ne fournit pas de température CPU exploitable sur ce système.';
  }
}

function sensorStatusText() {
  const status = state.sensorStatus;
  const providers = state.sensors?.sensorProviders;
  if (status?.state === 'starting') return 'Initialisation des capteurs GPU…';
  if (status?.state === 'unavailable') return 'Collecteur de capteurs indisponible';
  if (providers?.libreHardwareMonitor) return 'Températures : LibreHardwareMonitor';
  if (providers?.openHardwareMonitor) return 'Températures : OpenHardwareMonitor';
  if (providers || state.sensors) {
    return 'Températures indisponibles · GPU via les compteurs Windows';
  }
  return 'Capteurs en cours d’initialisation…';
}

function renderSensors() {
  renderGpu();
  renderTemperatures();
  setText(refs['footer-sensors-text'], sensorStatusText());
  renderSettings();
}

function renderProcessStats() {
  const snapshot = state.processes;
  if (!snapshot) {
    setText(refs['stat-processes'], '—');
    setText(refs['stat-processes-sub'], 'somme des working sets');
    return;
  }
  if (refs['stat-processes']) {
    setText(refs['stat-processes'], formatBytes(snapshot.processMemorySumBytes));
  }
  const count = snapshot.processCount ?? snapshot.visibleCount ?? snapshot.processes?.length ?? 0;
  setText(refs['stat-processes-sub'], `${plural(count, 'processus')} · working sets`);
}

function renderTelemetry() {
  renderMemory();
  renderCpu();
  renderGpu();
  renderTemperatures();
  renderProcessStats();
  setText(
    refs['footer-updated'],
    `Dernière actualisation : ${formatClock(state.lastTelemetryAt || state.memory?.timestamp)}`
  );
  if (refs['footer-sensors-text']) {
    setText(refs['footer-sensors-text'], sensorStatusText());
  }
  renderSettings();
}

function applyTelemetry(payload) {
  if (!payload) return;
  if (payload.memory) state.memory = payload.memory;
  if (payload.cpu) state.cpu = payload.cpu;
  if (payload.sensors !== undefined && payload.sensors !== null) state.sensors = payload.sensors;
  if (payload.sensorStatus) state.sensorStatus = payload.sensorStatus;
  if (payload.timestamp) state.lastTelemetryAt = payload.timestamp;
  renderTelemetry();
}

function applySensorSample(payload) {
  if (!payload) return;
  if (payload.sensors) state.sensors = payload.sensors;
  if (payload.sensorStatus) state.sensorStatus = payload.sensorStatus;
  renderSensors();
}

function applySensorStatus(status) {
  if (!status) return;
  state.sensorStatus = status;
  if (status.state === 'unavailable' && status.error && !state.sensorErrorShown) {
    state.sensorErrorShown = true;
    toast(
      'info',
      'Collecteur de capteurs indisponible',
      'Les températures restent « Indisponible ». Les compteurs GPU peuvent réapparaître automatiquement.'
    );
  }
  if (status.state === 'ok') state.sensorErrorShown = false;
  renderSensors();
}

// ---------------------------------------------------------------------------
// Groupes et lignes de processus
// ---------------------------------------------------------------------------

function collectGroups() {
  const groups = new Map();
  for (const proc of state.processes?.processes || []) {
    let group = groups.get(proc.nameLower);
    if (!group) {
      group = {
        key: proc.nameLower,
        name: proc.name,
        nameLower: proc.nameLower,
        processes: [],
        memoryBytes: 0,
        protectedCount: 0,
        selectablePids: []
      };
      groups.set(proc.nameLower, group);
    }
    group.processes.push(proc);
    group.memoryBytes += proc.memoryBytes;
    if (proc.protected) {
      group.protectedCount += 1;
    } else {
      group.selectablePids.push(proc.pid);
    }
  }

  for (const group of groups.values()) {
    group.processes.sort(sortByMemory);
  }
  return [...groups.values()].sort(
    (a, b) => b.memoryBytes - a.memoryBytes || a.nameLower.localeCompare(b.nameLower)
  );
}

function groupMatches(group, query) {
  if (!query) return true;
  if (group.nameLower.includes(query)) return true;
  return group.processes.some((proc) => String(proc.pid).includes(query));
}

function checkboxNode(mode) {
  const node = el('span', 'row-check');
  node.setAttribute('role', 'checkbox');
  if (mode === 'locked') {
    node.classList.add('is-locked');
    node.setAttribute('aria-disabled', 'true');
    node.setAttribute('aria-checked', 'false');
    node.setAttribute('title', 'Processus protégé : sélection impossible');
    node.appendChild(icon('#i-lock'));
  } else if (mode === 'checked') {
    node.classList.add('is-checked');
    node.setAttribute('aria-checked', 'true');
    node.appendChild(icon('#i-check'));
  } else if (mode === 'indeterminate') {
    node.classList.add('is-indeterminate');
    node.setAttribute('aria-checked', 'mixed');
  } else {
    node.setAttribute('aria-checked', 'false');
  }
  return node;
}

function groupCheckMode(group) {
  if (group.selectablePids.length === 0) return 'locked';
  const selected = group.selectablePids.filter((pid) => state.selection.has(pid)).length;
  if (selected === 0) return 'empty';
  if (selected === group.selectablePids.length) return 'checked';
  return 'indeterminate';
}

function makeGroupRow(group, maxMemory) {
  const row = el('div', 'process-row');
  row.dataset.group = group.key;
  row.tabIndex = 0;
  row.setAttribute('role', 'listitem');

  const mode = groupCheckMode(group);
  row.appendChild(checkboxNode(mode));

  const identity = el('div', 'proc-identity');
  identity.appendChild(avatar(group.name));
  const text = el('div', 'proc-text');
  const nameLine = el('span', 'proc-name');
  nameLine.appendChild(el('span', 'name-label', group.name));
  if (group.processes.length > 1) {
    const badge = el('span', 'count-badge', String(group.processes.length));
    badge.title = plural(group.processes.length, 'processus');
    nameLine.appendChild(badge);
  }
  if (group.protectedCount > 0) {
    const badge = el('span', 'protected-badge');
    badge.appendChild(icon('#i-shield'));
    badge.appendChild(document.createTextNode('Protégé'));
    badge.title = protectedReason(group) || 'Processus protégé par FreeRAM';
    nameLine.appendChild(badge);
  }
  text.appendChild(nameLine);

  const meta = el(
    'span',
    'proc-meta',
    group.protectedCount === group.processes.length
      ? `${plural(group.processes.length, 'processus protégé')} · fermeture impossible`
      : `${plural(group.processes.length, 'processus')}${
          group.processes.length > 1 ? ' · détail par PID' : ''
        }`
  );
  if (group.protectedCount === group.processes.length) {
    meta.title = protectedReason(group);
  } else if (group.processes.length > 1) {
    meta.title = `PID : ${formatPidList(group.processes.map((proc) => proc.pid), 20)}`;
  }
  text.appendChild(meta);
  identity.appendChild(text);
  row.appendChild(identity);

  const memoryCell = el('div', 'proc-memory');
  const memoryValue = el('span', 'memory-value', formatBytes(group.memoryBytes));
  const total = state.memory?.totalBytes;
  if (Number.isFinite(total) && total > 0) {
    memoryValue.appendChild(el('small', '', formatPercent((group.memoryBytes / total) * 100)));
  }
  memoryCell.appendChild(memoryValue);
  const bar = el('span', 'mini-bar');
  const fill = el('span');
  fill.style.width = `${clamp((group.memoryBytes / Math.max(1, maxMemory)) * 100, 2, 100)}%`;
  bar.appendChild(fill);
  memoryCell.appendChild(bar);
  row.appendChild(memoryCell);

  const pidCell = el('div', 'proc-pid');
  if (group.processes.length === 1) {
    pidCell.textContent = String(group.processes[0].pid);
  } else {
    pidCell.textContent = `${group.processes.length} PID`;
    pidCell.title = formatPidList(group.processes.map((proc) => proc.pid), 20);
  }
  row.appendChild(pidCell);

  if (group.processes.length > 1) {
    const expand = el('button', 'expand-button');
    expand.type = 'button';
    expand.dataset.action = 'expand';
    expand.title = state.expanded.has(group.key) ? 'Masquer les PID' : 'Afficher les PID';
    expand.setAttribute('aria-label', expand.title);
    const isExpanded = state.expanded.has(group.key);
    if (isExpanded) expand.classList.add('is-expanded');
    expand.setAttribute('aria-expanded', String(isExpanded));
    expand.appendChild(icon('#i-chevron'));
    expand.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleExpanded(group.key);
    });
    row.appendChild(expand);
  } else {
    row.appendChild(el('span', 'expand-spacer'));
  }

  if (mode === 'locked') {
    row.classList.add('is-protected');
    row.title = protectedReason(group) || 'Processus protégé';
    row.setAttribute('aria-disabled', 'true');
  } else {
    row.removeAttribute('title');
  }
  if (group.selectablePids.some((pid) => state.selection.has(pid))) {
    row.classList.add('is-selected');
  }

  const activate = () => {
    if (group.selectablePids.length === 0) {
      if (group.processes.length > 1) toggleExpanded(group.key);
      else toast('info', 'Processus protégé', protectedReason(group) || 'FreeRAM ne ferme pas ce processus.');
      return;
    }
    toggleGroup(group);
  };

  row.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="expand"]')) return;
    activate();
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });

  return row;
}

function makeProcessRow(proc, maxMemory) {
  const row = el('div', 'process-row instance');
  row.dataset.pid = String(proc.pid);
  row.tabIndex = 0;
  row.setAttribute('role', 'listitem');

  const mode = proc.protected ? 'locked' : state.selection.has(proc.pid) ? 'checked' : 'empty';
  row.appendChild(checkboxNode(mode));

  const identity = el('div', 'proc-identity');
  identity.appendChild(avatar(proc.name));
  const text = el('div', 'proc-text');
  const nameLine = el('span', 'proc-name');
  nameLine.appendChild(el('span', 'name-label', proc.name));
  text.appendChild(nameLine);
  const meta = el(
    'span',
    'proc-meta',
    proc.protected ? 'processus protégé' : `session ${proc.sessionNumber} · PID ${proc.pid}`
  );
  if (proc.protected) meta.title = proc.protectionReason || 'Processus protégé';
  text.appendChild(meta);
  identity.appendChild(text);
  row.appendChild(identity);

  const memoryCell = el('div', 'proc-memory');
  const memoryValue = el('span', 'memory-value', formatBytes(proc.memoryBytes));
  const total = state.memory?.totalBytes;
  if (Number.isFinite(total) && total > 0) {
    memoryValue.appendChild(el('small', '', formatPercent((proc.memoryBytes / total) * 100)));
  }
  memoryCell.appendChild(memoryValue);
  const bar = el('span', 'mini-bar');
  const fill = el('span');
  fill.style.width = `${clamp((proc.memoryBytes / Math.max(1, maxMemory)) * 100, 2, 100)}%`;
  bar.appendChild(fill);
  memoryCell.appendChild(bar);
  row.appendChild(memoryCell);

  const pidCell = el('div', 'proc-pid', String(proc.pid));
  row.appendChild(pidCell);
  row.appendChild(el('span', 'expand-spacer'));

  if (proc.protected) {
    row.classList.add('is-protected');
    row.title = proc.protectionReason || 'Processus protégé';
    row.setAttribute('aria-disabled', 'true');
  }
  if (state.selection.has(proc.pid)) row.classList.add('is-selected');

  const activate = () => {
    if (proc.protected) {
      toast('info', 'Processus protégé', proc.protectionReason || 'FreeRAM ne ferme pas ce processus.');
      return;
    }
    togglePid(proc.pid);
  };

  row.addEventListener('click', activate);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });

  return row;
}

function toggleExpanded(key) {
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  renderProcesses();
}

function renderProcesses() {
  if (!refs['process-list']) return;
  refs['process-list'].textContent = '';

  const snapshot = state.processes;
  if (!snapshot || !Array.isArray(snapshot.processes)) {
    setText(refs['processes-subtitle'], state.processError || 'Chargement des processus…');
    refs['empty-state'].hidden = true;
    renderSelectionUi();
    return;
  }

  pruneSelection();
  const query = normalizeSearch(state.search);
  const totalProcesses = snapshot.processCount ?? snapshot.processes.length;
  const fragment = document.createDocumentFragment();

  if (state.view === 'grouped') {
    const allGroups = collectGroups();
    const matching = query ? allGroups.filter((group) => groupMatches(group, query)) : allGroups;
    const visible = query ? matching : matching.slice(0, state.topCount);
    const maxMemory = Math.max(1, ...visible.map((group) => group.memoryBytes));

    for (const group of visible) {
      fragment.appendChild(makeGroupRow(group, maxMemory));
      if (state.expanded.has(group.key) && group.processes.length > 1) {
        const childMax = Math.max(1, ...group.processes.map((proc) => proc.memoryBytes));
        for (const proc of group.processes) {
          fragment.appendChild(makeProcessRow(proc, childMax));
        }
      }
    }

    const subtitle = query
      ? `${plural(matching.length, 'application')} correspondante${
          matching.length > 1 ? 's' : ''
        } sur ${plural(allGroups.length, 'application')}`
      : `${plural(visible.length, 'application')}${
          visible.length < allGroups.length ? ` sur ${allGroups.length}` : ''
        } · ${plural(totalProcesses, 'processus')} · tri par mémoire`;
    setText(refs['processes-subtitle'], subtitle);
    refs['empty-state'].hidden = visible.length > 0;
  } else {
    const all = [...snapshot.processes].sort(sortByMemory);
    const matching = query
      ? all.filter((proc) => proc.nameLower.includes(query) || String(proc.pid).includes(query))
      : all;
    const visible = query ? matching.slice(0, 200) : matching.slice(0, state.topCount);
    const maxMemory = Math.max(1, ...visible.map((proc) => proc.memoryBytes));

    for (const proc of visible) fragment.appendChild(makeProcessRow(proc, maxMemory));

    const subtitle = query
      ? `${plural(matching.length, 'processus')} correspondant${
          matching.length > 1 ? 's' : ''
        } sur ${plural(totalProcesses, 'processus')}`
      : `${plural(visible.length, 'processus')}${
          visible.length < totalProcesses ? ` sur ${plural(totalProcesses, 'processus')}` : ''
        } · tri par mémoire`;
    setText(refs['processes-subtitle'], subtitle);
    refs['empty-state'].hidden = visible.length > 0;
  }

  refs['process-list'].appendChild(fragment);
  renderSelectionUi();
}

function pruneSelection() {
  if (!state.processes?.processes) return;
  const map = processMap();
  let changed = false;
  for (const pid of [...state.selection]) {
    const proc = map.get(pid);
    if (!proc || proc.protected) {
      state.selection.delete(pid);
      changed = true;
    }
  }
  if (changed) renderSelectionUi();
}

function togglePid(pid) {
  if (state.selection.has(pid)) {
    state.selection.delete(pid);
    renderProcesses();
    return;
  }
  if (state.selection.size >= state.maxSelection) {
    toast(
      'info',
      'Limite de sélection atteinte',
      `Vous pouvez sélectionner au maximum ${state.maxSelection} processus à la fois.`
    );
    return;
  }
  state.selection.add(pid);
  renderProcesses();
}

function toggleGroup(group) {
  const selectable = group.selectablePids;
  if (selectable.length === 0) return;
  const allSelected = selectable.every((pid) => state.selection.has(pid));

  if (allSelected) {
    for (const pid of selectable) state.selection.delete(pid);
    renderProcesses();
    return;
  }

  const room = state.maxSelection - state.selection.size;
  if (room <= 0) {
    const selectedInGroup = selectable.filter((pid) => state.selection.has(pid));
    if (selectedInGroup.length > 0) {
      for (const pid of selectedInGroup) state.selection.delete(pid);
      renderProcesses();
      toast(
        'info',
        'Sélection retirée',
        `La limite de ${state.maxSelection} processus était atteinte : la sélection de ${group.name} a été retirée.`
      );
      return;
    }
    toast(
      'info',
      'Limite de sélection atteinte',
      `Vous pouvez sélectionner au maximum ${state.maxSelection} processus à la fois.`
    );
    return;
  }

  const missing = selectable.filter((pid) => !state.selection.has(pid));
  for (const pid of missing.slice(0, room)) state.selection.add(pid);

  if (missing.length > room) {
    toast(
      'info',
      'Sélection limitée',
      `Seuls ${room} processus de ${group.name} ont été ajoutés pour respecter la limite de ${state.maxSelection}.`
    );
  }
  renderProcesses();
}

// ---------------------------------------------------------------------------
// Barre de sélection et contrôles
// ---------------------------------------------------------------------------

function renderSelectionUi() {
  const selected = selectedProcesses();
  const count = selected.length;
  const bytes = selected.reduce((sum, proc) => sum + proc.memoryBytes, 0);
  const busy = state.closeActive || state.trimActive;

  setText(refs['selection-counter'], `${count} / ${state.maxSelection} sélectionné${count > 1 ? 's' : ''}`);
  refs['selection-counter']?.classList.toggle('has-selection', count > 0);
  refs['clear-selection'].disabled = count === 0 || busy;
  refs['trim-selected-btn'].disabled = count === 0 || busy;
  refs['close-selected-btn'].disabled = count === 0 || busy;

  if (count === 0) {
    setText(refs['selection-summary'], 'Aucun processus sélectionné');
    setText(
      refs['selection-hint'],
      `Sélectionnez jusqu'à ${state.maxSelection} processus, puis fermez-les en toute sécurité.`
    );
  } else {
    setText(
      refs['selection-summary'],
      `${plural(count, 'processus sélectionné')} · ${formatBytes(bytes)}`
    );
    setText(
      refs['selection-hint'],
      'La fermeture normale est tentée d’abord, puis vérifiée précisément après 5 s.'
    );
  }

  if (refs['free-btn']) refs['free-btn'].disabled = busy;
  if (refs['refresh-btn']) refs['refresh-btn'].disabled = busy || state.refreshing;
}

// ---------------------------------------------------------------------------
// Actions : fermeture
// ---------------------------------------------------------------------------

function selectedGroups() {
  const groups = new Map();
  for (const proc of selectedProcesses()) {
    let group = groups.get(proc.nameLower);
    if (!group) {
      group = { name: proc.name, nameLower: proc.nameLower, processes: [], bytes: 0 };
      groups.set(proc.nameLower, group);
    }
    group.processes.push(proc);
    group.bytes += proc.memoryBytes;
  }
  return [...groups.values()].sort(
    (a, b) => b.bytes - a.bytes || a.nameLower.localeCompare(b.nameLower)
  );
}

function openCloseDialog() {
  if (state.closeActive || state.trimActive) return;
  const selected = selectedProcesses();
  if (selected.length === 0) {
    toast('info', 'Aucune sélection', 'Sélectionnez au moins un processus à fermer.');
    return;
  }

  state.pendingClosePids = selected.map((proc) => proc.pid);
  const groups = selectedGroups();
  const bytes = selected.reduce((sum, proc) => sum + proc.memoryBytes, 0);

  setText(
    refs['close-dialog-subtitle'],
    `${plural(groups.length, 'application')} · ${plural(selected.length, 'processus')} · ${formatBytes(
      bytes
    )} de working sets`
  );

  refs['close-confirm-list'].textContent = '';
  for (const group of groups) {
    const row = el('div', 'confirm-app');
    row.appendChild(avatar(group.name));
    const text = el('div', 'confirm-app-text');
    text.appendChild(el('strong', '', group.name));
    text.appendChild(
      el(
        'span',
        '',
        `${plural(group.processes.length, 'processus')} · ${formatBytes(group.bytes)}`
      )
    );
    row.appendChild(text);
    row.appendChild(el('span', 'confirm-pids', formatPidList(group.processes.map((proc) => proc.pid))));
    refs['close-confirm-list'].appendChild(row);
  }

  const forceAvailable = Boolean(state.config?.closing?.forceAfterDelay);
  refs['force-checkbox'].checked = forceAvailable;
  refs['force-checkbox'].disabled = !forceAvailable;
  refs['force-row'].hidden = false;
  refs['close-admin-note'].hidden = state.admin;
  refs['confirm-close-btn'].disabled = false;

  refs['close-dialog'].showModal();
}

function resetProgressDialog() {
  refs['results-view'].hidden = true;
  refs['progress-view'].hidden = false;
  refs['results-summary'].textContent = '';
  refs['results-list'].textContent = '';
  refs['result-warnings'].textContent = '';
  refs['memory-delta'].hidden = true;
  refs['progress-close-x'].hidden = true;
  refs['progress-done-btn'].hidden = true;
  setText(refs['modal-timer'], 'Opération en cours…');
  setText(refs['progress-message'], '');
  setText(refs['countdown-number'], '0,0');
  for (const node of Object.values(refs.stepElements)) {
    node.classList.remove('is-active', 'is-done');
  }
}

async function startCloseFlow() {
  const pids = state.pendingClosePids.slice();
  if (pids.length === 0) return;
  const force = refs['force-checkbox'].checked && state.config?.closing?.forceAfterDelay !== false;
  state.closeForce = force;

  if (refs['close-dialog'].open) refs['close-dialog'].close();
  state.closeActive = true;
  state.closeStartedAt = performance.now();
  state.closeDelay = Math.max(1000, Number(state.config?.closing?.verificationDelayMs) || 5000);
  state.closeDeadline = state.closeStartedAt + state.closeDelay;

  resetProgressDialog();
  setText(refs['progress-eyebrow'], 'Fermeture en cours');
  setText(refs['progress-dialog-title'], 'Fermeture et vérification…');
  setText(
    refs['progress-dialog-subtitle'],
    `${plural(pids.length, 'processus')} · vérification prévue ${formatSeconds(state.closeDelay)} après la demande.`
  );
  setText(refs['progress-message'], 'Envoi des demandes de fermeture normale…');
  setProgressStage('closing');
  if (refs.stepElements.forcing) refs.stepElements.forcing.hidden = !force;
  setCountdown(state.closeDelay, state.closeDelay);
  refs['progress-dialog'].showModal();
  renderSelectionUi();

  animateCountdown();
  refreshModalTimer();
  state.closeTimer = setInterval(refreshModalTimer, 250);

  try {
    const result = await api.closeProcesses(pids, { force });
    if (!result || result.ok === false) {
      showOperationError(
        'Fermeture impossible',
        result?.error || 'Le processus principal n’a pas pu exécuter la fermeture.',
        result?.errors || []
      );
      toast('error', 'Fermeture impossible', result?.error || 'Réponse invalide du processus principal.');
    } else {
      state.selection.clear();
      showCloseResult(result);
    }
  } catch (error) {
    showOperationError(
      'Fermeture impossible',
      'La communication avec le processus principal a échoué.',
      [error?.message || String(error)]
    );
    toast('error', 'Fermeture impossible', error?.message || String(error));
  } finally {
    state.closeActive = false;
    state.pendingClosePids = [];
    stopOperationTimers();
    renderSelectionUi();
  }
}

function refreshModalTimer() {
  if (!state.closeActive) return;
  const elapsed = performance.now() - state.closeStartedAt;
  setText(refs['modal-timer'], `Opération en cours · ${formatSeconds(elapsed)}`);
}

function animateCountdown() {
  if (!state.closeActive) return;
  const remaining = Math.max(0, state.closeDeadline - performance.now());
  setCountdown(remaining, state.closeDelay);
  if (remaining > 0) {
    state.countdownFrame = requestAnimationFrame(animateCountdown);
  } else {
    state.countdownFrame = null;
  }
}

function setCountdown(remainingMs, delayMs) {
  const fraction = clamp(remainingMs / Math.max(1, delayMs), 0, 1);
  const circumference = 2 * Math.PI * 52;
  const ring = refs['countdown-value'];
  if (ring) {
    ring.style.strokeDasharray = String(circumference);
    ring.style.strokeDashoffset = String(circumference * (1 - fraction));
  }
  setText(refs['countdown-number'], decimals(remainingMs));
}

function stopOperationTimers() {
  if (state.closeTimer) {
    clearInterval(state.closeTimer);
    state.closeTimer = null;
  }
  if (state.countdownFrame) {
    cancelAnimationFrame(state.countdownFrame);
    state.countdownFrame = null;
  }
}

function setProgressStage(stage) {
  const order = ['closing', 'waiting', 'verifying', 'forcing'];
  const allDone = stage === 'finishing' || stage === 'done';
  const active = order.indexOf(stage);
  for (const [key, node] of Object.entries(refs.stepElements)) {
    const index = order.indexOf(key);
    const isDone = allDone || (active >= 0 && index < active);
    const isActive = !allDone && index === active;
    node.classList.toggle('is-done', isDone);
    node.classList.toggle('is-active', isActive);
  }
}

function handleCloseProgress(payload) {
  if (!state.closeActive || !payload) return;
  switch (payload.stage) {
    case 'closing':
      setProgressStage('closing');
      setText(refs['progress-message'], 'Envoi des demandes de fermeture normale (WM_CLOSE)…');
      break;
    case 'waiting':
      setProgressStage('waiting');
      if (Number.isFinite(payload.remainingMs)) {
        state.closeDelay = Math.max(1, Number(payload.delayMs) || state.closeDelay);
        state.closeDeadline = performance.now() + Math.max(0, payload.remainingMs);
      }
      setText(
        refs['progress-message'],
        `Attente volontaire de ${formatSeconds(payload.delayMs || state.closeDelay)} avant la vérification réelle…`
      );
      break;
    case 'verifying':
      setProgressStage('verifying');
      setCountdown(0, state.closeDelay);
      setText(
        refs['progress-message'],
        'Nouvelle lecture de tasklist, par nom d’exécutable et par PID…'
      );
      break;
    case 'forcing':
      setProgressStage('forcing');
      setText(
        refs['progress-message'],
        'Terminaison forcée des PID encore actifs, sans toucher aux autres…'
      );
      break;
    case 'finishing':
      setProgressStage('finishing');
      setText(refs['progress-message'], 'Dernière vérification des PID et des dates de démarrage…');
      break;
    default:
      break;
  }
}

function statusChip(status, count) {
  const chip = el('span', `summary-chip ${status}`);
  chip.appendChild(icon(STATUS_LABELS[status].icon));
  const labels = {
    closed: `${count} fermée${count > 1 ? 's' : ''}`,
    active: `${count} toujours active${count > 1 ? 's' : ''}`,
    restarted: `${count} relancée${count > 1 ? 's' : ''} automatiquement`,
    denied: `${count} erreur${count > 1 ? 's' : ''} d’accès`
  };
  chip.appendChild(document.createTextNode(labels[status]));
  return chip;
}

function resultAppDetail(app) {
  const pieces = [];
  if (app.status === 'closed') {
    pieces.push('Processus absent(s) lors de la vérification finale.');
  } else if (app.status === 'restarted') {
    pieces.push(
      'De nouvelles instances ont été détectées après la fermeture. Elles n’ont pas été fermées.'
    );
  } else if (app.status === 'denied') {
    pieces.push('Windows a refusé l’accès aux processus sélectionnés.');
    if (!state.admin) pieces.push('Relancez FreeRAM en administrateur pour les applications élevées.');
  } else if (app.status === 'active') {
    pieces.push('Au moins un processus sélectionné est encore présent.');
  }

  if (
    app.status === 'active' &&
    app.closedPids.length === app.selectedPids.length &&
    app.otherExistingPids.length > 0
  ) {
    pieces.push(
      'Les PID sélectionnés sont fermés ; les instances encore visibles existaient déjà avant la demande.'
    );
  }
  if (app.forcedPids.length > 0 && app.status !== 'closed') {
    pieces.push('La terminaison forcée a été tentée sans suffire.');
  }
  if (app.otherExistingPids.length > 0) {
    pieces.push(`${plural(app.otherExistingPids.length, 'instance')} non sélectionnée(s) était(en)t déjà active(s).`);
  }
  if (app.startTimesUnknown) {
    pieces.push('La date de démarrage d’une instance était illisible ; le statut repose sur les PID observés.');
  }
  return pieces.join(' ');
}

function renderResultApp(app, perPid) {
  const node = el('div', 'result-app');
  node.appendChild(avatar(app.name));
  const text = el('div', 'result-app-text');
  const title = el('div', 'result-app-title');
  title.appendChild(el('span', 'name-label', app.name));
  text.appendChild(title);
  text.appendChild(el('div', 'result-detail', resultAppDetail(app)));
  text.appendChild(
    el(
      'div',
      'result-pids',
      `Sélectionnés : ${formatPidList(app.selectedPids, 8)}${
        app.alivePids.length ? ` · actifs : ${formatPidList(app.alivePids, 8)}` : ''
      }${app.newPids.length ? ` · nouveaux : ${formatPidList(app.newPids, 8)}` : ''}${
        app.otherExistingPids.length
          ? ` · déjà actifs : ${formatPidList(app.otherExistingPids, 8)}`
          : ''
      }`
    )
  );

  const errors = (perPid || [])
    .filter((entry) => entry.forceError && app.selectedPids.includes(entry.pid))
    .map((entry) => entry.forceError);
  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length > 0) {
    text.appendChild(el('div', 'result-detail', `Détail : ${uniqueErrors.join(' · ')}`));
  }

  node.appendChild(text);
  const status = STATUS_LABELS[app.status] || STATUS_LABELS.active;
  const badge = el('span', `status-badge ${app.status}`, status.label);
  badge.prepend(icon(status.icon));
  node.appendChild(badge);
  return node;
}

function renderMemoryDelta(before, after, deltaAvailable, title) {
  if (!before || !after) {
    refs['memory-delta'].hidden = true;
    return;
  }
  refs['memory-delta'].hidden = false;
  setText(refs['delta-before'], formatBytes(before.availableBytes));
  setText(refs['delta-after'], formatBytes(after.availableBytes));
  setText(refs['delta-change'], formatDelta(deltaAvailable));

  const change = refs['delta-change'];
  change.classList.toggle('is-negative', Number(deltaAvailable) < -8 * 1024 * 1024);
  change.classList.toggle('is-neutral', Math.abs(Number(deltaAvailable)) < 8 * 1024 * 1024);
  change.title = title || '';
}

function clearResultsUi() {
  refs['results-summary'].textContent = '';
  refs['results-list'].textContent = '';
  refs['result-warnings'].textContent = '';
  refs['memory-delta'].hidden = true;
}

function prepareResultsDialog() {
  stopOperationTimers();
  setProgressStage('done');
  refs['progress-view'].hidden = true;
  refs['results-view'].hidden = false;
  refs['progress-close-x'].hidden = false;
  refs['progress-done-btn'].hidden = false;
  if (!refs['progress-dialog'].open) refs['progress-dialog'].showModal();
}

function showCloseResult(result) {
  prepareResultsDialog();
  clearResultsUi();
  setText(refs['progress-eyebrow'], 'Fermeture terminée');
  setText(refs['progress-dialog-title'], 'Résultat de la fermeture');
  setText(
    refs['progress-dialog-subtitle'],
    `Vérification finale effectuée ${formatSeconds(result.waitedMs)} après la demande.`
  );
  setText(
    refs['modal-timer'],
    `Terminé en ${formatSeconds(result.totalDurationMs || result.waitedMs)}`
  );

  const counts = result.statusCounts || {};
  const chips = [];
  for (const key of ['closed', 'active', 'restarted', 'denied']) {
    if (Number(counts[key]) > 0) chips.push(statusChip(key, counts[key]));
  }
  if (chips.length === 0) chips.push(el('span', 'summary-chip', 'Aucune application'));
  for (const chip of chips) refs['results-summary'].appendChild(chip);

  const perPid = Array.isArray(result.perPid) ? result.perPid : [];
  for (const app of result.apps || []) {
    refs['results-list'].appendChild(renderResultApp(app, perPid));
  }

  const title = [
    Number.isFinite(result.processMemoryBefore) && Number.isFinite(result.processMemoryAfter)
      ? `Working sets des processus : ${formatBytes(result.processMemoryBefore)} → ${formatBytes(
          result.processMemoryAfter
        )}`
      : '',
    'La mémoire disponible mesure aussi les caches Windows : elle ne représente pas une garantie de récupération.'
  ]
    .filter(Boolean)
    .join('\n');
  renderMemoryDelta(result.before, result.after, result.delta?.availableBytes, title);

  for (const warning of result.warnings || []) {
    refs['result-warnings'].appendChild(el('div', 'result-warning', warning));
  }

  const total =
    (result.apps || []).length > 0 ? plural((result.apps || []).length, 'application') : 'Aucune application';
  const summaryParts = [];
  if (counts.closed) summaryParts.push(`${counts.closed} fermée${counts.closed > 1 ? 's' : ''}`);
  if (counts.active) summaryParts.push(`${counts.active} toujours active${counts.active > 1 ? 's' : ''}`);
  if (counts.restarted) summaryParts.push(`${counts.restarted} relancée${counts.restarted > 1 ? 's' : ''}`);
  if (counts.denied) summaryParts.push(`${counts.denied} erreur${counts.denied > 1 ? 's' : ''} d’accès`);

  if (counts.denied > 0) {
    toast('error', 'Fermeture incomplète', `${total} · ${summaryParts.join(', ')}`);
  } else if (counts.active > 0 || counts.restarted > 0) {
    toast('info', 'Fermeture vérifiée', `${total} · ${summaryParts.join(', ')}`);
  } else {
    toast('success', 'Fermeture vérifiée', `${total} · vérification effectuée après 5 s.`);
  }

  refs['progress-done-btn'].focus();
  renderProcesses();
}

function showOperationError(title, message, errors) {
  prepareResultsDialog();
  clearResultsUi();
  setText(refs['progress-eyebrow'], 'Opération interrompue');
  setText(refs['progress-dialog-title'], title);
  setText(refs['progress-dialog-subtitle'], message);
  setText(refs['modal-timer'], 'Aucune fermeture supplémentaire effectuée');
  const chip = el('span', 'summary-chip denied', 'Aucun processus fermé');
  refs['results-summary'].appendChild(chip);
  refs['memory-delta'].hidden = true;
  for (const error of errors || []) {
    refs['result-warnings'].appendChild(el('div', 'result-warning', String(error)));
  }
  refs['progress-done-btn'].focus();
}

// ---------------------------------------------------------------------------
// Actions : ajustement mémoire
// ---------------------------------------------------------------------------

function eligibleTrimProcesses() {
  const minimum = (Number(state.config?.memoryTrim?.minimumWorkingSetMb) || 40) * 1024 * 1024;
  return (state.processes?.processes || []).filter(
    (proc) => !proc.protected && proc.memoryBytes >= minimum
  );
}

function openTrimDialog(mode) {
  if (state.closeActive || state.trimActive) return;
  const selected = selectedProcesses();
  const eligible = eligibleTrimProcesses();

  if (mode === 'selected' && selected.length === 0) {
    toast('info', 'Aucune sélection', 'Sélectionnez au moins un processus à ajuster.');
    return;
  }
  if (mode === 'all' && eligible.length === 0) {
    toast(
      'info',
      'Aucun processus éligible',
      'Aucun processus non protégé ne dépasse le seuil de working set configuré.'
    );
    return;
  }

  const targets = mode === 'selected' ? selected : eligible;
  const bytes = targets.reduce((sum, proc) => sum + proc.memoryBytes, 0);
  state.pendingTrim = {
    mode,
    pids: mode === 'selected' ? selected.map((proc) => proc.pid) : []
  };

  setText(
    refs['trim-dialog-subtitle'],
    mode === 'selected'
      ? `${plural(selected.length, 'processus sélectionné')} · ${formatBytes(bytes)}`
      : `${plural(eligible.length, 'processus éligible')} · plus de ${
          state.config?.memoryTrim?.minimumWorkingSetMb ?? 40
        } Mo chacun`
  );
  setText(
    refs['trim-target-text'],
    mode === 'selected'
      ? `${plural(selected.length, 'processus sélectionné')} · ${formatBytes(bytes)} de working sets.`
      : `${plural(eligible.length, 'processus non protégé')} ≥ ${
          state.config?.memoryTrim?.minimumWorkingSetMb ?? 40
        } Mo · ${formatBytes(bytes)} de working sets cumulés.`
  );
  refs['confirm-trim-btn'].disabled = false;
  refs['trim-dialog'].showModal();
}

async function startTrimFlow() {
  const pending = state.pendingTrim;
  if (!pending || state.trimActive) return;
  if (refs['trim-dialog'].open) refs['trim-dialog'].close();

  state.trimActive = true;
  state.pendingTrim = null;
  renderSelectionUi();
  const message =
    pending.mode === 'selected'
      ? 'Ajustement des working sets de la sélection…'
      : 'Ajustement des working sets des processus éligibles…';
  toast('info', 'Ajustement mémoire', message, 3000);

  try {
    const result = await api.trimMemory(pending.pids);
    if (!result || result.ok === false) {
      toast('error', 'Ajustement impossible', result?.error || 'Réponse invalide du processus principal.');
      return;
    }
    if (result.after) {
      state.memory = result.after;
      renderMemory();
    }
    showTrimResult(result);
  } catch (error) {
    toast('error', 'Ajustement impossible', error?.message || String(error));
  } finally {
    state.trimActive = false;
    renderSelectionUi();
    refreshSoon();
  }
}

function showTrimResult(result) {
  prepareResultsDialog();
  clearResultsUi();
  setText(refs['progress-eyebrow'], 'Ajustement mémoire');
  setText(refs['progress-dialog-title'], 'Working sets ajustés');
  setText(
    refs['progress-dialog-subtitle'],
    'Aucun processus n’a été fermé. La valeur obtenue reste une mesure instantanée.'
  );
  setText(refs['modal-timer'], `Terminé en ${formatSeconds(result.elapsedMs || 0)}`);

  if (result.trimmedCount > 0) {
    refs['results-summary'].appendChild(
      el('span', 'summary-chip closed', `${result.trimmedCount} ajusté${result.trimmedCount > 1 ? 's' : ''}`)
    );
  }
  if (result.failedCount > 0) {
    refs['results-summary'].appendChild(
      el('span', 'summary-chip denied', `${result.failedCount} refus${result.failedCount > 1 ? 's' : ''}`)
    );
  }
  refs['results-summary'].appendChild(
    el('span', 'summary-chip', `${result.requestedCount} demandé${result.requestedCount > 1 ? 's' : ''}`)
  );

  const app = el('div', 'result-app');
  app.appendChild(avatar('Working sets Windows'));
  const text = el('div', 'result-app-text');
  const title = el('div', 'result-app-title');
  title.appendChild(el('span', 'name-label', 'Working sets Windows'));
  text.appendChild(title);
  text.appendChild(
    el(
      'div',
      'result-detail',
      `${plural(result.trimmedCount, 'processus ajusté')}, ${plural(
        result.failedCount,
        'processus refusé'
      )}. ${result.note || ''}`
    )
  );
  text.appendChild(
    el('div', 'result-pids', `Mode : ${result.mode === 'selected' ? 'sélection' : 'processus éligibles'}`)
  );
  app.appendChild(text);
  const badge = el(
    'span',
    `status-badge ${result.trimmedCount > 0 ? 'closed' : 'active'}`,
    result.trimmedCount > 0 ? 'Ajusté' : 'Aucun changement'
  );
  badge.prepend(icon(result.trimmedCount > 0 ? '#i-check' : '#i-info'));
  app.appendChild(badge);
  refs['results-list'].appendChild(app);

  renderMemoryDelta(
    result.before,
    result.after,
    result.delta?.availableBytes,
    'La mémoire disponible peut aussi évoluer à cause des caches Windows et des autres applications.'
  );

  if (result.failedCount > 0) {
    refs['result-warnings'].appendChild(
      el(
        'div',
        'result-warning',
        `Windows a refusé l’accès à ${plural(result.failedCount, 'processus')}. ${
          state.admin ? '' : 'Relancez FreeRAM en administrateur pour les processus élevés.'
        }`
      )
    );
  }

  toast(
    result.trimmedCount > 0 ? 'success' : 'info',
    'Ajustement mémoire terminé',
    `${plural(result.trimmedCount, 'processus ajusté')} · ${result.failedCount} refus.`
  );
  refs['progress-done-btn'].focus();
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

const UPDATE_LABELS = {
  idle: 'Prêt à vérifier',
  checking: 'Recherche de mise à jour…',
  available: 'Mise à jour disponible',
  downloading: 'Téléchargement…',
  downloaded: 'Mise à jour prête à installer',
  'up-to-date': 'FreeRAM est à jour',
  error: 'Erreur de mise à jour',
  unsupported: 'Mise à jour non disponible'
};

function updateStatusText(update) {
  if (!update) return '—';
  if (update.status === 'downloading' && update.progress?.percent !== undefined) {
    return `${UPDATE_LABELS.downloading} ${Math.round(update.progress.percent)} %`;
  }
  return UPDATE_LABELS[update.status] || 'État inconnu';
}

function applyUpdateState(update) {
  if (!update || typeof update !== 'object') return;
  state.updateState = update;
  renderUpdatePanel();
}

function renderUpdatePanel() {
  const update = state.updateState;
  if (!refs['settings-update-status'] || !update) return;

  if (refs['settings-update-channel']) {
    refs['settings-update-channel'].value = update.channel === 'beta' ? 'beta' : 'stable';
    refs['settings-update-channel'].disabled =
      update.status === 'checking' ||
      update.status === 'downloading' ||
      update.status === 'downloaded';
  }

  const statusLabel = updateStatusText(update);
  setText(refs['settings-update-status'], statusLabel);
  refs['settings-update-status'].classList.toggle('is-error', update.status === 'error');
  refs['settings-update-status'].classList.toggle(
    'is-success',
    update.status === 'up-to-date' || update.status === 'downloaded'
  );

  const current = update.currentVersion ? `FreeRAM ${update.currentVersion}` : '';
  const available =
    update.availableVersion && update.availableVersion !== update.currentVersion
      ? ` · ${update.availableVersion} disponible`
      : '';
  setText(refs['settings-update-version'], `${current}${available}` || '—');

  const progress = update.progress;
  const showProgress = update.status === 'downloading' && progress;
  if (refs['settings-update-progress-wrap']) {
    refs['settings-update-progress-wrap'].hidden = !showProgress;
  }
  if (refs['settings-update-progress'] && showProgress) {
    refs['settings-update-progress'].style.width = `${Math.max(
      0,
      Math.min(100, Number(progress.percent) || 0)
    )}%`;
  }

  if (refs['settings-update-help']) {
    if (!update.supported) {
      setText(refs['settings-update-help'], update.message || 'Mise à jour non disponible.');
    } else if (update.status === 'error' && update.error) {
      setText(refs['settings-update-help'], update.error);
    } else if (showProgress) {
      const transferred = formatBytes(Number(progress.transferred) || 0);
      const total = formatBytes(Number(progress.total) || 0);
      setText(refs['settings-update-help'], `Téléchargement : ${transferred} sur ${total}.`);
    } else {
      setText(
        refs['settings-update-help'],
        'Vérification silencieuse toutes les 24 heures. Aucun téléchargement ni redémarrage ne se fait sans votre accord.'
      );
    }
  }

  const canCheck =
    update.supported && update.status !== 'checking' && update.status !== 'downloading';
  if (refs['settings-update-check']) refs['settings-update-check'].disabled = !canCheck;
  if (refs['settings-update-download']) {
    refs['settings-update-download'].hidden = update.status !== 'available';
    refs['settings-update-download'].disabled = update.status !== 'available';
  }
  if (refs['settings-update-install']) {
    refs['settings-update-install'].hidden = update.status !== 'downloaded';
    refs['settings-update-install'].disabled = update.status !== 'downloaded';
  }
}

function renderBuildPanel() {
  const capability = state.buildCapability;
  const status = state.buildStatus;
  if (!refs['settings-build']) return;

  if (!capability) {
    setText(refs['settings-build-status'], 'Vérification de l’environnement…');
    refs['settings-build'].disabled = true;
    return;
  }

  if (!capability.ok) {
    setText(refs['settings-build-help'], capability.message || 'Compilation locale indisponible.');
    setText(refs['settings-build-status'], 'Compilation locale indisponible.');
    refs['settings-build'].disabled = true;
  } else {
    setText(
      refs['settings-build-help'],
      `Source : ${capability.sourceRoot} · Node ${capability.nodeVersion} · npm ${capability.npmVersion}`
    );
    const statusText =
      status?.status === 'starting' || status?.status === 'building'
        ? 'Compilation en cours…'
        : status?.status === 'success'
          ? `Dernière compilation réussie : ${status.version} (${status.channel}).`
          : status?.status === 'failed'
            ? `Dernière compilation en échec : ${status.error || 'erreur inconnue'}`
            : 'Prêt à compiler le setup NSIS et le portable.';
    setText(refs['settings-build-status'], statusText);
    refs['settings-build'].disabled = Boolean(state.buildStarting);
  }

  if (refs['settings-build-log']) {
    refs['settings-build-log'].hidden = !status?.logPath;
  }
  if (refs['settings-build']) {
    refs['settings-build'].disabled = refs['settings-build'].disabled || state.buildStarting;
    refs['settings-build'].title = state.buildStarting
      ? 'Une compilation est en cours.'
      : 'Compiler le setup NSIS et le portable dans release.';
  }
}

async function openGithub() {
  if (!api) return;
  try {
    const result = await api.openGithub();
    if (!result?.ok) toast('error', 'Ouverture impossible', result?.error || 'GitHub indisponible.');
  } catch (error) {
    toast('error', 'Ouverture impossible', error?.message || String(error));
  }
}

async function loadUpdateState() {
  if (!api) return;
  try {
    const result = await api.getUpdateState();
    if (result?.ok) applyUpdateState(result.state);
  } catch {
    /* l'interface reste utilisable si la mise à jour est indisponible */
  }
}

async function loadBuildCapability() {
  if (!api) return;
  try {
    const result = await api.getBuildCapability();
    if (result?.ok) {
      state.buildCapability = result.capability;
      renderBuildPanel();
    }
  } catch {
    state.buildCapability = {
      ok: false,
      message: 'Impossible de vérifier l’environnement de compilation.'
    };
    renderBuildPanel();
  }
}

async function loadBuildStatus(announce = false) {
  if (!api) return;
  try {
    const result = await api.getBuildStatus();
    if (!result?.ok || !result.status) return;
    state.buildStatus = result.status;
    state.buildStarting = result.status.status === 'starting' || result.status.status === 'building';
    renderBuildPanel();
    if (announce && result.status.status === 'success') {
      toast(
        'success',
        'Compilation réussie',
        `FreeRAM ${result.status.version} a été compilé. L’ancienne version reste dans release.previous.`,
        9000
      );
    } else if (announce && result.status.status === 'failed') {
      toast(
        'error',
        'Compilation en échec',
        `${result.status.error || 'Erreur inconnue.'} L’ancienne version a été conservée.`,
        12000
      );
    }
  } catch {
    /* statut absent */
  }
}

async function checkForUpdates() {
  if (!api || !state.updateState?.supported) return;
  const previous = state.updateState;
  applyUpdateState({ ...previous, status: 'checking', error: null, progress: null });
  try {
    const result = await api.checkForUpdates();
    if (result?.ok && result.state) applyUpdateState(result.state);
    else if (!result?.ok) toast('error', 'Vérification impossible', result?.error || 'Erreur inconnue.');
  } catch (error) {
    toast('error', 'Vérification impossible', error?.message || String(error));
  } finally {
    loadUpdateState();
  }
}

async function downloadUpdate() {
  if (!api) return;
  try {
    const result = await api.downloadUpdate();
    if (!result?.ok) toast('error', 'Téléchargement impossible', result?.error || 'Erreur inconnue.');
    else if (result.state) applyUpdateState(result.state);
  } catch (error) {
    toast('error', 'Téléchargement impossible', error?.message || String(error));
  }
}

async function installUpdate() {
  if (!api) return;
  const version = state.updateState?.availableVersion || 'cette version';
  const confirmed = window.confirm(
    `Redémarrer FreeRAM et installer ${version} maintenant ?\n\nL’application va se fermer pendant l’installation.`
  );
  if (!confirmed) return;
  try {
    const result = await api.installUpdate();
    if (!result?.ok) toast('error', 'Installation impossible', result?.error || 'Erreur inconnue.');
    else setText(refs['settings-update-status'], 'Redémarrage pour installer…');
  } catch (error) {
    toast('error', 'Installation impossible', error?.message || String(error));
  }
}

async function changeUpdateChannel() {
  if (!api) return;
  const channel = refs['settings-update-channel']?.value === 'beta' ? 'beta' : 'stable';
  try {
    const result = await api.setUpdateChannel(channel);
    if (!result?.ok) {
      toast('error', 'Canal impossible', result?.error || 'Erreur inconnue.');
      loadUpdateState();
      return;
    }
    if (result.state) applyUpdateState(result.state);
    toast(
      'info',
      channel === 'beta' ? 'Canal bêta sélectionné' : 'Canal stable sélectionné',
      channel === 'beta'
        ? 'Les versions bêta seront proposées après vérification manuelle.'
        : 'Seules les versions stables seront proposées.'
    );
  } catch (error) {
    toast('error', 'Canal impossible', error?.message || String(error));
    loadUpdateState();
  }
}

async function startLocalBuild() {
  if (!api || state.buildStarting) return;
  const capability = state.buildCapability;
  if (!capability?.ok) {
    toast('error', 'Compilation impossible', capability?.message || 'Environnement incomplet.');
    return;
  }
  const channel = String(capability.version).includes('-')
    ? 'beta'
    : state.updateState?.channel === 'beta'
      ? 'beta'
      : 'stable';
  const confirmed = window.confirm(
    `Compiler FreeRAM ${capability.version} (${channel}) maintenant ?\n\n` +
      'FreeRAM va se fermer, compiler le setup et le portable, puis se relancer. ' +
      'L’ancienne version sera conservée dans release.previous.'
  );
  if (!confirmed) return;

  state.buildStarting = true;
  renderBuildPanel();
  try {
    const result = await api.startBuild(channel);
    if (!result?.ok) {
      state.buildStarting = false;
      renderBuildPanel();
      toast('error', 'Compilation impossible', result?.error || 'Erreur inconnue.');
      return;
    }
    setText(refs['settings-build-status'], 'FreeRAM va se fermer pour compiler…');
    toast('info', 'Compilation lancée', 'FreeRAM se ferme puis se relancera automatiquement.');
  } catch (error) {
    state.buildStarting = false;
    renderBuildPanel();
    toast('error', 'Compilation impossible', error?.message || String(error));
  }
}

async function openBuildLog() {
  if (!api) return;
  try {
    const result = await api.openBuildLog();
    if (!result?.ok) toast('error', 'Journal indisponible', result?.error || 'Erreur inconnue.');
  } catch (error) {
    toast('error', 'Journal indisponible', error?.message || String(error));
  }
}

function renderSettings() {
  if (!refs['settings-version']) return;
  const app = state.app;
  if (app) {
    setText(refs['settings-version'], `FreeRAM ${app.version}`);
    setText(refs['settings-electron'], `Electron ${app.electron} · Chromium ${app.chrome}`);
    setText(refs['settings-windows'], `Windows ${app.osRelease} (${app.arch})`);
    setText(refs['settings-cpu'], `${app.cpuModel} · ${app.logicalCpus} threads`);
    setText(refs['settings-memory'], formatBytes(app.totalMemoryBytes));
  }
  setText(refs['settings-admin'], state.admin ? 'Administrateur' : 'Mode standard');
  setText(refs['settings-protected'], `${state.protectedCount} exécutables`);

  const providers = state.sensors?.sensorProviders;
  const tempProvider = providers?.libreHardwareMonitor
    ? 'LibreHardwareMonitor'
    : providers?.openHardwareMonitor
      ? 'OpenHardwareMonitor'
      : null;
  const gpuState = state.sensorStatus?.state;
  setText(
    refs['settings-sensors'],
    `${gpuState === 'ok' ? 'GPU Windows' : gpuState === 'starting' ? 'GPU en attente' : 'GPU indisponible'}${
      tempProvider ? ` · ${tempProvider}` : ' · températures indisponibles'
    }`
  );

  if (refs['settings-relaunch-admin']) {
    refs['settings-relaunch-admin'].disabled = state.admin;
    refs['settings-relaunch-admin'].title = state.admin
      ? 'FreeRAM dispose déjà des droits administrateur'
      : 'Demander une élévation UAC';
  }

  renderUpdatePanel();
  renderBuildPanel();
}

function openSettings(focus = null) {
  renderSettings();
  if (!refs['settings-dialog'].open) refs['settings-dialog'].showModal();
  if (focus === 'temps') {
    setTimeout(() => refs['settings-temp-help']?.scrollIntoView({ block: 'center' }), 60);
  } else if (focus === 'admin') {
    setTimeout(() => refs['settings-relaunch-admin']?.scrollIntoView({ block: 'center' }), 60);
  }
}

function setSettingsStatus(text) {
  setText(refs['settings-status'], text);
}

async function createShortcut() {
  if (!api) return;
  const button = refs['settings-create-shortcut'];
  button.disabled = true;
  setSettingsStatus('Création du raccourci…');
  try {
    const result = await api.createShortcut();
    if (result?.ok) {
      setSettingsStatus(`Raccourci créé : ${result.path}`);
      toast(
        'success',
        'Raccourci créé sur le Bureau',
        result.packaged
          ? 'Le raccourci pointe vers FreeRAM.exe.'
          : 'En mode développement, le raccourci lance Electron avec ce projet.'
      );
    } else {
      setSettingsStatus(result?.error || 'Création impossible.');
      toast('error', 'Raccourci impossible', result?.error || 'Erreur inconnue.');
    }
  } catch (error) {
    setSettingsStatus(error?.message || String(error));
    toast('error', 'Raccourci impossible', error?.message || String(error));
  } finally {
    button.disabled = false;
  }
}

async function relaunchAsAdmin() {
  if (state.admin) {
    toast('info', 'Déjà administrateur', 'FreeRAM dispose déjà des droits nécessaires.');
    return;
  }
  setSettingsStatus('Demande d’élévation UAC…');
  try {
    const result = await api.relaunchAsAdmin();
    if (result?.ok) {
      setSettingsStatus('FreeRAM redémarre en administrateur…');
      toast('info', 'Élévation demandée', 'Acceptez la demande UAC de Windows.');
    } else {
      setSettingsStatus(result?.error || 'Élévation annulée.');
      toast(
        'info',
        'Élévation non effectuée',
        result?.error || 'La demande UAC a été annulée ou refusée.'
      );
    }
  } catch (error) {
    setSettingsStatus(error?.message || String(error));
    toast('error', 'Élévation impossible', error?.message || String(error));
  }
}

async function openConfiguredPath(key) {
  try {
    const result = await api.openPath(key);
    if (!result?.ok) toast('error', 'Ouverture impossible', result?.error || 'Dossier inconnu.');
  } catch (error) {
    toast('error', 'Ouverture impossible', error?.message || String(error));
  }
}

// ---------------------------------------------------------------------------
// Actualisation et réception des événements
// ---------------------------------------------------------------------------

function applyProcessSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.processes)) return;
  state.processes = snapshot;
  state.processError = null;
  state.lastProcessesAt = snapshot.timestamp || Date.now();
  pruneSelection();
  renderProcesses();
  renderProcessStats();
  renderSettings();
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.memory) state.memory = snapshot.memory;
  if (snapshot.cpu) state.cpu = snapshot.cpu;
  if (snapshot.sensors !== undefined) state.sensors = snapshot.sensors;
  if (snapshot.sensorStatus) state.sensorStatus = snapshot.sensorStatus;
  if (snapshot.processes) applyProcessSnapshot(snapshot.processes);
  if (snapshot.lastTelemetryAt) state.lastTelemetryAt = snapshot.lastTelemetryAt;
  if (snapshot.paused !== undefined) state.paused = Boolean(snapshot.paused);
  renderTelemetry();
  renderSensors();
}

async function refreshNow() {
  if (state.refreshing || state.closeActive || state.trimActive) return;
  state.refreshing = true;
  refs['refresh-icon']?.classList.add('is-spinning');
  refs['refresh-btn'].disabled = true;
  try {
    const result = await api.refresh();
    if (result?.ok) {
      applySnapshot(result.state);
    } else {
      toast('error', 'Actualisation impossible', result?.error || 'Erreur inconnue.');
    }
  } catch (error) {
    toast('error', 'Actualisation impossible', error?.message || String(error));
  } finally {
    state.refreshing = false;
    refs['refresh-icon']?.classList.remove('is-spinning');
    refs['refresh-btn'].disabled = state.closeActive || state.trimActive;
    renderSelectionUi();
  }
}

function refreshSoon() {
  setTimeout(() => {
    if (!state.closeActive && !state.trimActive) refreshNow();
  }, 250);
}

function subscribeEvents() {
  api.onTelemetry(applyTelemetry);
  api.onProcesses(applyProcessSnapshot);
  api.onProcessesError((payload) => {
    state.processError = payload?.message || 'Lecture des processus impossible.';
    toast('error', 'Processus illisibles', state.processError, 8000);
  });
  api.onSensors(applySensorSample);
  api.onSensorStatus(applySensorStatus);
  api.onCloseProgress(handleCloseProgress);
  api.onUpdateStatus(applyUpdateState);
  api.onMonitorPaused((payload) => {
    state.paused = Boolean(payload?.paused);
    refs['live-dot']?.classList.toggle('is-paused', state.paused);
    const live = refs['live-dot']?.parentElement;
    if (live) {
      live.title = state.paused
        ? 'Surveillance en pause pendant que la fenêtre est réduite.'
        : 'Actualisation automatique active.';
    }
  });
}

// ---------------------------------------------------------------------------
// Liaisons d'interface
// ---------------------------------------------------------------------------

function closeDialog(dialog) {
  if (!dialog?.open) return;
  if (dialog === refs['progress-dialog'] && state.closeActive) return;
  dialog.close();
}

function bindUi() {
  refs['refresh-btn'].addEventListener('click', refreshNow);
  refs['free-btn'].addEventListener('click', () => openTrimDialog('all'));
  refs['trim-selected-btn'].addEventListener('click', () => openTrimDialog('selected'));
  refs['close-selected-btn'].addEventListener('click', openCloseDialog);
  refs['clear-selection'].addEventListener('click', () => {
    state.selection.clear();
    renderProcesses();
  });

  refs['search-input'].addEventListener('input', (event) => {
    state.search = event.target.value;
    renderProcesses();
  });
  refs['search-input'].addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      state.search = '';
      refs['search-input'].value = '';
      renderProcesses();
    }
  });

  for (const button of document.querySelectorAll('.view-button[data-view]')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      for (const other of document.querySelectorAll('.view-button[data-view]')) {
        other.classList.toggle('is-active', other === button);
      }
      renderProcesses();
    });
  }

  refs['settings-btn'].addEventListener('click', () => openSettings(null));
  refs['github-btn']?.addEventListener('click', openGithub);
  refs['admin-pill'].addEventListener('click', () => openSettings(state.admin ? null : 'admin'));
  refs['sensor-help-btn'].addEventListener('click', () => openSettings('temps'));

  refs['settings-update-check']?.addEventListener('click', checkForUpdates);
  refs['settings-update-download']?.addEventListener('click', downloadUpdate);
  refs['settings-update-install']?.addEventListener('click', installUpdate);
  refs['settings-update-github']?.addEventListener('click', openGithub);
  refs['settings-update-channel']?.addEventListener('change', changeUpdateChannel);
  refs['settings-build']?.addEventListener('click', startLocalBuild);
  refs['settings-build-log']?.addEventListener('click', openBuildLog);

  refs['confirm-close-btn'].addEventListener('click', startCloseFlow);
  refs['confirm-trim-btn'].addEventListener('click', startTrimFlow);

  refs['progress-close-x'].addEventListener('click', () => closeDialog(refs['progress-dialog']));
  refs['progress-done-btn'].addEventListener('click', () => closeDialog(refs['progress-dialog']));

  refs['settings-reload-ui'].addEventListener('click', async () => {
    setSettingsStatus('Rechargement de l’interface…');
    try {
      await api.reloadUi();
    } catch (error) {
      setSettingsStatus(error?.message || String(error));
    }
  });
  refs['settings-create-shortcut'].addEventListener('click', createShortcut);
  refs['settings-relaunch-admin'].addEventListener('click', relaunchAsAdmin);
  refs['settings-relaunch'].addEventListener('click', async () => {
    setSettingsStatus('Redémarrage de FreeRAM…');
    try {
      await api.relaunch();
    } catch (error) {
      setSettingsStatus(error?.message || String(error));
    }
  });

  for (const button of document.querySelectorAll('[data-open-path]')) {
    button.addEventListener('click', () => openConfiguredPath(button.dataset.openPath));
  }

  for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => closeDialog($(button.dataset.closeDialog)));
  }

  for (const dialog of document.querySelectorAll('dialog.modal')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
    dialog.addEventListener('cancel', (event) => {
      if (dialog === refs['progress-dialog'] && state.closeActive) event.preventDefault();
    });
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      refs['search-input'].focus();
      refs['search-input'].select();
    }
    if (event.key === 'Escape' && document.activeElement === refs['search-input']) {
      state.search = '';
      refs['search-input'].value = '';
      renderProcesses();
    }
  });
}

function applyAppMeta(bootstrap) {
  state.app = bootstrap.app;
  state.config = bootstrap.config;
  state.paths = bootstrap.paths;
  state.admin = Boolean(bootstrap.admin);
  state.protectedCount = bootstrap.protectedCount || 0;
  state.warnings = Array.isArray(bootstrap.warnings) ? bootstrap.warnings : [];
  state.maxSelection = state.config?.processes?.maxSelection || 256;
  state.topCount = state.config?.processes?.topCount || 256;
  state.view = state.config?.processes?.defaultView === 'processes' ? 'processes' : 'grouped';

  for (const button of document.querySelectorAll('.view-button[data-view]')) {
    button.classList.toggle('is-active', button.dataset.view === state.view);
  }

  const memorySeconds = (Number(state.config?.refresh?.memoryMs) || 2000) / 1000;
  setText(refs['refresh-label'], `${memorySeconds.toLocaleString('fr-FR')} s`);

  setText(refs['admin-label'], state.admin ? 'Administrateur' : 'Mode standard');
  refs['admin-pill'].classList.toggle('is-admin', state.admin);
  refs['admin-pill'].title = state.admin
    ? 'FreeRAM dispose des droits administrateur.'
    : 'Mode standard : certaines applications élevées peuvent refuser la fermeture. Cliquez pour les options.';

  setText(refs['footer-version'], `FreeRAM ${bootstrap.app.version}`);
  document.title = `FreeRAM ${bootstrap.app.version}`;
  renderSettings();
}

async function init() {
  cacheRefs();

  if (!api) {
    setText(
      refs['processes-subtitle'],
      'API Electron indisponible. Lancez FreeRAM avec « npm start » ou l’exécutable Windows.'
    );
    toast(
      'error',
      'Interface hors application',
      'Cette page doit être ouverte par FreeRAM (Electron) pour accéder aux processus Windows.'
    );
    return;
  }

  bindUi();
  subscribeEvents();

  try {
    const bootstrap = await api.bootstrap();
    applyAppMeta(bootstrap);

    const initial = bootstrap.initial || {};
    state.memory = initial.memory;
    state.cpu = initial.cpu;
    state.sensors = initial.sensors;
    state.sensorStatus = initial.sensorStatus;
    state.lastTelemetryAt = initial.lastTelemetryAt;
    state.paused = Boolean(initial.paused);

    if (initial.processes) applyProcessSnapshot(initial.processes);
    renderTelemetry();
    renderSensors();
    renderProcesses();
    renderSelectionUi();
    renderSettings();

    loadUpdateState();
    loadBuildCapability().then(() => loadBuildStatus(true));

    if (state.warnings.length > 0) {
      toast(
        'info',
        'Configuration partiellement chargée',
        state.warnings.slice(0, 2).join(' '),
        9000
      );
    }
    if (!state.admin) {
      setTimeout(() => {
        toast(
          'info',
          'Mode standard',
          'Les applications lancées en administrateur peuvent refuser la fermeture. Utilisez « Relancer en administrateur » dans les paramètres si nécessaire.',
          8000
        );
      }, 1200);
    }
  } catch (error) {
    setText(refs['processes-subtitle'], 'Impossible de charger l’état initial de FreeRAM.');
    toast('error', 'Démarrage incomplet', error?.message || String(error), 10000);
  }
}

init();
