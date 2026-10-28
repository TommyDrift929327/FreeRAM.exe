'use strict';

/**
 * Journalisation minimale dans %APPDATA%\FreeRAM\logs\freeram.log.
 * Rotation simple : le fichier est tronqué au démarrage s'il dépasse 2 Mo.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let logFile = null;
let ready = false;

function resolveLogsDir() {
  try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.app) {
      return electron.app.getPath('logs');
    }
  } catch {
    /* hors Electron */
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'FreeRAM', 'logs');
}

function getVersion() {
  try {
    return require('../../package.json').version;
  } catch {
    return '1.0.0';
  }
}

function ensureReady() {
  if (ready) return;
  try {
    const dir = resolveLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'freeram.log');
    try {
      const stats = fs.statSync(logFile);
      if (stats.size > 2 * 1024 * 1024) {
        fs.renameSync(logFile, path.join(dir, 'freeram.previous.log'));
      }
    } catch {
      /* fichier absent : rien à faire */
    }
    fs.appendFileSync(
      logFile,
      `\n=== FreeRAM ${getVersion()} — ${new Date().toISOString()} ===\n`,
      'utf8'
    );
    ready = true;
  } catch {
    ready = false;
  }
}

function write(level, args) {
  ensureReady();
  const message = args
    .map((value) => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }
      return String(value);
    })
    .join(' ');

  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  if (process.env.FREERAM_DEBUG) {
    const method = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
    console[method](message);
  }
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line, 'utf8');
    } catch {
      /* ne jamais faire planter l'application pour un log */
    }
  }
}

module.exports = {
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  debug: (...args) => {
    let packaged = false;
    try {
      const electron = require('electron');
      packaged = Boolean(electron?.app?.isPackaged);
    } catch {
      /* hors Electron : mode développement */
    }
    if (process.env.FREERAM_DEBUG || !packaged) write('DEBUG', args);
  },
  getLogFile: () => logFile
};
