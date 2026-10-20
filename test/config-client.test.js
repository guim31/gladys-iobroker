// Configuration normalization and the rest-api client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, normalizeUrl, splitList } from '../src/config.js';
import {
  IobAuthError,
  IobHttpError,
  IobrokerClient,
  authorization,
} from '../src/iobroker/client.js';
import { PASSWORD, USER, createIobroker } from './helpers/fakeIobroker.js';

test('addresses: port 8093 by default, without /v1, no credentials inside', () => {
  assert.equal(normalizeUrl('192.0.2.10'), 'http://192.0.2.10:8093');
  assert.equal(normalizeUrl('192.0.2.10:9000'), 'http://192.0.2.10:9000');
  assert.equal(normalizeUrl('http://192.0.2.10:8093/v1/'), 'http://192.0.2.10:8093');
  assert.equal(normalizeUrl('https://iob.example/rest-api/'), 'https://iob.example/rest-api');
  assert.equal(normalizeUrl('http://admin:pw@192.0.2.10:8093'), null);
  assert.equal(normalizeUrl('ftp://192.0.2.10'), null);
  assert.equal(normalizeUrl(''), null);
});

test('lists: commas and new lines separate, spaces stay in a name', () => {
  assert.deepEqual(splitList('Living room, Kitchen\nBad;Kitchen'), [
    'Living room',
    'Kitchen',
    'Bad',
  ]);
  const config = normalizeConfig({
    url: 'nope nope',
    paths: 'hm-rpc.0.*, bad"pattern',
    rooms: 'Wohnzimmer',
    sensor_interval: '7000',
    language: 'it',
  });
  assert.equal(config.invalidUrl, true);
  assert.deepEqual(config.paths, ['hm-rpc.0.*']);
  assert.deepEqual(config.rooms, ['wohnzimmer']);
  assert.equal(config.sensorInterval, 3600);
  assert.equal(config.language, 'fr');
  assert.equal(config.allowSecurity, false);
});

test('client: basic authentication, typed errors, bulk reading', async () => {
  assert.equal(authorization({}), undefined);
  assert.match(authorization({ username: 'a', password: 'b' }), /^Basic /);
  const iob = createIobroker({ auth: true });
  const base = { baseUrl: 'http://192.0.2.10:8093', fetch: iob.fetch };
  await assert.rejects(new IobrokerClient(base).getVersion(), IobAuthError);
  await assert.rejects(
    new IobrokerClient({ ...base, username: USER, password: 'no' }).getVersion(),
    IobAuthError,
  );
  const client = new IobrokerClient({ ...base, username: USER, password: PASSWORD });
  assert.equal(await client.getVersion(), '7.2.5');
  const states = await client.getStates(['0_userdata.0.plug', '0_userdata.0.nope']);
  assert.deepEqual([...states.keys()], ['0_userdata.0.plug']);
  await assert.rejects(client.setState('0_userdata.0.nope', 1), (err) => {
    assert.ok(err instanceof IobHttpError);
    assert.equal(err.status, 404);
    assert.equal(err.detail, 'ID not found');
    return true;
  });
  iob.down = true;
  await assert.rejects(client.getVersion(), /ECONNREFUSED/);
});

test('client: long polling delivers the events, one per answer, and closes', async () => {
  const iob = createIobroker({ pollTimeout: 20 });
  const client = new IobrokerClient({ baseUrl: 'http://192.0.2.10:8093', fetch: iob.fetch });
  const events = [];
  const stream = await client.openEvents({
    patterns: ['0_userdata.0.*'],
    onEvent: (event) => events.push(event),
  });
  assert.equal(await stream.subscriptions(), 1);
  iob.change('0_userdata.0.plug', true);
  iob.change('0_userdata.0.plug', false);
  iob.change('hm-rpc.1.00021B3C4D5E6F.3.STATE', true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(
    events.map((e) => [e.id, e.state.val]),
    [
      ['0_userdata.0.plug', true],
      ['0_userdata.0.plug', false],
    ],
  );
  iob.restart();
  assert.equal(await stream.subscriptions(), -1, 'a forgotten session');
  stream.close();
  assert.equal(await stream.done, 'closed');
});
