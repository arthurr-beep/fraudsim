/**
 * The CLI's `--option` parsing, run as a real process against a local server.
 *
 * Covers the shape of list options: a single value has no comma to split on,
 * and must still reach the scenario as a one-element list.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../bin/fraud-sim.js', import.meta.url));

let server;
let baseUrl;
const seenUsers = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        const body = JSON.parse(data || '{}');
        if (body.user_id) seenUsers.add(body.user_id);
      } catch {
        // Not JSON — still answer, the assertion is on what was seen.
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ decision: 'BLOCK', risk_score: 1, reasons: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ code, output }));
  });
}

const RUN = ['run', 'credential-stuffing', '--quiet', '--rps', '0'];
const SMALL = ['--option', 'maxTotalAttempts=5', '--option', 'delayMs=0', '--option', 'attackerCount=1'];

test('a single targetUserIds value is accepted as a one-element list', async () => {
  seenUsers.clear();
  const { code, output } = await cli([...RUN, '--target-url', baseUrl, '--option', 'targetUserIds=solo_user', ...SMALL]);
  assert.doesNotMatch(output, /non-empty array/);
  assert.equal(code, 0, output);
  assert.deepEqual([...seenUsers], ['solo_user']);
});

test('the scoped form gets the same treatment', async () => {
  seenUsers.clear();
  const { code, output } = await cli([
    ...RUN, '--target-url', baseUrl, '--option', 'credential-stuffing.targetUserIds=scoped_user', ...SMALL,
  ]);
  assert.doesNotMatch(output, /non-empty array/);
  assert.equal(code, 0, output);
  assert.deepEqual([...seenUsers], ['scoped_user']);
});
