/**
 * End-to-end walkthrough — fraud-sim against two real fraud engines.
 *
 * Starts both bundled practice targets as real HTTP servers, then drives the
 * real CLI and library against them in six acts. Every act asserts what it
 * shows, so this is a test first and a demo second: if the story stops being
 * true, it fails.
 *
 *   npm run demo        paced for a screen recording, opens the HTML report
 *   npm run test:e2e    flat out, for CI
 *
 * Options (environment):
 *   DEMO_PACE=<ms>      pause per beat (default 900 when run directly, 0 under node --test)
 *   DEMO_OPEN=0         do not open the HTML report at the end of a recording
 *   DEMO_LLM=anthropic  act 3 uses a real model (needs ANTHROPIC_API_KEY); its
 *                       outcome is shown but not asserted, since a model may choose differently
 *   FRAUD_SIM_SOURCE=npm  run the published package instead of this repository
 *                       (FRAUD_SIM_VERSION pins it) — see helpers/source.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { loadFraudSim } from './helpers/source.js';
import { startTarget, freePort, ENDPOINTS } from './helpers/targets.js';
import { act, say, verdict, cli, pause, log, c, DECISION_COLOUR, RECORDING } from './helpers/narrate.js';

const SEED = '42';
const REPORT_DIR = join(tmpdir(), 'fraud-sim-walkthrough');
const REPORT = join(REPORT_DIR, 'assessment.html');

let simple;
let hardened;
/** The fraud-sim under test: this repository, or the package from npm. */
let fs;
const fraudSim = (args) => cli(args, fs.cli);

const endpointFlags = [
  '--endpoint-login', ENDPOINTS.login,
  '--endpoint-withdrawal', ENDPOINTS.withdrawal,
  '--endpoint-action', ENDPOINTS.action,
];

before(async () => {
  mkdirSync(REPORT_DIR, { recursive: true });
  fs = await loadFraudSim();
  log(`
  ${c.bold('fraud-sim')} — synthetic attacks and real customers, against a real fraud engine`);
  log(`  ${c.dim(fs.from === 'npm' ? `fraud-sim ${fs.version}, installed from npm` : `fraud-sim ${fs.version}, from this repository`)}`);
  log(`  ${c.dim('Two practice engines run as real HTTP servers: a simple one and a hardened one.')}`);
  await pause(2);
});

after(() => {
  simple?.stop();
  hardened?.stop();
});

/**
 * A freshly started engine for each act. Both practice servers decay their
 * velocity counters on a 60-second wall-clock timer; a paced recording runs
 * long enough for that timer to fire mid-act and change what the act asserts.
 * A new server per act keeps every act well inside its first minute.
 */
async function fresh(name) {
  if (name === 'simple') {
    simple?.stop();
    simple = await startTarget('simple', fs.root);
    return simple;
  }
  hardened?.stop();
  hardened = await startTarget('hardened', fs.root);
  return hardened;
}

// ── Act 1 ───────────────────────────────────────────────────────────────

test('act 1: a credential-stuffing botnet is contained', async () => {
  await fresh('simple');
  await act(1, 'A botnet replays a stolen password list', `
    Many IPs, many accounts, the commonest account-takeover attack there is.
    Target: the simple practice engine.`);

  const { code, stdout } = await fraudSim([
    'run', 'credential-stuffing',
    '--target-url', simple.url, ...endpointFlags,
    '--option', 'delayMs=0',
    '--seed', SEED, '--rps', '0',
  ]);

  assert.equal(code, 0, 'a contained attack passes the run');
  assert.match(stdout, /credential-stuffing\s.*Contained/);
  const [, events, blocked, rate] = stdout.match(/credential-stuffing\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+([\d.]+)%/) ?? [];
  assert.ok(Number(rate) >= 80, `most of the botnet is blocked (got ${rate}%)`);
  await verdict(true, `${blocked} of ${events} attempts blocked (${rate}%): velocity and new-device rules hold.`);
});

// ── Act 2 ───────────────────────────────────────────────────────────────

test('act 2: an adaptive attacker that rotates everything is defeated', async () => {
  await fresh('hardened');
  await act(2, 'An attacker that adapts after every block', `
    It reads each decision and its reason codes, then changes IP, device or
    browser. Target: the hardened engine, which never allows an unknown device.`);

  const report = await attackRounds(hardened, 'victim_001');

  assert.equal(report.outcome, 'attacker_defeated');
  assert.equal(report.allowed, 0);
  await verdict(true, `Rotation wins back a challenge, never an allow. Defeated in ${report.rounds} rounds.`);
});

// ── Act 3 ───────────────────────────────────────────────────────────────

test('act 3: a smarter attacker finds the gap the hardened engine leaves', async () => {
  await fresh('hardened');
  const useLlm = process.env.DEMO_LLM === 'anthropic' && process.env.ANTHROPIC_API_KEY;
  await act(3, 'A smarter attacker: "a step-up is not a block"', `
    The hardened engine remembers a challenged device as seen, not as bad.
    ${useLlm ? 'Attacker: Claude, reasoning from the decisions it gets back.' : 'Attacker: a scripted stand-in for an LLM, so this test is deterministic.'}`);

  const llm = useLlm ? fs.anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : replayChallengedDevice();
  const report = await attackRounds(hardened, 'victim_002', llm);

  if (useLlm) {
    await verdict(true, `The model ${report.outcome === 'attacker_succeeded' ? 'found the gap' : 'did not find the gap'} in ${report.rounds} rounds.`);
  } else {
    assert.equal(report.outcome, 'attacker_succeeded');
    await verdict(false, `Replaying the challenged device gets in on round ${report.rounds}. That is a finding.`);
  }
});

// ── Act 4 ───────────────────────────────────────────────────────────────

test('act 4: ordinary customers get through the hardened engine', async () => {
  await fresh('hardened');
  await act(4, 'The other half: real customers', `
    Blocking everything gives a perfect block rate. So fraud-sim also sends
    ordinary customers: routine logins, new phones, travel, payments.`);

  const { code, stdout } = await fraudSim([
    'run', 'legitimate-users',
    '--target-url', hardened.url, ...endpointFlags,
    '--max-false-positives', '2',
    '--seed', SEED, '--rps', '0',
  ]);

  assert.equal(code, 0, 'no customer blocked, so the false-positive gate passes');
  assert.match(stdout, /0 of 12 customers refused/);
  await verdict(true, 'No customer blocked. New phones and travel are challenged, which is fair.');
});

// ── Act 5 ───────────────────────────────────────────────────────────────

test('act 5: the full assessment, gated like CI would gate it', async () => {
  await fresh('simple');
  await act(5, 'The full assessment, as a CI gate', `
    All ten attacks plus customer traffic against the simple engine.
    Gate: block at least 85% of attacks AND block no more than 2% of customers.`);

  const { code, stdout } = await fraudSim([
    'suite', '--all',
    '--target-url', simple.url, ...endpointFlags,
    '--option', 'delayMs=0',
    '--option', 'account-drain.postLoginPauseMs=0',
    '--option', 'account-drain.delayBetweenWithdrawalsMs=0',
    '--fail-under', '85',
    '--max-false-positives', '2',
    '--report', REPORT,
    '--title', 'Simple practice engine — assessment',
    '--seed', SEED, '--rps', '0',
  ]);

  assert.equal(code, 1, 'the gate fails: attacks got through and customers were blocked');
  assert.match(stdout, /LEGITIMATE TRAFFIC/);
  assert.match(stdout, /GATE\s+FAIL — false-positive rate/);
  assert.match(stdout, /The attack reached money/);
  assert.ok(existsSync(REPORT), 'the HTML report was written');
  assert.match(readFileSync(REPORT, 'utf8'), /What it cost ordinary customers/);

  const blockRate = stdout.match(/TOTAL .*· ([\d.]+)% blocked/)?.[1];
  const falsePositives = stdout.match(/CUSTOMERS .*· ([\d.]+)% blocked \(false positives\)/)?.[1];
  assert.ok(blockRate && falsePositives, 'both halves of the measurement are reported');
  await verdict(false, `${blockRate}% of attacks blocked, money still lost, and ${falsePositives}% of customer events refused.`);
  await say(`${c.dim('Shareable report:')} ${REPORT}`);
});

// ── Act 6 ───────────────────────────────────────────────────────────────

test('act 6: a target that is down is not reported as a weak defence', async () => {
  const deadPort = await freePort();
  await act(6, 'When the target itself is down', `
    A broken staging box must not look like a weak defence, or a strong one.
    Exit 1 means fix the rules. Exit 3 means fix the environment.`);

  const { code, stderr } = await fraudSim([
    'run', 'credential-stuffing',
    '--target-url', `http://127.0.0.1:${deadPort}`, ...endpointFlags,
    '--option', 'attackerCount=2',
    '--option', 'attemptsPerIp=2',
    '--option', 'delayMs=0',
    '--timeout', '1000', '--rps', '0',
  ]);

  assert.equal(code, 3);
  assert.match(stderr, /does not measure the defence/);
  await verdict(true, 'Exit 3: the run is flagged as unmeasurable, not as a pass or a fail.');

  if (RECORDING) await finale();
});

// ── pieces ──────────────────────────────────────────────────────────────

/** Run the adaptive attacker through the library, printing each round. */
async function attackRounds(target, victim, llm) {
  const adapter = fs.httpAdapter({ baseUrl: target.url, endpoints: { scoreLogin: ENDPOINTS.login } });
  let reasoning = '';
  const rounds = [];

  const report = await fs.run('adaptive-attacker', {
    target: adapter,
    llm,
    options: { targetUserId: victim, maxRounds: 8, delayMs: 0 },
    seed: 7,
    maxRequestsPerSecond: Infinity,
    onEvent: (event) => {
      if (event.type === 'attacker_adapts') reasoning = event.reasoning;
      if (event.type === 'response') rounds.push({ round: event.round, reasoning, response: event.response });
    },
  });

  // Printed after the run, at the recording's pace, rather than as events
  // arrive: the attack itself takes milliseconds.
  for (const { round, reasoning: why, response } of rounds) {
    const decision = response?.decision ?? 'ERROR';
    const paintDecision = DECISION_COLOUR[decision] ?? ((s) => s);
    const codes = (response?.reasons ?? []).map((r) => r.code).join(', ') || '—';
    log(`\n  ${c.dim(`round ${String(round).padStart(2)}`)}  ${paintDecision(decision.padEnd(8))}${c.dim(codes)}`);
    // Wrapped at a word, under the arrow: a terminal breaks a long line
    // mid-word, which is hard to read and worse on a recording.
    wrap(`↳ ${why}`, Math.max(60, (process.stdout.columns || 110) - 14)).forEach((line, i) =>
      log(`            ${c.dim(i === 0 ? line : `  ${line}`)}`)
    );
    await pause();
  }

  return report;
}

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A scripted strategy that reasons the way the gap needs: once a device has
 * only been challenged, keep it and rotate to a clean network.
 */
function replayChallengedDevice() {
  return {
    name: 'scripted-replay',
    async generateStrategy({ history }) {
      const challenged = history.find((h) => h.decision === 'STEP_UP');
      if (challenged) {
        return {
          reasoning: 'A step-up is not a block. Replaying the device that was only challenged.',
          parameters: { deviceFingerprint: challenged.parameters.deviceFingerprint },
        };
      }
      return { reasoning: 'Blocked outright. Rotating to a fresh residential IP.', parameters: { ip: '197.211.62.99' } };
    },
  };
}

async function finale() {
  log(`\n${c.cyan('═'.repeat(72))}`);
  log(`  ${c.bold('What the run showed')}`);
  log(c.cyan('═'.repeat(72)));
  for (const line of [
    'A block rate on its own hides two things: money that still got out, and customers locked out.',
    'An adaptive attacker finds gaps a scripted test never will.',
    'Every result above replays exactly from its seed, and gates CI with an exit code.',
  ]) {
    await say(line);
  }
  log(`\n  ${c.bold('npx fraud-sim')}   ${c.dim('github.com/arthurr-beep/fraudsim')}\n`);

  if (process.env.DEMO_OPEN !== '0') openInBrowser(REPORT);
}

function openInBrowser(file) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', file]]
      : process.platform === 'darwin'
        ? ['open', [file]]
        : ['xdg-open', [file]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}
