'use strict';

/**
 * Tests de base, sans Electron.
 * Lancement : npm test
 */

const assert = require('node:assert/strict');
const os = require('node:os');
const config = require('../src/main/config');
const memory = require('../src/main/memory');
const processes = require('../src/main/processes');
const { SensorService } = require('../src/main/sensors');
const win32 = require('../src/main/win32');

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`\nFreeRAM — tests de base (${os.platform()} ${os.release()})\n`);

  await test('configuration chargée et bornée', () => {
    const cfg = config.getConfig();
    assert.equal(typeof cfg.refresh.memoryMs, 'number');
    assert.ok(cfg.refresh.memoryMs >= 500);
    assert.ok(cfg.processes.topCount >= 5);
    assert.ok(cfg.processes.maxSelection >= 1 && cfg.processes.maxSelection <= 256);
    assert.ok(cfg.closing.verificationDelayMs >= 1000);
    assert.equal(typeof config.getProtectedMap().size, 'number');
    assert.ok(config.getProtectedMap().size > 20);
  });

  await test('liste protégée : noms insensibles à la casse et .exe', () => {
    assert.equal(config.isProtectedName('EXPLORER.EXE'), true);
    assert.equal(config.isProtectedName('explorer'), true);
    assert.equal(config.isProtectedName('Lsass'), true);
    assert.equal(config.isProtectedName('freeram.exe'), true);
    assert.equal(config.isProtectedName('notepad.exe'), false);
    assert.match(config.protectionForName('explorer.exe').reason, /Shell Windows/);
  });

  await test('mémoire : total, utilisé et disponible cohérents', () => {
    const snapshot = memory.getMemorySnapshot();
    assert.ok(snapshot.totalBytes > 0);
    assert.ok(snapshot.availableBytes > 0);
    assert.ok(snapshot.availableBytes <= snapshot.totalBytes);
    assert.equal(snapshot.usedBytes + snapshot.availableBytes, snapshot.totalBytes);
    assert.ok(snapshot.usedPercent >= 0 && snapshot.usedPercent <= 100);
    assert.ok(snapshot.availablePercent >= 0 && snapshot.availablePercent <= 100);
  });

  await test('CPU : deux échantillons produisent un pourcentage plausible', async () => {
    memory.primeCpu();
    await wait(450);
    const first = memory.sampleCpu();
    assert.ok(first === null || (first.percent >= 0 && first.percent <= 100));
    await wait(350);
    const sample = memory.sampleCpu();
    if (sample) {
      assert.ok(sample.percent >= 0 && sample.percent <= 100);
      assert.ok(sample.userPercent >= 0 && sample.userPercent <= 100);
      assert.ok(sample.systemPercent >= 0 && sample.systemPercent <= 100);
    }
  });

  await test('parseur tasklist : guillemets, espaces, points-virgules', () => {
    const output = [
      '"chrome.exe","1234","Console","1","12 345 Ko"',
      '"Nom avec, virgule.exe","77","Services","0","1 024 Ko"',
      '"accentué.exe","88","Console","1","2 048 Ko"',
      '',
      'INFO: No tasks are running which match the specified criteria.'
    ].join('\r\n');
    const parsed = processes.parseTasklistOutput(output);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].pid, 1234);
    assert.equal(parsed[0].name, 'chrome.exe');
    assert.equal(parsed[0].memoryBytes, 12345 * 1024);
    assert.equal(parsed[1].name, 'Nom avec, virgule.exe');
    assert.equal(parsed[1].sessionNumber, 0);
    assert.equal(parsed[2].name, 'accentué.exe');
  });

  await test('protection : session 0, PID noyau et liste', () => {
    const map = config.getProtectedMap();
    const context = { selfPids: new Set([9999]), protectedMap: map };
    assert.match(
      processes.evaluateProtection({ pid: 4, name: 'System', sessionNumber: 0 }, context),
      /noyau/
    );
    assert.match(
      processes.evaluateProtection({ pid: 123, name: 'svchost.exe', sessionNumber: 0 }, context),
      /Service système/
    );
    assert.match(
      processes.evaluateProtection({ pid: 9999, name: 'freeRAM.exe', sessionNumber: 1 }, context),
      /FreeRAM/
    );
    assert.equal(
      processes.evaluateProtection({ pid: 321, name: 'notepad.exe', sessionNumber: 1 }, context),
      null
    );
  });

  await test('tasklist réel : liste non vide, PID uniques, self masqué', async () => {
    const selfPids = new Set([process.pid]);
    const snapshot = await processes.listProcesses({ selfPids });
    assert.ok(snapshot.processes.length > 5, 'au moins quelques processus attendus');
    assert.equal(
      snapshot.processes.some((proc) => proc.pid === process.pid),
      false,
      'le processus de test doit être masqué'
    );
    assert.equal(new Set(snapshot.processes.map((proc) => proc.pid)).size, snapshot.processes.length);
    assert.ok(snapshot.processMemorySumBytes > 0);
    assert.ok(snapshot.durationMs >= 0);
    for (let index = 1; index < snapshot.processes.length; index += 1) {
      assert.ok(snapshot.processes[index - 1].memoryBytes >= snapshot.processes[index].memoryBytes);
    }
  });

  await test('validation : sélection vide, protégée et limite de 256', async () => {
    const selfPids = new Set([process.pid]);
    const snapshot = await processes.listProcesses({ selfPids });
    const empty = processes.validateSelection(snapshot, [], 256);
    assert.equal(empty.ok, false);

    const protectedProc = snapshot.processes.find((proc) => proc.protected);
    assert.ok(protectedProc, 'un processus protégé doit être présent');
    const denied = processes.validateSelection(snapshot, [protectedProc.pid], 256);
    assert.equal(denied.ok, false);
    assert.match(denied.errors.join(' '), /protégé/i);

    const tooMany = processes.validateSelection(
      snapshot,
      Array.from({ length: 257 }, (_value, index) => 100000 + index),
      256
    );
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.errors.join(' '), /Maximum 256/);
  });

  await test('droits administrateur détectés sans erreur', async () => {
    const elevated = await win32.isElevated(true);
    assert.equal(typeof elevated, 'boolean');
    console.log(`    (mode ${elevated ? 'administrateur' : 'standard'})`);
  });

  await test('collecteur GPU/températures : échantillon réel ou indisponibilité honnête', async () => {
    let sample = null;
    let status = null;
    const service = new SensorService({
      gpuIntervalMs: 2500,
      tempIntervalMs: 5000,
      onSample: (value) => {
        sample = value;
      },
      onStatus: (value) => {
        status = value;
      }
    });

    service.start();
    const deadline = Date.now() + 18000;
    while (!sample && Date.now() < deadline) await wait(250);
    service.stop();

    assert.ok(status, 'un statut doit être émis');
    if (!sample) {
      console.log('    (aucun échantillon GPU dans le délai : compteurs indisponibles sur ce système)');
      return;
    }

    assert.ok(sample.receivedAt > 0);
    if (sample.gpu) {
      if (sample.gpu.utilizationPercent !== null) {
        assert.ok(sample.gpu.utilizationPercent >= 0 && sample.gpu.utilizationPercent <= 100);
      }
      if (sample.gpu.dedicatedUsedBytes !== null) {
        assert.ok(sample.gpu.dedicatedUsedBytes >= 0);
      }
    }
    if (sample.temperatures) {
      for (const key of ['cpuCelsius', 'gpuCelsius', 'systemCelsius']) {
        const value = sample.temperatures[key];
        if (value !== null) {
          assert.ok(Number.isFinite(value));
          assert.ok(value > -20 && value < 150, `température ${key} plausible`);
        }
      }
      assert.equal(typeof sample.temperatures.source, 'string');
    }
    console.log(
      `    GPU ${sample.gpu?.utilizationPercent ?? '—'}% · températures ${
        sample.temperatures ? sample.temperatures.source : 'indisponibles'
      }`
    );
  });

  console.log('');
  const passed = results.filter((entry) => entry.ok).length;
  console.log(`Résultat : ${passed}/${results.length} tests réussis.`);
  if (failures > 0) {
    console.error(`${failures} test(s) en échec.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
