'use strict';

/**
 * Chargement et validation de la configuration.
 *
 * Ordre de priorité :
 *   1. valeurs par défaut internes (ce fichier)
 *   2. config/app.config.json embarqué avec l'application
 *   3. %APPDATA%\FreeRAM\config\app.config.json (surcharge utilisateur, optionnelle)
 *
 * Les fichiers embarqués restent modifiables : dans une version packagée,
 * ils sont dépaquetés dans resources/app.asar.unpacked/config.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Permet d'utiliser ce module hors d'Electron (tests Node, scripts).
let electronApp = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.app) electronApp = electron.app;
} catch {
  /* hors Electron */
}

function isPackaged() {
  return Boolean(electronApp && electronApp.isPackaged);
}

function getAppRoot() {
  if (electronApp) return electronApp.getAppPath();
  return path.resolve(__dirname, '..', '..');
}

function getUserDataDir() {
  if (electronApp) return electronApp.getPath('userData');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'FreeRAM');
}

function getLogsDir() {
  if (electronApp) {
    try {
      return electronApp.getPath('logs');
    } catch {
      /* fallback */
    }
  }
  return path.join(getUserDataDir(), 'logs');
}

const DEFAULTS = {
  refresh: {
    memoryMs: 2000,
    cpuMs: 2000,
    processesMs: 4000,
    gpuMs: 5000,
    temperaturesMs: 10000
  },
  processes: {
    topCount: 256,
    maxSelection: 256,
    defaultView: 'grouped',
    showProtected: true
  },
  closing: {
    verificationDelayMs: 5000,
    forceAfterDelay: true,
    postForceCheckMs: 1500
  },
  memoryTrim: {
    minimumWorkingSetMb: 40,
    settleMs: 1200
  },
  ui: {
    locale: 'fr-FR',
    confirmBeforeTrim: true
  },
  updates: {
    owner: 'TommyDrift929327',
    repo: 'FreeRAM.exe',
    channel: 'stable',
    checkOnStartup: true,
    checkIntervalHours: 24
  }
};

const state = {
  config: structuredClone(DEFAULTS),
  protectedMap: new Map(),
  warnings: [],
  paths: null
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
  if (!isPlainObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key], value);
    } else if (value !== undefined) {
      target[key] = Array.isArray(value) ? value.slice() : value;
    }
  }
  return target;
}

function readJson(file, warnings, label) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.push(`Impossible de lire ${label} (${file}) : ${error.message}`);
    }
    return null;
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizedName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/i, '');
}

function unpackedPath(target) {
  if (!isPackaged()) return target;
  return target.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function resolvePaths() {
  const appRoot = getAppRoot();
  const userData = getUserDataDir();
  const bundledConfig = unpackedPath(path.join(appRoot, 'config'));
  const rendererDir = unpackedPath(path.join(appRoot, 'src', 'renderer'));
  const userConfig = path.join(userData, 'config');

  return {
    appRoot,
    configDir: fs.existsSync(bundledConfig) ? bundledConfig : path.join(appRoot, 'config'),
    rendererDir: fs.existsSync(rendererDir) ? rendererDir : path.join(appRoot, 'src', 'renderer'),
    userConfigDir: userConfig,
    logsDir: getLogsDir(),
    userDataDir: userData,
    exePath: process.execPath
  };
}

function sanitize(raw) {
  const merged = deepMerge(structuredClone(DEFAULTS), raw || {});

  merged.refresh.memoryMs = clampInt(merged.refresh.memoryMs, 500, 60000, 2000);
  merged.refresh.cpuMs = clampInt(merged.refresh.cpuMs, 500, 60000, 2000);
  merged.refresh.processesMs = clampInt(merged.refresh.processesMs, 1000, 120000, 4000);
  merged.refresh.gpuMs = clampInt(merged.refresh.gpuMs, 2000, 120000, 5000);
  merged.refresh.temperaturesMs = clampInt(merged.refresh.temperaturesMs, 2000, 300000, 10000);

  merged.processes.topCount = clampInt(merged.processes.topCount, 5, 256, 256);
  // Contrainte produit : 256 processus maximum sélectionnables simultanément.
  merged.processes.maxSelection = clampInt(merged.processes.maxSelection, 1, 256, 256);
  merged.processes.showProtected = merged.processes.showProtected !== false;
  if (!['grouped', 'processes'].includes(merged.processes.defaultView)) {
    merged.processes.defaultView = 'grouped';
  }

  merged.closing.verificationDelayMs = clampInt(
    merged.closing.verificationDelayMs,
    1000,
    30000,
    5000
  );
  merged.closing.forceAfterDelay = merged.closing.forceAfterDelay !== false;
  merged.closing.postForceCheckMs = clampInt(merged.closing.postForceCheckMs, 300, 10000, 1500);

  merged.memoryTrim.minimumWorkingSetMb = clampInt(
    merged.memoryTrim.minimumWorkingSetMb,
    0,
    8192,
    40
  );
  merged.memoryTrim.settleMs = clampInt(merged.memoryTrim.settleMs, 300, 10000, 1200);

  merged.ui.locale = typeof merged.ui.locale === 'string' ? merged.ui.locale : 'fr-FR';
  merged.ui.confirmBeforeTrim = merged.ui.confirmBeforeTrim !== false;

  const owner = String(merged.updates?.owner || '').trim();
  const repo = String(merged.updates?.repo || '').trim();
  merged.updates = {
    owner: /^[A-Za-z0-9-]+$/.test(owner) ? owner : DEFAULTS.updates.owner,
    repo: /^[A-Za-z0-9._-]+$/.test(repo) ? repo : DEFAULTS.updates.repo,
    channel: merged.updates?.channel === 'beta' ? 'beta' : 'stable',
    checkOnStartup: merged.updates?.checkOnStartup !== false,
    checkIntervalHours: clampInt(merged.updates?.checkIntervalHours, 1, 168, 24)
  };

  return merged;
}

function loadProtected(bundled, userFile, warnings) {
  const map = new Map();

  const addEntry = (entry, source) => {
    if (!entry) return;
    const name = typeof entry === 'string' ? entry : entry.name;
    const reason = typeof entry === 'string' ? null : entry.reason;
    const key = normalizedName(name);
    if (!key) return;
    const existing = map.get(key);
    map.set(key, {
      name,
      reason: reason || existing?.reason || `Processus protégé (${source})`
    });
  };

  if (bundled && Array.isArray(bundled.protected)) {
    bundled.protected.forEach((entry) => addEntry(entry, 'liste système'));
  }
  if (bundled && Array.isArray(bundled.extra)) {
    bundled.extra.forEach((entry) => addEntry(entry, 'configuration'));
  }

  const user = readJson(userFile, warnings, 'la liste de protection utilisateur');
  if (user) {
    if (Array.isArray(user.protected)) {
      user.protected.forEach((entry) => addEntry(entry, 'surcharge utilisateur'));
    }
    if (Array.isArray(user.extra)) {
      user.extra.forEach((entry) => addEntry(entry, 'surcharge utilisateur'));
    }
  }

  return map;
}

/**
 * Initialise la configuration. À appeler après app.whenReady().
 */
function init() {
  if (state.paths) return state;

  const warnings = [];
  state.paths = resolvePaths();

  const bundledConfig = readJson(
    path.join(state.paths.configDir, 'app.config.json'),
    warnings,
    'la configuration'
  );
  const userConfig = readJson(
    path.join(state.paths.userConfigDir, 'app.config.json'),
    warnings,
    'la configuration utilisateur'
  );

  const combined = deepMerge(
    deepMerge(structuredClone(DEFAULTS), bundledConfig || {}),
    userConfig || {}
  );
  state.config = sanitize(combined);

  const bundledProtected = readJson(
    path.join(state.paths.configDir, 'protected-processes.json'),
    warnings,
    'la liste des processus protégés'
  );
  const userProtectedFile = path.join(state.paths.userConfigDir, 'protected-processes.json');
  state.protectedMap = loadProtected(bundledProtected, userProtectedFile, warnings);
  state.warnings = warnings;

  return state;
}

function get() {
  return init();
}

function getConfig() {
  return init().config;
}

function getProtectedMap() {
  return init().protectedMap;
}

function getPaths() {
  return init().paths;
}

function getWarnings() {
  return init().warnings;
}

/** Vérifie si un nom (avec ou sans .exe) figure dans la liste de protection. */
function protectionForName(name) {
  return getProtectedMap().get(normalizedName(name)) || null;
}

function isProtectedName(name) {
  return getProtectedMap().has(normalizedName(name));
}

module.exports = {
  DEFAULTS,
  init,
  get,
  getConfig,
  getProtectedMap,
  getPaths,
  getWarnings,
  protectionForName,
  isProtectedName,
  normalizedName
};
