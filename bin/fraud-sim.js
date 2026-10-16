#!/usr/bin/env node
/**
 * fraud-sim command line interface.
 *
 * Exists so a team can gate CI on their fraud defence without writing any
 * JavaScript, and so an assessment is one command rather than a script someone
 * has to maintain.
 *
 * Exit codes are the contract with CI:
 *   0  ran, and the gate passed (or no gate was set)
 *   1  ran, and the gate failed — an attack succeeded, a block rate was
 *      below --fail-under, or too many legitimate customers were blocked
 *   2  usage error — bad flags, unknown scenario
 *   3  the run itself failed, or the target was too unreliable to measure
 *
 * The 1/3 split matters: a weak defence and an unreachable target are different
 * problems, and a pipeline should not report them the same way.
 */

import { writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

import { run, runSuite, listScenarios, resolveLocale, localeIds } from '../src/index.js';
import { httpAdapter } from '../src/adapters/http.js';
import { generateReport, summarise } from '../src/reporting/index.js';

const VERSION = '0.5.1';

const FORMAT_BY_EXT = {
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'junit',
  '.json': 'json',
  '.txt': 'text',
};

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const command = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (command === 'list') return cmdList(flags);
  if (command === 'run') return cmdRun(flags);
  if (command === 'suite') return cmdSuite(flags);

  throw usage(`Unknown command "${command}". Expected: list, run, suite.`);
}

// ── commands ────────────────────────────────────────────────────────────

function cmdList(flags) {
  const scenarios = listScenarios();

  if (flags.json) {
    process.stdout.write(JSON.stringify(scenarios, null, 2) + '\n');
    return;
  }

  const width = Math.max(...scenarios.map((s) => s.id.length));
  process.stdout.write(`\n  ${scenarios.length} scenarios\n\n`);
  for (const s of scenarios) {
    process.stdout.write(`  ${s.id.padEnd(width)}  ${s.description}\n`);
  }
  process.stdout.write(
    `\n  Options for a scenario:  fraud-sim list --json\n` +
      `  Run one:                 fraud-sim run <id> --target-url <url>\n\n`
  );
}

async function cmdRun(flags) {
  const scenarioId = flags._[0];
  if (!scenarioId) throw usage('run needs a scenario id. See: fraud-sim list');

  const known = listScenarios().map((s) => s.id);
  if (!known.includes(scenarioId)) {
    throw usage(`Unknown scenario "${scenarioId}". Available: ${known.join(', ')}`);
  }

  resolveMarket(flags); // fail on a bad country code before sending anything
  assertFalsePositiveGateMeasurable([scenarioId], flags);
  const target = buildTarget(flags);
  const report = await run(scenarioId, {
    target,
    options: optionsFor(scenarioId, flags),
    ...runConfig(flags),
    onEvent: progressReporter(flags),
  });

  return finish([report], flags, scenarioId);
}

async function cmdSuite(flags) {
  const known = listScenarios().map((s) => s.id);

  let ids;
  if (flags.all) {
    ids = known;
  } else if (flags.scenarios) {
    ids = String(flags.scenarios)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = ids.filter((id) => !known.includes(id));
    if (unknown.length) throw usage(`Unknown scenario(s): ${unknown.join(', ')}`);
  } else {
    throw usage('suite needs --all or --scenarios a,b,c');
  }

  resolveMarket(flags); // fail on a bad country code before sending anything
  assertFalsePositiveGateMeasurable(ids, flags);
  const target = buildTarget(flags);
  const result = await runSuite({
    name: flags.name ?? 'fraud-sim suite',
    target,
    scenarios: ids.map((id) => ({ id, options: optionsFor(id, flags) })),
    concurrency: flags.concurrency ?? 1,
    ...runConfig(flags),
    onEvent: progressReporter(flags),
  });

  return finish(result.scenarioReports, flags, result.suiteName);
}

// ── shared ──────────────────────────────────────────────────────────────

/**
 * Identifiers a scenario requires but cannot invent for itself. Declared as
 * `null` in a scenario's defaultOptions, meaning "you must supply this".
 *
 * The CLI fills them so `suite --all` works without the caller hand-writing an
 * option set per scenario. Each scenario gets its own slice of the account
 * pool, because scenarios sharing accounts contaminate each other's velocity
 * counters — the same isolation problem as running them concurrently.
 */
const IDENTITY_OPTIONS = {
  targetUserIds: (users) => users,
  targetUserId: (users) => users[0],
  sourceUserId: (users) => users[0],
};

/**
 * Build the option set for one scenario.
 *
 * Precedence, lowest first:
 *   1. synthesised identifiers
 *   2. global `--option key=value`, applied only where the scenario declares
 *      that key — otherwise a global `--option delayMs=5` would be rejected by
 *      every scenario that has no delayMs, which is the opposite of useful
 *   3. scoped `--option <scenario>.<key>=<value>`, which always wins
 */
function optionsFor(scenarioId, flags) {
  const meta = listScenarios().find((s) => s.id === scenarioId);
  const declared = meta?.defaultOptions ?? {};
  const options = {};

  const users = usersFor(scenarioId, flags);
  for (const [key, build] of Object.entries(IDENTITY_OPTIONS)) {
    if (key in declared && declared[key] === null) options[key] = build(users);
  }

  // `targetUserIds` supersedes `targetUserId` where a scenario accepts both.
  if ('targetUserIds' in options && 'targetUserId' in options) delete options.targetUserId;

  for (const [key, value] of Object.entries(flags.option)) {
    if (key in declared) options[key] = value;
  }

  for (const [key, value] of Object.entries(flags.scopedOption[scenarioId] ?? {})) {
    options[key] = value;
  }

  return options;
}

/** A distinct block of synthetic accounts per scenario. */
function usersFor(scenarioId, flags) {
  const count = flags.users ?? 12;
  const prefix = flags['user-prefix'] ?? 'sim_user';
  // A stable per-scenario offset keeps runs reproducible while keeping the
  // account ranges disjoint.
  const offset = [...scenarioId].reduce((a, c) => a + c.charCodeAt(0), 0) % 900;
  return Array.from({ length: count }, (_, i) => `${prefix}_${1000 + offset * 100 + i}`);
}


function runConfig(flags) {
  const config = {};
  if (flags.seed != null) config.seed = flags.seed;
  if (flags.rps != null) config.maxRequestsPerSecond = flags.rps === 0 ? Infinity : flags.rps;
  if (flags.locale != null) config.locale = flags.locale;
  return config;
}

/**
 * The market to simulate, validated before anything is sent.
 *
 * Checking up front matters: an unknown country code would otherwise surface as
 * a wall of validation errors from the target, which reads as "your fraud engine
 * is broken" rather than "you typed the wrong code".
 */
function resolveMarket(flags) {
  try {
    return resolveLocale(flags.locale);
  } catch (err) {
    throw usage(err.message);
  }
}

/**
 * A false-positive gate over a run with no legitimate traffic would pass by
 * default — zero customers, zero refused. Refuse it before anything is sent.
 */
function assertFalsePositiveGateMeasurable(ids, flags) {
  if (!Number.isFinite(flags['max-false-positives'])) return;
  const legitimate = listScenarios()
    .filter((s) => s.traffic === 'legitimate')
    .map((s) => s.id);
  if (!ids.some((id) => legitimate.includes(id))) {
    throw usage(
      '--max-false-positives needs legitimate traffic in the run. ' +
        `Use suite --all, or include ${legitimate.join(', ')} in --scenarios.`
    );
  }
}

function buildTarget(flags) {
  if (!flags['target-url']) {
    throw usage('--target-url is required (e.g. --target-url https://api.example.com)');
  }

  const endpoints = {};
  if (flags['endpoint-login']) endpoints.scoreLogin = endpointPath(flags['endpoint-login']);
  if (flags['endpoint-withdrawal']) endpoints.scoreWithdrawal = endpointPath(flags['endpoint-withdrawal']);
  if (flags['endpoint-action']) endpoints.scoreAction = endpointPath(flags['endpoint-action']);

  return httpAdapter({
    baseUrl: flags['target-url'],
    headers: flags.header,
    endpoints: Object.keys(endpoints).length ? endpoints : undefined,
    timeoutMs: flags.timeout ?? 5000,
    blockOnStatus: flags['block-on-status'] ?? [],
  });
}

/**
 * Validate an endpoint path, catching one specific way it arrives wrong.
 *
 * Git Bash and other MSYS shells on Windows rewrite arguments that look like
 * absolute Unix paths into Windows paths, so `--endpoint-login /score/login`
 * silently becomes `C:/Program Files/Git/score/login`. Every request then 404s
 * and the run reports that the *target* is unreliable — sending the user to
 * debug a system that was never contacted. Fail loudly with the actual fix
 * instead.
 */
function endpointPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    throw usage(
      `--endpoint path "${value}" was rewritten into a filesystem path by your shell.\n` +
        '  This is MSYS/Git Bash path conversion on Windows. Either prefix the command:\n' +
        '      MSYS_NO_PATHCONV=1 fraud-sim ...\n' +
        '  or pass the path with a leading double slash: --endpoint-login //score/login'
    );
  }

  // Accept `score/login` as well as `/score/login`; the difference never matters
  // to the caller and getting it wrong costs a confusing 404.
  const path = value.startsWith('//') ? value.slice(1) : value;
  return path.startsWith('/') ? path : `/${path}`;
}

/** Live progress on a TTY; silent in a pipeline unless something is wrong. */
function progressReporter(flags) {
  if (flags.quiet) return undefined;

  const interactive = process.stdout.isTTY;
  let scored = 0;
  const seenErrors = new Set();

  return (event) => {
    if (event.type === 'response') {
      scored++;
      if (interactive && scored % 10 === 0) {
        process.stdout.write(`\r  scoring… ${scored} events`);
      }
    } else if (event.type === 'warning') {
      if (interactive) process.stdout.write('\r');
      process.stderr.write(`  ! ${event.message}\n`);
    } else if (event.type === 'error') {
      // Report *why* attempts are failing, not just how many. Deduplicated:
      // a broken target produces the same message hundreds of times, and the
      // useful information is the set of distinct causes.
      const message = String(event.message ?? 'unknown error');
      if (!seenErrors.has(message) && seenErrors.size < 5) {
        seenErrors.add(message);
        if (interactive) process.stdout.write('\r');
        process.stderr.write(`  x ${message}\n`);
      }
    }
  };
}

function finish(reports, flags, name) {
  const market = resolveMarket(flags);

  if (process.stdout.isTTY && !flags.quiet) process.stdout.write('\r[K');

  const reportOptions = {
    title: flags.title ?? name,
    targetName: flags['target-name'] ?? flags['target-url'],
    version: VERSION,
    // Denominated in the market's own currency unless overridden — simulating
    // a UK bank and reporting in naira would be a strange default.
    currency: flags.currency ?? market.currency,
    market: market.id,
    failUnder: flags['fail-under-each'] ?? flags['fail-under'],
    failUnderScope: flags['fail-under-each'] != null ? 'scenario' : 'overall',
    maxFalsePositiveRate: flags['max-false-positives'],
    suiteName: name,
  };

  // Always print the terminal summary, so a run is legible without opening a file.
  if (!flags.quiet) {
    process.stdout.write(generateReport(reports, { ...reportOptions, format: 'text' }));
  }

  if (flags.report) {
    const path = resolve(flags.report);
    const format =
      flags.format ?? FORMAT_BY_EXT[extname(path).toLowerCase()] ?? 'html';
    writeFileSync(path, generateReport(reports, { ...reportOptions, format }));
    if (!flags.quiet) process.stdout.write(`  Report written to ${path} (${format})\n\n`);
  }

  const { totals } = summarise(reports, reportOptions);
  const legit = totals.legitimate;

  // An unmeasurable run must not be reported as either a pass or a failure of
  // the defence — it is an environment problem.
  const unreliable = Math.max(totals.errorRate, legit?.errorRate ?? 0);
  if (unreliable > 0.05) {
    process.stderr.write(
      `  ${(unreliable * 100).toFixed(1)}% of attempts never received a decision. ` +
        'The target was unreliable, so this run does not measure the defence.\n\n'
    );
    process.exit(3);
  }

  const failures = [];
  if (totals.attacksSucceeded > 0) {
    failures.push(`${totals.attacksSucceeded} attack(s) succeeded`);
  }

  // --fail-under gates the overall block rate. Gating every scenario
  // individually is a different, stricter question: some scenarios legitimately
  // run at a low block rate because their event stream includes the victim's
  // own traffic, so a per-scenario floor produces false failures unless the
  // caller has chosen it deliberately. That is --fail-under-each.
  if (Number.isFinite(flags['fail-under']) && totals.blockRate < flags['fail-under']) {
    failures.push(
      `overall block rate ${(totals.blockRate * 100).toFixed(1)}% is below the ` +
        `${(flags['fail-under'] * 100).toFixed(0)}% floor`
    );
  }

  // Blocking good customers is a failure of the defence too — the half of the
  // measurement a block rate cannot see. Gated only when asked, because every
  // real engine refuses some customers and the acceptable share is a policy.
  if (
    Number.isFinite(flags['max-false-positives']) &&
    legit &&
    legit.falsePositiveRate > flags['max-false-positives']
  ) {
    failures.push(
      `false-positive rate ${(legit.falsePositiveRate * 100).toFixed(1)}% is above the ` +
        `${(flags['max-false-positives'] * 100).toFixed(1)}% ceiling ` +
        `(${legit.customersBlocked} of ${legit.customers} customers refused)`
    );
  }

  if (Number.isFinite(flags['fail-under-each'])) {
    // Attack scenarios only: a block-rate floor on legitimate traffic would
    // demand that good customers be refused.
    const below = reports.filter(
      (r) => r.traffic !== 'legitimate' && r.blockRate < flags['fail-under-each']
    );
    if (below.length) {
      failures.push(
        `${below.length} scenario(s) below the per-scenario ${(flags['fail-under-each'] * 100).toFixed(0)}% floor: ` +
          below.map((r) => r.scenarioId).join(', ')
      );
    }
  }

  if (failures.length) {
    process.stderr.write(`  FAILED: ${failures.join('; ')}\n\n`);
    process.exit(1);
  }
}

// ── flag parsing ────────────────────────────────────────────────────────

const NUMERIC = new Set([
  'seed',
  'rps',
  'concurrency',
  'timeout',
  'fail-under',
  'fail-under-each',
  'max-false-positives',
  'users',
]);
const REPEATABLE = new Set(['header', 'option', 'block-on-status']);
const BOOLEAN = new Set(['all', 'json', 'quiet']);

function parseFlags(argv) {
  const flags = { _: [], header: {}, option: {}, scopedOption: {} };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }

    let key = arg.slice(2);
    let value;

    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }

    if (BOOLEAN.has(key)) {
      flags[key] = value === undefined ? true : value !== 'false';
      continue;
    }

    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw usage(`--${key} needs a value`);
    }

    if (REPEATABLE.has(key)) {
      applyRepeatable(flags, key, value);
      continue;
    }

    if (NUMERIC.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw usage(`--${key} must be a number, received "${value}"`);
      flags[key] = n;
      continue;
    }

    flags[key] = value;
  }

  // A percentage is friendlier to type than a fraction, so accept both.
  for (const key of ['fail-under', 'fail-under-each']) {
    if (flags[key] > 1) flags[key] = flags[key] / 100;
  }
  // A 100% false-positive ceiling gates nothing, so 1 here means 1%, not 1.0.
  if (flags['max-false-positives'] >= 1) {
    flags['max-false-positives'] = flags['max-false-positives'] / 100;
  }

  return flags;
}

function applyRepeatable(flags, key, value) {
  if (key === 'header') {
    const idx = value.indexOf(':');
    if (idx === -1) throw usage(`--header expects "Name: value", received "${value}"`);
    flags.header[value.slice(0, idx).trim()] = value.slice(idx + 1).trim();
    return;
  }

  if (key === 'block-on-status') {
    flags['block-on-status'] ??= [];
    for (const part of value.split(',')) {
      const n = Number(part.trim());
      if (!Number.isInteger(n)) throw usage(`--block-on-status expects status codes`);
      flags['block-on-status'].push(n);
    }
    return;
  }

  // --option key=value, with the value coerced so numeric and boolean scenario
  // options do not arrive as strings and silently fail their validation.
  const idx = value.indexOf('=');
  if (idx === -1) throw usage(`--option expects key=value, received "${value}"`);
  const name = value.slice(0, idx);
  const parsed = coerce(value.slice(idx + 1));

  // `--option scenario.key=value` targets one scenario; a bare key applies to
  // every scenario that declares it.
  const dot = name.indexOf('.');
  if (dot !== -1) {
    const scenario = name.slice(0, dot);
    flags.scopedOption[scenario] ??= {};
    flags.scopedOption[scenario][name.slice(dot + 1)] = parsed;
    return;
  }

  flags.option[name] = parsed;
}

function coerce(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && Number.isFinite(Number(raw))) return Number(raw);
  if (raw.includes(',')) return raw.split(',').map((s) => coerce(s.trim()));
  return raw;
}

function usage(message) {
  const err = new Error(`${message}\n\nRun \`fraud-sim --help\` for usage.`);
  err.exitCode = 2;
  return err;
}

const HELP = `
  fraud-sim ${VERSION} — synthetic attack traffic for testing fraud detection

  USAGE
    fraud-sim list [--json]
    fraud-sim run <scenario> --target-url <url> [options]
    fraud-sim suite (--all | --scenarios a,b,c) --target-url <url> [options]

  TARGET
    --target-url <url>          Base URL of the system under test (required)
    --header "Name: value"      Request header; repeat for several
    --endpoint-login <path>     Override the login scoring path
    --endpoint-withdrawal <p>   Override the withdrawal scoring path
    --endpoint-action <path>    Override the action scoring path
    --block-on-status 403       HTTP statuses that mean a genuine block.
                                By default no status does — a 429 or 5xx is an
                                error, never a block, so a failing target can
                                never look like a strong one.
    --timeout <ms>              Per-request timeout (default 5000)

  RUN
    --option key=value          Scenario option, applied to every scenario that
                                declares it; repeat for several
    --option <id>.key=value     Scenario option for one scenario only
    --users <n>                 Synthetic accounts per scenario (default 12).
                                Scenarios that require account ids get their own
                                disjoint block, so they do not contaminate each
                                other's per-user counters.
    --user-prefix <text>        Prefix for those accounts (default sim_user)
    --seed <n>                  Make the run reproducible
    --rps <n>                   Request ceiling per second (default 25, 0 = off)
    --concurrency <n>           Scenarios in parallel (suite only, default 1)
    --name <text>               Suite name for the report
    --locale <code>             Market to simulate: account-number and phone
                                formats, bank names, payload currency, and which
                                country counts as domestic for geo rules.
                                Available: ${localeIds().join(', ')} (default US)

  OUTPUT
    --report <file>             Write a report; format inferred from extension
                                (.html, .xml = JUnit, .json, .txt)
    --format <fmt>              Force html | junit | json | text
    --title <text>              Report title
    --currency <code>           Display currency. Defaults to the market's own.
                                Amounts are minor-unit integers, so this changes
                                presentation only — nothing is converted.
    --target-name <text>        How the target is named in the report
    --quiet                     Suppress the terminal summary

  CI
    --fail-under <rate>         Exit 1 if the OVERALL block rate is below this
                                (accepts 0.85 or 85)
    --fail-under-each <rate>    Exit 1 if ANY single scenario is below this.
                                Stricter, and needs care: some scenarios include
                                the victim's own legitimate traffic, so a low
                                block rate there is correct rather than a failure.

    --max-false-positives <r>   Exit 1 if more than this share of LEGITIMATE
                                customer events were blocked (accepts 0.02 or 2).
                                Needs legitimate-users in the run; suite --all
                                includes it.

    An attack that reaches its objective always fails the run, with or without
    these flags.

  EXIT CODES
    0  gate passed        2  usage error
    1  gate failed        3  run failed, or target too unreliable to measure

  EXAMPLES
    fraud-sim list

    fraud-sim run credential-stuffing \\
      --target-url https://staging.example.com \\
      --header "Authorization: Bearer $API_KEY" \\
      --option targetUserIds=u1,u2,u3 --seed 42

    fraud-sim suite --all \\
      --target-url https://staging.example.com \\
      --seed 42 --report assessment.html --fail-under 85 --max-false-positives 2

`;
// Invoked last on purpose: the flag tables above are module-level `const`,
// so calling main() before they initialise fails with a temporal-dead-zone
// error at runtime rather than anything the linter would catch.
main().catch((err) => {
  process.stderr.write(`\nfraud-sim: ${err.message}\n`);
  process.exit(err.exitCode ?? 3);
});

