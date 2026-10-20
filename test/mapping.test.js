// One ioBroker state -> Gladys features: roles, value conventions, writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  COVER_STATE,
  LOCK_STATE,
  OPENING_SENSOR_STATE,
  WriteError,
  isSecurityState,
  mapState,
  parseRgb,
  pickText,
  toRgb,
} from '../src/mapping.js';
import { buildInventory, isSystemState, stateLabel } from '../src/inventory.js';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/iobroker/objects.json', import.meta.url), 'utf8'),
);
const obj = (id) => ({ ...fixture.states[id], _id: id });
const state = (common, id = '0_userdata.0.test') => ({
  _id: id,
  type: 'state',
  common: { read: true, ...common },
});
const only = (features) => {
  assert.ok(Array.isArray(features), JSON.stringify(features));
  return features;
};

test('opening sensors: ioBroker true (open) is Gladys 0, value.window 0 is closed', () => {
  const [door] = only(mapState(obj('zigbee.0.00158d0003d4e5f6.opened')));
  assert.equal(door.spec.category, 'opening-sensor');
  assert.equal(door.read(true), OPENING_SENSOR_STATE.OPEN);
  assert.equal(door.read(false), OPENING_SENSOR_STATE.CLOSE);
  assert.equal(door.spec.read_only, true);
  const [hm] = only(mapState(obj('hm-rpc.1.0007DA5B6C7D8E.1.STATE')));
  assert.equal(hm.read(0), OPENING_SENSOR_STATE.CLOSE);
  assert.equal(hm.read(1), OPENING_SENSOR_STATE.OPEN, 'tilted is open');
  assert.equal(hm.read(2), OPENING_SENSOR_STATE.OPEN);
});

test('locks: ioBroker true (unlocked) is Gladys 0; written only when allowed', () => {
  const lock = obj('0_userdata.0.lock');
  const [readOnly] = only(mapState(lock, { security: true }));
  assert.equal(readOnly.spec.category, 'lock');
  assert.equal(readOnly.read(true), LOCK_STATE.UNLOCK);
  assert.equal(readOnly.read(false), LOCK_STATE.LOCK);
  assert.equal(readOnly.write, undefined);
  assert.equal(readOnly.spec.read_only, true);
  const [allowed] = only(mapState(lock, { security: true, allowSecurity: true }));
  assert.deepEqual(allowed.write(LOCK_STATE.LOCK), { id: '0_userdata.0.lock', val: false });
  assert.deepEqual(allowed.write(LOCK_STATE.UNLOCK), { id: '0_userdata.0.lock', val: true });
});

test('a state is written only when its object says write: true', () => {
  const [plug] = only(mapState(obj('hm-rpc.1.00021B3C4D5E6F.3.STATE')));
  assert.deepEqual(plug.write(1), { id: 'hm-rpc.1.00021B3C4D5E6F.3.STATE', val: true });
  assert.equal(plug.spec.has_feedback, true);
  const [unknown] = only(mapState(state({ type: 'boolean', role: 'switch' })));
  assert.equal(unknown.write, undefined, 'write missing: read-only');
  const [garage] = only(mapState(obj('0_userdata.0.garage.relay'), { security: true }));
  assert.equal(garage.write, undefined, 'a garage relay waits for the security option');
  const [numeric] = only(mapState(state({ type: 'number', role: 'switch', write: true })));
  assert.equal(numeric.write(1).val, 1, 'a number switch gets 1/0');
});

test('blinds: position as ioBroker gives it (max = open), open/close/stop', () => {
  const level = obj('hm-rpc.1.00111A2B3C4D5E.4.LEVEL');
  const [position, command] = only(
    mapState(level, { stopButton: 'hm-rpc.1.00111A2B3C4D5E.4.STOP' }),
  );
  assert.equal(position.spec.type, 'position');
  assert.equal(position.read(100), 100);
  assert.deepEqual(position.write(40), { id: level._id, val: 40 });
  assert.throws(
    () => position.write(140),
    (e) => e instanceof WriteError && e.key === 'out_of_range',
  );
  assert.equal(command.write(COVER_STATE.OPEN).val, 100);
  assert.equal(command.write(COVER_STATE.CLOSE).val, 0);
  assert.deepEqual(command.write(COVER_STATE.STOP), {
    id: 'hm-rpc.1.00111A2B3C4D5E.4.STOP',
    val: true,
  });
  const [, noStop] = only(mapState(level));
  assert.throws(() => noStop.write(COVER_STATE.STOP), WriteError);
});

test('dimmers: brightness in the bounds of the object, an on/off when alone', () => {
  const dimmer = state({ type: 'number', role: 'level.dimmer', write: true, min: 0, max: 254 });
  const [power, brightness] = only(mapState(dimmer, { standaloneDimmer: true }));
  assert.equal(power.spec.category, 'light');
  assert.equal(power.read(0), 0);
  assert.equal(power.read(12), 1);
  assert.equal(power.write(1).val, 254);
  assert.equal(power.write(0).val, 0);
  assert.equal(brightness.spec.max, 254);
  assert.equal(only(mapState(dimmer, { standaloneDimmer: false })).length, 1);
});

test('thermostat setpoint: limits of the object, refused outside them', () => {
  const [setpoint] = only(mapState(obj('hm-rpc.1.000A18A9B8C7D6.1.SET_POINT_TEMPERATURE')));
  assert.equal(setpoint.spec.category, 'thermostat');
  assert.equal(setpoint.spec.unit, 'celsius');
  assert.equal(setpoint.spec.min, 4.5);
  assert.deepEqual(setpoint.write(21.5).val, 21.5);
  assert.throws(() => setpoint.write(35), WriteError);
});

test('measurements by role and unit', () => {
  const cases = [
    ['hm-rpc.1.00021B3C4D5E6F.6.ENERGY_COUNTER', 'energy-sensor', 'index', 'watt-hour'],
    ['hm-rpc.1.00021B3C4D5E6F.6.POWER', 'energy-sensor', 'power', 'watt'],
    ['zigbee.0.00158d0001a2b3c4.battery', 'battery', 'integer', 'percent'],
    ['zigbee.0.00158d0002c3d4e5.illuminance', 'light-sensor', 'decimal', 'lux'],
    ['zigbee.0.00158d0001a2b3c4.pressure', 'pressure-sensor', 'decimal', 'hPa'],
  ];
  for (const [id, category, type, unit] of cases) {
    const [f] = only(mapState(obj(id)));
    assert.deepEqual([f.spec.category, f.spec.type, f.spec.unit], [category, type, unit], id);
    assert.equal(f.throttle, true);
  }
  const [battery] = only(mapState(obj('zigbee.0.00158d0001a2b3c4.battery')));
  assert.equal(battery.read(86.6), 87);
  const [noUnit] = only(mapState(state({ type: 'number', role: 'value.temperature' })));
  assert.equal(noUnit.spec.unit, 'celsius');
  assert.equal(noUnit.read('21,5'), 21.5);
  const [generic] = only(mapState(state({ type: 'number', role: 'value', unit: 'kWh' })));
  assert.equal(generic.spec.type, 'index');
});

test('what is not imported, and why', () => {
  const skipped = (common) => mapState(state(common)).skipped;
  assert.equal(
    skipped({ type: 'number', role: 'value.temperature.forecast.1', unit: '°C' }),
    'forecast',
  );
  assert.equal(skipped({ type: 'string', role: 'text' }), 'text');
  assert.equal(skipped({ type: 'json', role: 'json' }), 'json');
  assert.equal(
    skipped({ type: 'boolean', role: 'button', read: false, write: true }),
    'write-only',
  );
  assert.equal(skipped({ type: 'number', role: 'value.rssi', unit: 'dBm' }), 'value.rssi');
  assert.equal(skipped({ type: 'number', role: 'value.power', unit: 'Wh' }), 'value.power Wh');
  assert.equal(skipped({ type: 'boolean', role: 'state' }), 'state', 'a read-only generic state');
});

test('colours: #RRGGBB both ways', () => {
  assert.equal(parseRgb('#ff8000'), 0xff8000);
  assert.equal(parseRgb('FF8000FF'), 0xff8000, 'RGBW keeps the colour');
  assert.equal(parseRgb('red'), null);
  assert.equal(toRgb(0x00ff10), '#00ff10');
  const [color] = only(mapState(obj('zigbee.0.0017880104a5b6c7.color')));
  assert.deepEqual(color.write(0x123456), {
    id: 'zigbee.0.0017880104a5b6c7.color',
    val: '#123456',
  });
});

test('security: by role, and by name for the plain relays', () => {
  assert.ok(isSecurityState(obj('0_userdata.0.lock')));
  assert.ok(isSecurityState(obj('0_userdata.0.garage.relay')));
  assert.ok(isSecurityState(state({ type: 'boolean', role: 'switch', name: 'Garagentor' })));
  assert.ok(isSecurityState(state({ type: 'boolean', role: 'switch', name: 'Portail' })));
  assert.ok(isSecurityState(state({ type: 'boolean', role: 'switch.gate' })));
  assert.ok(!isSecurityState(obj('hm-rpc.1.00021B3C4D5E6F.3.STATE')));
  assert.ok(!isSecurityState(state({ type: 'boolean', role: 'switch', name: 'Motor' })));
  assert.ok(!isSecurityState(obj('zigbee.0.00158d0003d4e5f6.opened')));
});

test('names: translated, without the device name of hm-rpc', () => {
  assert.equal(pickText({ en: 'Living room', de: 'Wohnzimmer' }, 'de'), 'Wohnzimmer');
  assert.equal(pickText({ en: 'Living room', de: 'Wohnzimmer' }, 'fr'), 'Living room');
  assert.equal(pickText({ ru: 'Кухня' }, 'fr'), 'Кухня');
  const holder = { common: { name: 'Bedroom shutter' } };
  assert.equal(stateLabel(obj('hm-rpc.1.00111A2B3C4D5E.4.LEVEL'), holder, 'fr'), '4.LEVEL');
  assert.equal(stateLabel(obj('zigbee.0.00158d0001a2b3c4.humidity'), holder, 'fr'), 'Humidity');
});

test('ioBroker states are never devices', () => {
  assert.ok(isSystemState('system.adapter.admin.0.alive'));
  assert.ok(isSystemState('admin.0.info.connection'));
  assert.ok(isSystemState('hm-rpc.1.info.connection'));
  assert.ok(!isSystemState('hm-rpc.1.00021B3C4D5E6F.3.STATE'));
  const inventory = buildInventory(
    { states: fixture.states, parents: { ...fixture.channels, ...fixture.devices } },
    { externalIds: (type, id) => ({ device: `x:${id}`, feature: (f) => `x:${id}:${f}` }) },
  );
  assert.ok(![...inventory.stateDevice.keys()].some(isSystemState));
});
