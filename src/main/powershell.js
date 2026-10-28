'use strict';

/**
 * Exécution de scripts PowerShell 5.1 sans fichier temporaire.
 * EncodedCommand évite les problèmes de guillemets, d'accents et de chemins
 * contenant des espaces (le dossier du projet s'appelle « FreeRAM.exe »).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function getPowerShellPath() {
  if (process.platform !== 'win32') return 'pwsh';
  const root = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Exécute un script PowerShell et renvoie stdout/stderr.
 * @param {string} script
 * @param {{timeoutMs?: number}} [options]
 */
function runPowerShell(script, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodeCommand(script)
  ];

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    execFile(
      getPowerShellPath(),
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        const result = {
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          durationMs: Date.now() - startedAt
        };
        if (error) {
          const wrapped = new Error(
            `Échec PowerShell (${error.code ?? 'inconnu'}) : ${
              (result.stderr || result.stdout || error.message).trim().slice(0, 500)
            }`
          );
          wrapped.stdout = result.stdout;
          wrapped.stderr = result.stderr;
          wrapped.durationMs = result.durationMs;
          reject(wrapped);
          return;
        }
        resolve(result);
      }
    );
  });
}

/** Transforme une valeur PowerShell en tableau JS (ConvertTo-Json sérialise parfois un singleton en objet). */
function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Exécute un script PowerShell qui doit écrire un objet JSON sur sa dernière ligne.
 */
async function runPowerShellJson(script, options = {}) {
  const { stdout } = await runPowerShell(script, options);
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* essaie la ligne précédente */
    }
  }

  throw new Error("La réponse PowerShell n'est pas un JSON exploitable.");
}

module.exports = {
  getPowerShellPath,
  runPowerShell,
  runPowerShellJson,
  asArray
};
