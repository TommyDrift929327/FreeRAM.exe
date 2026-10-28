'use strict';

/**
 * Surveillance de la mémoire et du processeur.
 *
 * Mémoire : os.totalmem()/os.freemem(). Sous Windows, os.freemem() correspond à
 * la mémoire physique *disponible* (GlobalMemoryStatusEx > ullAvailPhys),
 * c'est-à-dire la valeur « Disponible » du Gestionnaire des tâches : mémoire
 * libre + listes de pages en veille. On ne prétend donc pas que toute cette
 * mémoire est immédiatement récupérable par un simple nettoyage.
 */

const os = require('node:os');

let previousCpuSample = null;

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function readCpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  let user = 0;
  let system = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    user += times.user;
    system += times.sys + times.nice + times.irq;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total, user, system };
}

/**
 * Premier échantillon : permet de calculer un delta au cycle suivant.
 */
function primeCpu() {
  previousCpuSample = readCpuTimes();
  return previousCpuSample;
}

/**
 * Utilisation CPU depuis le dernier appel (moyenne sur tous les cœurs).
 * Retourne null tant qu'aucun intervalle exploitable n'existe.
 */
function sampleCpu() {
  const current = readCpuTimes();
  if (!previousCpuSample) {
    previousCpuSample = current;
    return null;
  }

  const idleDelta = current.idle - previousCpuSample.idle;
  const totalDelta = current.total - previousCpuSample.total;
  const userDelta = current.user - previousCpuSample.user;
  const systemDelta = current.system - previousCpuSample.system;
  previousCpuSample = current;

  if (totalDelta <= 0) return null;

  return {
    percent: clampPercent((1 - idleDelta / totalDelta) * 100),
    userPercent: clampPercent((userDelta / totalDelta) * 100),
    systemPercent: clampPercent((systemDelta / totalDelta) * 100),
    timestamp: Date.now()
  };
}

function getMemorySnapshot() {
  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);

  return {
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0,
    availablePercent: totalBytes > 0 ? clampPercent((availableBytes / totalBytes) * 100) : 0,
    timestamp: Date.now()
  };
}

function getSystemInfo() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    hostname: os.hostname(),
    cpuModel: cpus.length ? cpus[0].model.trim() : 'Inconnu',
    logicalCpus: cpus.length,
    totalMemoryBytes: os.totalmem()
  };
}

primeCpu();

module.exports = {
  getMemorySnapshot,
  sampleCpu,
  primeCpu,
  getSystemInfo
};
