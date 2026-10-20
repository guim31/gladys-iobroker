// The scene action and the dashboard widget.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { statusContent } from '../src/widgets.js';
import { createIobroker } from './helpers/fakeIobroker.js';
import { addDevice, baseConfig, createWorld, deviceOf } from './helpers/world.js';

test('set_state: any state, the value typed by its object', async (t) => {
  const iob = createIobroker();
  iob.setObject('0_userdata.0.message', {
    type: 'state',
    common: { name: 'Message', type: 'string', role: 'text', read: true, write: true },
    native: {},
  });
  const world = await createWorld({ iob });
  t.after(() => world.app.stop());
  for (const [state, value, val] of [
    ['0_userdata.0.good_night', 'true', true],
    ['0_userdata.0.thermostat', '19,5', 19.5],
    ['0_userdata.0.message', ' Hello ', 'Hello'],
  ]) {
    const ack = await world.fake.sceneAction('set_state', { state, value });
    assert.equal(ack.success, true, ack.error);
    assert.deepEqual(world.iob.commands.at(-1), { id: state, val, ack: false });
  }
  for (const [fields, error] of [
    [{ state: 'hm-rpc.*', value: '1' }, /identifiant de l'état/],
    [{ state: '0_userdata.0.nope', value: '1' }, /ne connaît pas .*nope/],
    [{ state: '0_userdata.0.good_night', value: 'maybe' }, /ne convient pas/],
    [{ state: 'zigbee.0.00158d0003d4e5f6.opened', value: 'true' }, /lecture seule/],
  ]) {
    const refused = await world.fake.sceneAction('set_state', fields);
    assert.equal(refused.success, false, JSON.stringify(fields));
    assert.match(refused.error, error);
  }
});

test('set_state: locks, garage doors and alarms follow the security switch', async (t) => {
  const iob = createIobroker();
  iob.setObject('0_userdata.0.alarm_arm', {
    type: 'state',
    common: { name: 'Arm', type: 'boolean', role: 'switch.mode.alarm', read: true, write: true },
    native: {},
  });
  const world = await createWorld({ iob });
  t.after(() => world.app.stop());
  for (const state of [
    '0_userdata.0.lock',
    '0_userdata.0.garage.relay',
    '0_userdata.0.alarm_arm',
    '0_userdata.0.alarm_mode',
  ]) {
    const ack = await world.fake.sceneAction('set_state', { state, value: 'false' });
    assert.equal(ack.success, false, state);
    assert.match(ack.error, /désactivées dans la configuration/);
  }
  assert.equal(iob.commands.length, 0);
  const allowed = await createWorld({ iob, config: baseConfig({ allow_security_commands: true }) });
  t.after(() => allowed.app.stop());
  const ack = await allowed.fake.sceneAction('set_state', {
    state: '0_userdata.0.lock',
    value: 'false',
  });
  assert.equal(ack.success, true, ack.error);
});

test('the widget content is valid in every state and language', () => {
  for (const status of ['online', 'connecting', 'unreachable', 'auth_failed', 'not_configured']) {
    for (const live of [true, false]) {
      for (const language of ['en', 'fr', 'de', 'es']) {
        const content = statusContent(
          { status, live, version: '7.2.5', offered: 21, added: 2, followed: 5 },
          language,
        );
        assert.doesNotThrow(() => validateWidgetContent(content), `${status} ${live}`);
      }
    }
  }
});

test('the widget counts the added devices, and its button reads the objects again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await addDevice(world, deviceOf(world, '0_userdata.0.plug'));
  const got = await world.fake.widgetGet('status', { settings: {}, language: 'de' });
  assert.equal(got.success, true, got.error);
  const values = got.data.content.components.filter((c) => c.type === 'value').map((c) => c.value);
  assert.deepEqual(values, [world.bridge.inventory.devices.length, 1, 1]);
  const before = world.iob.requests.length;
  const ack = await world.fake.widgetAction('status', 'reload');
  assert.equal(ack.success, true, ack.error);
  assert.ok(world.iob.requests.slice(before).some((r) => r.path === '/v1/objects'));
});
