/**
 * The two bundled practice targets, started as real HTTP servers.
 *
 * Each one runs in its own child process on a free port, exactly as a user
 * would run `npm run example:mock-target` — so the walkthrough exercises the
 * same code path as a real deployment: HTTP, JSON, the CLI's flag parsing.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const SERVERS = {
  simple: 'examples/express-mock-target/server.js',
  hardened: 'examples/express-hardened-target/server.js',
};

/** Both practice targets expose the same paths. */
export const ENDPOINTS = {
  login: '/score/login',
  withdrawal: '/score/withdrawal',
  action: '/score/action',
};

/** A port nothing is listening on, found by letting the OS pick one. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start a practice target and wait until it answers its health check.
 *
 * @param {'simple'|'hardened'} name
 * @returns {Promise<{ name: string, url: string, stop: () => void }>}
 */
export async function startTarget(name) {
  const script = SERVERS[name];
  if (!script) throw new Error(`Unknown practice target "${name}"`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode != null) {
      throw new Error(`${name} target exited before it was ready:\n${stderr}`);
    }
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`${name} target did not become healthy on ${url} within 10s:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    name,
    url,
    stop() {
      child.kill();
    },
  };
}
