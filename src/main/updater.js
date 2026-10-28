'use strict';

/**
 * Service de mise à jour.
 *
 * - La vérification est toujours manuelle ou planifiée (24 h par défaut).
 * - Aucun téléchargement automatique : l'utilisateur doit cliquer.
 * - Aucune installation sans confirmation : quitAndInstall n'est appelé
 *   qu'après l'action explicite du renderer.
 * - Le canal stable refuse toute version pré-release, même si GitHub renvoie
 *   par erreur un fichier de mise à jour bêta.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const configModule = require('./config');
const logger = require('./logger');
const {
  normalizeChannel,
  channelForVersion,
  isAllowedVersion,
  updateChannelName
} = require('./update-policy');

const STATUS = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  UP_TO_DATE: 'up-to-date',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported'
});

const SUPPORT_MESSAGES = Object.freeze({
  development:
    'Les mises à jour sont disponibles uniquement dans la version installée. Le mode développement ne peut pas être mis à jour automatiquement.',
  portable:
    'La version portable ne peut pas se mettre à jour automatiquement. Téléchargez la nouvelle version depuis GitHub.',
  unpacked:
    'Cette copie non installée (win-unpacked) ne peut pas se mettre à jour automatiquement. Installez FreeRAM avec le setup NSIS.',
  metadata:
    'Le fichier de configuration de mise à jour est absent. Réinstallez FreeRAM avec le setup officiel.'
});

function isPrereleaseVersion(version) {
  return String(version || '').includes('-');
}

function supportInfo() {
  if (!app.isPackaged) {
    return { supported: false, reason: 'development', message: SUPPORT_MESSAGES.development };
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) {
    return { supported: false, reason: 'portable', message: SUPPORT_MESSAGES.portable };
  }
  if (path.basename(path.dirname(process.execPath)).toLowerCase() === 'win-unpacked') {
    return { supported: false, reason: 'unpacked', message: SUPPORT_MESSAGES.unpacked };
  }
  try {
    if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
      return { supported: false, reason: 'metadata', message: SUPPORT_MESSAGES.metadata };
    }
  } catch {
    return { supported: false, reason: 'metadata', message: SUPPORT_MESSAGES.metadata };
  }
  return { supported: true, reason: null, message: null };
}

class UpdateService {
  constructor(options = {}) {
    this.getWindow = typeof options.getWindow === 'function' ? options.getWindow : () => null;
    this.config = options.config || configModule.getConfig();
    this.preferencesFile = path.join(app.getPath('userData'), 'update-preferences.json');
    this.initialized = false;
    this.checking = false;
    this.initialTimer = null;
    this.intervalTimer = null;
    this.state = {
      status: STATUS.IDLE,
      currentVersion: app.getVersion(),
      availableVersion: null,
      channel: this.getInitialChannel(),
      supported: false,
      reason: null,
      message: null,
      progress: null,
      releaseName: null,
      releaseNotes: null,
      error: null,
      lastCheckedAt: null
    };
  }

  getInitialChannel() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.preferencesFile, 'utf8'));
      if (raw && (raw.channel === 'stable' || raw.channel === 'beta')) {
        return raw.channel;
      }
    } catch {
      /* préférence absente ou invalide */
    }
    if (isPrereleaseVersion(app.getVersion())) return channelForVersion(app.getVersion());
    return normalizeChannel(this.config.updates?.channel);
  }

  getState() {
    return { ...this.state };
  }

  send() {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send('updates:status', this.getState());
    } catch {
      /* fenêtre en cours de fermeture */
    }
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.send();
  }

  applyChannel(channel) {
    autoUpdater.channel = updateChannelName(channel);
    autoUpdater.allowPrerelease = normalizeChannel(channel) === 'beta';
    // Le setter de electron-updater active allowDowngrade automatiquement.
    // FreeRAM ne doit jamais rétrograder une installation, surtout pas de bêta vers stable.
    autoUpdater.allowDowngrade = false;
    logger.info(
      `Canal de mise à jour : ${channel} (${autoUpdater.channel}, allowPrerelease=${autoUpdater.allowPrerelease})`
    );
  }

  init() {
    if (this.initialized) return this.state;
    this.initialized = true;

    const support = supportInfo();
    this.state = {
      ...this.state,
      supported: support.supported,
      reason: support.reason,
      message: support.message,
      status: support.supported ? STATUS.IDLE : STATUS.UNSUPPORTED
    };

    if (!support.supported) {
      logger.info('Mises à jour non prises en charge :', support.reason);
      this.send();
      return this.state;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info: (...args) => logger.info('[updater]', ...args),
      warn: (...args) => logger.warn('[updater]', ...args),
      error: (...args) => logger.error('[updater]', ...args),
      debug: (...args) => logger.debug('[updater]', ...args)
    };

    this.applyChannel(this.state.channel);
    this.bindEvents();
    this.schedule();
    this.send();
    return this.state;
  }

  bindEvents() {
    autoUpdater.on('checking-for-update', () => {
      this.setState({ status: STATUS.CHECKING, error: null, progress: null });
    });

    autoUpdater.on('update-available', (info) => {
      const version = String(info?.version || '');
      if (!isAllowedVersion(version, this.state.channel)) {
        this.setState({
          status: STATUS.ERROR,
          availableVersion: null,
          progress: null,
          error:
            this.state.channel === 'stable'
              ? `La version ${version} est une pré-release et a été refusée sur le canal stable.`
              : `La version ${version} n'appartient pas au canal bêta pris en charge.`,
          lastCheckedAt: Date.now()
        });
        return;
      }
      this.setState({
        status: STATUS.AVAILABLE,
        availableVersion: version,
        releaseName: info?.releaseName || null,
        releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
        progress: null,
        error: null,
        lastCheckedAt: Date.now()
      });
    });

    autoUpdater.on('update-not-available', () => {
      this.setState({
        status: STATUS.UP_TO_DATE,
        availableVersion: null,
        progress: null,
        error: null,
        lastCheckedAt: Date.now()
      });
    });

    autoUpdater.on('download-progress', (progress) => {
      const percent = Number(progress?.percent);
      this.setState({
        status: STATUS.DOWNLOADING,
        progress: {
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
          transferred: Number(progress?.transferred) || 0,
          total: Number(progress?.total) || 0,
          bytesPerSecond: Number(progress?.bytesPerSecond) || 0
        },
        error: null
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      const version = String(info?.version || this.state.availableVersion || '');
      if (!isAllowedVersion(version, this.state.channel)) {
        this.setState({
          status: STATUS.ERROR,
          error: `Mise à jour ${version} refusée : canal incompatible.`
        });
        return;
      }
      this.setState({
        status: STATUS.DOWNLOADED,
        availableVersion: version,
        releaseName: info?.releaseName || this.state.releaseName,
        releaseNotes:
          typeof info?.releaseNotes === 'string' ? info.releaseNotes : this.state.releaseNotes,
        progress: { percent: 100 },
        error: null
      });
    });

    autoUpdater.on('error', (error) => {
      const message = String(error?.message || error || 'Erreur de mise à jour inconnue.');
      logger.error('Erreur de mise à jour :', message);
      this.setState({
        status: STATUS.ERROR,
        error: message,
        lastCheckedAt: Date.now()
      });
    });
  }

  async check() {
    if (!this.state.supported) return this.getState();
    if (this.checking) return this.getState();
    if (this.state.status === STATUS.DOWNLOADING || this.state.status === STATUS.DOWNLOADED) {
      return this.getState();
    }
    this.checking = true;
    this.setState({ status: STATUS.CHECKING, error: null, progress: null });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.setState({
        status: STATUS.ERROR,
        error: String(error?.message || error),
        lastCheckedAt: Date.now()
      });
    } finally {
      this.checking = false;
    }
    return this.getState();
  }

  async download() {
    if (!this.state.supported) return { ok: false, error: this.state.message };
    if (this.state.status !== STATUS.AVAILABLE || !this.state.availableVersion) {
      return { ok: false, error: 'Aucune mise à jour disponible à télécharger.' };
    }
    if (!isAllowedVersion(this.state.availableVersion, this.state.channel)) {
      return { ok: false, error: 'Cette mise à jour ne correspond pas au canal sélectionné.' };
    }
    try {
      this.setState({ status: STATUS.DOWNLOADING, progress: { percent: 0 }, error: null });
      await autoUpdater.downloadUpdate();
      return { ok: true, state: this.getState() };
    } catch (error) {
      this.setState({
        status: STATUS.ERROR,
        error: String(error?.message || error),
        progress: null
      });
      return { ok: false, error: String(error?.message || error) };
    }
  }

  install() {
    if (this.state.status !== STATUS.DOWNLOADED) {
      return { ok: false, error: 'Aucune mise à jour téléchargée à installer.' };
    }
    logger.info('Installation de la mise à jour demandée :', this.state.availableVersion);
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        logger.error('Installation de la mise à jour impossible :', error);
      }
    }, 250);
    return { ok: true };
  }

  setChannel(channel) {
    const normalized = normalizeChannel(channel);
    if (
      this.checking ||
      this.state.status === STATUS.DOWNLOADING ||
      this.state.status === STATUS.DOWNLOADED
    ) {
      return {
        ok: false,
        error: 'Attendez la fin de la vérification ou du téléchargement avant de changer de canal.'
      };
    }
    try {
      fs.mkdirSync(path.dirname(this.preferencesFile), { recursive: true });
      const temporary = `${this.preferencesFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ channel: normalized }, null, 2), 'utf8');
      fs.renameSync(temporary, this.preferencesFile);
    } catch (error) {
      logger.error('Enregistrement du canal de mise à jour impossible :', error);
      return { ok: false, error: 'Impossible d’enregistrer le canal de mise à jour.' };
    }

    if (this.state.supported) this.applyChannel(normalized);
    this.setState({
      channel: normalized,
      status: this.state.supported ? STATUS.IDLE : STATUS.UNSUPPORTED,
      availableVersion: null,
      progress: null,
      error: null,
      releaseName: null,
      releaseNotes: null
    });
    return { ok: true, state: this.getState() };
  }

  schedule() {
    const checkOnStartup = this.config.updates?.checkOnStartup !== false;
    if (!checkOnStartup || !this.state.supported) return;

    const hours = Math.max(1, Math.min(168, Number(this.config.updates?.checkIntervalHours) || 24));
    const intervalMs = hours * 60 * 60 * 1000;

    this.initialTimer = setTimeout(() => {
      this.check().catch((error) => logger.warn('Vérification automatique impossible :', error));
    }, 30_000);
    this.initialTimer.unref?.();

    this.intervalTimer = setInterval(() => {
      this.check().catch((error) => logger.warn('Vérification automatique impossible :', error));
    }, intervalMs);
    this.intervalTimer.unref?.();
  }

  stop() {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }
}

module.exports = {
  UpdateService,
  STATUS,
  supportInfo,
  isPrereleaseVersion
};
