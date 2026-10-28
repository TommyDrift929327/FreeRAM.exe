'use strict';

/**
 * Handlers IPC. Toute entrée venant du renderer est revalidée ici.
 * Le renderer n'a accès ni à Node.js ni au système de fichiers.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, shell } = require('electron');
const configModule = require('./config');
const logger = require('./logger');
const memory = require('./memory');
const { listProcesses, validateSelection } = require('./processes');
const closer = require('./closer');
const win32 = require('./win32');
const shortcuts = require('./shortcuts');
const { releasesUrl } = require('./update-policy');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertTrustedSender(event) {
  const url = event.senderFrame?.url || event.sender?.getURL?.() || '';
  if (!url.startsWith('file://') || !url.includes('/src/renderer/')) {
    throw new Error('Appel IPC non autorisé.');
  }
}

function parsePids(value, max) {
  if (!Array.isArray(value)) throw new Error('Liste de PID invalide.');
  const pids = value.map((entry) => (typeof entry === 'number' ? entry : Number.NaN));
  if (pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new Error('Un PID fourni est invalide.');
  }
  if (pids.length === 0) throw new Error('Aucun processus sélectionné.');
  if (new Set(pids).size !== pids.length) throw new Error('PID en double dans la sélection.');
  if (pids.length > max) throw new Error(`Maximum ${max} processus sélectionnables.`);
  return pids;
}

/**
 * @param {object} deps
 * @param {import('./monitor').Monitor} deps.monitor
 * @param {import('./sensors').SensorService} deps.sensors
 * @param {() => Set<number>} deps.getSelfPids
 * @param {() => boolean} deps.getAdmin
 * @param {Promise<boolean>} deps.adminPromise
 * @param {() => Electron.BrowserWindow|null} deps.getWindow
 * @param {import('./updater').UpdateService} deps.updater
 * @param {import('./build').BuildService} deps.buildService
 */
function registerIpc(deps) {
  const {
    monitor,
    sensors,
    getSelfPids,
    getAdmin,
    adminPromise,
    getWindow,
    updater,
    buildService
  } = deps;
  const paths = configModule.getPaths();
  let busy = null;

  function acquire(operation) {
    if (busy) return false;
    busy = operation;
    return true;
  }

  function release() {
    busy = null;
  }

  function githubReleasesUrl() {
    const cfg = configModule.getConfig();
    return releasesUrl(cfg.updates?.owner, cfg.updates?.repo);
  }

  function appInfo() {
    const system = memory.getSystemInfo();
    return {
      name: 'FreeRAM',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      osRelease: system.release,
      hostname: system.hostname,
      cpuModel: system.cpuModel,
      logicalCpus: system.logicalCpus,
      totalMemoryBytes: system.totalMemoryBytes,
      exePath: process.execPath,
      logFile: logger.getLogFile()
    };
  }

  async function buildBootstrap() {
    await monitor.ensureReady();
    await adminPromise;
    const cfg = configModule.getConfig();
    return {
      app: appInfo(),
      config: cfg,
      protectedCount: configModule.getProtectedMap().size,
      paths: {
        configDir: paths.configDir,
        rendererDir: paths.rendererDir,
        userConfigDir: paths.userConfigDir,
        logsDir: paths.logsDir,
        exePath: paths.exePath
      },
      admin: Boolean(getAdmin()),
      warnings: configModule.getWarnings(),
      initial: monitor.getBootstrap()
    };
  }

  ipcMain.handle('app:bootstrap', async (event) => {
    assertTrustedSender(event);
    return buildBootstrap();
  });

  ipcMain.handle('app:refresh', async (event) => {
    assertTrustedSender(event);
    if (busy) return { ok: false, error: 'Une opération est déjà en cours.' };
    const state = await monitor.refreshNow();
    return { ok: true, state };
  });

  ipcMain.handle('processes:list', async (event) => {
    assertTrustedSender(event);
    await monitor.refreshProcesses();
    return { ok: true, state: monitor.getBootstrap() };
  });

  ipcMain.handle('processes:close', async (event, payload) => {
    assertTrustedSender(event);
    if (!acquire('close')) {
      return { ok: false, error: 'Une opération est déjà en cours. Patientez un instant.' };
    }

    try {
      const cfg = configModule.getConfig();
      const pids = parsePids(payload?.pids, cfg.processes.maxSelection);
      const forceRequested = payload?.force !== false;
      const result = await closer.closeProcesses({
        pids,
        maxSelection: cfg.processes.maxSelection,
        verificationDelayMs: cfg.closing.verificationDelayMs,
        forceAfterDelay: forceRequested && cfg.closing.forceAfterDelay,
        postForceCheckMs: cfg.closing.postForceCheckMs,
        selfPids: getSelfPids(),
        onProgress: (progress) => {
          try {
            if (!event.sender.isDestroyed()) event.sender.send('close:progress', progress);
          } catch {
            /* fenêtre fermée pendant l'opération */
          }
        }
      });

      await monitor.refreshProcesses();
      monitor.refreshTelemetry();
      return result;
    } catch (error) {
      logger.error('Fermeture impossible :', error);
      return { ok: false, error: error.message, errors: [error.message] };
    } finally {
      release();
    }
  });

  ipcMain.handle('memory:trim', async (event, payload) => {
    assertTrustedSender(event);
    if (!acquire('trim')) {
      return { ok: false, error: 'Une opération est déjà en cours. Patientez un instant.' };
    }

    try {
      const cfg = configModule.getConfig();
      const selfPids = getSelfPids();
      const snapshot = await listProcesses({ selfPids });
      const requestedPids = Array.isArray(payload?.pids) ? payload.pids : [];
      const mode = requestedPids.length > 0 ? 'selected' : 'all';
      let targets = [];

      if (mode === 'selected') {
        const pids = parsePids(requestedPids, cfg.processes.maxSelection);
        const validation = validateSelection(snapshot, pids, cfg.processes.maxSelection);
        if (!validation.ok) return { ok: false, error: 'Sélection invalide.', errors: validation.errors };
        targets = validation.selected.map((proc) => proc.pid);
      } else {
        const minimumBytes = cfg.memoryTrim.minimumWorkingSetMb * 1024 * 1024;
        targets = snapshot.processes
          .filter((proc) => !proc.protected && proc.memoryBytes >= minimumBytes)
          .slice(0, 400)
          .map((proc) => proc.pid);
      }

      targets = targets.filter((pid) => !selfPids.has(pid));
      if (targets.length === 0) {
        return { ok: false, error: 'Aucun processus éligible pour cet ajustement.' };
      }

      const before = memory.getMemorySnapshot();
      const startedAt = Date.now();
      const trimmed = await win32.trimWorkingSets(targets);
      await sleep(cfg.memoryTrim.settleMs);
      const after = memory.getMemorySnapshot();
      await monitor.refreshProcesses();
      monitor.refreshTelemetry();

      return {
        ok: true,
        mode,
        requestedCount: targets.length,
        trimmedCount: trimmed.trimmed.length,
        failedCount: trimmed.failed.length,
        before,
        after,
        delta: {
          availableBytes: after.availableBytes - before.availableBytes,
          usedBytes: after.usedBytes - before.usedBytes
        },
        elapsedMs: Date.now() - startedAt,
        note:
          "Les working sets ont été ajustés : Windows a déplacé des pages vers sa liste de veille. " +
          "Ce n'est pas une récupération garantie, et certaines applications peuvent recharger des données."
      };
    } catch (error) {
      logger.error('Ajustement mémoire impossible :', error);
      return { ok: false, error: error.message };
    } finally {
      release();
    }
  });

  ipcMain.handle('app:create-shortcut', async (event) => {
    assertTrustedSender(event);
    try {
      const packaged = app.isPackaged;
      const args = packaged ? [] : [app.getAppPath()];
      const iconPath = packaged ? process.execPath : path.join(app.getAppPath(), 'build', 'icon.ico');
      const result = await shortcuts.createDesktopShortcut({
        targetPath: process.execPath,
        args,
        workingDirectory: packaged ? path.dirname(process.execPath) : app.getAppPath(),
        iconPath,
        name: 'FreeRAM'
      });
      return { ...result, packaged, devShortcut: !packaged };
    } catch (error) {
      logger.error('Création du raccourci impossible :', error);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('app:open-path', async (event, payload) => {
    assertTrustedSender(event);
    const key = payload?.key;
    const map = {
      config: paths.configDir,
      styles: paths.rendererDir,
      logs: paths.logsDir,
      userConfig: paths.userConfigDir
    };
    const target = map[key];
    if (!target) return { ok: false, error: 'Dossier inconnu.' };

    try {
      if (key === 'userConfig') fs.mkdirSync(target, { recursive: true });
      const error = await shell.openPath(target);
      if (error) return { ok: false, error };
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('app:relaunch-admin', async (event) => {
    assertTrustedSender(event);
    try {
      const packaged = app.isPackaged;
      const args = packaged
        ? ['--freeram-elevated']
        : [app.getAppPath(), '--freeram-elevated'];
      const result = await win32.relaunchAsAdmin({ exePath: process.execPath, args });
      if (result.ok) {
        setTimeout(() => app.quit(), 800);
      }
      return { ...result, scheduled: result.ok };
    } catch (error) {
      logger.error('Élévation impossible :', error);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('app:relaunch', async (event) => {
    assertTrustedSender(event);
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 150);
    return { ok: true };
  });

  ipcMain.handle('app:reload-ui', async (event) => {
    assertTrustedSender(event);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.reloadIgnoringCache();
    return { ok: true };
  });

  ipcMain.handle('updates:get-state', async (event) => {
    assertTrustedSender(event);
    return { ok: true, state: updater.getState() };
  });

  ipcMain.handle('updates:check', async (event) => {
    assertTrustedSender(event);
    try {
      return { ok: true, state: await updater.check() };
    } catch (error) {
      logger.error('Vérification des mises à jour impossible :', error);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('updates:download', async (event) => {
    assertTrustedSender(event);
    return updater.download();
  });

  ipcMain.handle('updates:install', async (event) => {
    assertTrustedSender(event);
    return updater.install();
  });

  ipcMain.handle('updates:set-channel', async (event, payload) => {
    assertTrustedSender(event);
    const channel = payload?.channel;
    if (channel !== 'stable' && channel !== 'beta') {
      return { ok: false, error: 'Canal de mise à jour invalide.' };
    }
    return updater.setChannel(channel);
  });

  ipcMain.handle('updates:open-github', async (event) => {
    assertTrustedSender(event);
    const url = githubReleasesUrl();
    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('build:capability', async (event) => {
    assertTrustedSender(event);
    return { ok: true, capability: await buildService.getCapability() };
  });

  ipcMain.handle('build:start', async (event, payload) => {
    assertTrustedSender(event);
    const channel = payload?.channel;
    if (channel !== 'stable' && channel !== 'beta') {
      return { ok: false, error: 'Canal de compilation invalide.' };
    }
    try {
      return await buildService.startBuild(channel);
    } catch (error) {
      logger.error('Compilation locale impossible :', error);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('build:status', async (event) => {
    assertTrustedSender(event);
    return { ok: true, status: buildService.readBuildStatus() };
  });

  ipcMain.handle('build:open-log', async (event) => {
    assertTrustedSender(event);
    const status = buildService.getStatus();
    const logPath = status?.logPath ? path.resolve(status.logPath) : null;
    const allowedRoot = path.resolve(paths.logsDir);
    if (!logPath || !logPath.startsWith(`${allowedRoot}${path.sep}`) || !fs.existsSync(logPath)) {
      return { ok: false, error: 'Aucun journal de compilation disponible.' };
    }
    try {
      const error = await shell.openPath(logPath);
      if (error) return { ok: false, error };
      return { ok: true, path: logPath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('sensors:status', async (event) => {
    assertTrustedSender(event);
    return { ok: true, status: sensors.getStatus(), latest: sensors.getLatest() };
  });
}

module.exports = { registerIpc };
