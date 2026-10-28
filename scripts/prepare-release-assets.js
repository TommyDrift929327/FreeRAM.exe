'use strict';

/**
 * Vérifie les artefacts electron-builder et prépare les métadonnées de canal.
 *
 * Stable : latest.yml et une copie beta.yml (pour que les clients bêta voient
 * aussi les versions stables plus récentes).
 * Bêta : beta.yml uniquement ; latest.yml est retiré du dossier de build.
 *
 * Ce script ne publie rien sur GitHub.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  expectedArtifacts,
  inspectArtifactDirectory,
  validateUpdateMetadata
} = require('../src/main/build-policy');
const { normalizeChannel, channelForVersion } = require('../src/main/update-policy');

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const channel = args.channel
    ? normalizeChannel(args.channel)
    : channelForVersion(version);
  const directory = path.resolve(args.dir || path.join(root, 'release'));
  const expected = expectedArtifacts(version, channel);

  const inspection = inspectArtifactDirectory(directory, version, channel, fs);
  if (!inspection.ok) {
    throw new Error(`Artefacts manquants : ${inspection.missing.join(', ')}`);
  }

  const latest = path.join(directory, 'latest.yml');
  const beta = path.join(directory, 'beta.yml');
  if (channel === 'stable') {
    if (!fs.existsSync(latest)) throw new Error('latest.yml est absent de la compilation stable.');
    fs.copyFileSync(latest, beta);
  } else if (fs.existsSync(latest)) {
    fs.rmSync(latest, { force: true });
  }

  for (const file of [expected.updateFile]) {
    const metadata = validateUpdateMetadata(
      path.join(directory, file),
      version,
      expected.setup,
      fs
    );
    if (!metadata.ok) throw new Error(metadata.error);
  }

  if (channel === 'stable') {
    const betaMetadata = validateUpdateMetadata(beta, version, expected.setup, fs);
    if (!betaMetadata.ok) throw new Error(betaMetadata.error);
  }

  console.log(`Artefacts ${channel} validés pour FreeRAM ${version}.`);
  for (const file of [
    expected.setup,
    expected.portable,
    expected.blockmap,
    expected.updateFile,
    ...(channel === 'stable' ? ['beta.yml'] : [])
  ]) {
    console.log(`- ${path.join(directory, file)}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`Préparation des artefacts impossible : ${error.message}`);
  process.exitCode = 1;
}
