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
 */

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
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pick one element from an array.
 */
export function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a random alphanumeric string of the given length.
 */
export function alphanumeric(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHANUM.charAt(Math.floor(Math.random() * ALPHANUM.length));
  }
  return out;
}

/**
 * Generate a synthetic IPv4 address.
 * Not from any real range — purely synthetic for testing.
 */
export function randomIp() {
  return `${randomInt(1, 254)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;
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
