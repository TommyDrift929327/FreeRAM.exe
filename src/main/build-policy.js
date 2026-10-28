'use strict';

/**
 * Règles pures de vérification d'une compilation locale.
 * Aucun accès Electron : utilisable par les tests et par le helper détaché.
 */

const path = require('node:path');
const { normalizeChannel, updateFileName } = require('./update-policy');

const MIN_INSTALLER_BYTES = 1024 * 1024;

function expectedArtifacts(version, channel) {
  const normalized = normalizeChannel(channel);
  return {
    setup: `FreeRAM-${version}-setup.exe`,
    portable: `FreeRAM-${version}-portable.exe`,
    blockmap: `FreeRAM-${version}-setup.exe.blockmap`,
    updateFile: updateFileName(normalized)
  };
}

function inspectArtifactDirectory(directory, version, channel, fsModule = require('node:fs')) {
  const expected = expectedArtifacts(version, channel);
  const missing = [];
  const present = {};

  for (const [key, name] of Object.entries(expected)) {
    const fullPath = path.join(directory, name);
    try {
      const stats = fsModule.statSync(fullPath);
      if (!stats.isFile()) {
        missing.push(name);
        continue;
      }
      if (key === 'setup' || key === 'portable') {
        if (stats.size < MIN_INSTALLER_BYTES) {
          missing.push(`${name} (fichier trop petit)`);
          continue;
        }
      }
      if (key === 'updateFile' && stats.size < 20) {
        missing.push(`${name} (métadonnées vides)`);
        continue;
      }
      present[key] = fullPath;
    } catch {
      missing.push(name);
    }
  }

  return {
    ok: missing.length === 0,
    expected,
    present,
    missing
  };
}

function validateUpdateMetadata(file, version, setupName, fsModule = require('node:fs')) {
  try {
    const content = fsModule.readFileSync(file, 'utf8');
    if (!content.includes(`version: ${version}`)) {
      return { ok: false, error: `Le fichier ${path.basename(file)} ne contient pas la version ${version}.` };
    }
    if (!content.includes(`path: ${setupName}`)) {
      return { ok: false, error: `Le fichier ${path.basename(file)} ne pointe pas vers ${setupName}.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

module.exports = {
  MIN_INSTALLER_BYTES,
  expectedArtifacts,
  inspectArtifactDirectory,
  validateUpdateMetadata
};
