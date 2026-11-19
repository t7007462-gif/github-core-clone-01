// main.ts — entrypoint: start the forge on an ephemeral port, register it with
// the trial environment, then stay alive until the environment says it is done.
// The environment hands us MAKEFUN_ENV_URL (its control plane) and
// MAKEFUN_SHOP_TOKEN (the token the grader presents as the viewer).

import { createServer } from 'node:http';
import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<boolean> {
  // The control plane may still be warming up; retry with a growing pause
  // (capped at 5 s) for about a minute before giving up.
  let pauseMs = 250;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return true;
      await response.text().catch(() => '');
    } catch {
      // connection refused / reset while the environment starts: retry
    }
    await sleep(pauseMs);
    pauseMs = Math.min(pauseMs * 2, 5000);
  }
  return false;
}

async function waitUntilDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // transient: keep polling
    }
    await sleep(500);
  }
}

async function main(): Promise<number> {
  if (!ENV_URL) {
    process.stderr.write('MAKEFUN_ENV_URL is not set\n');
    return 1;
  }
  if (!SHOP_TOKEN) {
    process.stderr.write('MAKEFUN_SHOP_TOKEN is not set\n');
    return 1;
  }
  const { handler } = createApp();
  const server = createServer(handler);
  // If the trial is torn down early, exit promptly instead of hanging on the poll.
  let shuttingDown = false;
  process.on('SIGTERM', () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  if (!port) {
    process.stderr.write('failed to bind an ephemeral port\n');
    return 1;
  }
  const registered = await register(port);
  if (!registered) {
    process.stderr.write('failed to register with the trial environment\n');
    server.close();
    return 1;
  }
  await waitUntilDone();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
