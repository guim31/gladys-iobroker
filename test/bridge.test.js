// The bridge end to end: the SDK's fake Gladys on one side, the fake ioBroker
// rest-api (real objects, long polling, acknowledged commands) on the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';
import { PASSWORD, USER, createIobroker } from './helpers/fakeIobroker.js';
import { captureLogs } from './helpers/logs.js';
import {
  addDevice,
  baseConfig,
  createWorld,
  deviceOf,
  featureOf,
  flushed,
  settle,
  until,
} from './helpers/world.js';

const statesOf = (world, featureId) =>
  world.fake.states.filter((s) => s.device_feature_external_id === featureId).map((s) => s.state);

const BULB = 'zigbee.0.0017880104a5b6c7';
const WINDOW = 'zigbee.0.00158d0003d4e5f6.opened';

test('one device per ioBroker device, with its room; nothing of ioBroker itself', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const bulb = deviceOf(world, `${BULB}.state`);
  assert.equal(bulb, deviceOf(world, `${BULB}.brightness`));
  assert.equal(bulb.name, 'Hall bulb (Entrée)');
  assert.match(bulb.external_id, /:object:zigbee\.0\.0017880104a5b6c7$/);
  assert.deepEqual(
    bulb.features.map((f) => [f.category, f.type]),
    [
      ['light', 'binary'],
      ['light', 'brightness'],
      ['light', 'color'],
    ],
  );
  const shutter = deviceOf(world, 'hm-rpc.1.00111A2B3C4D5E.4.LEVEL');
  assert.equal(shutter, deviceOf(world, 'hm-rpc.1.00111A2B3C4D5E.0.LOW_BAT'), 'channels merged');
  for (const device of world.fake.discoveredDevices) {
    assert.equal(device.should_poll, false, device.name);
    assert.doesNotMatch(device.external_id, /:object:(system|admin)\./);
  }
  assert.equal(deviceOf(world, '0_userdata.0.alarm_mode'), undefined, 'a text state');
});

test('states go to the added devices only, all again when one is added', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await flushed(world);
  assert.equal(world.fake.states.length, 0, 'nothing added yet');
  assert.deepEqual(world.bridge.stream.patterns, []);
  await addDevice(world, deviceOf(world, WINDOW));
  await flushed(world);
  const door = featureOf(world, WINDOW, 'state').external_id;
  assert.deepEqual(statesOf(world, door), [1], 'false (closed) is 1');
  await until(() => world.bridge.stream?.patterns.includes('zigbee.0.00158d0003d4e5f6.*'), {
    what: 'the new subscription',
  });
  world.iob.change(WINDOW, true);
  await until(async () => (await flushed(world), statesOf(world, door).length === 2), {
    what: 'the change',
  });
  assert.deepEqual(statesOf(world, door), [1, 0]);
});

test('a command is a typed value with ack false, the acknowledgement is the feedback', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const bulb = await addDevice(world, deviceOf(world, `${BULB}.brightness`));
  await until(() => world.bridge.stream?.patterns.length === 1, { what: 'subscription' });
  const brightness = featureOf(world, `${BULB}.brightness`, 'brightness');
  const ack = await world.fake.setValue(bulb, brightness, 35);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.iob.commands, [{ id: `${BULB}.brightness`, val: 35, ack: false }]);
  await until(
    async () => (await flushed(world), statesOf(world, brightness.external_id).includes(35)),
    { what: 'the feedback' },
  );
  await world.fake.setValue(bulb, featureOf(world, `${BULB}.state`, 'state'), 0);
  assert.deepEqual(world.iob.commands.at(-1), { id: `${BULB}.state`, val: false, ack: false });
  await world.fake.setValue(bulb, featureOf(world, `${BULB}.color`, 'color'), 0x00ff00);
  assert.equal(world.iob.commands.at(-1).val, '#00ff00');
});

test('locks and garage doors: read-only by default, refused with a clear message', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const lock = await addDevice(world, deviceOf(world, '0_userdata.0.lock'));
  const feature = featureOf(world, '0_userdata.0.lock', 'state');
  assert.equal(feature.read_only, true);
  const ack = await world.fake.setValue(lock, feature, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /serrures, portails/);
  assert.equal(world.iob.commands.length, 0);
  const garage = await addDevice(world, deviceOf(world, '0_userdata.0.garage.relay'));
  const refused = await world.fake.setValue(
    garage,
    featureOf(world, '0_userdata.0.garage.relay', 'state'),
    1,
  );
  assert.equal(refused.success, false);
});

test('locks: commanded once allowed, unlock is true in ioBroker', async (t) => {
  const world = await createWorld({ config: baseConfig({ allow_security_commands: true }) });
  t.after(() => world.app.stop());
  const lock = await addDevice(world, deviceOf(world, '0_userdata.0.lock'));
  const ack = await world.fake.setValue(lock, featureOf(world, '0_userdata.0.lock', 'state'), 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.iob.commands.at(-1), { id: '0_userdata.0.lock', val: true, ack: false });
});

test('rest-api restarted: the watchdog opens a new session', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await addDevice(world, deviceOf(world, WINDOW));
  await until(() => world.bridge.stream?.patterns.length === 1, { what: 'subscription' });
  const before = world.bridge.stream;
  world.iob.restart();
  await world.bridge.tick(world.bridge.generation);
  await until(() => world.bridge.stream && world.bridge.stream !== before, {
    what: 'a new session',
  });
  await flushed(world);
  const door = featureOf(world, WINDOW, 'state').external_id;
  world.iob.change(WINDOW, true);
  await until(async () => (await flushed(world), statesOf(world, door).at(-1) === 0), {
    what: 'the change through the new session',
  });
});

test('without long polling: states read on each tick, a command read back', async (t) => {
  const iob = createIobroker({ polling: false });
  const world = await createWorld({ iob });
  t.after(() => world.app.stop());
  await until(() => world.bridge.streamFailing, { what: 'long polling refused' });
  assert.equal(world.bridge.live, false);
  const plug = await addDevice(world, deviceOf(world, '0_userdata.0.plug'));
  const feature = featureOf(world, '0_userdata.0.plug', 'state');
  await flushed(world);
  iob.values.set('0_userdata.0.plug', { val: false, ack: true });
  await world.bridge.tick(world.bridge.generation);
  await flushed(world);
  assert.equal(statesOf(world, feature.external_id).at(-1), 0);
  await world.fake.setValue(plug, feature, 1);
  await until(
    async () => (await flushed(world), statesOf(world, feature.external_id).at(-1) === 1),
    {
      what: 'the read back',
    },
  );
});

test('basic authentication: refused, then accepted', async (t) => {
  const iob = createIobroker({ auth: true });
  const refused = await createWorld({
    iob,
    config: baseConfig({ username: USER, password: 'wrong' }),
    waitOnline: false,
  });
  t.after(() => refused.app.stop());
  await until(() => refused.bridge.status === 'auth_failed', { what: 'auth_failed' });
  assert.match((await refused.fake.action('test_connection')).error, /refuse l'accès/);
  refused.app.stop();
  const world = await createWorld({
    iob,
    config: baseConfig({ username: USER, password: PASSWORD }),
  });
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection');
  assert.equal(ack.success, true, ack.error);
  assert.match(JSON.stringify(ack), /Connecté à ioBroker 7\.2\.5/);
});

test('ioBroker lost: unreachable badges, back online on its own', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const device = await addDevice(world, deviceOf(world, '0_userdata.0.plug'));
  world.iob.down = true;
  await world.bridge.refresh();
  assert.equal(world.bridge.status, 'unreachable');
  assert.deepEqual(world.fake.transports.at(-1), {
    device_external_id: device.external_id,
    transport: 'unreachable',
  });
  world.iob.down = false;
  await until(() => world.bridge.status === 'online', { what: 'back online' });
  await until(() => world.bridge.live, { what: 'long polling again' });
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('an object added in ioBroker is offered without a scan', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.iob.setObject('0_userdata.0.new_lamp', {
    type: 'state',
    common: { name: 'New lamp', type: 'boolean', role: 'switch.light', read: true, write: true },
    native: {},
  });
  await until(() => deviceOf(world, '0_userdata.0.new_lamp'), { what: 'the new device' });
  assert.equal(deviceOf(world, '0_userdata.0.new_lamp').features[0].category, 'light');
});

test('watched states start the scene trigger with the new and previous values', async (t) => {
  const world = await createWorld({
    config: baseConfig({ watched_states: '0_userdata.0.alarm*' }),
  });
  t.after(() => world.app.stop());
  assert.deepEqual(world.bridge.stream.patterns, ['0_userdata.0.alarm*']);
  world.iob.change('0_userdata.0.alarm_mode', 'armed');
  await until(() => world.fake.sceneEvents.length > 0, { what: 'the scene event' });
  assert.deepEqual(world.fake.sceneEvents[0], {
    key: 'state_changed',
    data: {
      id: '0_userdata.0.alarm_mode',
      name: 'Alarm mode',
      value: 'armed',
      old_value: 'disarmed',
    },
  });
});

test('a normal cycle writes nothing at the info level', async (t) => {
  const world = await createWorld({ logger: createLogger({ name: 'iobroker' }) });
  t.after(() => world.app.stop());
  await addDevice(world, deviceOf(world, WINDOW));
  await until(() => world.bridge.stream?.patterns.length === 1, { what: 'subscription' });
  const { lines, stop } = captureLogs(t, 'info');
  world.iob.change(WINDOW, true);
  await world.bridge.tick(world.bridge.generation);
  await world.bridge.resync();
  await flushed(world);
  await settle();
  assert.deepEqual(stop(), []);
  assert.equal(lines.length, 0);
});

test('security: a gate named on its channel or its device, in any language, stays read-only', async (t) => {
  const iob = createIobroker();
  const relay = (name) => ({
    type: 'state',
    common: { name, type: 'boolean', role: 'switch', read: true, write: true },
    native: {},
  });
  iob.setObject('shelly.0.SHSW-1#A1#1', { type: 'device', common: { name: 'Shelly 1' } });
  iob.setObject('shelly.0.SHSW-1#A1#1.Relay0', { type: 'channel', common: { name: 'Portail' } });
  iob.setObject('shelly.0.SHSW-1#A1#1.Relay0.Switch', relay('Switch'));
  iob.setObject('shelly.0.SHSW-1#B2#1', {
    type: 'device',
    common: { name: { en: 'Relay', de: 'Garagentor' } },
  });
  iob.setObject('shelly.0.SHSW-1#B2#1.Relay0', { type: 'channel', common: { name: 'Relay0' } });
  iob.setObject('shelly.0.SHSW-1#B2#1.Relay0.Switch', relay('Switch'));
  // Outside the configured patterns: its parents are read from ioBroker.
  const world = await createWorld({
    iob,
    config: baseConfig({ paths: '0_userdata.0.*, shelly.0.SHSW-1#A1#1.Relay0.*' }),
  });
  t.after(() => world.app.stop());
  const gate = 'shelly.0.SHSW-1#A1#1.Relay0.Switch';
  assert.equal(featureOf(world, gate, 'state').read_only, true);
  assert.match(
    deviceOf(world, gate).external_id,
    /:object:shelly\.0\.SHSW-1#A1#1$/,
    'the device, whatever the patterns',
  );
  for (const state of [gate, 'shelly.0.SHSW-1#B2#1.Relay0.Switch']) {
    const ack = await world.fake.sceneAction('set_state', { state, value: 'true' });
    assert.equal(ack.success, false, state);
  }
  assert.equal(iob.commands.length, 0);
});

test('a command not yet acknowledged by its adapter is not shown; user data is', async (t) => {
  const iob = createIobroker({ autoAck: false });
  const world = await createWorld({ iob });
  t.after(() => world.app.stop());
  const bulb = await addDevice(world, deviceOf(world, `${BULB}.brightness`));
  const plug = await addDevice(world, deviceOf(world, '0_userdata.0.plug'));
  await until(() => world.bridge.stream?.patterns.length === 2, { what: 'subscriptions' });
  await flushed(world);
  const brightness = featureOf(world, `${BULB}.brightness`, 'brightness');
  await world.fake.setValue(bulb, brightness, 35);
  const switchFeature = featureOf(world, '0_userdata.0.plug', 'state');
  await world.fake.setValue(plug, switchFeature, 0);
  await until(
    async () => (await flushed(world), statesOf(world, switchFeature.external_id).at(-1) === 0),
    {
      what: 'the user data value',
    },
  );
  await world.bridge.resync();
  await flushed(world);
  assert.ok(!statesOf(world, brightness.external_id).includes(35), 'ack: false is a command');
  iob.change(`${BULB}.brightness`, 35, true);
  await until(
    async () => (await flushed(world), statesOf(world, brightness.external_id).includes(35)),
    {
      what: 'the acknowledged value',
    },
  );
});

test('devices added while a session opens are followed by the next one', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const first = addDevice(world, deviceOf(world, WINDOW));
  const second = addDevice(world, deviceOf(world, '0_userdata.0.plug'));
  await Promise.all([first, second]);
  await until(
    () =>
      JSON.stringify(world.bridge.stream?.patterns) ===
      JSON.stringify(['0_userdata.0.plug', 'zigbee.0.00158d0003d4e5f6.*']),
    { what: 'both devices followed' },
  );
});

test('the watchdog sees a lost session even with nothing followed', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const before = world.bridge.stream;
  world.iob.restart();
  await world.bridge.tick(world.bridge.generation);
  await until(() => world.bridge.stream && world.bridge.stream !== before, {
    what: 'a new session',
  });
});
