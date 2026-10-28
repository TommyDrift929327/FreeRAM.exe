'use strict';

/**
 * Helper détaché de compilation locale.
 *
 * Il est lancé par FreeRAM avant sa fermeture, attend la disparition du
 * processus principal, compile dans un dossier temporaire, vérifie les
 * artefacts, sauvegarde l'ancien `release` dans `release.previous`, puis
 * remplace `release` uniquement en cas de succès.
 *
 * Aucune publication GitHub n'est effectuée ici.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  expectedArtifacts,
  inspectArtifactDirectory,
  validateUpdateMetadata
} = require('../src/main/build-policy');
const { channelForVersion, updateChannelName } = require('../src/main/update-policy');

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : '';
    result[name] = value;
    if (value) index += 1;
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForExit(pid, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(250);
  }
  return !isProcessAlive(pid);
}

function writeStatus(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(temporary, file);
  } catch {
    /* le processus a déjà quitté */
  }
}

function appendLog(logPath, text) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch {
    /* journal indisponible */
  }
}

function runBuilder(sourceRoot, stagingDir, channel, logPath) {
  const cli = path.join(sourceRoot, 'node_modules', 'electron-builder', 'cli.js');
  if (!fs.existsSync(cli)) {
    return Promise.reject(new Error('electron-builder est absent du dossier source.'));
  }

  const args = [
    cli,
    '--win',
    '--publish',
    'never',
    `--config.directories.output=${stagingDir}`,
    `--config.publish.channel=${updateChannelName(channel)}`
  ];

  appendLog(logPath, `Commande : node ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(process.execPath, args, {
      cwd: sourceRoot,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      appendLog(logPath, text.trimEnd());
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      appendLog(logPath, text.trimEnd());
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`electron-builder a échoué avec le code ${code}.`));
      }
    });
  });
}

function copyForBetaChannel(directory, version, expected, channel) {
  const latest = path.join(directory, 'latest.yml');
  if (channel === 'beta') {
    if (fs.existsSync(latest)) fs.rmSync(latest, { force: true });
    return expected.updateFile;
  }
  if (!fs.existsSync(latest)) {
    throw new Error('latest.yml est absent de la compilation stable.');
  }
  const beta = path.join(directory, 'beta.yml');
  fs.copyFileSync(latest, beta);
  return expected.updateFile;
}

function swapRelease(sourceRoot, stagingDir) {
  const releaseDir = path.join(sourceRoot, 'release');
  const previousDir = path.join(sourceRoot, 'release.previous');

  if (fs.existsSync(previousDir)) {
    fs.rmSync(previousDir, { recursive: true, force: true });
  }

  const hadRelease = fs.existsSync(releaseDir);
  if (hadRelease) fs.renameSync(releaseDir, previousDir);

  try {
    fs.renameSync(stagingDir, releaseDir);
  } catch (error) {
    if (hadRelease && !fs.existsSync(releaseDir) && fs.existsSync(previousDir)) {
      fs.renameSync(previousDir, releaseDir);
    }
    throw error;
  }
  return { releaseDir, previousDir, hadRelease };
}

function launch(executable, argument) {
  if (!executable || !fs.existsSync(executable)) return false;
  try {
    const args = argument ? [argument] : [];
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(args.source || '');
  const statusFile = path.resolve(args.status || '');
  const logPath = path.resolve(args.log || path.join(sourceRoot, 'release-build.log'));
  const parentPid = Number.parseInt(args['parent-pid'], 10);
  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const channel = args.channel === 'beta' ? 'beta' : channelForVersion(version);
  const expected = expectedArtifacts(version, channel);
  const stagingDir = path.join(sourceRoot, `release.staging-${Date.now()}`);
  const startedAt = new Date().toISOString();

  const baseStatus = {
    status: 'building',
    version,
    channel,
    sourceRoot,
    outputDir: path.join(sourceRoot, 'release'),
    logPath,
    startedAt,
    artifacts: expected,
    error: null
  };
  writeStatus(statusFile, baseStatus);
  appendLog(logPath, `Compilation de FreeRAM ${version} (${channel})`);

  if (!(await waitForExit(parentPid))) {
    const error = 'FreeRAM ne s’est pas fermé à temps. La compilation a été annulée.';
    appendLog(logPath, error);
    writeStatus(statusFile, { ...baseStatus, status: 'failed', error, finishedAt: new Date().toISOString() });
    launch(args.relaunch, args['relaunch-arg']);
    return;
  }

  let staged = false;
  try {
    await runBuilder(sourceRoot, stagingDir, channel, logPath);
    staged = true;

    const inspection = inspectArtifactDirectory(stagingDir, version, channel, fs);
    if (!inspection.ok) {
      throw new Error(`Fichiers manquants après compilation : ${inspection.missing.join(', ')}`);
    }

    const updateFile = copyForBetaChannel(stagingDir, version, expected, channel);
    const metadata = validateUpdateMetadata(updateFile, version, expected.setup, fs);
    if (!metadata.ok) throw new Error(metadata.error);
    if (channel === 'stable') {
      const betaMetadata = validateUpdateMetadata(
        path.join(stagingDir, 'beta.yml'),
        version,
        expected.setup,
        fs
      );
      if (!betaMetadata.ok) throw new Error(betaMetadata.error);
    }

    const swapped = swapRelease(sourceRoot, stagingDir);
    const finishedAt = new Date().toISOString();
    const success = {
      ...baseStatus,
      status: 'success',
      finishedAt,
      releaseDir: swapped.releaseDir,
      previousDir: swapped.hadRelease ? swapped.previousDir : null,
      artifacts: {
        ...expected,
        setupPath: path.join(swapped.releaseDir, expected.setup),
        portablePath: path.join(swapped.releaseDir, expected.portable),
        updatePath: path.join(swapped.releaseDir, expected.updateFile)
      }
    };
    writeStatus(statusFile, success);
    appendLog(logPath, `Compilation réussie. Ancienne version : ${success.previousDir || 'aucune'}`);
    launch(path.join(swapped.releaseDir, 'win-unpacked', 'FreeRAM.exe'), '');
  } catch (error) {
    const message = String(error?.message || error);
    appendLog(logPath, `ÉCHEC : ${message}`);
    if (staged || fs.existsSync(stagingDir)) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* le dossier sera nettoyé plus tard */
      }
    }
    writeStatus(statusFile, {
      ...baseStatus,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: message
    });
    // En cas d'échec, `release` n'a pas été touché : on relance l'ancienne version.
    launch(
      path.join(sourceRoot, 'release', 'win-unpacked', 'FreeRAM.exe'),
      ''
    ) || launch(args.relaunch, args['relaunch-arg']);
  }
}

main().catch((error) => {
  const args = parseArgs(process.argv.slice(2));
  const statusFile = args.status ? path.resolve(args.status) : null;
  if (statusFile) {
    writeStatus(statusFile, {
      status: 'failed',
      error: String(error?.stack || error),
      finishedAt: new Date().toISOString()
    });
  }
  process.exitCode = 1;
});
