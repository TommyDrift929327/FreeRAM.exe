'use strict';

/**
 * Énumération des processus Windows et évaluation de leur caractère protégé.
 *
 * Source : tasklist /FO CSV /NH. On utilise le nom de l'exécutable (Image Name)
 * et le PID, jamais le titre d'une fenêtre. Le code page 65001 est forcé pour
 * que les noms contenant des caractères accentués restent lisibles.
 */

const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('./config');

const TASKLIST_TIMEOUT_MS = 15000;

function execFileBuffer(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: TASKLIST_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        ...options
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = typeof stderr === 'string' ? stderr : stderr?.toString?.('utf8');
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/** Parse une ligne CSV tasklist (guillemets doublés, virgules échappées). */
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function parseTasklistOutput(output) {
  const processes = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // tasklist peut écrire un message d'information (aucune tâche, etc.).
    if (!trimmed.startsWith('"')) continue;

    const fields = parseCsvLine(trimmed);
    if (fields.length < 5) continue;

    const [name, pidRaw, sessionName, sessionRaw, memoryRaw] = fields;
    const pid = Number.parseInt(pidRaw, 10);
    if (!Number.isInteger(pid)) continue;

    const memoryKb = Number.parseInt(String(memoryRaw).replace(/[^\d]/g, ''), 10);
    const sessionNumber = Number.parseInt(sessionRaw, 10);

    processes.push({
      pid,
      name: name.trim(),
      nameLower: name.trim().toLowerCase(),
      sessionName: sessionName.trim(),
      sessionNumber: Number.isInteger(sessionNumber) ? sessionNumber : 0,
      memoryBytes: Number.isFinite(memoryKb) ? memoryKb * 1024 : 0
    });
  }

  return processes;
}

async function readRawProcesses() {
  if (process.platform !== 'win32') {
    throw new Error('FreeRAM ne prend en charge que Windows.');
  }

  const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  // chcp 65001 : sortie UTF-8, pour conserver les noms accentués.
  const command = 'chcp 65001>nul & tasklist /FO CSV /NH';
  const { stdout } = await execFileBuffer(comspec, ['/d', '/s', '/c', command], {
    encoding: 'utf8'
  });

  return parseTasklistOutput(stdout.replace(/^\uFEFF/, ''));
}

function evaluateProtection(proc, context) {
  if (context.selfPids && context.selfPids.has(proc.pid)) {
    return 'Processus interne de FreeRAM — fermeture interdite';
  }
  if (proc.pid <= 4) {
    return 'Processus noyau de Windows';
  }
  if (proc.sessionNumber === 0) {
    return 'Service système Windows (session 0)';
  }
  const entry = context.protectedMap.get(config.normalizedName(proc.name));
  if (entry) return entry.reason;
  return null;
}

/**
 * @param {object} options
 * @param {Set<number>} [options.selfPids] PID de FreeRAM et de ses processus enfants
 * @returns {Promise<object>}
 */
async function listProcesses(options = {}) {
  const startedAt = Date.now();
  const raw = await readRawProcesses();
  const selfPids = options.selfPids instanceof Set ? options.selfPids : new Set();
  const protectedMap = config.getProtectedMap();
  const context = { selfPids, protectedMap };

  let processMemorySumBytes = 0;
  let processCount = 0;

  const all = [];
  for (const proc of raw) {
    if (proc.pid === 0) continue; // System Idle Process : sans intérêt ici
    processMemorySumBytes += proc.memoryBytes;
    processCount += 1;

    const protectionReason = evaluateProtection(proc, context);
    const isSelf = selfPids.has(proc.pid);
    if (isSelf) continue; // FreeRAM ne s'affiche pas lui-même dans la liste

    all.push({
      ...proc,
      protected: Boolean(protectionReason),
      protectionReason
    });
  }

  all.sort((a, b) => b.memoryBytes - a.memoryBytes || a.nameLower.localeCompare(b.nameLower));

  return {
    processes: all,
    processCount,
    visibleCount: all.length,
    protectedCount: all.filter((proc) => proc.protected).length,
    processMemorySumBytes,
    source: 'tasklist',
    timestamp: Date.now(),
    durationMs: Date.now() - startedAt
  };
}

/**
 * Vérifie qu'un ensemble de PID est toujours présent et non protégé.
 * Utilisé avant toute action destructrice : le renderer n'est jamais cru sur parole.
 */
function validateSelection(snapshot, pids, maxSelection) {
  const errors = [];
  const unique = [...new Set(pids)];

  if (unique.length === 0) errors.push('Aucun processus sélectionné.');
  if (unique.length > maxSelection) {
    errors.push(`Maximum ${maxSelection} processus sélectionnables simultanément.`);
  }

  const byPid = new Map(snapshot.processes.map((proc) => [proc.pid, proc]));
  const selected = [];

  for (const pid of unique) {
    const proc = byPid.get(pid);
    if (!proc) {
      errors.push(`Le processus PID ${pid} n'existe plus.`);
      continue;
    }
    if (proc.protected) {
      errors.push(`${proc.name} (PID ${pid}) est protégé : ${proc.protectionReason}`);
      continue;
    }
    selected.push(proc);
  }

  return { ok: errors.length === 0, errors, selected };
}

module.exports = {
  listProcesses,
  validateSelection,
  parseCsvLine,
  parseTasklistOutput,
  evaluateProtection
};
