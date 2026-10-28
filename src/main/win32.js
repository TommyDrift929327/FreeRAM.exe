'use strict';

/**
 * Primitives Windows : fermeture gracieuse (WM_CLOSE), terminaison forcée,
 * dates de démarrage des processus, ajustement des working sets, élévation.
 *
 * Aucune de ces fonctions ne décide seule de fermer un processus : la
 * validation (PID existants, liste protégée, limite de 256) est faite en amont.
 */

const { runPowerShellJson, asArray } = require('./powershell');
const logger = require('./logger');

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Envoie WM_CLOSE à toutes les fenêtres visibles des PID ciblés.
 * C'est la fermeture « normale » : l'application peut afficher une sauvegarde,
 * se réduire dans la zone de notification, ou refuser de se fermer.
 */
async function sendCloseMessages(pids) {
  if (!Array.isArray(pids) || pids.length === 0) return { results: [] };

  const targets = pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  if (targets.length === 0) return { results: [] };

  const script = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$targets = @(${targets.join(',')})

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FreeRamWindowClose
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    private const uint WM_CLOSE = 0x0010;

    public static int SendClose(int targetPid)
    {
        int visible = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == (uint)targetPid && IsWindowVisible(hWnd))
            {
                if (PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) visible++;
            }
            return true;
        }, IntPtr.Zero);

        if (visible > 0) return visible;

        // Application réduite dans la zone de notification : sa fenêtre
        // principale est masquée mais possède généralement un titre.
        int hidden = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == (uint)targetPid && !IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0)
            {
                if (PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) hidden++;
            }
            return true;
        }, IntPtr.Zero);
        return hidden;
    }
}
'@

$results = @()
foreach ($target in $targets) {
  $windows = 0
  $errorMessage = $null
  try {
    $windows = [FreeRamWindowClose]::SendClose([int]$target)
  } catch {
    $errorMessage = $_.Exception.Message
  }
  $results += [pscustomobject]@{
    pid = [int]$target
    windows = [int]$windows
    error = $errorMessage
  }
}
[pscustomobject]@{ results = @($results) } | ConvertTo-Json -Compress -Depth 4
`;

  const json = await runPowerShellJson(script, { timeoutMs: 25000 });
  const byPid = new Map(
    asArray(json.results).map((entry) => [
      Number(entry.pid),
      { pid: Number(entry.pid), windows: Number(entry.windows) || 0, error: entry.error || null }
    ])
  );

  return {
    results: targets.map(
      (pid) => byPid.get(pid) || { pid, windows: 0, error: 'Aucune réponse de Windows' }
    )
  };
}

/**
 * Terminaison forcée de plusieurs PID en un seul appel PowerShell.
 * On n'utilise volontairement pas taskkill /T : fermer un arbre entier
 * pourrait emporter des processus non sélectionnés.
 *
 * Stop-Process renvoie un code d'erreur natif exploitable (5 = accès refusé),
 * ce qui évite de dépendre de la langue de Windows.
 */
async function forceKillMany(pids) {
  const targets = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  if (targets.length === 0) return [];

  const script = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$targets = @(${targets.join(',')})
$results = @()
foreach ($target in $targets) {
  $ok = $false
  $message = $null
  $nativeError = $null
  try {
    Stop-Process -Id ([int]$target) -Force -ErrorAction Stop
    $ok = $true
  } catch {
    $message = $_.Exception.Message
    if ($null -ne $_.Exception.NativeErrorCode) { $nativeError = [int]$_.Exception.NativeErrorCode }
    elseif ($null -ne $_.Exception.InnerException.NativeErrorCode) { $nativeError = [int]$_.Exception.InnerException.NativeErrorCode }
  }
  $results += [pscustomobject]@{
    pid = [int]$target
    ok = [bool]$ok
    message = $message
    nativeError = $nativeError
  }
}
[pscustomobject]@{ results = @($results) } | ConvertTo-Json -Compress -Depth 4
`;

  try {
    const json = await runPowerShellJson(script, { timeoutMs: 30000 });
    const byPid = new Map(
      asArray(json.results).map((entry) => [
        Number(entry.pid),
        {
          pid: Number(entry.pid),
          ok: Boolean(entry.ok),
          message: entry.message || '',
          nativeError: entry.nativeError === null ? null : Number(entry.nativeError)
        }
      ])
    );
    return targets.map(
      (pid) =>
        byPid.get(pid) || {
          pid,
          ok: false,
          message: 'Aucune réponse de Windows',
          nativeError: null
        }
    );
  } catch (error) {
    logger.warn('Terminaison forcée impossible :', error.message);
    return targets.map((pid) => ({
      pid,
      ok: false,
      message: error.message,
      nativeError: null
    }));
  }
}

async function forceKill(pid) {
  const results = await forceKillMany([pid]);
  return results[0];
}

/**
 * Récupère les dates de démarrage des processus dont le nom (sans .exe)
 * figure dans `names`. Sert à distinguer une vraie relance automatique
 * d'une instance qui existait déjà avant la fermeture.
 */
async function getProcessStartTimes(names) {
  const cleaned = [...new Set(
    names
      .map((name) => String(name).toLowerCase().replace(/\.exe$/i, ''))
      .filter((name) => /^[a-z0-9._\- ]+$/i.test(name))
  )];
  if (cleaned.length === 0) return [];

  const nameList = cleaned.map(psQuote).join(',');
  const script = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$names = @(${nameList})
$set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $names) { [void]$set.Add([string]$entry) }

$items = @()
foreach ($proc in @(Get-Process)) {
  if (-not $set.Contains($proc.ProcessName)) { continue }
  $start = $null
  try { $start = $proc.StartTime.ToUniversalTime().ToString('o') } catch { }
  $items += [pscustomobject]@{
    pid = [int]$proc.Id
    name = [string]($proc.ProcessName + '.exe')
    startTime = $start
  }
}
[pscustomobject]@{ items = @($items) } | ConvertTo-Json -Compress -Depth 4
`;

  try {
    const json = await runPowerShellJson(script, { timeoutMs: 20000 });
    return asArray(json.items).map((item) => ({
      pid: Number(item.pid),
      name: String(item.name || '').toLowerCase(),
      startTime: item.startTime ? Date.parse(item.startTime) : null
    }));
  } catch (error) {
    logger.warn('Lecture des dates de démarrage impossible :', error.message);
    return [];
  }
}

/**
 * Demande à Windows de vider les working sets des PID indiqués.
 * Cela déplace des pages vers la liste de veille : ce n'est PAS une
 * récupération garantie de RAM et cela peut ralentir brièvement les applis.
 */
async function trimWorkingSets(pids) {
  const targets = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 4);
  if (targets.length === 0) return { trimmed: [], failed: [] };

  const script = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FreeRamTrim
{
    [DllImport("psapi.dll", SetLastError = true)]
    public static extern bool EmptyWorkingSet(IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@

$processIds = @(${targets.join(',')})
$trimmed = @()
$failed = @()
foreach ($target in $processIds) {
  $handle = [FreeRamTrim]::OpenProcess(0x0500, $false, [int]$target)
  if ($handle -eq [IntPtr]::Zero) { $failed += [int]$target; continue }
  try {
    if ([FreeRamTrim]::EmptyWorkingSet($handle)) { $trimmed += [int]$target }
    else { $failed += [int]$target }
  } finally {
    [FreeRamTrim]::CloseHandle($handle) | Out-Null
  }
}
[pscustomobject]@{
  trimmed = @($trimmed)
  failed = @($failed)
} | ConvertTo-Json -Compress -Depth 3
`;

  const json = await runPowerShellJson(script, { timeoutMs: 45000 });
  return {
    trimmed: asArray(json.trimmed).map(Number),
    failed: asArray(json.failed).map(Number)
  };
}

let elevationCache = null;

/** Vérifie si le processus courant est élevé (administrateur). */
async function isElevated(force = false) {
  if (!force && elevationCache !== null) return elevationCache;
  const script = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
[pscustomobject]@{ elevated = [bool]$isAdmin } | ConvertTo-Json -Compress
`;
  try {
    const json = await runPowerShellJson(script, { timeoutMs: 15000 });
    elevationCache = Boolean(json.elevated);
  } catch (error) {
    logger.warn("Détection des droits administrateur impossible :", error.message);
    elevationCache = false;
  }
  return elevationCache;
}

/**
 * Relance FreeRAM avec une élévation UAC.
 * @param {{exePath: string, args: string[]}} options
 */
async function relaunchAsAdmin({ exePath, args }) {
  const argumentList = (args || []).map(psQuote).join(',');
  const script = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  Start-Process -FilePath ${psQuote(exePath)} -ArgumentList @(${argumentList}) -Verb RunAs -ErrorAction Stop
  [pscustomobject]@{ ok = $true; error = $null } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
  const json = await runPowerShellJson(script, { timeoutMs: 30000 });
  return { ok: Boolean(json.ok), error: json.error || null };
}

module.exports = {
  sendCloseMessages,
  forceKill,
  forceKillMany,
  getProcessStartTimes,
  trimWorkingSets,
  isElevated,
  relaunchAsAdmin
};
