'use strict';

/**
 * Processus principal FreeRAM.
 *
 * Responsabilités :
 *   - cycle de vie de la fenêtre Electron et verrouillage mono-instance ;
 *   - durcissement de la sécurité (aucun Node.js dans le renderer) ;
 *   - démarrage de la surveillance mémoire/CPU/processus/capteurs ;
 *   - enregistrement des handlers IPC.
 *
 * Le renderer est volontairement « bête » : il affiche et demande des
 * actions. Toute validation sensible (PID, protection, limite de 256) est
 * refaite dans le processus principal.
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, session } = require('electron');

const configModule = require('./src/main/config');
const logger = require('./src/main/logger');
const memory = require('./src/main/memory');
const win32 = require('./src/main/win32');
const { SensorService } = require('./src/main/sensors');
const { Monitor } = require('./src/main/monitor');
const { UpdateService } = require('./src/main/updater');
const { BuildService } = require('./src/main/build');
const { registerIpc } = require('./src/main/ipc');

app.setName('FreeRAM');
app.setAppUserModelId('com.freeram.app');

const isElevatedLaunch = process.argv.includes('--freeram-elevated');
const isDebugLaunch =
  process.argv.includes('--dev') || process.argv.includes('--remote-debugging-port=9222');
const isDev = !app.isPackaged;

// En mode élevé, on ne demande pas le verrou : l'instance standard est en
// train de quitter et les deux processus ne doivent pas se bloquer.
const hasSingleInstanceLock = isElevatedLaunch || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow = null;
let monitor = null;
let sensors = null;
let updater = null;
let buildService = null;
let admin = false;

const adminPromise = win32
  .isElevated()
  .then((value) => {
    admin = Boolean(value);
    return admin;
  })
  .catch(() => false);

function iconPath() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(process.resourcesPath || '', 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico')
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function selfPids() {
  const pids = new Set([process.pid]);
  try {
    for (const metric of app.getAppMetrics()) {
      if (Number.isInteger(metric.pid)) pids.add(metric.pid);
    }
  } catch {
    /* app.getAppMetrics peut échouer pendant l'arrêt */
  }
  const sensorPid = sensors?.getChildPid?.();
  if (Number.isInteger(sensorPid)) pids.add(sensorPid);
  return pids;
}

function hardenWebContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));

  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL();
    if (!url.startsWith('file://') || (current && url !== current)) {
      event.preventDefault();
    }
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  contents.on('render-process-gone', (_event, details) => {
    logger.error('Processus de rendu interrompu :', details.reason);
  });
}

function createWindow() {
  const chromeHeight = 56;

  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#06090f',
    title: 'FreeRAM',
    icon: iconPath(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#06090f',
      symbolColor: '#adbbd0',
      height: chromeHeight
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: isDev || isDebugLaunch
    }
  });

  hardenWebContents(mainWindow.webContents);

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    if (isDebugLaunch && mainWindow.webContents.isDevToolsOpened() === false) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('minimize', () => {
    monitor?.pause();
  });

  mainWindow.on('restore', () => {
    monitor?.resume();
  });

  mainWindow.on('show', () => {
    monitor?.resume();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(configModule.getPaths().rendererDir, 'index.html')).catch((error) => {
    logger.error('Chargement de l’interface impossible :', error);
  });
}

async function bootstrap() {
  configModule.init();
  const cfg = configModule.getConfig();

  sensors = new SensorService({
    gpuIntervalMs: cfg.refresh.gpuMs,
    tempIntervalMs: cfg.refresh.temperaturesMs
  });

  monitor = new Monitor({
    config: cfg,
    sensors,
    getWindow: () => mainWindow,
    getSelfPids: selfPids
  });

  updater = new UpdateService({
    config: cfg,
    getWindow: () => mainWindow
  });
  buildService = new BuildService({
    config: cfg,
    getWindow: () => mainWindow
  });

  registerIpc({
    monitor,
    sensors,
    getSelfPids: selfPids,
    getAdmin: () => admin,
    adminPromise,
    getWindow: () => mainWindow,
    updater,
    buildService
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  Menu.setApplicationMenu(null);
  createWindow();

  updater.init();

  // La surveillance démarre après l'affichage : le premier bootstrap attend
  // malgré tout ensureReady() pour renvoyer un état complet.
  setTimeout(() => {
    monitor.init().catch((error) => logger.error('Initialisation de la surveillance :', error));
  }, 60);

  logger.info('FreeRAM démarré', {
    version: app.getVersion(),
    electron: process.versions.electron,
    admin,
    packaged: app.isPackaged,
    elevatedLaunch: isElevatedLaunch,
    memoryBytes: memory.getSystemInfo().totalMemoryBytes
  });
}

if (isElevatedLaunch) {
  // Rien à faire ici : le verrou est volontairement ignoré.
  logger.info('Démarrage en mode élevé demandé.');
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  try {
    updater?.stop();
  } catch {
    /* ignore */
  }
  try {
    monitor?.stop();
  } catch {
    /* ignore */
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

process.on('uncaughtException', (error) => {
  logger.error('Exception non interceptée :', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Promesse rejetée non traitée :', reason);
});

app
  .whenReady()
  .then(() => {
    if (!hasSingleInstanceLock) return null;
    return bootstrap();
  })
  .catch((error) => {
    logger.error('Démarrage impossible :', error);
    app.quit();
  });
