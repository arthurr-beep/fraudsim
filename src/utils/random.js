/**
 * Internal random data utilities.
 *
 * fraud-sim deliberately does not depend on a faker library. We need a handful
 * of synthetic data generators and the simpler the dependency graph, the safer
 * the library is to adopt. This module provides everything we use.
 *
 * If you need richer fake data in your own scenarios (real-looking names,
 * locale-specific data, etc.), import @faker-js/faker in your scenario file —
 * it is not bundled with fraud-sim, but you can use it freely alongside it.
 *
 * Every helper here is built on exactly three primitives — `randomInt`,
 * `pickOne` and `alphanumeric` — and all three draw from the run-scoped source
 * in `random-source.js`. Seed a run and every value below replays identically.
 * A helper that reaches for `Math.random()` directly would silently opt itself
 * out of that, so none of them do.
 */

import { randomFloat } from './random-source.js';

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const NIGERIAN_BANKS = [
  'GTBank',
  'UBA',
  'Access',
  'Zenith',
  'First Bank',
  'FCMB',
  'Sterling',
  'Stanbic IBTC',
  'Fidelity',
  'Wema',
];

const FIRST_NAMES = [
  'Adaeze', 'Chinedu', 'Folake', 'Tunde', 'Aisha', 'Emeka', 'Nkechi', 'Bayo',
  'Ngozi', 'Olumide', 'Funmi', 'Kayode', 'Hauwa', 'Ifeanyi', 'Toyin', 'Segun',
  'James', 'Mary', 'David', 'Sarah', 'Michael', 'Grace', 'John', 'Esther',
];

const LAST_NAMES = [
  'Adeyemi', 'Okonkwo', 'Ibrahim', 'Nwosu', 'Bello', 'Eze', 'Yusuf', 'Okoye',
  'Lawal', 'Obi', 'Musa', 'Achebe', 'Akin', 'Adamu', 'Ojo', 'Chukwu',
  'Smith', 'Brown', 'Williams', 'Johnson',
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'curl/8.4.0',
  'python-requests/2.31.0',
];

/**
 * Random integer in [min, max] inclusive.
 */
export function randomInt(min, max) {
  return Math.floor(randomFloat() * (max - min + 1)) + min;
}

/**
 * Pick one element from an array.
 */
export function pickOne(arr) {
  return arr[Math.floor(randomFloat() * arr.length)];
}

/**
 * Generate a random alphanumeric string of the given length.
 */
export function alphanumeric(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHANUM.charAt(Math.floor(randomFloat() * ALPHANUM.length));
  }
  return out;
}

/**
 * IPv4 ranges that are reserved, private, or otherwise never routed on the
 * public internet. A generator that emits these produces addresses that no
 * IP-intelligence provider can resolve — which silently disables every
 * geo/reputation rule on the target being tested. We skip them.
 *
 * @param {number} a - first octet
 * @param {number} b - second octet
 * @returns {boolean}
 */
function isReservedIpv4(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;      // this-network, private, loopback
  if (a >= 224) return true;                               // multicast + reserved + broadcast
  if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT   100.64.0.0/10
  if (a === 169 && b === 254) return true;                 // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;        // private 172.16.0.0/12
  if (a === 192 && b === 168) return true;                 // private
  if (a === 192 && b === 0) return true;                   // 192.0.0.0/24 + TEST-NET-1
  if (a === 192 && b === 88) return true;                  // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true;     // benchmarking
  if (a === 198 && b === 51) return true;                  // TEST-NET-2
  if (a === 203 && b === 0) return true;                   // TEST-NET-3
  return false;
}

/**
 * Generate a synthetic but *publicly routable* IPv4 address.
 *
 * Deliberately excludes private, loopback, CGNAT, link-local, multicast and
 * documentation ranges. Addresses from those blocks cannot be resolved by any
 * geo/reputation provider, so a target that scores them will fall back to
 * neutral intel and never fire its proxy, abuse-score, or geo rules — making a
 * defence look weaker than it is.
 *
 * These addresses are used only as payload field values. `fraud-sim` never
 * connects to them.
 *
 * For a stable, pre-seedable set with known geolocation, use
 * {@link DEMO_IP_POOL} / {@link pickDemoIp} instead.
 */
export function randomIp() {
  let a, b;
  do {
    a = randomInt(1, 223);
    b = randomInt(0, 255);
  } while (isReservedIpv4(a, b));
  return `${a}.${b}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

/**
 * A fixed pool of attacker IPs with known, declared geolocation and
 * reputation metadata.
 *
 * Why this exists: most fraud systems resolve IP intelligence *asynchronously*
 * and fall back to neutral values on a cache miss. In a short simulation every
 * IP is seen for the first time, so geo and reputation rules never fire and the
 * run under-reports what the defence can actually catch. Because this pool is
 * fixed and its metadata is declared here, the system under test can pre-warm
 * its IP-intel cache from `DEMO_IP_POOL` before a run — no live lookups, no
 * third-party rate limits, and reproducible results.
 *
 * Addresses are drawn from the RFC 5737 documentation ranges (192.0.2.0/24,
 * 198.51.100.0/24, 203.0.113.0/24). They are reserved for documentation, are
 * never routed, and belong to no real network — so attack traffic in a
 * simulation is never attributed to a real operator. The geolocation and
 * reputation fields are synthetic labels chosen to exercise distinct rule
 * paths, not claims about these addresses.
 *
 * Personas covered:
 *   - `domestic` residential  → the victim's home country; the quiet baseline
 *   - `hosting`               → datacenter ranges; should fire hosting rules
 *   - `proxy`                 → VPN/proxy exits; should fire proxy rules
 *   - `foreign` residential   → new-country and impossible-travel paths
 *
 * @type {ReadonlyArray<{ip: string, countryCode: string, country: string,
 *   lat: number, lon: number, proxy: boolean, hosting: boolean,
 *   abuseScore: number, isp: string, persona: string}>}
 */
export const DEMO_IP_POOL = Object.freeze([
  // ── Domestic residential — the baseline a victim would normally log in from
  f('192.0.2.10', 'NG', 'Nigeria', 6.5244, 3.3792, false, false, 0, 'Simulated Residential ISP (Lagos)', 'domestic'),
  f('192.0.2.11', 'NG', 'Nigeria', 9.0765, 7.3986, false, false, 0, 'Simulated Residential ISP (Abuja)', 'domestic'),
  f('192.0.2.12', 'NG', 'Nigeria', 4.8156, 7.0498, false, false, 2, 'Simulated Mobile Carrier (Port Harcourt)', 'domestic'),

  // ── Datacenter / hosting — bot traffic rarely comes from a living room
  f('198.51.100.20', 'NL', 'Netherlands', 52.3676, 4.9041, false, true, 78, 'Simulated Cloud Hosting (Amsterdam)', 'hosting'),
  f('198.51.100.21', 'DE', 'Germany', 50.1109, 8.6821, false, true, 84, 'Simulated Cloud Hosting (Frankfurt)', 'hosting'),
  f('198.51.100.22', 'US', 'United States', 39.0438, -77.4874, false, true, 91, 'Simulated Cloud Hosting (Ashburn)', 'hosting'),
  f('198.51.100.23', 'SG', 'Singapore', 1.3521, 103.8198, false, true, 66, 'Simulated Cloud Hosting (Singapore)', 'hosting'),

  // ── Proxy / VPN exits — the usual answer to a blocked datacenter range
  f('203.0.113.30', 'RU', 'Russia', 55.7558, 37.6173, true, false, 72, 'Simulated VPN Exit (Moscow)', 'proxy'),
  f('203.0.113.31', 'UA', 'Ukraine', 50.4501, 30.5234, true, false, 58, 'Simulated VPN Exit (Kyiv)', 'proxy'),
  f('203.0.113.32', 'CN', 'China', 22.5431, 114.0579, true, false, 69, 'Simulated Proxy Exit (Shenzhen)', 'proxy'),

  // ── Foreign residential — new country + impossible travel, low reputation signal
  f('203.0.113.40', 'BR', 'Brazil', -23.5505, -46.6333, false, false, 12, 'Simulated Residential ISP (Sao Paulo)', 'foreign'),
  f('203.0.113.41', 'IN', 'India', 19.076, 72.8777, false, false, 8, 'Simulated Residential ISP (Mumbai)', 'foreign'),
]);

/** Compact constructor for DEMO_IP_POOL rows — keeps the table above readable. */
function f(ip, countryCode, country, lat, lon, proxy, hosting, abuseScore, isp, persona) {
  return Object.freeze({ ip, countryCode, country, lat, lon, proxy, hosting, abuseScore, isp, persona });
}

/**
 * Pick an entry from {@link DEMO_IP_POOL}, optionally filtered by persona.
 *
 * @param {'any'|'domestic'|'hosting'|'proxy'|'foreign'} [persona='any']
 * @returns {(typeof DEMO_IP_POOL)[number]}
 */
export function pickDemoIp(persona = 'any') {
  if (persona === 'any') return pickOne(DEMO_IP_POOL);
  const matches = DEMO_IP_POOL.filter((entry) => entry.persona === persona);
  if (matches.length === 0) {
    throw new Error(
      `Unknown IP persona: "${persona}". Expected one of: any, domestic, hosting, proxy, foreign.`
    );
  }
  return pickOne(matches);
}

/**
 * Publicly documented test BIN prefixes.
 *
 * These are the card prefixes every payment processor publishes for sandbox
 * use. `fraud-sim` deliberately does NOT generate Luhn-valid card numbers and
 * never emits a full PAN — a fraud API receives a token, a BIN, and the last
 * four digits, so that is all a scenario produces. Anything more would make the
 * library useful for something other than testing your own defences.
 */
const TEST_CARD_BINS = [
  '411111', // Visa
  '400000', // Visa
  '555555', // Mastercard
  '510510', // Mastercard
  '601111', // Discover
  '371449', // Amex
];

/** Pick one of the published test BINs. */
export function randomCardBin() {
  return pickOne(TEST_CARD_BINS);
}

/** All test BINs, for scenarios that need to walk a BIN range deliberately. */
export function cardBins() {
  return [...TEST_CARD_BINS];
}

/** Four synthetic trailing digits. Not derived from any real card. */
export function randomLast4() {
  let out = '';
  for (let i = 0; i < 4; i++) out += randomInt(0, 9).toString();
  return out;
}

/** An opaque card token, the way a processor would hand one to a risk API. */
export function newCardToken() {
  return `tok_sim_${alphanumeric(24)}`;
}

/**
 * Generate an IP inside the same /24 as `ip`.
 *
 * Promo-abuse and other single-actor attacks look like many users, but the
 * addresses cluster. Subnet clustering is usually the signal that catches them.
 */
export function ipInSameSubnet(ip) {
  const octets = String(ip).split('.');
  if (octets.length !== 4) {
    throw new Error(`ipInSameSubnet: "${ip}" is not a dotted-quad IPv4 address`);
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.${randomInt(1, 254)}`;
}

/** A plausible synthetic phone number in Nigerian mobile format. */
export function randomPhoneNumber() {
  const prefixes = ['0803', '0806', '0703', '0705', '0813', '0816', '0906', '0913'];
  let rest = '';
  for (let i = 0; i < 7; i++) rest += randomInt(0, 9).toString();
  return `${pickOne(prefixes)}${rest}`;
}

/**
 * Pick a realistic user agent string.
 */
export function randomUserAgent() {
  return pickOne(USER_AGENTS);
}

/**
 * Generate a synthetic Nigerian-style account number (10 digits).
 */
export function randomAccountNumber() {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += randomInt(0, 9).toString();
  }
  return out;
}

/**
 * Pick a Nigerian bank name.
 */
export function randomBank() {
  return pickOne(NIGERIAN_BANKS);
}

/**
 * Generate a random full name.
 */
export function randomFullName() {
  return `${pickOne(FIRST_NAMES)} ${pickOne(LAST_NAMES)}`;
}

/**
 * A float in [0, 1) from the run's random source.
 *
 * Custom scenarios should use this rather than `Math.random()` — anything that
 * bypasses it will not replay when the run is seeded.
 */
export { randomFloat } from './random-source.js';
