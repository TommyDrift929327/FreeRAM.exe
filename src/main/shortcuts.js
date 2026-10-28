'use strict';

/**
 * Création d'un raccourci sur le Bureau via WScript.Shell.
 * Utilisé par le bouton de l'application et par scripts/create-shortcut.ps1.
 */

const fs = require('node:fs');
const path = require('node:path');
const { runPowerShellJson } = require('./powershell');

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function safeShortcutName(name) {
  const cleaned = String(name || 'FreeRAM')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .trim()
    .slice(0, 80);
  return cleaned || 'FreeRAM';
}

async function createDesktopShortcut(options = {}) {
  const targetPath = options.targetPath;
  if (!targetPath || !fs.existsSync(targetPath)) {
    throw new Error(`Cible du raccourci introuvable : ${targetPath || '(vide)'}`);
  }

  const name = safeShortcutName(options.name);
  const args = Array.isArray(options.args) ? options.args.join(' ') : String(options.args || '');
  const workingDirectory = options.workingDirectory || path.dirname(targetPath);
  const iconPath = options.iconPath && fs.existsSync(options.iconPath) ? options.iconPath : targetPath;
  const description = options.description || 'FreeRAM — surveiller et libérer la mémoire vive';

  const script = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktop (${psQuote(name)} + '.lnk')
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = ${psQuote(targetPath)}
  $shortcut.Arguments = ${psQuote(args)}
  $shortcut.WorkingDirectory = ${psQuote(workingDirectory)}
  $shortcut.IconLocation = ${psQuote(iconPath)} + ',0'
  $shortcut.Description = ${psQuote(description)}
  $shortcut.WindowStyle = 1
  $shortcut.Save()
  [pscustomobject]@{ ok = $true; path = $shortcutPath; error = $null } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; path = $null; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

  const result = await runPowerShellJson(script, { timeoutMs: 20000 });
  if (!result.ok) throw new Error(result.error || 'Création du raccourci impossible.');
  return { ok: true, path: result.path, targetPath, args };
}

module.exports = { createDesktopShortcut, safeShortcutName };
