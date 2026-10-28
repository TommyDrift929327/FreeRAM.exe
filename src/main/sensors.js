'use strict';

/**
 * Capteurs matériels.
 *
 * GPU : compteurs de performance Windows
 *   - Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine (utilisation)
 *   - Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory (VRAM)
 *   Ces compteurs ne nécessitent pas d'administrateur et fonctionnent avec
 *   les pilotes AMD / NVIDIA / Intel récents.
 *
 * Températures : Windows n'expose pas de façon fiable la température CPU/GPU
 * sans pilote ou outil tiers. On interroge donc le fournisseur WMI de
 * LibreHardwareMonitor (ou OpenHardwareMonitor) s'il est lancé. Sinon on
 * renvoie null et l'interface affiche « Indisponible » — aucune valeur inventée.
 */

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { getPowerShellPath } = require('./powershell');
const logger = require('./logger');

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildScript({ gpuIntervalMs, tempIntervalMs }) {
  return String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$gpuIntervalMs = ${Math.max(2000, Math.round(gpuIntervalMs))}
$tempIntervalMs = ${Math.max(2000, Math.round(tempIntervalMs))}

$hardware = $null
try {
  $controllers = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop |
    Where-Object { $_.Name -notmatch 'Microsoft Basic|Remote Display|Parsec' })
  $primary = $controllers | Select-Object -First 1
  $vram = $null
  $primaryName = $null
  $driverVersion = $null
  if ($null -ne $primary) {
    $primaryName = [string]$primary.Name
    $driverVersion = [string]$primary.DriverVersion
  }
  try {
    $props = @(Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\*' -Name 'HardwareInformation.qwMemorySize' -ErrorAction Stop)
    $maxVram = [uint64]0
    foreach ($prop in $props) {
      $bytes = [uint64]$prop.'HardwareInformation.qwMemorySize'
      if ($bytes -gt $maxVram) { $maxVram = $bytes }
    }
    if ($maxVram -gt 0) { $vram = $maxVram }
  } catch { }
  $hardware = [pscustomobject]@{
    name = $primaryName
    driverVersion = $driverVersion
    vramTotalBytes = $vram
  }
} catch {
  $hardware = $null
}

$lhmCheckedAt = 0
$lhmAvailable = $false
$ohmCheckedAt = 0
$ohmAvailable = $false
$acpiCheckedAt = 0
$temperatures = $null
$lastTempAt = 0

function Read-MonitorTemperatures([string]$namespace, [string]$sourceName) {
  $sensors = @(Get-CimInstance -Namespace $namespace -ClassName Sensor -ErrorAction Stop)
  $temperatureSensors = @($sensors | Where-Object { [string]$_.SensorType -eq 'Temperature' })
  if ($temperatureSensors.Count -eq 0) { return $null }

  $cpuCandidates = @()
  $gpuCandidates = @()
  foreach ($sensor in $temperatureSensors) {
    $name = [string]$sensor.Name
    $value = 0.0
    try { $value = [double]$sensor.Value } catch { continue }
    if ($value -lt -10 -or $value -gt 150) { continue }
    if ($name -match 'GPU') {
      $gpuCandidates += [pscustomobject]@{ name = $name; value = $value }
    } elseif ($name -match 'CPU|Core|CCD|Tctl|Tdie|Package|SoC') {
      $cpuCandidates += [pscustomobject]@{ name = $name; value = $value }
    }
  }

  $cpu = $null
  if ($cpuCandidates.Count -gt 0) {
    $preferred = $cpuCandidates | Where-Object { $_.name -match 'CPU Package|Tctl|Tdie|CPU \(' } | Select-Object -First 1
    if ($null -eq $preferred) { $preferred = $cpuCandidates | Sort-Object value -Descending | Select-Object -First 1 }
    $cpu = [math]::Round([double]$preferred.value, 1)
  }

  $gpu = $null
  if ($gpuCandidates.Count -gt 0) {
    $preferredGpu = $gpuCandidates | Where-Object { $_.name -match '^GPU Core$' } | Select-Object -First 1
    if ($null -eq $preferredGpu) { $preferredGpu = $gpuCandidates | Sort-Object value -Descending | Select-Object -First 1 }
    $gpu = [math]::Round([double]$preferredGpu.value, 1)
  }

  if ($null -eq $cpu -and $null -eq $gpu) { return $null }
  return [pscustomobject]@{
    cpuCelsius = $cpu
    gpuCelsius = $gpu
    systemCelsius = $null
    source = $sourceName
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

function Read-AcpiSystemTemperature() {
  $values = @()
  try {
    $zones = @(Get-CimInstance -Namespace 'root/wmi' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop)
    foreach ($zone in $zones) {
      $celsius = ([double]$zone.CurrentTemperature / 10.0) - 273.15
      if ($celsius -gt 15 -and $celsius -lt 115) { $values += $celsius }
    }
  } catch { }
  if ($values.Count -eq 0) {
    try {
      $zones = @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop)
      foreach ($zone in $zones) {
        $raw = [double]$zone.HighPrecisionTemperature
        if ($raw -gt 0) {
          $celsius = ($raw / 10.0) - 273.15
          if ($celsius -gt 15 -and $celsius -lt 115) { $values += $celsius }
        }
      }
    } catch { }
  }
  if ($values.Count -eq 0) { return $null }
  return [pscustomobject]@{
    cpuCelsius = $null
    gpuCelsius = $null
    systemCelsius = [math]::Round((($values | Measure-Object -Maximum).Maximum), 1)
    source = 'ACPI'
    at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

while ($true) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  $gpu = $null
  try {
    $engines = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)
    $groups = @{}
    foreach ($entry in $engines) {
      if ($entry.Name -match 'luid_(0x[0-9A-Fa-f]+)_(0x[0-9A-Fa-f]+)_phys_([0-9]+)_eng_[0-9]+_engtype_([A-Za-z0-9]+)') {
        $key = $matches[1] + '_' + $matches[2] + '_' + $matches[3] + '_' + $matches[4]
        $value = 0.0
        try { $value = [double]$entry.UtilizationPercentage } catch { }
        if ($groups.ContainsKey($key)) { $groups[$key] = [double]$groups[$key] + $value }
        else { $groups[$key] = $value }
      }
    }
    $maxValue = -1.0
    $maxEngine = $null
    foreach ($key in $groups.Keys) {
      if ([double]$groups[$key] -gt $maxValue) {
        $maxValue = [double]$groups[$key]
        $maxEngine = ($key -split '_')[-1]
      }
    }
    $utilization = $null
    if ($maxValue -ge 0) { $utilization = [math]::Round([math]::Min(100.0, $maxValue), 1) }

    $adapters = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction Stop)
    $bestAdapter = $adapters | Sort-Object { [double]$_.DedicatedUsage } -Descending | Select-Object -First 1
    $dedicated = $null
    $shared = $null
    if ($null -ne $bestAdapter) {
      $dedicated = [uint64]$bestAdapter.DedicatedUsage
      $shared = [uint64]$bestAdapter.SharedUsage
    }

    $gpu = [pscustomobject]@{
      utilizationPercent = $utilization
      engine = $maxEngine
      dedicatedUsedBytes = $dedicated
      sharedUsedBytes = $shared
      at = $now
    }
  } catch {
    $gpu = $null
  }

  if (($now - $lastTempAt) -ge $tempIntervalMs) {
    $lastTempAt = $now

    if (($now - $lhmCheckedAt) -ge 60000) {
      $lhmCheckedAt = $now
      $lhmAvailable = $false
      try {
        $null = Get-CimInstance -Namespace 'root/LibreHardwareMonitor' -ClassName Sensor -ErrorAction Stop
        $lhmAvailable = $true
      } catch { }
      $ohmAvailable = $false
      try {
        $null = Get-CimInstance -Namespace 'root/OpenHardwareMonitor' -ClassName Sensor -ErrorAction Stop
        $ohmAvailable = $true
      } catch { }
      $acpiCheckedAt = $now
    }

    $temperatures = $null
    if ($lhmAvailable) {
      try { $temperatures = Read-MonitorTemperatures 'root/LibreHardwareMonitor' 'LibreHardwareMonitor' } catch { }
    }
    if ($null -eq $temperatures -and $ohmAvailable) {
      try { $temperatures = Read-MonitorTemperatures 'root/OpenHardwareMonitor' 'OpenHardwareMonitor' } catch { }
    }
    if ($null -eq $temperatures) {
      try { $temperatures = Read-AcpiSystemTemperature } catch { }
    }
  }

  $payload = [pscustomobject]@{
    ts = $now
    gpu = $gpu
    temperatures = $temperatures
    hardware = $hardware
    sensors = [pscustomobject]@{
      libreHardwareMonitor = $lhmAvailable
      openHardwareMonitor = $ohmAvailable
    }
  }
  $payload | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds $gpuIntervalMs
}
`;
}

class SensorService {
  constructor(options = {}) {
    this.gpuIntervalMs = Math.max(2000, Number(options.gpuIntervalMs) || 5000);
    this.tempIntervalMs = Math.max(2000, Number(options.tempIntervalMs) || 10000);
    this.onSample = typeof options.onSample === 'function' ? options.onSample : () => {};
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};

    this.child = null;
    this.restartTimer = null;
    this.stopping = false;
    this.restartAttempt = 0;

    this.latest = null;
    this.status = {
      state: 'stopped',
      error: null,
      startedAt: null,
      lastSampleAt: null,
      samples: 0,
      source: 'Windows GPU Performance Counters'
    };
  }

  getLatest() {
    return this.latest;
  }

  getChildPid() {
    return this.child?.pid ?? null;
  }

  getStatus() {
    return { ...this.status };
  }

  emitStatus() {
    try {
      this.onStatus(this.getStatus());
    } catch (error) {
      logger.warn('Callback de statut capteur en erreur :', error.message);
    }
  }

  start() {
    if (this.child || this.restartTimer) return;
    this.stopping = false;
    this.status = {
      ...this.status,
      state: 'starting',
      error: null,
      startedAt: Date.now()
    };
    this.emitStatus();

    const script = buildScript({
      gpuIntervalMs: this.gpuIntervalMs,
      tempIntervalMs: this.tempIntervalMs
    });
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    let child;
    try {
      child = spawn(
        getPowerShellPath(),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );
    } catch (error) {
      this.markUnavailable(`Lancement du collecteur impossible : ${error.message}`);
      this.scheduleRestart();
      return;
    }

    this.child = child;

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => this.handleLine(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      // PowerShell sérialise parfois ses erreurs en CLIXML quand stderr est redirigé.
      // On ne pollue pas le journal avec cette enveloppe sans contenu utile.
      if (!message || message.startsWith('#< CLIXML')) return;
      logger.warn('Collecteur capteurs :', message.slice(0, 300));
    });

    child.on('error', (error) => {
      this.markUnavailable(`Collecteur capteurs : ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      stdout.close();
      if (this.stopping) {
        this.status = { ...this.status, state: 'stopped' };
        this.emitStatus();
        return;
      }
      this.markUnavailable(
        `Le collecteur de capteurs s'est arrêté (code ${code ?? signal ?? 'inconnu'}).`
      );
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const delays = [5000, 15000, 30000, 60000];
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)];
    this.restartAttempt += 1;
    logger.warn(`Nouvelle tentative du collecteur capteurs dans ${delay / 1000} s.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  markUnavailable(message) {
    this.status = { ...this.status, state: 'unavailable', error: message };
    logger.warn(message);
    this.emitStatus();
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('{')) return;

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch (error) {
      logger.warn('Échantillon capteur illisible :', error.message);
      return;
    }

    const hardware = payload.hardware
      ? {
          name: payload.hardware.name || null,
          driverVersion: payload.hardware.driverVersion || null,
          vramTotalBytes: toNumberOrNull(payload.hardware.vramTotalBytes)
        }
      : null;

    const gpu = payload.gpu
      ? {
          utilizationPercent: toNumberOrNull(payload.gpu.utilizationPercent),
          engine: payload.gpu.engine || null,
          dedicatedUsedBytes: toNumberOrNull(payload.gpu.dedicatedUsedBytes),
          sharedUsedBytes: toNumberOrNull(payload.gpu.sharedUsedBytes),
          name: hardware?.name || null,
          vramTotalBytes: hardware?.vramTotalBytes ?? null,
          timestamp: toNumberOrNull(payload.gpu.at) || toNumberOrNull(payload.ts) || Date.now()
        }
      : null;

    const temperatures = payload.temperatures
      ? {
          cpuCelsius: toNumberOrNull(payload.temperatures.cpuCelsius),
          gpuCelsius: toNumberOrNull(payload.temperatures.gpuCelsius),
          systemCelsius: toNumberOrNull(payload.temperatures.systemCelsius),
          source: payload.temperatures.source || null,
          timestamp: toNumberOrNull(payload.temperatures.at) || Date.now()
        }
      : null;

    this.latest = {
      gpu,
      temperatures,
      hardware,
      sensorProviders: {
        libreHardwareMonitor: Boolean(payload.sensors?.libreHardwareMonitor),
        openHardwareMonitor: Boolean(payload.sensors?.openHardwareMonitor)
      },
      generatedAt: toNumberOrNull(payload.ts) || Date.now(),
      receivedAt: Date.now()
    };

    this.restartAttempt = 0;
    this.status = {
      ...this.status,
      state: 'ok',
      error: null,
      lastSampleAt: this.latest.receivedAt,
      samples: this.status.samples + 1
    };

    try {
      this.onSample(this.latest, this.getStatus());
    } catch (error) {
      logger.warn('Callback capteur en erreur :', error.message);
    }
    this.emitStatus();
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
    }
    this.status = { ...this.status, state: 'stopped' };
    this.emitStatus();
  }
}

module.exports = { SensorService, buildScript };
