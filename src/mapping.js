// -----------------------------------------------------------------------------
// One ioBroker state -> Gladys features (pure).
//
// A state object is what GET /v1/objects returns: `_id`, `common` (`name`,
// `type` boolean/number/string, `role`, `unit`, `min`, `max`, `read`,
// `write`), `enums`. `mapState` returns its features, each
//   role      part of the feature external id: never change it,
//   main      the feature is the state itself (named after it),
//   spec      category, type, unit, min, max, read_only, has_feedback,
//   read      (val) -> number | null (null: nothing to publish),
//   write     (value) -> { id, val }: the command sent to ioBroker,
//   throttle  a measurement, spaced by the sensor interval,
// or `{ skipped: reason }` when nothing maps it.
//
// The features come from the ioBroker ROLE of the state (STATE_ROLES of the
// ioBroker documentation, as @iobroker/type-detector reads them), then from
// its unit for the generic roles (`value`, `level`, `state`). A state is
// written only when its object says `write: true`. Value conventions:
// ioBroker `sensor.window`/`sensor.door` are true when OPEN, a Gladys opening
// sensor is 0 when OPEN; ioBroker `switch.lock` is true when UNLOCKED, a
// Gladys lock is 1 when LOCKED; `level.blind` is max when open, like the
// Gladys shutter position.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';

// Value enums of the Gladys core (server/utils/constants.js: the SDK does not export them).
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const LOCK_STATE = { UNLOCK: 0, LOCK: 1 };

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const BIG = 1e9;

/** The error thrown for a refused write, keyed in src/texts.js ERRORS. */
export class WriteError extends Error {
  constructor(key) {
    super(key);
    this.name = 'WriteError';
    this.key = key;
  }
}

// --- Object helpers ---------------------------------------------------------------

export const roleOf = (obj) =>
  String(obj?.common?.role ?? '')
    .trim()
    .toLowerCase();

/** Writable only when the object says so: `write` defaults to true in ioBroker, not here. */
export const isWritable = (obj) => obj?.common?.write === true;

/** A translated ioBroker text ({ en, de, fr… } or a string) in one language. */
export function pickText(text, language = 'en') {
  if (typeof text === 'string') {
    return text.trim();
  }
  if (text && typeof text === 'object') {
    const value =
      text[language] ?? text.en ?? Object.values(text).find((v) => typeof v === 'string');
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

/** The last part of an id: `hm-rpc.0.ABC.1.STATE` -> `STATE`. */
export const lastPart = (id) =>
  String(id ?? '')
    .split('.')
    .pop();

/** Units made comparable: NFKC turns "㎥" into "m3" and "℃" into "°C"; "μ" is "µ". */
export const normalizeUnit = (unit) =>
  String(unit ?? '')
    .normalize('NFKC')
    .replace(/μ/g, 'µ')
    .replace(/³/g, '3')
    .trim();

/** A value of ioBroker as a number: true/false, "21.5" and "21,5" too. */
export function toNumber(val) {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A value of ioBroker as a boolean: true/false, 1/0, "true"/"on". */
export function toBoolean(val) {
  if (typeof val === 'boolean') {
    return val;
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val !== 0 : null;
  }
  if (typeof val === 'string') {
    const text = val.trim().toLowerCase();
    if (['true', 'on', '1'].includes(text)) {
      return true;
    }
    if (['false', 'off', '0'].includes(text)) {
      return false;
    }
  }
  return null;
}

/** "#FF8000" or "FF8000" -> 0xFF8000. */
export function parseRgb(val) {
  const match =
    typeof val === 'string' ? val.trim().match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i) : null;
  return match ? parseInt(match[1], 16) : null;
}

export const toRgb = (n) =>
  `#${clamp(Math.round(Number(n) || 0), 0, 0xffffff)
    .toString(16)
    .padStart(6, '0')}`;

// --- Units and sensors ------------------------------------------------------------

/** ioBroker unit (normalized) -> Gladys unit. */
export const UNITS = {
  '°C': U.CELSIUS,
  '°F': U.FAHRENHEIT,
  K: U.KELVIN,
  '%': U.PERCENT,
  hPa: U.HECTO_PASCAL,
  mbar: U.MILLIBAR,
  Pa: U.PASCAL,
  kPa: U.KILO_PASCAL,
  bar: U.BAR,
  psi: U.PSI,
  lx: U.LUX,
  lux: U.LUX,
  ppm: U.PPM,
  ppb: U.PPB,
  W: U.WATT,
  kW: U.KILOWATT,
  Wh: U.WATT_HOUR,
  kWh: U.KILOWATT_HOUR,
  MWh: U.MEGAWATT_HOUR,
  V: U.VOLT,
  mV: U.MILLI_VOLT,
  A: U.AMPERE,
  mA: U.MILLI_AMPERE,
  m3: U.CUBIC_METER,
  l: U.LITER,
  L: U.LITER,
  'µg/m3': U.MICROGRAM_PER_CUBIC_METER,
  'm/s': U.METER_PER_SECOND,
  'km/h': U.KILOMETER_PER_HOUR,
  dB: U.DECIBEL,
  'mm/h': U.MILLIMETER_PER_HOUR,
};

const sensor = (category, type, min, max, round = false) => ({ category, type, min, max, round });

const TEMPERATURE_BOUNDS = { '°C': [-60, 150], '°F': [-76, 302], K: [0, 500] };

/** Measurements recognised by their unit alone (generic roles `value`, `level`…). */
const BY_UNIT = {
  '°C': sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, ...TEMPERATURE_BOUNDS['°C']),
  '°F': sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, ...TEMPERATURE_BOUNDS['°F']),
  K: sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, ...TEMPERATURE_BOUNDS.K),
  hPa: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  mbar: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  Pa: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  kPa: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  bar: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  psi: sensor(C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, 0, BIG),
  lx: sensor(C.LIGHT_SENSOR, T.SENSOR.DECIMAL, 0, 200_000),
  lux: sensor(C.LIGHT_SENSOR, T.SENSOR.DECIMAL, 0, 200_000),
  W: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, -BIG, BIG),
  kW: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, -BIG, BIG),
  Wh: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX, 0, 1e12),
  kWh: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX, 0, 1e12),
  MWh: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX, 0, 1e12),
  V: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, 0, 1_000_000),
  mV: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, 0, 1_000_000),
  A: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.CURRENT, -BIG, BIG),
  mA: sensor(C.ENERGY_SENSOR, T.ENERGY_SENSOR.CURRENT, -BIG, BIG),
  m3: sensor(C.VOLUME_SENSOR, T.VOLUME_SENSOR.DECIMAL, 0, 1e12),
  l: sensor(C.VOLUME_SENSOR, T.VOLUME_SENSOR.DECIMAL, 0, 1e12),
  L: sensor(C.VOLUME_SENSOR, T.VOLUME_SENSOR.DECIMAL, 0, 1e12),
  'm/s': sensor(C.SPEED_SENSOR, T.SPEED_SENSOR.DECIMAL, 0, 1000),
  'km/h': sensor(C.SPEED_SENSOR, T.SPEED_SENSOR.DECIMAL, 0, 1000),
  dB: sensor(C.NOISE_SENSOR, T.SENSOR.INTEGER, 0, 200, true),
  'mm/h': sensor(C.PRECIPITATION_SENSOR, T.PRECIPITATION_SENSOR.DECIMAL, 0, 10_000),
  ppm: sensor(C.CO2_SENSOR, T.SENSOR.DECIMAL, 0, 100_000),
  ppb: sensor(C.VOC_SENSOR, T.SENSOR.DECIMAL, 0, 100_000),
  'µg/m3': sensor(C.PM25_SENSOR, T.SENSOR.DECIMAL, 0, 10_000),
};

/**
 * Number roles of ioBroker -> the sensor they are, with the units accepted
 * (none listed: any unit, or none). First match wins.
 */
const NUMBER_ROLES = [
  [/^value\.temperature(\.|$)/, ['°C', '°F', 'K', ''], 'temperature'],
  [/^value\.humidity(\.|$)/, ['%', ''], sensor(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, 0, 100)],
  [/^value\.battery(\.|$)/, ['%', ''], sensor(C.BATTERY, T.BATTERY.INTEGER, 0, 100, true)],
  [/^value\.brightness(\.|$)/, ['lx', 'lux', ''], BY_UNIT.lx],
  [/^value\.pressure(\.|$)/, ['hPa', 'mbar', 'Pa', 'kPa', 'bar', 'psi'], 'unit'],
  [/^value\.(energy|power\.consumption)(\.|$)/, ['Wh', 'kWh', 'MWh'], 'unit'],
  [/^value\.power(\.|$)/, ['W', 'kW'], 'unit'],
  [/^value\.voltage(\.|$)/, ['V', 'mV'], 'unit'],
  [/^value\.current(\.|$)/, ['A', 'mA'], 'unit'],
  [/^value\.co2(\.|$)/, ['ppm', ''], sensor(C.CO2_SENSOR, T.SENSOR.DECIMAL, 0, 100_000)],
  [/^value\.speed\.wind(\.|$)/, ['km/h', 'm/s'], 'unit'],
  [/^value\.uv(\.|$)/, [''], sensor(C.UV_SENSOR, T.UV_SENSOR.INTEGER, 0, 20, true)],
];

/** Generic roles: only their unit says what they are. */
const GENERIC_NUMBER = /^(value|level|state|indicator)?$|^value\.[a-z]+$/;

/** Boolean detectors (read-only), by role. */
const DETECTORS = [
  [/^(sensor|state)\.(window|door|contact)$|^sensor\.(window|door)\./, 'opening'],
  [/^(sensor|state)\.motion$|^motion$/, C.MOTION_SENSOR, T.SENSOR.BINARY],
  [/^sensor\.presence$|^state\.presence$/, C.PRESENCE_SENSOR, T.SENSOR.BINARY],
  [/^(state|sensor|indicator)(\.alarm)?\.(flood|leak|water)$/, C.LEAK_SENSOR, T.SENSOR.BINARY],
  [/^(state|sensor|indicator)(\.alarm)?\.(fire|smoke)$/, C.SMOKE_SENSOR, T.SENSOR.BINARY],
  [/^(state|sensor|indicator)(\.alarm)?\.co$/, C.CO_SENSOR, T.SENSOR.BINARY],
  [/^indicator(\.maintenance)?\.(lowbat|battery)$/, C.BATTERY_LOW, T.BATTERY_LOW.BINARY],
  [/^(indicator|sensor)(\.alarm)?\.tamper$/, C.TAMPER, T.TAMPER.BINARY],
  [/^(sensor|state)\.vibration$/, C.VIBRATION_SENSOR, T.VIBRATION_SENSOR.BINARY],
];

/**
 * What opens the house or arms it: locks, gates, garage doors, door openers,
 * alarm systems. By role, and by name or id for the generic `switch` relays
 * that drive a garage door or a gate. Commands refused unless allowed.
 */
const SECURITY_ROLE =
  /(^|\.)(lock|gate|garage)(\.|$)|^button\.open\.door|^(switch|level|button)(\.mode)?\.alarm/;
const SECURITY_WORDS =
  /(^|[^a-zà-ÿ])(lock|locks|garage|gate|portail|serrure|verrou|schloss|garagentor|tür(öffner)?|tor|cerradura|portón|alarm|alarme|alarma)([^a-zà-ÿ]|$)/i;

/** Every text of a name: a string, or each of its translations. */
const allTexts = (name) =>
  typeof name === 'string'
    ? [name]
    : name && typeof name === 'object'
      ? Object.values(name).filter((v) => typeof v === 'string')
      : [];

/**
 * True for the states whose commands are a security choice: the state, or
 * any channel or device above it, has a security role, id or name (in any
 * language). The devices and the scene action use this same test.
 * @param {object} obj the state object
 * @param {object | object[]} [ancestors] the channels and devices above it
 */
export function isSecurityState(obj, ancestors = []) {
  const all = [obj, ...(Array.isArray(ancestors) ? ancestors : [ancestors])].filter(Boolean);
  if (all.some((o) => SECURITY_ROLE.test(roleOf(o)))) {
    return true;
  }
  const texts = all.flatMap((o) => [o._id, ...allTexts(o.common?.name)]);
  return texts.some((t) => SECURITY_WORDS.test(String(t ?? '').replace(/[._]/g, ' ')));
}

const binary = (category, type, extra = {}) => ({ category, type, min: 0, max: 1, ...extra });

const bounds = (obj, min, max) => {
  const lo = finite(obj?.common?.min) ? obj.common.min : min;
  const hi = finite(obj?.common?.max) ? obj.common.max : max;
  return lo < hi ? [lo, hi] : [min, max];
};

/** A number written to ioBroker, checked against the limits of the object. */
const numberWriter =
  (obj, transform = (v) => v) =>
  (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new WriteError('unsupported_value');
    }
    const val = transform(n);
    const { min, max } = obj.common ?? {};
    if ((finite(min) && val < min) || (finite(max) && val > max)) {
      throw new WriteError('out_of_range');
    }
    return { id: obj._id, val };
  };

/** A boolean written as the object type wants it: a boolean, or 1/0 for a number. */
const booleanWriter =
  (obj, invert = false) =>
  (value) => {
    const on = Number(value) > 0 !== invert;
    return { id: obj._id, val: obj.common?.type === 'number' ? (on ? 1 : 0) : on };
  };

const readBoolean =
  (invert = false) =>
  (val) => {
    const b = toBoolean(val);
    return b === null ? null : b !== invert ? 1 : 0;
  };

// --- Roles ------------------------------------------------------------------------

function booleanState(obj, ctx) {
  const role = roleOf(obj);
  const writable = isWritable(obj);
  if (/^(button|action)(\.|$)/.test(role)) {
    return { skipped: 'button' };
  }
  if (/(^|\.)lock(\.|$)/.test(role)) {
    if (!/^switch\.lock/.test(role)) {
      return { skipped: role };
    }
    // ioBroker: true = unlocked; Gladys: 1 = locked.
    return [
      {
        role: 'state',
        main: true,
        spec: binary(C.LOCK, T.LOCK.BINARY),
        read: readBoolean(true),
        write: writable && ctx.allowSecurity ? booleanWriter(obj, true) : undefined,
      },
    ];
  }
  const detector = DETECTORS.find(([re]) => re.test(role));
  if (detector) {
    if (detector[1] === 'opening') {
      // ioBroker true = open; Gladys opening sensor 0 = open.
      return [
        {
          role: 'state',
          main: true,
          spec: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
          read: readBoolean(true),
        },
      ];
    }
    return [
      { role: 'state', main: true, spec: binary(detector[1], detector[2]), read: readBoolean() },
    ];
  }
  if (/^switch(\.|$)/.test(role) && !/^switch\.(mode|camera)\./.test(role)) {
    const light = role === 'switch.light' || ctx.light;
    return [
      {
        role: 'state',
        main: true,
        spec: light ? binary(C.LIGHT, T.LIGHT.BINARY) : binary(C.SWITCH, T.SWITCH.BINARY),
        read: readBoolean(),
        write: writable && (!ctx.security || ctx.allowSecurity) ? booleanWriter(obj) : undefined,
      },
    ];
  }
  if (role === 'state' && writable) {
    return [
      {
        role: 'state',
        main: true,
        spec: ctx.light ? binary(C.LIGHT, T.LIGHT.BINARY) : binary(C.SWITCH, T.SWITCH.BINARY),
        read: readBoolean(),
        write: !ctx.security || ctx.allowSecurity ? booleanWriter(obj) : undefined,
      },
    ];
  }
  return { skipped: role || 'no role' };
}

function measurement(obj, def, unit) {
  const round = def.round ? (n) => Math.round(n) : (n) => n;
  return [
    {
      role: 'value',
      main: true,
      throttle: true,
      spec: {
        category: def.category,
        type: def.type,
        min: def.min,
        max: def.max,
        ...(UNITS[unit] ? { unit: UNITS[unit] } : {}),
      },
      read: (val) => {
        const n = toNumber(val);
        return n === null ? null : round(n);
      },
    },
  ];
}

function numberState(obj, ctx) {
  const role = roleOf(obj);
  const unit = normalizeUnit(obj.common?.unit);
  const writable = isWritable(obj);
  const allowed = !ctx.security || ctx.allowSecurity;

  if (/forecast/.test(role)) {
    return { skipped: 'forecast' };
  }
  if (/^(switch|sensor)(\.|$)/.test(role)) {
    // A switch or a detector stored as 1/0.
    return booleanState(obj, ctx);
  }
  if (/^level\.(dimmer|brightness)$/.test(role)) {
    const [min, max] = bounds(obj, 0, 100);
    const features = [
      {
        role: 'brightness',
        main: !ctx.standaloneDimmer,
        spec: {
          category: C.LIGHT,
          type: T.LIGHT.BRIGHTNESS,
          min,
          max,
          ...(unit === '%' ? { unit: U.PERCENT } : {}),
        },
        read: toNumber,
        write: writable ? numberWriter(obj) : undefined,
      },
    ];
    if (ctx.standaloneDimmer) {
      // No switch beside it: an on/off of its own, off = min, on = max.
      features.unshift({
        role: 'power',
        main: true,
        spec: binary(C.LIGHT, T.LIGHT.BINARY),
        read: (val) => {
          const n = toNumber(val);
          return n === null ? null : n > min ? 1 : 0;
        },
        write: writable
          ? (value) => ({ id: obj._id, val: Number(value) > 0 ? max : min })
          : undefined,
      });
    }
    return features;
  }
  if (/^(level|value)\.(blind|curtain)$/.test(role)) {
    const [min, max] = bounds(obj, 0, 100);
    const write = writable && role.startsWith('level.') && allowed;
    const features = [
      {
        role: 'position',
        main: true,
        spec: {
          category: C.SHUTTER,
          type: T.SHUTTER.POSITION,
          min,
          max,
          ...(unit === '%' ? { unit: U.PERCENT } : {}),
        },
        read: toNumber,
        write: write ? numberWriter(obj) : undefined,
      },
    ];
    if (write) {
      features.push({
        role: 'command',
        spec: { category: C.SHUTTER, type: T.SHUTTER.STATE, min: -1, max: 1 },
        write: (value) => {
          const v = Number(value);
          if (v === COVER_STATE.OPEN) {
            return { id: obj._id, val: max };
          }
          if (v === COVER_STATE.CLOSE) {
            return { id: obj._id, val: min };
          }
          if (v === COVER_STATE.STOP && ctx.stopButton) {
            return { id: ctx.stopButton, val: true };
          }
          throw new WriteError('unsupported_value');
        },
      });
    }
    return features;
  }
  if (
    /^level(\.temperature(\.heating)?|\.thermostat)$/.test(role) ||
    role === 'value.temperature.setpoint'
  ) {
    const u = ['°F', 'K'].includes(unit) ? unit : '°C';
    const [min, max] = bounds(obj, u === '°F' ? 41 : 5, u === '°F' ? 86 : 30);
    return [
      {
        role: 'setpoint',
        main: true,
        spec: {
          category: C.THERMOSTAT,
          type: T.THERMOSTAT.TARGET_TEMPERATURE,
          unit: UNITS[u],
          min,
          max,
        },
        read: toNumber,
        write: writable && allowed ? numberWriter(obj) : undefined,
      },
    ];
  }
  if (role === 'value.window') {
    // 0 closed, 1 tilted, 2 open (Homematic): anything but 0 is open.
    return [
      {
        role: 'state',
        main: true,
        spec: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
        read: (val) => {
          const n = toNumber(val);
          return n === null
            ? null
            : n === 0
              ? OPENING_SENSOR_STATE.CLOSE
              : OPENING_SENSOR_STATE.OPEN;
        },
      },
    ];
  }
  for (const [re, units, def] of NUMBER_ROLES) {
    if (!re.test(role)) {
      continue;
    }
    if (!units.includes(unit)) {
      return { skipped: `${role} ${unit || 'without unit'}` };
    }
    if (def === 'temperature') {
      const u = unit || '°C';
      return measurement(obj, BY_UNIT[u], u);
    }
    return measurement(obj, def === 'unit' ? BY_UNIT[unit] : def, unit);
  }
  if (GENERIC_NUMBER.test(role) && BY_UNIT[unit]) {
    return measurement(obj, BY_UNIT[unit], unit);
  }
  return { skipped: role || 'no role' };
}

function stringState(obj) {
  const role = roleOf(obj);
  if (role === 'level.color.rgb' && isWritable(obj)) {
    return [
      {
        role: 'color',
        main: true,
        spec: { category: C.LIGHT, type: T.LIGHT.COLOR, min: 0, max: 0xffffff },
        read: parseRgb,
        write: (value) => ({ id: obj._id, val: toRgb(value) }),
      },
    ];
  }
  return { skipped: 'text' };
}

/**
 * @param {object} obj the state object (GET /v1/objects)
 * @param {object} ctx
 * @param {boolean} [ctx.allowSecurity] commands of locks, gates, garage doors and alarms allowed
 * @param {boolean} [ctx.security] this state is one of them (isSecurityState)
 * @param {boolean} [ctx.light] its channel or device is a lamp (a dimmer or a light role beside it)
 * @param {boolean} [ctx.standaloneDimmer] a dimmer without a switch beside it
 * @param {string} [ctx.stopButton] id of the stop button of a blind, beside it
 * @returns {object[] | { skipped: string }}
 */
export function mapState(obj, ctx = {}) {
  const common = obj?.common ?? {};
  if (common.read === false) {
    return { skipped: 'write-only' };
  }
  let features;
  if (common.type === 'boolean') {
    features = booleanState(obj, ctx);
  } else if (common.type === 'number') {
    features = numberState(obj, ctx);
  } else if (common.type === 'string') {
    features = stringState(obj, ctx);
  } else {
    // `mixed`, `json`, `array`, `object`, `file`: no Gladys feature for them.
    return { skipped: common.type ?? 'no type' };
  }
  if (!Array.isArray(features)) {
    return features;
  }
  return features.map((f) => ({
    ...f,
    spec: {
      ...f.spec,
      read_only: !f.write,
      has_feedback: Boolean(f.write && f.read),
    },
  }));
}
