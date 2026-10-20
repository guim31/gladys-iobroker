// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers: these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, LANGUAGES } from '../src/config.js';
import { TRIGGERS, WIDGET_KEY } from '../src/bridge.js';
import { SCENE_ACTION_KEYS } from '../src/scenes.js';
import { createWorld } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const keysOf = (list) => (list ?? []).map((entry) => entry.key);

test('identity: name, image, local transport, protocols category', () => {
  assert.equal(manifest.name, 'ioBroker');
  assert.equal(manifest.type, 'device');
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-iobroker:/);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-iobroker/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['protocols', 'lighting', 'climate']);
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('scene triggers, scene actions and widgets require Gladys >= 5.1.0, no more', () => {
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('config_schema: the defaults and options of the code', () => {
  const keys = manifest.config_schema.filter((f) => f.type !== 'section').map((f) => f.key);
  assert.deepEqual(keys.sort(), Object.keys(DEFAULT_CONFIG).sort());
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.deepEqual(DEFAULT_CONFIG[field.key], field.default, `default of ${field.key}`);
    }
  }
  assert.equal(manifest.config_schema.find((f) => f.key === 'password').type, 'secret');
  for (const key of ['username', 'password']) {
    assert.notEqual(
      manifest.config_schema.find((f) => f.key === key).required,
      true,
      `${key}: rest-api works without authentication by default`,
    );
  }
  assert.equal(
    manifest.config_schema.find((f) => f.key === 'allow_security_commands').default,
    false,
    'locks, gates, garage doors and alarms stay read-only by default',
  );
  const languages = manifest.config_schema.find((f) => f.key === 'language');
  assert.deepEqual(
    languages.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.equal(languages.default, 'fr');
});

test('number fields have integer bounds and defaults (rendered without step)', () => {
  for (const field of manifest.config_schema.filter((f) => f.type === 'number')) {
    for (const key of ['min', 'max', 'default']) {
      assert.ok(Number.isInteger(field[key]), `${field.key}.${key}`);
    }
  }
});

test('section fields are purely presentational', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('every manifest action, scene action and widget has a handler, and vice versa', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { fake } = world;
  assert.match((await fake.action('nope')).error, /not implemented/i);
  for (const action of manifest.actions) {
    const ack = await fake.action(action.key, {});
    assert.equal(ack.success, true, `action ${action.key}: ${ack.error}`);
  }
  assert.deepEqual(keysOf(manifest.scene_actions).sort(), [...SCENE_ACTION_KEYS].sort());
  for (const action of manifest.scene_actions) {
    const ack = await fake.sceneAction(action.key, {});
    assert.doesNotMatch(ack.error ?? '', /not implemented/i, action.key);
  }
  assert.deepEqual(keysOf(manifest.widgets), [WIDGET_KEY]);
  assert.equal((await fake.widgetGet(WIDGET_KEY, { settings: {} })).success, true);
});

test('scene action fields are the ones the code reads', () => {
  const fields = Object.fromEntries(
    manifest.scene_actions.map((a) => [a.key, keysOf(a.fields).sort()]),
  );
  assert.deepEqual(fields, { set_state: ['state', 'value'] });
  // An action applies no default: a field added later as required breaks every scene using it.
  const required = manifest.scene_actions[0].fields.filter((f) => f.required).map((f) => f.key);
  assert.deepEqual(required, ['state', 'value']);
});

test('the scene trigger is declared with the filters and variables the bridge sends', () => {
  assert.deepEqual(keysOf(manifest.scene_triggers).sort(), Object.values(TRIGGERS).sort());
  const sent = { state_changed: ['id', 'name', 'value', 'old_value'] };
  for (const trigger of manifest.scene_triggers) {
    for (const key of [...keysOf(trigger.fields), ...keysOf(trigger.variables)]) {
      assert.ok(sent[trigger.key].includes(key), `${trigger.key}: "${key}" is sent`);
    }
    for (const field of trigger.fields) {
      assert.ok(['string', 'select', 'multi_select'].includes(field.type), field.key);
    }
  }
});
