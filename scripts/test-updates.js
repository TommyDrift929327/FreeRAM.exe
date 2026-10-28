'use strict';

/**
 * Tests des règles de canaux et de vérification des artefacts.
 * Aucun réseau, aucun Electron, aucune compilation.
 *
 * Lancement : npm run test:updates
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isAllowedVersion,
  isBetaVersion,
  channelForVersion,
  updateChannelName,
  updateFileName,
  releasesUrl
} = require('../src/main/update-policy');
const {
  expectedArtifacts,
  inspectArtifactDirectory,
  validateUpdateMetadata
} = require('../src/main/build-policy');

let failures = 0;
const results = [];

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, ms: Date.now() - started, error });
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

async function main() {
  console.log(`\nFreeRAM — tests des mises à jour (${os.platform()} ${os.release()})\n`);

  await test('détection des versions bêta', () => {
    assert.equal(isBetaVersion('1.1.0-beta.1'), true);
    assert.equal(isBetaVersion('1.1.0-beta.2'), true);
    assert.equal(isBetaVersion('1.1.0'), false);
    assert.equal(isBetaVersion('1.1.0-rc.1'), false);
  });

  await test('canal par défaut selon la version', () => {
    assert.equal(channelForVersion('1.1.0-beta.1'), 'beta');
    assert.equal(channelForVersion('1.1.0'), 'stable');
  });

  await test('le canal stable refuse toutes les pré-releases', () => {
    assert.equal(isAllowedVersion('1.1.0', 'stable'), true);
    assert.equal(isAllowedVersion('1.1.0-beta.1', 'stable'), false);
    assert.equal(isAllowedVersion('1.1.0-rc.1', 'stable'), false);
  });

  await test('le canal bêta accepte stable et beta uniquement', () => {
    assert.equal(isAllowedVersion('1.1.0', 'beta'), true);
    assert.equal(isAllowedVersion('1.1.0-beta.1', 'beta'), true);
    assert.equal(isAllowedVersion('1.1.0-alpha.1', 'beta'), false);
    assert.equal(isAllowedVersion('1.1.0-rc.1', 'beta'), false);
  });

  await test('noms de canaux electron-updater', () => {
    assert.equal(updateChannelName('stable'), 'latest');
    assert.equal(updateChannelName('beta'), 'beta');
    assert.equal(updateFileName('stable'), 'latest.yml');
    assert.equal(updateFileName('beta'), 'beta.yml');
  });

  await test('URL GitHub des releases', () => {
    assert.equal(
      releasesUrl('TommyDrift929327', 'FreeRAM.exe'),
      'https://github.com/TommyDrift929327/FreeRAM.exe/releases'
    );
  });

  await test('artefacts attendus pour une stable', () => {
    assert.deepEqual(expectedArtifacts('1.1.0', 'stable'), {
      setup: 'FreeRAM-1.1.0-setup.exe',
      portable: 'FreeRAM-1.1.0-portable.exe',
      blockmap: 'FreeRAM-1.1.0-setup.exe.blockmap',
      updateFile: 'latest.yml'
    });
  });

  await test('artefacts attendus pour une bêta', () => {
    assert.deepEqual(expectedArtifacts('1.1.0-beta.1', 'beta'), {
      setup: 'FreeRAM-1.1.0-beta.1-setup.exe',
      portable: 'FreeRAM-1.1.0-beta.1-portable.exe',
      blockmap: 'FreeRAM-1.1.0-beta.1-setup.exe.blockmap',
      updateFile: 'beta.yml'
    });
  });

  await test('vérification d’un dossier de compilation valide', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freeram-artifacts-'));
    const expected = expectedArtifacts('1.1.0-beta.1', 'beta');
    try {
      const payload = Buffer.alloc(1024 * 1024 + 1);
      fs.writeFileSync(path.join(directory, expected.setup), payload);
      fs.writeFileSync(path.join(directory, expected.portable), payload);
      fs.writeFileSync(path.join(directory, expected.blockmap), payload);
      fs.writeFileSync(
        path.join(directory, expected.updateFile),
        `version: 1.1.0-beta.1\npath: ${expected.setup}\n`
      );

      const inspection = inspectArtifactDirectory(directory, '1.1.0-beta.1', 'beta', fs);
      assert.equal(inspection.ok, true, inspection.missing.join(', '));
      const metadata = validateUpdateMetadata(
        path.join(directory, expected.updateFile),
        '1.1.0-beta.1',
        expected.setup,
        fs
      );
      assert.equal(metadata.ok, true, metadata.error);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await test('un artefact manquant invalide la compilation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freeram-artifacts-'));
    try {
      const inspection = inspectArtifactDirectory(directory, '1.1.0', 'stable', fs);
      assert.equal(inspection.ok, false);
      assert.ok(inspection.missing.includes('FreeRAM-1.1.0-setup.exe'));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} test(s) en échec sur ${results.length}.`);
    process.exitCode = 1;
  } else {
    console.log(`${results.length}/${results.length} tests réussis.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
