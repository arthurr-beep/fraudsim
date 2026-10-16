/**
 * HTML report renderer.
 *
 * Produces a single self-contained file — no build step, no external assets
 * beyond an optional web font, and it prints correctly. The output is meant to
 * be sent to someone: a risk lead, a CTO evaluating the system, an auditor.
 *
 * Two deliberate choices worth knowing about:
 *
 *   - **Decision colour is status colour, not series colour.** Blocked,
 *     challenged and allowed mean good, partial and bad from the defender's
 *     side, so they use fixed status hues rather than a categorical palette.
 *   - **Every bar has its number beside it.** The status yellow is below 3:1
 *     against a light surface, so colour alone is never the carrier — the table
 *     is the data, the bar is the glance.
 */

import {
  normaliseInput,
  totalsFor,
  reasonFrequency,
  latencyFor,
  outcomeFor,
  findingsFor,
  isLegitimate,
  pct,
  fmtMs,
} from './aggregate.js';
import { formatMoney } from './money.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape anything that reaches the document — scenario ids and reason codes
 *  come from user-written scenarios and target responses, not from us. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function renderHtml(result, options = {}) {
  const { reports } = normaliseInput(result);
  const title = options.title ?? 'Adversarial Assessment';
  const targetName = options.targetName ?? 'Target system';
  const generatedAt = options.now ?? new Date();

  const money = (minor) => formatMoney(minor, options);
  const totals = totalsFor(reports);
  const legit = totals.legitimate;
  const customerIds = reports.filter(isLegitimate).map((r) => r.scenarioId);
  const findings = findingsFor(reports, options);
  const reasons = reasonFrequency(reports);
  const latency = latencyFor(reports);
  const seeds = [...new Set(reports.map((r) => r.seed).filter((s) => s != null))];

  const rows = [...reports].sort((a, b) => (b.attempts ?? 0) - (a.attempts ?? 0));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@500;600&display=swap">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">

  <header class="masthead">
    <span class="eyebrow">Adversarial assessment</span>
    <h1>${esc(title)}</h1>
    <p class="standfirst">
      ${reports.length} scenario${reports.length === 1 ? '' : 's'},
      ${totals.attempts} scored event${totals.attempts === 1 ? '' : 's'},
      run against ${esc(targetName)}.
      ${totals.estimatedLossMinor > 0
        ? `It blocked ${pct(totals.blockRate)} of what was thrown at it — and still let ${esc(money(totals.estimatedLossMinor))} through.`
        : `It blocked ${pct(totals.blockRate)} of what was thrown at it.`}
      ${legit
        ? legit.blocked > 0
          ? `It also refused ${pct(legit.falsePositiveRate)} of ordinary customer activity — ${legit.customersBlocked} of ${legit.customers} customers locked out at least once.`
          : `It let every ordinary customer through${legit.stepUp > 0 ? `, challenging ${pct(legit.stepUp / Math.max(1, legit.scoredAttempts))} of their activity` : ''}.`
        : ''}
    </p>

    <dl class="meta">
      <div><dt>Target</dt><dd>${esc(targetName)}</dd></div>
      <div><dt>Date</dt><dd>${esc(generatedAt.toISOString().slice(0, 10))}</dd></div>
      <div><dt>Scenarios</dt><dd class="num">${reports.length}</dd></div>
      <div><dt>Scored events</dt><dd class="num">${totals.scoredAttempts}</dd></div>
      <div><dt>Seed</dt><dd class="mono num">${seeds.length ? esc(seeds.join(', ')) : 'unseeded'}</dd></div>
      <div><dt>Failed requests</dt><dd class="num">${totals.errors}</dd></div>
    </dl>
  </header>

  ${totals.errorRate > 0.05 ? unreliableBanner(totals) : ''}
  ${seeds.length === 0 ? unseededBanner() : ''}

  <section>
    <div class="sec-head"><span class="eyebrow">01 — Summary</span>
      <h2>${totals.estimatedLossMinor > 0
        ? 'A healthy block rate is not the same as no losses'
        : 'What the defence stopped'}</h2>
    </div>

    <div class="tiles">
      ${tile('Block rate', pct(totals.blockRate), `${totals.blocked} of ${totals.scoredAttempts} scored events blocked outright.`)}
      ${tile('Challenged', pct(totals.stepUpRate), `${totals.stepUp} sent to step-up rather than refused.`)}
      ${tile('Attacks that succeeded', String(totals.attacksSucceeded), 'Scenarios that reached their objective.', totals.attacksSucceeded > 0)}
      ${tile('Value extracted', totals.estimatedLossMinor > 0 ? esc(money(totals.estimatedLossMinor)) : '—',
        totals.estimatedLossMinor > 0 ? 'Summed across every scenario that reached money.' : 'No scenario reached money.',
        totals.estimatedLossMinor > 0)}
    </div>
    ${legit ? `
    <h3 class="sub">What it cost ordinary customers</h3>
    <div class="tiles">
      ${tile('False-positive rate', pct(legit.falsePositiveRate), `${legit.blocked} of ${legit.scoredAttempts} legitimate events blocked.`, legit.blocked > 0)}
      ${tile('Friction', pct(legit.frictionRate), `${legit.stepUp + legit.blocked} legitimate events challenged or blocked.`)}
      ${tile('Customers refused', `${legit.customersBlocked} of ${legit.customers}`, 'Customers blocked at least once.', legit.customersBlocked > 0)}
      ${tile('Payments refused', legit.valueBlockedMinor > 0 ? esc(money(legit.valueBlockedMinor)) : '—',
        legit.valueBlockedMinor > 0 ? "Customers' own payments to people they pay." : 'No legitimate payment was refused.',
        legit.valueBlockedMinor > 0)}
    </div>` : ''}
  </section>

  ${findings.length ? `
  <section>
    <div class="sec-head"><span class="eyebrow">02 — Findings</span>
      <h2>${findings.length} finding${findings.length === 1 ? '' : 's'}, ranked by what they cost</h2>
    </div>
    <div class="findings">
      ${findings.map(renderFinding).join('\n')}
    </div>
  </section>` : `
  <section>
    <div class="sec-head"><span class="eyebrow">02 — Findings</span><h2>Nothing got through</h2></div>
    <p class="prose col">Every scenario was contained, no run reached money, and no result
    carries a reliability caveat. That is a good outcome — read the per-scenario table
    below to see how much margin each one had.</p>
  </section>`}

  <section>
    <div class="sec-head"><span class="eyebrow">03 — Full results</span><h2>Every scenario, every decision</h2></div>

    <div class="legend">
      <span class="l-blocked">Blocked</span>
      <span class="l-challenged">Challenged (step-up)</span>
      <span class="l-allowed">Allowed</span>
    </div>

    <div class="table-scroll">
      <table>
        <thead><tr>
          <th scope="col">Scenario</th>
          <th scope="col" class="r">Events</th>
          <th scope="col" style="min-width:150px">Decisions</th>
          <th scope="col" class="r">Blocked</th>
          <th scope="col" class="r">Chall.</th>
          <th scope="col" class="r">Allowed</th>
          <th scope="col" class="r">p95</th>
          <th scope="col">Outcome</th>
        </tr></thead>
        <tbody>${rows.map(renderRow).join('\n')}</tbody>
      </table>
    </div>
    <p class="footnote">Counts are events, not attacks. Some scenarios include the victim's own
    legitimate activity, so an allowed event is not automatically a miss — the outcome column
    reads the attack rather than the arithmetic.${legit ? ` On legitimate traffic
    (<span class="mono">${customerIds.map(esc).join('</span>, <span class="mono">')}</span>) the
    colours invert: a blocked customer is shown red and an allowed one green.` : ''}</p>
  </section>

  ${reasons.length ? `
  <section>
    <div class="sec-head"><span class="eyebrow">04 — Signals</span><h2>Which rules did the work</h2></div>
    <div class="reasons">
      ${reasons.map(([code, n]) => {
        const share = n / Math.max(1, reasons[0][1]);
        return `<div class="reason">
          <span class="mono code">${esc(code)}</span>
          <span class="track"><span class="fill" style="width:${(share * 100).toFixed(1)}%"></span></span>
          <span class="mono num count">${n}</span>
        </div>`;
      }).join('\n')}
    </div>
    <p class="footnote">Times each reason code appeared across the run. A rule that never
    appears is either misconfigured or is not being exercised by these scenarios.</p>
  </section>` : ''}

  <section>
    <div class="sec-head"><span class="eyebrow">05 — Limits</span><h2>What this run does not tell you</h2></div>
    <div class="limits">
      ${limitsFor(reports, totals, latency).map((l) => `<div class="limit"><span class="mark">${l.n}</span><p>${l.html}</p></div>`).join('\n')}
    </div>
  </section>

  <footer>
    <span>Generated by <span class="mono">fraud-sim</span>${options.version ? ` v${esc(options.version)}` : ''}</span>
    <span class="mono">${totals.attempts} events · ${totals.errors} errors${seeds.length ? ` · seed ${esc(seeds.join(', '))}` : ''}</span>
  </footer>
</div>
</body>
</html>
`;
}

// ── pieces ──────────────────────────────────────────────────────────────

function tile(label, value, note, alarm = false) {
  return `<div class="tile${alarm ? ' is-alarm' : ''}">
    <span class="label">${esc(label)}</span>
    <span class="value">${value}</span>
    <span class="note">${esc(note)}</span>
  </div>`;
}

function renderFinding(f) {
  return `<article class="finding" data-sev="${esc(f.severity)}">
    <div class="finding-top">
      <span class="chip" data-sev="${esc(f.severity)}">${esc(f.severity)}</span>
      <span class="chip scenario mono">${esc(f.scenario)}</span>
    </div>
    <h3>${esc(f.title)}</h3>
    <p>${esc(f.detail)}</p>
    <div class="evidence">${f.stats
      .map(([k, v]) => `<span class="k">${esc(k)}</span> ${esc(v)}`)
      .join('<br>')}</div>
  </article>`;
}

function renderRow(r) {
  const outcome = outcomeFor(r);
  const total = Math.max(1, r.blocked + r.stepUp + r.allowed);
  const seg = (n, cls) =>
    n > 0 ? `<span class="${cls}" style="flex:${n}" title="${n} of ${total}"></span>` : '';
  // Decision colour is status colour: for a real customer a block is the bad
  // outcome, so the hues swap rather than reading a refusal as a win.
  const legitimate = isLegitimate(r);
  const blockedCls = legitimate ? 'seg-allowed' : 'seg-blocked';
  const allowedCls = legitimate ? 'seg-blocked' : 'seg-allowed';

  return `<tr>
    <td class="scenario-name"><span class="mono">${esc(r.scenarioId)}</span></td>
    <td class="n">${r.attempts}</td>
    <td><div class="bar">${seg(r.blocked, blockedCls)}${seg(r.stepUp, 'seg-challenged')}${seg(r.allowed, allowedCls)}</div></td>
    <td class="n">${r.blocked}</td>
    <td class="n">${r.stepUp}</td>
    <td class="n">${r.allowed}</td>
    <td class="n">${esc(fmtMs(r.latency?.p95))}</td>
    <td><span class="outcome" data-o="${esc(outcome.severity)}">${esc(outcome.label)}</span></td>
  </tr>`;
}

function unreliableBanner(totals) {
  return `<p class="banner is-warn"><span class="mono">!</span><span><strong>This run is not a
  measurement.</strong> ${pct(totals.errorRate)} of attempts never received a decision — the
  target was rate limiting, erroring, or unreachable. Every rate below is computed over the
  ${totals.scoredAttempts} events that were actually scored, but the sample is compromised.
  Fix the target and run again before drawing conclusions.</span></p>`;
}

function unseededBanner() {
  return `<p class="banner"><span class="mono">&#9656;</span><span><strong>This run was not
  seeded.</strong> Its results cannot be replayed exactly. Pass a seed to make anything that
  got through reproducible.</span></p>`;
}

function limitsFor(reports, totals, latency) {
  const out = [];
  const timed = reports.filter((r) => r.simulatedTime).map((r) => r.scenarioId);

  if (timed.length) {
    out.push({
      html: `<strong>${timed.length} scenario${timed.length === 1 ? '' : 's'} depend on which clock the
      target uses.</strong> <span class="mono">${timed.map(esc).join('</span>, <span class="mono">')}</span>
      space events by advancing the event timestamp rather than sleeping. If the target derives
      its velocity windows from server arrival time, it saw a burst and those rows measure
      something other than the attack described.`,
    });
  }

  out.push({
    html: `<strong>Latency here is ${latency.count ? `p95 ${esc(fmtMs(latency.p95))}, max ${esc(fmtMs(latency.max))}` : 'not measured'}.</strong>
    ${latency.approximate ? 'Suite-level percentiles are the worst per-scenario value, not a merged distribution. ' : ''}
    Figures include network time to the target and are only meaningful against a
    deployment that resembles production.`,
  });

  if (totals.errors === 0) {
    out.push({
      html: `<strong>No errors, so nothing is diluted.</strong> All ${totals.attempts} events
      returned a decision. Had the target failed, those events would be excluded from the rates
      above and flagged — a failing target is not a defending one.`,
    });
  }

  out.push({
    html: `<strong>This is a point-in-time result.</strong> It reflects the rules and thresholds
    in place during the run. Wire the same suite into CI if you want it to stay true.`,
  });

  return out.map((l, i) => ({ ...l, n: String(i + 1).padStart(2, '0') }));
}

// ── styles ──────────────────────────────────────────────────────────────

const STYLES = `
:root{color-scheme:light;--ground:#f7f8f8;--surface:#fff;--surface-sunk:#eef1f1;--rule:#dfe4e4;--rule-strong:#c6cfcf;--ink:#101a1d;--ink-2:#3d4d52;--ink-3:#5c6b70;--accent:#0f5f66;--accent-soft:#e4eeee;--blocked:#0ca30c;--challenged:#fab219;--allowed:#d03b3b;--sev-critical:#d03b3b;--sev-high:#ec835a;--sev-medium:#fab219;--sev-unknown:#5c6b70;--shadow:0 1px 2px rgba(16,26,29,.06),0 8px 24px -16px rgba(16,26,29,.3)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--ground:#12191c;--surface:#182226;--surface-sunk:#101619;--rule:#2a373b;--rule-strong:#3c4b50;--ink:#e9eeee;--ink-2:#b3c1c4;--ink-3:#8b9b9f;--accent:#5cc2ca;--accent-soft:#173235;--sev-unknown:#8b9b9f;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -16px rgba(0,0,0,.8)}}
:root[data-theme="dark"]{color-scheme:dark;--ground:#12191c;--surface:#182226;--surface-sunk:#101619;--rule:#2a373b;--rule-strong:#3c4b50;--ink:#e9eeee;--ink-2:#b3c1c4;--ink-3:#8b9b9f;--accent:#5cc2ca;--accent-soft:#173235;--sev-unknown:#8b9b9f;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -16px rgba(0,0,0,.8)}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16.5px;line-height:1.62;-webkit-font-smoothing:antialiased;padding:0 24px 96px}
.wrap{max-width:1120px;margin:0 auto}
.col{max-width:68ch}
h1,h2,h3{font-family:"IBM Plex Serif",ui-serif,Georgia,serif;font-weight:600;line-height:1.18;text-wrap:balance;margin:0}
p{margin:0}
.eyebrow{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11.5px;font-weight:500;letter-spacing:.13em;text-transform:uppercase;color:var(--accent)}
.mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.num{font-variant-numeric:tabular-nums}
header.masthead{padding:72px 0 0;display:flex;flex-direction:column;gap:20px}
h1{font-size:clamp(38px,6.5vw,60px);letter-spacing:-.02em}
.standfirst{max-width:62ch;font-size:19px;line-height:1.5;color:var(--ink-2)}
.meta{margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:8px;overflow:hidden}
.meta div{background:var(--surface);padding:12px 16px;display:flex;flex-direction:column;gap:3px}
.meta dt{font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.meta dd{margin:0;font-size:14px;font-weight:500}
.banner{margin:36px 0 0;display:flex;gap:14px;align-items:flex-start;padding:16px 20px;background:var(--accent-soft);border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:6px;font-size:15px;color:var(--ink-2);max-width:92ch}
.banner.is-warn{border-left-color:var(--allowed)}
.banner strong{color:var(--ink);font-weight:600}
section{margin-top:68px}
.sec-head{display:flex;flex-direction:column;gap:10px;padding-bottom:18px;border-bottom:1px solid var(--rule-strong);margin-bottom:30px}
h2{font-size:clamp(24px,3.4vw,31px);letter-spacing:-.012em}
h3{font-size:18px}
.prose{color:var(--ink-2)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:16px}
h3.sub{margin:32px 0 16px;color:var(--ink-2)}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:20px 22px 22px;display:flex;flex-direction:column;gap:6px;box-shadow:var(--shadow)}
.tile .label{font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.tile .value{font-family:"IBM Plex Mono",monospace;font-size:38px;font-weight:500;line-height:1.05;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile .note{font-size:13.5px;color:var(--ink-3);line-height:1.45}
.tile.is-alarm .value{color:var(--allowed)}
.findings{display:flex;flex-direction:column;gap:20px}
.finding{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:24px 26px 26px;display:flex;flex-direction:column;gap:13px;position:relative;overflow:hidden;box-shadow:var(--shadow)}
.finding::before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--stripe,var(--rule-strong))}
.finding[data-sev="critical"]{--stripe:var(--sev-critical)}
.finding[data-sev="high"]{--stripe:var(--sev-high)}
.finding[data-sev="medium"]{--stripe:var(--sev-medium)}
.finding-top{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.chip{display:inline-flex;align-items:center;gap:6px;font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;padding:4px 9px;border-radius:4px;border:1px solid var(--rule-strong);color:var(--ink-2);white-space:nowrap}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--dot,var(--ink-3))}
.chip[data-sev="critical"]{--dot:var(--sev-critical)}
.chip[data-sev="high"]{--dot:var(--sev-high)}
.chip[data-sev="medium"]{--dot:var(--sev-medium)}
.chip.scenario{color:var(--ink-3)}
.chip.scenario::before{display:none}
.finding p{color:var(--ink-2)}
.evidence{background:var(--surface-sunk);border:1px solid var(--rule);border-radius:7px;padding:13px 15px;font-family:"IBM Plex Mono",monospace;font-size:13px;line-height:1.75;color:var(--ink-2);overflow-x:auto}
.evidence .k{color:var(--ink-3)}
.legend{display:flex;flex-wrap:wrap;gap:18px;margin-bottom:16px}
.legend span{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;color:var(--ink-2)}
.legend span::before{content:"";width:11px;height:11px;border-radius:3px;background:var(--sw)}
.legend .l-blocked::before{--sw:var(--blocked)}
.legend .l-challenged::before{--sw:var(--challenged)}
.legend .l-allowed::before{--sw:var(--allowed)}
.table-scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:10px;background:var(--surface)}
table{width:100%;border-collapse:collapse;min-width:740px}
thead th{text-align:left;font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);padding:14px 16px;border-bottom:1px solid var(--rule-strong);white-space:nowrap}
thead th.r{text-align:right}
tbody td{padding:13px 16px;border-bottom:1px solid var(--rule);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
td.scenario-name{font-weight:500;white-space:nowrap}
td.n{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.bar{display:flex;gap:2px;height:16px;min-width:130px}
.bar span{display:block;border-radius:1px}
.bar span:first-child{border-radius:4px 1px 1px 4px}
.bar span:last-child{border-radius:1px 4px 4px 1px}
.bar span:only-child{border-radius:4px}
.seg-blocked{background:var(--blocked)}
.seg-challenged{background:var(--challenged)}
.seg-allowed{background:var(--allowed)}
.outcome{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;white-space:nowrap;color:var(--ink-2)}
.outcome::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--dot);flex:none}
.outcome[data-o="critical"]{--dot:var(--allowed);color:var(--ink);font-weight:500}
.outcome[data-o="high"]{--dot:var(--sev-high);color:var(--ink);font-weight:500}
.outcome[data-o="caveat"]{--dot:var(--challenged)}
.outcome[data-o="unknown"]{--dot:var(--sev-unknown)}
.outcome[data-o="ok"]{--dot:var(--blocked)}
.footnote{margin-top:14px;font-size:13.5px;color:var(--ink-3);max-width:80ch}
.reasons{display:flex;flex-direction:column;gap:8px}
.reason{display:grid;grid-template-columns:minmax(180px,240px) 1fr 52px;gap:14px;align-items:center}
.reason .code{font-size:13px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis}
.reason .track{height:9px;background:var(--surface-sunk);border-radius:5px;overflow:hidden}
.reason .fill{display:block;height:100%;background:var(--accent);border-radius:5px}
.reason .count{font-size:13px;text-align:right;color:var(--ink-3)}
.limits{display:flex;flex-direction:column;gap:15px;max-width:84ch}
.limit{display:grid;grid-template-columns:22px 1fr;gap:14px;align-items:start;font-size:15px;color:var(--ink-2);line-height:1.55}
.limit .mark{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink-3);padding-top:3px}
.limit strong{color:var(--ink);font-weight:600}
footer{margin-top:56px;padding-top:24px;border-top:1px solid var(--rule);font-size:13.5px;color:var(--ink-3);display:flex;flex-wrap:wrap;gap:8px 24px}
@page{size:A4;margin:14mm 12mm 16mm}
@media print{
:root{--ground:#fff;--surface:#fff;--surface-sunk:#f4f6f6;--rule:#d5dcdc;--rule-strong:#b3bebe;--ink:#0d1518;--ink-2:#35454a;--ink-3:#5b6a6f;--accent:#0d5057;--accent-soft:#eef4f4;--shadow:none}
body{background:#fff;font-size:10.5pt;line-height:1.5;padding:0}
.wrap{max-width:none}
.bar span,.tile.is-alarm .value,.chip::before,.outcome::before,.legend span::before,.finding::before,.banner,.evidence,.meta,.meta div,.tile,.finding,.closing,.table-scroll,thead th,.reason .track,.reason .fill{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.finding,.tile,.limit,.banner,.evidence,tr,.reason{break-inside:avoid;page-break-inside:avoid}
h1,h2,h3,.sec-head{break-after:avoid;page-break-after:avoid}
header.masthead{padding-top:0}
h1{font-size:30pt}h2{font-size:16pt}h3{font-size:12pt}
.standfirst{font-size:11.5pt}
section{margin-top:24pt}
.tile .value{font-size:24pt}
.table-scroll{overflow:visible}
table{min-width:0}
thead{display:table-header-group}
tbody td,thead th{padding:6pt 8pt}
.bar{height:11px;min-width:80px}
a{text-decoration:none}
}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important}}
@media (max-width:640px){body{padding:0 16px 64px}header.masthead{padding-top:44px}.reason{grid-template-columns:1fr 44px}.reason .track{display:none}}
`;
