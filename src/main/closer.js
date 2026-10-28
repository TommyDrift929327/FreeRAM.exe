'use strict';

/**
 * Orchestration d'une fermeture :
 *   1. validation serveur (PID réels, non protégés, 256 max)
 *   2. mesure de la RAM avant
 *   3. fermeture normale : WM_CLOSE sur les fenêtres des PID sélectionnés
 *   4. attente de 5 secondes (valeur par défaut, configurable) sans mensonge
 *   5. nouvelle énumération tasklist + dates de démarrage
 *   6. terminaison forcée uniquement des PID encore actifs (si autorisé)
 *   7. nouvelle vérification et mesure de la RAM après
 *
 * Le renderer n'est jamais cru : les PID sont revalidés ici.
 */

const { performance } = require('node:perf_hooks');
const memory = require('./memory');
const { listProcesses, validateSelection } = require('./processes');
const win32 = require('./win32');
const logger = require('./logger');

const STATUS = {
  CLOSED: 'closed',
  ACTIVE: 'active',
  RESTARTED: 'restarted',
  DENIED: 'denied'
};

function isAccessDenied(entry) {
  if (!entry) return false;
  if (Number(entry.nativeError) === 5) return true;
  return looksLikeAccessDenied(entry.message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function looksLikeAccessDenied(message) {
  return /acc[eè]s (est )?refus|access is denied|access denied|privil[eè]ges insuffisants|error 5\b|code 5\b/i.test(
    String(message || '')
  );
}

function baseName(name) {
  return String(name || '').toLowerCase().replace(/\.exe$/i, '');
}

function uniqueVerificationNames(groups) {
  return [...new Set([...groups.keys()].map(baseName))];
}

/**
 * @param {object} options
 * @param {number[]} options.pids
 * @param {number} [options.maxSelection]
 * @param {number} [options.verificationDelayMs]
 * @param {boolean} [options.forceAfterDelay]
 * @param {number} [options.postForceCheckMs]
 * @param {Set<number>} [options.selfPids]
 * @param {(progress: object) => void} [options.onProgress]
 */
async function closeProcesses(options = {}) {
  const pids = Array.isArray(options.pids) ? options.pids : [];
  const maxSelection = options.maxSelection ?? 256;
  const verificationDelayMs = Math.max(1000, Number(options.verificationDelayMs ?? 5000));
  const forceAfterDelay = options.forceAfterDelay !== false;
  const postForceCheckMs = Math.max(300, Number(options.postForceCheckMs ?? 1500));
  const selfPids = options.selfPids instanceof Set ? options.selfPids : new Set();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const log = options.logger || logger;

  // Le délai de 5 s court à partir de la demande (confirmation utilisateur).
  const requestStartedAt = performance.now();
  const requestedAt = Date.now();
  const emit = (payload) => {
    try {
      onProgress({ ...payload, requestedAt });
    } catch (error) {
      log.warn('Callback de progression en erreur :', error.message);
    }
  };

  let beforeSnapshot;
  try {
    beforeSnapshot = await listProcesses({ selfPids });
  } catch (error) {
    return {
      ok: false,
      error: `Impossible de lire la liste des processus : ${error.message}`,
      errors: [error.message]
    };
  }

  const validation = validateSelection(beforeSnapshot, pids, maxSelection);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'Sélection refusée.',
      errors: validation.errors
    };
  }

  const selected = validation.selected;
  const memoryBefore = memory.getMemorySnapshot();
  const processMemoryBefore = beforeSnapshot.processMemorySumBytes;

  const groups = new Map();
  for (const proc of selected) {
    if (!groups.has(proc.nameLower)) {
      groups.set(proc.nameLower, {
        name: proc.name,
        nameLower: proc.nameLower,
        selected: []
      });
    }
    groups.get(proc.nameLower).selected.push(proc);
  }

  const preByName = new Map();
  for (const proc of beforeSnapshot.processes) {
    if (!preByName.has(proc.nameLower)) preByName.set(proc.nameLower, new Set());
    preByName.get(proc.nameLower).add(proc.pid);
  }

  emit({
    stage: 'closing',
    selectedCount: selected.length,
    pids: selected.map((proc) => proc.pid),
    apps: [...groups.values()].map((group) => ({
      name: group.name,
      pids: group.selected.map((proc) => proc.pid)
    }))
  });

  let closeReport = { results: [] };
  let gracefulError = null;
  try {
    closeReport = await win32.sendCloseMessages(selected.map((proc) => proc.pid));
  } catch (error) {
    gracefulError = error.message;
    log.warn('Envoi de WM_CLOSE impossible :', error.message);
  }

  const closeByPid = new Map(closeReport.results.map((entry) => [entry.pid, entry]));

  emit({
    stage: 'waiting',
    delayMs: verificationDelayMs,
    remainingMs: Math.max(0, Math.round(requestStartedAt + verificationDelayMs - performance.now()))
  });

  const deadline = requestStartedAt + verificationDelayMs;
  while (performance.now() < deadline) {
    const remaining = deadline - performance.now();
    emit({
      stage: 'waiting',
      delayMs: verificationDelayMs,
      remainingMs: Math.max(0, Math.round(remaining))
    });
    await sleep(Math.min(Math.max(remaining, 1), 200));
  }

  const waitedMs = Math.round(performance.now() - requestStartedAt);
  const verifiedAt = Date.now();
  emit({ stage: 'verifying', waitedMs, delayMs: verificationDelayMs });

  const afterFiveSnapshot = await listProcesses({ selfPids });
  const afterFiveByPid = new Map(afterFiveSnapshot.processes.map((proc) => [proc.pid, proc]));
  const verificationNames = uniqueVerificationNames(groups);
  let startTimes = await win32.getProcessStartTimes(verificationNames);
  let startTimeByPid = new Map(startTimes.map((entry) => [entry.pid, entry]));

  const records = new Map();
  for (const proc of selected) {
    const stillThere = afterFiveByPid.has(proc.pid);
    const closeInfo = closeByPid.get(proc.pid);
    const gracefulDenied = Boolean(closeInfo?.error && looksLikeAccessDenied(closeInfo.error));
    records.set(proc.pid, {
      pid: proc.pid,
      name: proc.name,
      nameLower: proc.nameLower,
      memoryBytesBefore: proc.memoryBytes,
      status: stillThere ? STATUS.ACTIVE : STATUS.CLOSED,
      statusAtFiveSeconds: stillThere ? STATUS.ACTIVE : STATUS.CLOSED,
      windowsSignaled: closeInfo?.windows ?? 0,
      gracefulError: closeInfo?.error || null,
      accessDenied: gracefulDenied,
      forced: false,
      forceError: null,
      note: stillThere
        ? 'Toujours présent 5 s après la demande.'
        : 'Processus absent lors de la vérification à 5 s.'
    });
  }

  const aliveAtFive = selected.filter((proc) => afterFiveByPid.has(proc.pid));

  let afterSnapshot = afterFiveSnapshot;
  let forceResults = [];
  if (forceAfterDelay && aliveAtFive.length > 0) {
    emit({
      stage: 'forcing',
      pids: aliveAtFive.map((proc) => proc.pid),
      remainingMs: 0,
      delayMs: verificationDelayMs
    });
    forceResults = await win32.forceKillMany(aliveAtFive.map((proc) => proc.pid));
    const forceByPid = new Map(forceResults.map((entry) => [entry.pid, entry]));

    await sleep(postForceCheckMs);
    emit({ stage: 'finishing', remainingMs: 0, delayMs: verificationDelayMs });

    afterSnapshot = await listProcesses({ selfPids });
    startTimes = await win32.getProcessStartTimes(verificationNames);
    startTimeByPid = new Map(startTimes.map((entry) => [entry.pid, entry]));

    for (const proc of selected) {
      const record = records.get(proc.pid);
      const force = forceByPid.get(proc.pid);
      if (!force) continue;
      record.forced = true;
      const stillAlive = afterSnapshot.processes.some((entry) => entry.pid === proc.pid);
      if (stillAlive) {
        record.forceError = force.message || 'Terminaison refusée.';
        record.accessDenied = record.accessDenied || isAccessDenied(force);
        record.status = record.accessDenied ? STATUS.DENIED : STATUS.ACTIVE;
        record.note = record.accessDenied
          ? "Windows a refusé l'accès. Relancez FreeRAM en administrateur pour fermer cette application."
          : `La terminaison forcée a échoué : ${record.forceError}`;
      } else {
        record.status = STATUS.CLOSED;
        record.forceError = null;
        record.note =
          record.windowsSignaled === 0
            ? 'Aucune fenêtre visible : fermeture forcée après 5 s.'
            : 'Fermée par terminaison forcée après 5 s sans réponse.';
      }
    }
  }

  const finalByPid = new Map(afterSnapshot.processes.map((proc) => [proc.pid, proc]));
  for (const proc of selected) {
    const record = records.get(proc.pid);
    const stillAlive = finalByPid.has(proc.pid);
    if (!stillAlive) {
      record.status = STATUS.CLOSED;
      if (!record.forced) {
        record.note = 'Fermée avant la vérification à 5 s.';
      }
      continue;
    }
    if (record.status !== STATUS.DENIED) {
      record.status = STATUS.ACTIVE;
    }
    if (!record.forced) {
      record.note = record.windowsSignaled
        ? "L'application a reçu WM_CLOSE mais est toujours active."
        : "Aucune fenêtre à fermer ; l'application est toujours active.";
      if (record.gracefulError) {
        record.note += ` Détail : ${record.gracefulError}`;
      }
    }
  }

  const apps = [];
  for (const group of groups.values()) {
    const selectedPids = group.selected.map((proc) => proc.pid);
    const selectedSet = new Set(selectedPids);
    const finalSameName = afterSnapshot.processes.filter(
      (proc) => proc.nameLower === group.nameLower
    );
    const aliveRecords = selectedPids
      .map((pid) => records.get(pid))
      .filter((record) => record && record.status !== STATUS.CLOSED);

    const prePids = preByName.get(group.nameLower) || new Set();
    const otherExisting = finalSameName.filter(
      (proc) => !selectedSet.has(proc.pid) && prePids.has(proc.pid)
    );
    const newInstances = finalSameName.filter((proc) => {
      if (selectedSet.has(proc.pid) || prePids.has(proc.pid)) return false;
      const startTime = startTimeByPid.get(proc.pid)?.startTime;
      if (startTime === null || startTime === undefined) return true;
      return startTime >= requestedAt - 2000;
    });

    let status;
    if (aliveRecords.length > 0) {
      status = aliveRecords.some((record) => record.status === STATUS.DENIED)
        ? STATUS.DENIED
        : STATUS.ACTIVE;
    } else if (finalSameName.length === 0) {
      status = STATUS.CLOSED;
    } else if (newInstances.length > 0 && otherExisting.length === 0) {
      status = STATUS.RESTARTED;
    } else {
      // Des instances existaient avant la demande et n'ont pas été sélectionnées,
      // ou un mélange d'anciennes et de nouvelles instances subsiste.
      status = STATUS.ACTIVE;
    }

    apps.push({
      name: group.name,
      nameLower: group.nameLower,
      status,
      selectedPids,
      closedPids: selectedPids.filter((pid) => records.get(pid)?.status === STATUS.CLOSED),
      alivePids: aliveRecords.map((record) => record.pid),
      deniedPids: aliveRecords
        .filter((record) => record.status === STATUS.DENIED)
        .map((record) => record.pid),
      forcedPids: selectedPids.filter((pid) => records.get(pid)?.forced),
      newPids: newInstances.map((proc) => proc.pid),
      otherExistingPids: otherExisting.map((proc) => proc.pid),
      startTimesUnknown: finalSameName.some(
        (proc) => startTimeByPid.get(proc.pid)?.startTime === null
      )
    });
  }

  apps.sort((a, b) => a.nameLower.localeCompare(b.nameLower));

  const memoryAfter = memory.getMemorySnapshot();
  const statusCounts = {
    closed: apps.filter((app) => app.status === STATUS.CLOSED).length,
    active: apps.filter((app) => app.status === STATUS.ACTIVE).length,
    restarted: apps.filter((app) => app.status === STATUS.RESTARTED).length,
    denied: apps.filter((app) => app.status === STATUS.DENIED).length
  };

  const warnings = [];
  if (gracefulError) {
    warnings.push(`La fermeture normale n'a pas pu être demandée : ${gracefulError}`);
  }
  if (!forceAfterDelay && aliveAtFive.length > 0) {
    warnings.push(
      `La terminaison forcée est désactivée : ${aliveAtFive.length} processus sont restés actifs après 5 s.`
    );
  }
  if (statusCounts.denied > 0) {
    warnings.push(
      "Au moins une application a refusé la fermeture (droits insuffisants). Utilisez « Relancer en administrateur »."
    );
  }
  if (statusCounts.restarted > 0) {
    warnings.push(
      "Au moins une application s'est relancée automatiquement. Les nouvelles instances n'ont pas été fermées."
    );
  }
  if (statusCounts.active > 0 && forceAfterDelay) {
    warnings.push(
      "Au moins une application fonctionne encore. Elle est signalée « Toujours active », sans conclusion hâtive."
    );
  }

  const perPid = [...records.values()].sort(
    (a, b) => a.nameLower.localeCompare(b.nameLower) || a.pid - b.pid
  );

  const finishedAt = Date.now();
  const result = {
    ok: true,
    requestedAt,
    verifiedAt,
    finishedAt,
    waitedMs,
    delayMs: verificationDelayMs,
    forceAfterDelay,
    forceUsed: forceResults.length > 0,
    totalDurationMs: finishedAt - requestedAt,
    before: memoryBefore,
    after: memoryAfter,
    delta: {
      availableBytes: memoryAfter.availableBytes - memoryBefore.availableBytes,
      usedBytes: memoryAfter.usedBytes - memoryBefore.usedBytes,
      usedPercent: memoryAfter.usedPercent - memoryBefore.usedPercent,
      processMemoryBytes: afterSnapshot.processMemorySumBytes - processMemoryBefore
    },
    processMemoryBefore,
    processMemoryAfter: afterSnapshot.processMemorySumBytes,
    close: {
      pids: selected.map((proc) => proc.pid),
      signaledPids: closeReport.results
        .filter((entry) => entry.windows > 0)
        .map((entry) => entry.pid),
      noWindowPids: closeReport.results
        .filter((entry) => entry.windows === 0)
        .map((entry) => entry.pid),
      errors: closeReport.results.filter((entry) => entry.error)
    },
    apps,
    perPid,
    statusCounts,
    warnings
  };

  emit({ stage: 'done', result });
  log.info('Fermeture terminée', {
    requested: selected.length,
    statusCounts,
    waitedMs,
    forceUsed: result.forceUsed,
    deltaAvailableBytes: result.delta.availableBytes
  });

  return result;
}

module.exports = {
  STATUS,
  closeProcesses,
  looksLikeAccessDenied,
  baseName
};
