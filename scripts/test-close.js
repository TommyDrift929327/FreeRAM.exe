'use strict';

/**
 * Test d'intégration Windows : fermeture gracieuse, vérification à 5 s,
 * terminaison forcée, détection de relance, protection et limite de sélection.
 *
 * Lancement : npm run test:close
 */

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const closer = require('../src/main/closer');
const win32 = require('../src/main/win32');

const CSC = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
);

const SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        bool ignoreClose = false;
        bool restartOnClose = false;
        foreach (string arg in args)
        {
            if (arg == "--ignore-close") ignoreClose = true;
            if (arg == "--restart-on-close") restartOnClose = true;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TestForm(ignoreClose, restartOnClose));
    }
}

public class TestForm : Form
{
    private readonly bool ignoreClose;
    private readonly bool restartOnClose;
    private bool restarted;

    public TestForm(bool ignoreClose, bool restartOnClose)
    {
        this.ignoreClose = ignoreClose;
        this.restartOnClose = restartOnClose;
        Text = "FreeRAM Test Process";
        Width = 480;
        Height = 220;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(10, 15, 24);
        Label label = new Label();
        label.Text = "FreeRAM test process\r\nFermez cette fenêtre pour tester WM_CLOSE.";
        label.ForeColor = Color.White;
        label.Dock = DockStyle.Fill;
        label.TextAlign = ContentAlignment.MiddleCenter;
        Controls.Add(label);
        FormClosing += OnFormClosing;
    }

    private void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        if (ignoreClose)
        {
            e.Cancel = true;
            return;
        }
        if (restartOnClose && !restarted)
        {
            restarted = true;
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = Application.ExecutablePath;
                info.Arguments = "--restart-child";
                info.UseShellExecute = false;
                info.WorkingDirectory = System.IO.Path.GetDirectoryName(Application.ExecutablePath);
                Process.Start(info);
            }
            catch
            {
                // le test échouera sur le statut attendu
            }
        }
    }
}
`;

let workDir = null;
let exePath = null;
let failures = 0;
let passed = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compileTestApp() {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeram-close-test-'));
  const sourcePath = path.join(workDir, 'FreeRAMTestApp.cs');
  exePath = path.join(workDir, 'FreeRAMTestApp.exe');
  fs.writeFileSync(sourcePath, SOURCE, 'utf8');

  execFileSync(
    CSC,
    [
      '/nologo',
      '/target:winexe',
      '/optimize+',
      `/out:${exePath}`,
      '/reference:System.dll',
      '/reference:System.Drawing.dll',
      '/reference:System.Windows.Forms.dll',
      sourcePath
    ],
    { stdio: 'pipe', windowsHide: true }
  );
  assert.ok(fs.existsSync(exePath), 'exécutable de test compilé');
}

function startTestApp(args = []) {
  const child = spawn(exePath, args, {
    stdio: 'ignore',
    windowsHide: false
  });
  return child;
}

async function waitForApp() {
  await sleep(2200);
}

function cleanup() {
  try {
    execFileSync('taskkill', ['/F', '/IM', 'FreeRAMTestApp.exe'], {
      stdio: 'ignore',
      windowsHide: true
    });
  } catch {
    /* aucun processus restant */
  }
}

async function run(name, fn) {
  const started = Date.now();
  try {
    cleanup();
    await fn();
    passed += 1;
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name} (${Date.now() - started} ms)`);
    console.error(`    ${error.stack || error.message}`);
  } finally {
    cleanup();
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Ce test ne s’exécute que sous Windows.');
  }
  if (!fs.existsSync(CSC)) {
    throw new Error(`Compilateur C# introuvable : ${CSC}`);
  }

  compileTestApp();
  console.log(`\nFreeRAM — test de fermeture (${path.basename(workDir)})\n`);
  console.log(`  Exécutable de test : ${exePath}\n`);

  await run('fermeture gracieuse : WM_CLOSE puis vérification après 5 s', async () => {
    const child = startTestApp();
    await waitForApp();
    assert.equal(child.exitCode, null, 'le processus de test doit être actif');

    const result = await closer.closeProcesses({
      pids: [child.pid],
      verificationDelayMs: 5000,
      forceAfterDelay: true,
      postForceCheckMs: 600,
      selfPids: new Set(),
      onProgress: () => {}
    });

    assert.equal(result.ok, true, result.error || 'fermeture annoncée comme réussie');
    assert.ok(result.waitedMs >= 4900, `attente réelle >= 4,9 s (${result.waitedMs} ms)`);
    assert.ok(result.waitedMs < 9000, `attente raisonnable (${result.waitedMs} ms)`);
    assert.equal(result.delayMs, 5000);
    assert.equal(result.forceUsed, false, 'aucune terminaison forcée nécessaire');
    assert.equal(result.statusCounts.closed, 1);
    assert.equal(result.apps[0].status, 'closed');
    assert.ok(result.before.availableBytes > 0);
    assert.ok(result.after.availableBytes > 0);
    assert.equal(typeof result.delta.availableBytes, 'number');
    assert.ok(result.totalDurationMs >= 4900);
    console.log(
      `    attendu ${result.waitedMs} ms · statut ${result.apps[0].status} · RAM dispo ${result.delta.availableBytes} octets`
    );
  });

  await run('sans terminaison forcée : l’application reste « Toujours active »', async () => {
    const child = startTestApp(['--ignore-close']);
    await waitForApp();

    const result = await closer.closeProcesses({
      pids: [child.pid],
      verificationDelayMs: 5000,
      forceAfterDelay: false,
      postForceCheckMs: 500,
      selfPids: new Set()
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.forceUsed, false);
    assert.equal(result.statusCounts.active, 1);
    assert.equal(result.apps[0].status, 'active');
    assert.ok(result.warnings.some((warning) => /terminaison forcée est désactivée/i.test(warning)));

    const stillRunning = await win32.getProcessStartTimes(['FreeRAMTestApp']);
    assert.ok(stillRunning.some((entry) => entry.pid === child.pid), 'le processus doit toujours exister');
    console.log(`    statut ${result.apps[0].status} · PID ${child.pid} toujours présent`);
  });

  await run('terminaison forcée après 5 s : statut « Fermée » et forceUsed', async () => {
    const child = startTestApp(['--ignore-close']);
    await waitForApp();

    const result = await closer.closeProcesses({
      pids: [child.pid],
      verificationDelayMs: 5000,
      forceAfterDelay: true,
      postForceCheckMs: 700,
      selfPids: new Set()
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.forceUsed, true, 'Stop-Process doit être utilisé');
    assert.equal(result.statusCounts.closed, 1);
    assert.equal(result.apps[0].status, 'closed');
    assert.ok(result.apps[0].forcedPids.includes(child.pid));
    assert.equal(result.perPid[0].forced, true);
    console.log(`    statut ${result.apps[0].status} · forcé : ${result.apps[0].forcedPids.join(', ')}`);
  });

  await run('relance automatique : statut « Relancée automatiquement »', async () => {
    const child = startTestApp(['--restart-on-close']);
    await waitForApp();

    const result = await closer.closeProcesses({
      pids: [child.pid],
      verificationDelayMs: 5000,
      forceAfterDelay: true,
      postForceCheckMs: 900,
      selfPids: new Set()
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.apps[0].status, 'restarted');
    assert.equal(result.statusCounts.restarted, 1);
    assert.ok(result.apps[0].newPids.length >= 1, 'un nouveau PID doit être détecté');
    assert.ok(!result.apps[0].newPids.includes(child.pid), 'le nouveau PID diffère de l’ancien');
    console.log(`    nouvelle instance : ${result.apps[0].newPids.join(', ')}`);
  });

  await run('processus protégé : refus avant toute action', async () => {
    const { listProcesses } = require('../src/main/processes');
    const snapshot = await listProcesses({ selfPids: new Set([process.pid]) });
    const protectedProc = snapshot.processes.find(
      (proc) => proc.protected && /explorer|svchost|lsass/i.test(proc.name)
    );
    assert.ok(protectedProc, 'un processus système protégé doit être visible');

    const result = await closer.closeProcesses({
      pids: [protectedProc.pid],
      verificationDelayMs: 1000,
      forceAfterDelay: true,
      selfPids: new Set([process.pid])
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /protégé/i);
    console.log(`    refusé : ${protectedProc.name} (PID ${protectedProc.pid})`);
  });

  await run('limite de 256 et PID inconnu : validation serveur', async () => {
    const tooMany = await closer.closeProcesses({
      pids: Array.from({ length: 257 }, (_value, index) => 100000 + index),
      maxSelection: 256,
      verificationDelayMs: 1000,
      selfPids: new Set([process.pid])
    });
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.errors.join(' '), /Maximum 256/);

    const unknown = await closer.closeProcesses({
      pids: [999999],
      verificationDelayMs: 1000,
      selfPids: new Set([process.pid])
    });
    assert.equal(unknown.ok, false);
    assert.match(unknown.errors.join(' '), /n'existe plus|n’existe plus/);
    console.log('    257 PID refusés · PID inexistant refusé');
  });

  await run('ajustement des working sets : EmptyWorkingSet réel', async () => {
    const child = startTestApp();
    await waitForApp();

    const trimmed = await win32.trimWorkingSets([child.pid]);
    assert.ok(trimmed.trimmed.includes(child.pid), 'le PID doit être ajusté');
    assert.ok(!trimmed.failed.includes(child.pid), 'aucun échec attendu');
    console.log(`    working set ajusté pour le PID ${child.pid}`);
  });

  console.log('');
  console.log(`Résultat : ${passed}/${passed + failures} tests réussis.`);
  if (failures > 0) {
    console.error(`${failures} test(s) en échec.`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
