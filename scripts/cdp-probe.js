'use strict';

/** Sonde CDP de développement : état DOM + capture d'écran. */

const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const port = process.env.CDP_PORT || '9222';
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page' && /src\/renderer\/index\.html/.test(target.url));
  if (!page) throw new Error('Fenêtre FreeRAM introuvable.');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      logs.push(
        `console.${message.params.type}: ${message.params.args
          .map((arg) => arg.value ?? arg.description ?? '')
          .join(' ')}`
      );
    }
    if (message.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description || ''}`);
    }
    if (message.method === 'Log.entryAdded') {
      logs.push(`log.${message.params.entry.level}: ${message.params.entry.text}`);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };

  const info = await evaluate(`(() => ({
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    title: document.title,
    rows: document.querySelectorAll('.process-row').length,
    groups: document.querySelectorAll('.process-row:not(.instance)').length,
    instances: document.querySelectorAll('.process-row.instance').length,
    subtitle: document.getElementById('processes-subtitle')?.textContent,
    counter: document.getElementById('selection-counter')?.textContent,
    ram: document.getElementById('ram-percent')?.textContent,
    used: document.getElementById('stat-used')?.textContent,
    processSum: document.getElementById('stat-processes')?.textContent,
    cpu: document.getElementById('cpu-value')?.textContent,
    gpu: document.getElementById('gpu-value')?.textContent,
    cpuTemp: document.getElementById('cpu-temp-value')?.textContent,
    gpuTemp: document.getElementById('gpu-temp-value')?.textContent,
    gpuName: document.getElementById('gpu-name')?.textContent,
    footerSensors: document.getElementById('footer-sensors-text')?.textContent,
    footerUpdated: document.getElementById('footer-updated')?.textContent,
    overlayHeight: getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height'),
    bodyOverflow: getComputedStyle(document.body).overflow,
    dialogsOpen: [...document.querySelectorAll('dialog[open]')].map((d) => d.id),
    contentScroll: { height: document.querySelector('.content')?.scrollHeight, client: document.querySelector('.content')?.clientHeight },
    processList: { height: document.getElementById('process-list')?.scrollHeight, client: document.getElementById('process-list')?.clientHeight }
  }))()`);

  console.log(JSON.stringify({ info, logs }, null, 2));

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const output = path.join(__dirname, '..', 'build', 'freeram-window.png');
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
  console.log(`Capture : ${output}`);

  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
