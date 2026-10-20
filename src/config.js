// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export const DEFAULT_CONFIG = {
  url: '',
  username: '',
  password: '',
  paths: '',
  rooms: '',
  exclude_states: '',
  allow_security_commands: false,
  sensor_interval: 10,
  watched_states: '',
  language: 'fr',
};

// The rest-api adapter listens on 8093 by default: an address typed without a port gets it.
export const DEFAULT_PORT = 8093;

/**
 * Turn what the user typed into the base URL of the rest-api adapter (no
 * trailing slash, without `/v1`): `192.0.2.10`, `192.0.2.10:8093`,
 * `http://iob.example:8093`, `https://iob.example/rest-api` (the web
 * extension) or `http://192.0.2.10:8093/v1`. Returns null when it is not usable.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (text === '') {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '') {
    return null;
  }
  if (url.username || url.password) {
    // Credentials in the URL would end up in logs and error messages.
    return null;
  }
  if (!hasScheme && url.port === '') {
    url.port = String(DEFAULT_PORT);
  }
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(v1|api-doc)$/, '')
    .replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * "a, b\nc d" -> ['a', 'b', 'c d'], without blanks or duplicates. Commas,
 * semicolons and new lines separate: a room name or an ioBroker id may hold a space.
 */
export function splitList(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(/[,;\n\r]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * A state id pattern: `0_userdata.0.lamp`, `hm-rpc.0.*`, `*.LOWBAT`. ioBroker
 * ids are case-sensitive, the patterns are not: a user rarely remembers the case.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** @param {string[]} patterns */
export function matcher(patterns) {
  const regexps = patterns.map(patternToRegExp);
  return (name) => regexps.some((re) => re.test(name));
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const typed = typeof source.url === 'string' ? source.url.trim() : '';
  const url = normalizeUrl(typed);
  const interval = Number(source.sensor_interval);
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  return {
    url,
    // An address was typed but cannot be used: said in the connection status.
    invalidUrl: typed !== '' && url === null,
    username: text('username'),
    // A password may start or end with a space: kept as typed.
    password: typeof source.password === 'string' ? source.password : '',
    // Patterns sent to ioBroker as they are: `*` when empty.
    paths: splitList(source.paths).filter((p) => /^[^"'`\\[\]?]+$/.test(p)),
    rooms: splitList(source.rooms).map((r) => r.toLowerCase()),
    exclude: splitList(source.exclude_states),
    allowSecurity: source.allow_security_commands === true,
    sensorInterval: Number.isFinite(interval)
      ? Math.min(3600, Math.max(0, Math.round(interval)))
      : DEFAULT_CONFIG.sensor_interval,
    watched: splitList(source.watched_states),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
