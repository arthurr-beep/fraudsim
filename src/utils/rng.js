/**
 * Seeded pseudo-random number generator.
 *
 * Backs both seeded runs (installed as the run's random source by the runner —
 * see `random-source.js`) and the deterministic LLM provider, which needs the
 * same seed to produce the same strategy for the same history.
 *
 * Algorithm is mulberry32 — small, fast, and good enough for synthetic data.
 * It is NOT cryptographically secure and must never be used for anything that
 * needs real randomness.
 */

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export class DeterministicRng {
  /**
   * @param {number} [seed] - Any integer. The same seed always replays the same sequence.
   */
  constructor(seed = 1) {
    // Coerce to a 32-bit integer so string/float seeds don't silently misbehave.
    this.state = Math.trunc(seed) >>> 0;
  }

  /**
   * Next float in [0, 1).
   * @returns {number}
   */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Integer in [min, max] inclusive.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Pick one element from an array.
   * @param {Array} arr
   * @returns {*}
   */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /**
   * Random alphanumeric string of the given length.
   * @param {number} length
   * @returns {string}
   */
  alphanumeric(length) {
    let out = '';
    for (let i = 0; i < length; i++) {
      out += ALPHANUM.charAt(Math.floor(this.next() * ALPHANUM.length));
    }
    return out;
  }

  /**
   * Synthetic IPv4 address.
   * @returns {string}
   */
  ip() {
    return `${this.int(1, 254)}.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
}
