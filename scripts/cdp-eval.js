'use strict';

/** Petit utilitaire CDP : évalue une expression dans la fenêtre FreeRAM. */

async function main() {
  const expression = process.argv.slice(2).join(' ');
  if (!expression) throw new Error('Usage : node scripts/cdp-eval.js "expression"');
  const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || '9222'}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page' && /src\/renderer\/index\.html/.test(target.url));
  if (!page) throw new Error('Fenêtre FreeRAM introuvable.');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    console.error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result.result.value, null, 2));
  }
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
