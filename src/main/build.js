'use strict';

/**
 * Compilation locale.
 *
 * Le renderer ne peut jamais lancer une commande arbitraire : le processus
 * principal vérifie le dossier source, Node.js, npm et electron-builder, puis
 * démarre un helper fixe. Le helper attend la fermeture de FreeRAM, compile
 * dans un dossier temporaire, vérifie les fichiers et remplace `release`
 * seulement si tout est valide.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { app } = require('electron');
const configModule = require('./config');
const logger = require('./logger');
const { expectedArtifacts } = require('./build-policy');
const { normalizeChannel, channelForVersion } = require('./update-policy');

const CAPABILITY_TTL_MS = 15_000;
const BUILD_STATUS_FILE = 'build-status.json';

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function validSourceRoot(root) {
  if (!root) return false;
  return (
    fileExists(path.join(root, 'package.json')) &&
    fileExists(path.join(root, 'main.js')) &&
    fileExists(path.join(root, 'src', 'main', 'ipc.js')) &&
    fileExists(path.join(root, 'scripts', 'build-and-relaunch.js')) &&
    fileExists(path.join(root, 'node_modules', 'electron-builder', 'cli.js'))
  );
}

function findSourceRoot() {
  const candidates = [];
  if (!app.isPackaged) candidates.push(app.getAppPath());
  try {
    candidates.push(path.resolve(path.dirname(process.execPath), '..', '..'));
  } catch {
    /* chemin indisponible */
  }
  candidates.push(process.cwd());

  for (const candidate of [...new Set(candidates)]) {
    try {
      const resolved = path.resolve(candidate);
      if (validSourceRoot(resolved)) return resolved;
    } catch {
      /* candidat invalide */
    }
  }
  return null;
}

function execText(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: 10000,
        encoding: 'utf8',
        ...options
      },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: String(error.message || error), value: null });
          return;
        }
        resolve({ ok: true, value: String(stdout || '').trim(), error: null });
      }
    );
  });
}

class BuildService {
  constructor(options = {}) {
    this.getWindow = typeof options.getWindow === 'function' ? options.getWindow : () => null;
    this.config = options.config || configModule.getConfig();
    this.statusFile = path.join(app.getPath('userData'), BUILD_STATUS_FILE);
    this.capabilityCache = null;
    this.capabilityCachedAt = 0;
    this.building = false;
    this.lastStatus = null;
  }

  send() {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send('build:status', this.getStatus());
    } catch {
      /* fenêtre fermée */
    }
  }

  getStatus() {
    if (this.lastStatus) return this.lastStatus;
    const stored = readJson(this.statusFile);
    if (!stored) return null;
    return stored;
  }

  consumeStatus() {
    const status = this.getStatus();
    if (!status) return null;
    this.lastStatus = status;
    if (status.status === 'starting' || status.status === 'building') return status;
    try {
      fs.rmSync(this.statusFile, { force: true });
    } catch {
      /* le statut sera simplement relu */
    }
    return status;
  }

  async getCapability(force = false) {
    const now = Date.now();
    if (!force && this.capabilityCache && now - this.capabilityCachedAt < CAPABILITY_TTL_MS) {
      return this.capabilityCache;
    }

    const sourceRoot = findSourceRoot();
    if (!sourceRoot) {
      this.capabilityCache = {
        ok: false,
        reason: 'source-missing',
        message:
          'Le code source est absent. La compilation locale est disponible uniquement depuis le dossier du projet, pas depuis une version installée.',
        sourceRoot: null,
        outputDir: null,
        version: app.getVersion(),
        channel: channelForVersion(app.getVersion()),
        artifacts: expectedArtifacts(app.getVersion(), channelForVersion(app.getVersion()))
      };
      this.capabilityCachedAt = now;
      return this.capabilityCache;
    }

    const packageJson = readJson(path.join(sourceRoot, 'package.json'));
    if (!packageJson?.version) {
      this.capabilityCache = {
        ok: false,
        reason: 'package-invalid',
        message: 'Le fichier package.json du projet est illisible ou ne contient pas de version.',
        sourceRoot,
        outputDir: path.join(sourceRoot, 'release'),
        version: null,
        channel: channelForVersion(app.getVersion()),
        artifacts: null
      };
      this.capabilityCachedAt = now;
      return this.capabilityCache;
    }

    const node = await execText('node', ['--version']);
    if (!node.ok) {
      this.capabilityCache = {
        ok: false,
        reason: 'node-missing',
        message:
          'Node.js est introuvable dans le PATH. Installez Node.js puis relancez FreeRAM.',
        sourceRoot,
        outputDir: path.join(sourceRoot, 'release'),
        version: packageJson.version,
        channel: channelForVersion(app.getVersion()),
        artifacts: expectedArtifacts(packageJson.version, channelForVersion(packageJson.version))
      };
      this.capabilityCachedAt = now;
      return this.capabilityCache;
    }

    const npm = await execText(process.env.ComSpec || 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      'npm --version'
    ]);
    if (!npm.ok) {
      this.capabilityCache = {
        ok: false,
        reason: 'npm-missing',
        message: 'npm est introuvable. Réinstallez Node.js avec npm puis relancez FreeRAM.',
        sourceRoot,
        outputDir: path.join(sourceRoot, 'release'),
        version: packageJson.version,
        channel: channelForVersion(app.getVersion()),
        artifacts: expectedArtifacts(packageJson.version, channelForVersion(packageJson.version))
      };
      this.capabilityCachedAt = now;
      return this.capabilityCache;
    }

    if (!fileExists(path.join(sourceRoot, 'node_modules', 'electron-builder', 'cli.js'))) {
      this.capabilityCache = {
        ok: false,
        reason: 'dependencies-missing',
        message:
          'Les dépendances de compilation sont absentes. Lancez « npm install » dans le dossier du projet.',
        sourceRoot,
        outputDir: path.join(sourceRoot, 'release'),
        version: packageJson.version,
        channel: channelForVersion(app.getVersion()),
        artifacts: expectedArtifacts(packageJson.version, channelForVersion(packageJson.version))
      };
      this.capabilityCachedAt = now;
      return this.capabilityCache;
    }

    this.capabilityCache = {
      ok: true,
      reason: null,
      message: 'Compilation locale disponible.',
      sourceRoot,
      outputDir: path.join(sourceRoot, 'release'),
      version: packageJson.version,
      channel: channelForVersion(app.getVersion()),
      nodeVersion: node.value,
      npmVersion: npm.value,
      artifacts: expectedArtifacts(packageJson.version, channelForVersion(packageJson.version))
    };
    this.capabilityCachedAt = now;
    return this.capabilityCache;
  }

  async startBuild(requestedChannel) {
    if (this.building) {
      return { ok: false, error: 'Une compilation est déjà en cours.' };
    }
    const capability = await this.getCapability(true);
    if (!capability.ok) return { ok: false, error: capability.message, capability };

    const version = capability.version;
    const channel =
      channelForVersion(version) === 'beta'
        ? 'beta'
        : requestedChannel
          ? normalizeChannel(requestedChannel)
          : 'stable';
    const logDir = app.getPath('logs');
    const logPath = path.join(logDir, `build-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.mkdirSync(path.dirname(this.statusFile), { recursive: true });
    } catch (error) {
      return { ok: false, error: `Impossible de préparer le journal de compilation : ${error.message}` };
    }

    const status = {
      status: 'starting',
      version,
      channel,
      sourceRoot: capability.sourceRoot,
      outputDir: capability.outputDir,
      logPath,
      startedAt: new Date().toISOString(),
      artifacts: capability.artifacts,
      error: null
    };
    try {
      fs.writeFileSync(this.statusFile, JSON.stringify(status, null, 2), 'utf8');
    } catch (error) {
      return { ok: false, error: `Impossible d’écrire le statut de compilation : ${error.message}` };
    }

    const helper = path.join(capability.sourceRoot, 'scripts', 'build-and-relaunch.js');
    const args = [
      helper,
      '--source',
      capability.sourceRoot,
      '--channel',
      channel,
      '--parent-pid',
      String(process.pid),
      '--status',
      this.statusFile,
      '--log',
      logPath,
      '--relaunch',
      process.execPath,
      '--relaunch-arg',
      app.isPackaged ? '' : app.getAppPath()
    ];

    try {
      const child = spawn('node', args, {
        cwd: capability.sourceRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } catch (error) {
      const failed = { ...status, status: 'failed', error: String(error?.message || error) };
      try {
        fs.writeFileSync(this.statusFile, JSON.stringify(failed, null, 2), 'utf8');
      } catch {
        /* ignore */
      }
      return { ok: false, error: `Impossible de démarrer la compilation : ${error.message}` };
    }

    this.building = true;
    logger.info('Compilation locale demandée', { version, channel, sourceRoot: capability.sourceRoot });
    setTimeout(() => app.quit(), 1200);
    return { ok: true, status, message: 'FreeRAM va se fermer pour compiler.' };
  }

  readBuildStatus() {
    return this.consumeStatus();
  }
}

module.exports = {
  BuildService,
  findSourceRoot,
  validSourceRoot
};
