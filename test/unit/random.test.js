import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomIp, pickDemoIp, DEMO_IP_POOL, demoIpPool } from '../../src/utils/random.js';
import { localeIds, resolveLocale } from '../../src/locales/index.js';

/**
 * Mirrors the reserved-range table in random.js. Kept as an independent
 * implementation so a mistake in the source doesn't silently pass the test.
 */
function isReserved(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 88 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}

test('randomIp never emits reserved or unroutable addresses', () => {
  // Reserved addresses resolve to nothing at every IP-intel provider, which
  // silently disables the target's geo and reputation rules.
  const offenders = [];
  for (let i = 0; i < 20000; i++) {
    const ip = randomIp();
    if (isReserved(ip)) offenders.push(ip);
  }
  assert.deepEqual(offenders.slice(0, 5), [], `emitted reserved IPs, e.g. ${offenders[0]}`);
});

test('randomIp emits well-formed IPv4 with a non-zero final octet', () => {
  for (let i = 0; i < 500; i++) {
    const octets = randomIp().split('.').map(Number);
    assert.equal(octets.length, 4);
    for (const o of octets) {
      assert.ok(Number.isInteger(o) && o >= 0 && o <= 255, `bad octet in ${octets.join('.')}`);
    }
    assert.notEqual(octets[3], 0);
    assert.notEqual(octets[3], 255);
  }
});

test('DEMO_IP_POOL uses only RFC 5737 documentation ranges', () => {
  // These blocks are reserved for documentation and are never routed, so a
  // simulation never attributes attack traffic to a real network operator.
  const allowed = ['192.0.2.', '198.51.100.', '203.0.113.'];
  for (const entry of DEMO_IP_POOL) {
    assert.ok(
      allowed.some((prefix) => entry.ip.startsWith(prefix)),
      `${entry.ip} is outside the documentation ranges`
    );
  }
});

test('DEMO_IP_POOL entries carry the fields a target needs to pre-seed intel', () => {
  for (const entry of DEMO_IP_POOL) {
    for (const field of ['ip', 'countryCode', 'country', 'lat', 'lon', 'isp', 'persona']) {
      assert.ok(entry[field] != null, `${entry.ip} is missing ${field}`);
    }
    assert.equal(typeof entry.proxy, 'boolean');
    assert.equal(typeof entry.hosting, 'boolean');
    assert.ok(entry.abuseScore >= 0 && entry.abuseScore <= 100);
    assert.ok(entry.lat >= -90 && entry.lat <= 90);
    assert.ok(entry.lon >= -180 && entry.lon <= 180);
  }
});

test('DEMO_IP_POOL covers every persona and has no duplicate addresses', () => {
  const personas = new Set(DEMO_IP_POOL.map((e) => e.persona));
  for (const expected of ['domestic', 'hosting', 'proxy', 'foreign']) {
    assert.ok(personas.has(expected), `no pool entry with persona "${expected}"`);
  }

  const ips = DEMO_IP_POOL.map((e) => e.ip);
  assert.equal(new Set(ips).size, ips.length, 'duplicate IP in pool');
});

test('foreign pool entries are far enough to exercise impossible-travel rules', () => {
  // Only the `foreign` persona earns its place through distance. A `hosting`
  // entry earns its place by being a datacenter — and in a US-market run a US
  // datacenter is both legitimately close and legitimately suspicious, so
  // requiring distance of it would be asserting the wrong property.
  const domestic = DEMO_IP_POOL.find((e) => e.persona === 'domestic');
  const foreign = DEMO_IP_POOL.filter((e) => e.persona === 'foreign');

  const km = (a, b) => {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((a.lat * Math.PI) / 180) *
        Math.cos((b.lat * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  for (const entry of foreign) {
    assert.ok(km(domestic, entry) > 500, `${entry.ip} is only ${km(domestic, entry)}km away`);
  }
});

test('pickDemoIp filters by persona', () => {
  for (const persona of ['domestic', 'hosting', 'proxy', 'foreign']) {
    for (let i = 0; i < 40; i++) {
      assert.equal(pickDemoIp(persona).persona, persona);
    }
  }
});

test('pickDemoIp with no argument draws from the whole pool', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(pickDemoIp().ip);
  assert.ok(seen.size > 1, 'expected more than one distinct IP');
});

test('pickDemoIp rejects an unknown persona instead of silently returning nothing', () => {
  assert.throws(() => pickDemoIp('datacentre'), /Unknown IP persona/);
});

test('hosting and proxy entries carry the flags that make them suspicious', () => {
  // These are the ones whose value is reputation rather than geography.
  for (const entry of DEMO_IP_POOL.filter((e) => e.persona === 'hosting')) {
    assert.equal(entry.hosting, true, `${entry.ip} is labelled hosting but not flagged`);
  }
  for (const entry of DEMO_IP_POOL.filter((e) => e.persona === 'proxy')) {
    assert.equal(entry.proxy, true, `${entry.ip} is labelled proxy but not flagged`);
  }
});

test('the pool follows the market, so "domestic" means the right country', () => {
  // Lagos is the quiet baseline for a Nigerian bank and a new-country signal
  // for a British one. A fixed pool would mean opposite things per market.
  for (const id of localeIds()) {
    const pool = demoIpPool(resolveLocale(id));
    const domestic = pool.filter((e) => e.persona === 'domestic');

    assert.ok(domestic.length > 0, `${id} has no domestic entries`);
    for (const entry of domestic) {
      assert.equal(entry.countryCode, id, `${id} pool has a domestic entry in ${entry.countryCode}`);
    }
  }
});
