/**
 * Locale packs — the market a simulation pretends to be in.
 *
 * A fraud system is fed by data that looks like its market: account numbers of
 * the right length, banks that exist, phone numbers in the right format, amounts
 * in the right currency. Sending Nigerian-shaped payloads at a US processor
 * produces validation errors, not fraud decisions — and a run full of 400s
 * measures nothing.
 *
 * So the market is a parameter. `run()` and `runSuite()` take a `locale`, and
 * every generator draws from it — the same way `seed` works, and scoped the same
 * way, so no builder needs an extra argument threaded through it.
 *
 * ── What a pack is not ────────────────────────────────────────────────
 * It is not a claim about a country. The banks and names here are a small,
 * plausible sample chosen so generated payloads pass format validation; they are
 * not a directory, and no real customer, account or number is represented. Every
 * value is synthetic.
 *
 * @example
 *   await run('account-drain', { target, locale: 'US', options: { ... } });
 *
 * Adding a market is a pull request against this file: fill the same fields,
 * keeping the data synthetic and the formats real.
 */

/**
 * @typedef {object} Locale
 * @property {string} id - ISO 3166-1 alpha-2 country code.
 * @property {string} name
 * @property {string} currency - ISO 4217 code.
 * @property {number} minorUnits - Minor units per major unit (100 for most).
 * @property {string[]} banks
 * @property {string[]} firstNames
 * @property {string[]} lastNames
 * @property {() => string} accountNumber - Market-shaped account identifier.
 * @property {() => string} phoneNumber - Market-shaped subscriber number.
 * @property {Array<{city: string, lat: number, lon: number}>} cities - Domestic
 *   locations for the IP pool's "this looks like home" entries.
 */

/** Digits helper shared by the packs; takes the run's RNG so output stays seeded. */
const digits = (rand, n) => {
  let out = '';
  for (let i = 0; i < n; i++) out += Math.floor(rand() * 10).toString();
  return out;
};

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

export const LOCALES = {
  NG: {
    id: 'NG',
    name: 'Nigeria',
    currency: 'NGN',
    minorUnits: 100,
    banks: [
      'GTBank', 'UBA', 'Access', 'Zenith', 'First Bank',
      'FCMB', 'Sterling', 'Stanbic IBTC', 'Fidelity', 'Wema',
    ],
    firstNames: [
      'Adaeze', 'Chinedu', 'Folake', 'Tunde', 'Aisha', 'Emeka', 'Nkechi',
      'Bayo', 'Ngozi', 'Olumide', 'Funmi', 'Kayode', 'Hauwa', 'Ifeanyi',
    ],
    lastNames: [
      'Adeyemi', 'Okonkwo', 'Ibrahim', 'Nwosu', 'Bello', 'Eze', 'Yusuf',
      'Okoye', 'Lawal', 'Obi', 'Musa', 'Achebe', 'Adamu', 'Chukwu',
    ],
    // NUBAN: 10 digits.
    accountNumber: (rand) => digits(rand, 10),
    phoneNumber: (rand) =>
      pick(rand, ['0803', '0806', '0703', '0705', '0813', '0816', '0906', '0913']) +
      digits(rand, 7),
    cities: [
      { city: 'Lagos', lat: 6.5244, lon: 3.3792 },
      { city: 'Abuja', lat: 9.0765, lon: 7.3986 },
      { city: 'Port Harcourt', lat: 4.8156, lon: 7.0498 },
    ],
  },

  US: {
    id: 'US',
    name: 'United States',
    currency: 'USD',
    minorUnits: 100,
    banks: [
      'Chase', 'Bank of America', 'Wells Fargo', 'Citibank', 'US Bank',
      'PNC', 'Truist', 'Capital One', 'TD Bank', 'Fifth Third',
    ],
    firstNames: [
      'James', 'Mary', 'Robert', 'Patricia', 'Michael', 'Jennifer', 'David',
      'Linda', 'William', 'Elizabeth', 'Maria', 'Jose', 'Aisha', 'Wei',
    ],
    lastNames: [
      'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
      'Davis', 'Rodriguez', 'Martinez', 'Nguyen', 'Kim', 'Patel', 'Cohen',
    ],
    // ACH account numbers vary; 8-12 digits is the common range.
    accountNumber: (rand) => digits(rand, 8 + Math.floor(rand() * 5)),
    // NANP, avoiding reserved 555 exchange codes being the only option.
    phoneNumber: (rand) =>
      `+1${pick(rand, ['212', '312', '415', '469', '512', '646', '702', '917'])}${digits(rand, 7)}`,
    cities: [
      { city: 'New York', lat: 40.7128, lon: -74.006 },
      { city: 'Chicago', lat: 41.8781, lon: -87.6298 },
      { city: 'Austin', lat: 30.2672, lon: -97.7431 },
    ],
  },

  GB: {
    id: 'GB',
    name: 'United Kingdom',
    currency: 'GBP',
    minorUnits: 100,
    banks: [
      'Barclays', 'HSBC', 'Lloyds', 'NatWest', 'Santander UK',
      'Halifax', 'Nationwide', 'Monzo', 'Starling', 'TSB',
    ],
    firstNames: [
      'Oliver', 'Amelia', 'Harry', 'Isla', 'George', 'Ava', 'Noah',
      'Freya', 'Priya', 'Mohammed', 'Sophie', 'Jack', 'Chloe', 'Adam',
    ],
    lastNames: [
      'Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Davies',
      'Patel', 'Evans', 'Thomas', 'Khan', 'Roberts', 'Walker', 'Wright',
    ],
    // UK account numbers are 8 digits (sort code is separate).
    accountNumber: (rand) => digits(rand, 8),
    phoneNumber: (rand) => `+447${digits(rand, 9)}`,
    cities: [
      { city: 'London', lat: 51.5072, lon: -0.1276 },
      { city: 'Manchester', lat: 53.4808, lon: -2.2426 },
      { city: 'Edinburgh', lat: 55.9533, lon: -3.1883 },
    ],
  },

  KE: {
    id: 'KE',
    name: 'Kenya',
    currency: 'KES',
    minorUnits: 100,
    banks: [
      'Equity Bank', 'KCB', 'Co-operative Bank', 'Absa Kenya', 'Standard Chartered',
      'NCBA', 'DTB', 'Stanbic Kenya', 'I&M Bank', 'Family Bank',
    ],
    firstNames: [
      'Wanjiku', 'Otieno', 'Achieng', 'Kamau', 'Njeri', 'Mwangi', 'Akinyi',
      'Kipchoge', 'Wafula', 'Chebet', 'Omondi', 'Nyambura', 'Barasa', 'Amina',
    ],
    lastNames: [
      'Kariuki', 'Ochieng', 'Mutiso', 'Wanjala', 'Kimani', 'Odhiambo',
      'Njoroge', 'Mutua', 'Cheruiyot', 'Maina', 'Owino', 'Githinji',
    ],
    accountNumber: (rand) => digits(rand, 12),
    phoneNumber: (rand) => `+2547${digits(rand, 8)}`,
    cities: [
      { city: 'Nairobi', lat: -1.2864, lon: 36.8172 },
      { city: 'Mombasa', lat: -4.0435, lon: 39.6682 },
      { city: 'Kisumu', lat: -0.0917, lon: 34.768 },
    ],
  },
};

/** The market used when a run does not name one. */
export const DEFAULT_LOCALE = 'US';

/**
 * Resolve a locale id to its pack.
 *
 * Unknown ids throw rather than falling back: silently generating US-shaped
 * data for a run that asked for `DE` would produce a result that looks valid
 * and measures the wrong market.
 *
 * @param {string|Locale} [id]
 * @returns {Locale}
 */
export function resolveLocale(id = DEFAULT_LOCALE) {
  if (id && typeof id === 'object') return id;

  const pack = LOCALES[String(id).toUpperCase()];
  if (!pack) {
    throw new Error(
      `Unknown locale: "${id}". Available: ${Object.keys(LOCALES).join(', ')}. ` +
        'Pass a locale object to use a market that is not bundled.'
    );
  }
  return pack;
}

/** Ids of the bundled packs. */
export function localeIds() {
  return Object.keys(LOCALES);
}
