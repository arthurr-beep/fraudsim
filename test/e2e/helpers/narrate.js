/**
 * Narration for the walkthrough: titles, captions, typed commands and the
 * live output of the real CLI.
 *
 * Two speeds. Run directly (`npm run demo`) it pauses between beats so a screen
 * recording can be followed; under `node --test` (`npm run test:e2e`, CI) it
 * runs flat out. Set DEMO_PACE=<ms> to choose the pause yourself.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = 'bin/fraud-sim.js';

// node --test runs each file in a child with NODE_TEST_CONTEXT set; a direct
// run does not. That is the difference between CI and a recording.
export const PACE = Number(
  process.env.DEMO_PACE ?? (process.env.NODE_TEST_CONTEXT ? 0 : 900)
);
export const RECORDING = PACE > 0;

// Under node --test a file's stdout carries the runner's own serialized
// messages, and raw bytes written there can be mistaken for one ("Unable to
// deserialize cloned data"). Narration goes to stderr there, which the runner
// passes through as plain text; a direct run keeps it on stdout for recording.
const out = process.env.NODE_TEST_CONTEXT ? process.stderr : process.stdout;

/** console.log, routed to whichever stream is safe for this run. */
export function log(...parts) {
  out.write(`${parts.join(' ')}\n`);
}

const tty = out.isTTY || RECORDING;
const paint = (code) => (text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};

export const DECISION_COLOUR = { BLOCK: c.red, STEP_UP: c.yellow, ALLOW: c.green };

export function pause(beats = 1) {
  return PACE > 0 ? new Promise((r) => setTimeout(r, PACE * beats)) : Promise.resolve();
}

/** A full-width act heading. */
export async function act(number, title, caption) {
  const rule = '═'.repeat(72);
  log(`\n${c.cyan(rule)}`);
  log(`  ${c.cyan(c.bold(`ACT ${number}`))}  ${c.bold(title)}`);
  log(c.cyan(rule));
  if (caption) {
    for (const line of caption.trim().split('\n')) log(`  ${c.dim(line.trim())}`);
  }
  await pause(2);
}

/** One line of commentary. */
export async function say(text) {
  log(`\n  ${text}`);
  await pause();
}

/** The verdict an act was building to. */
export async function verdict(ok, text) {
  log(`\n  ${ok ? c.green('✔') : c.red('✘')} ${c.bold(text)}`);
  await pause(2);
}

/** Print a shell command as if typed, then pause before it runs. */
async function typeCommand(args) {
  const shown = ['npx fraud-sim', ...args.map(quoteForShow)].join(' ');
  const wrapped = shown.replace(/ --/g, ' \\\n      --');
  out.write(`\n  ${c.dim('$')} `);
  if (RECORDING) {
    for (const ch of wrapped) {
      out.write(ch);
      await new Promise((r) => setTimeout(r, 12));
    }
  } else {
    out.write(wrapped);
  }
  out.write('\n');
  await pause();
}

function quoteForShow(arg) {
  return /[\s"]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Run the real CLI as a child process, showing its output as it arrives and
 * returning it for assertions. No shell is involved, so no path mangling.
 *
 * @param {string[]} args
 * @param {string} [cliPath] - The CLI to run: this repository's by default,
 *   or the one in a copy installed from npm.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function cli(args, cliPath = join(ROOT, CLI)) {
  await typeCommand(args);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      out.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      out.write(chunk);
    });
    child.on('error', reject);
    child.on('close', async (code) => {
      log(`  ${c.dim(`exit code ${code}`)}`);
      await pause();
      resolve({ code, stdout, stderr });
    });
  });
}
