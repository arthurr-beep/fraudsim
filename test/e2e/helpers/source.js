/**
 * Which fraud-sim the walkthrough exercises.
 *
 * By default, this repository's source — what CI must test on a pull request.
 * With FRAUD_SIM_SOURCE=npm, the package as published: it is installed from the
 * registry into a temporary folder and everything runs from there — the CLI,
 * the library and the practice engines that ship in its examples/. That is the
 * mode for a recording, so that `npx fraud-sim` on screen is literally what ran.
 *
 *   FRAUD_SIM_SOURCE=npm, or --from-npm   install fraud-sim@latest
 *   FRAUD_SIM_VERSION=0.5.0                pin the version installed
 *
 * `npm run demo:npm` passes --from-npm, which works in every shell; setting an
 * environment variable inline does not work in a Windows npm script.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * @returns {Promise<{ from: 'repo'|'npm', version: string, root: string, cli: string,
 *   run: Function, httpAdapter: Function, anthropic: Function }>}
 */
export async function loadFraudSim() {
  const fromNpm = process.env.FRAUD_SIM_SOURCE === 'npm' || process.argv.includes('--from-npm');
  const root = fromNpm ? installFromNpm() : REPO;
  const load = (path) => import(pathToFileURL(join(root, path)).href);

  const [{ run }, { httpAdapter }, { anthropic }] = await Promise.all([
    load('src/index.js'),
    load('src/adapters/http.js'),
    load('src/llm/anthropic.js'),
  ]);

  return {
    from: root === REPO ? 'repo' : 'npm',
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    root,
    cli: join(root, 'bin', 'fraud-sim.js'),
    run,
    httpAdapter,
    anthropic,
  };
}

function installFromNpm() {
  const spec = `fraud-sim@${process.env.FRAUD_SIM_VERSION ?? 'latest'}`;
  const dir = join(tmpdir(), 'fraud-sim-from-npm');
  mkdirSync(dir, { recursive: true });

  // express is not a dependency of fraud-sim — only its example servers use
  // it — so it is installed beside the package for the practice engines.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', dir, spec, 'express@^4'],
    { encoding: 'utf8', shell: process.platform === 'win32' }
  );
  if (result.status !== 0) {
    throw new Error(`npm install ${spec} failed:\n${result.stderr || result.stdout}`);
  }
  return join(dir, 'node_modules', 'fraud-sim');
}
