// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from a real
// ioBroker (test/fixtures/iobroker: Homematic IP, Shelly and Zigbee objects,
// user data: lights, plugs, shutters, a garage door, a lock, sensors with
// units, detectors, setpoints), with the security commands allowed or not,
// filtered by id pattern or room — in every name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { baseConfig, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const installations = [
  { label: 'every object', config: {}, least: 20 },
  { label: 'security commands allowed', config: { allow_security_commands: true }, least: 20 },
  { label: 'Homematic only', config: { paths: 'hm-rpc.*' }, least: 4 },
  { label: 'two rooms', config: { rooms: 'Hall, Küche' }, least: 5 },
];

const languages = [undefined, 'en', 'de', 'es'];

for (const installation of installations) {
  for (const language of languages) {
    test(`every discovered device follows the Gladys rules (${installation.label}, ${language ?? 'default language'})`, async () => {
      const { gladys, app } = await createWorld({
        config: baseConfig({ ...installation.config, ...(language ? { language } : {}) }),
      });
      try {
        const devices = gladys.fake.discoveredDevices;
        assert.ok(devices.length >= installation.least, `only ${devices.length} devices`);
        for (const device of devices) {
          const where = device.name;

          // should_poll: true if and only if poll_frequency is provided, in ms.
          if (device.poll_frequency === undefined) {
            assert.notEqual(
              device.should_poll,
              true,
              `${where}: should_poll without poll_frequency`,
            );
          } else {
            assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
            assert.ok(
              table.poll_frequencies_ms.includes(device.poll_frequency),
              `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
            );
          }

          assert.ok(device.features.length > 0, `${where}: no feature`);
          const externalIds = new Set();
          const names = new Set();
          for (const feature of device.features) {
            const at = `${where} / ${feature.name}`;
            const pair = table.pairs[`${feature.category}/${feature.type}`];
            assert.ok(
              pair,
              `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
            );
            assert.ok(
              pair.label_en && pair.label_fr && pair.icon,
              `${at}: couple without label or icon`,
            );

            assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
            assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
            assert.ok(
              Number.isFinite(feature.min) && Number.isFinite(feature.max),
              `${at}: finite min/max`,
            );
            assert.ok(feature.min <= feature.max, `${at}: min > max`);
            assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
            assert.equal(
              typeof feature.has_feedback,
              'boolean',
              `${at}: has_feedback must be a boolean`,
            );
            if (feature.unit !== undefined) {
              assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
              // The table nests some lists (pm25-sensor): flattened, not loosened.
              const allowed = table.units_by_category?.[feature.category]?.flat();
              if (allowed) {
                assert.ok(
                  allowed.includes(feature.unit),
                  `${at}: unit ${feature.unit} not for ${feature.category}`,
                );
              }
            }

            assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
            externalIds.add(feature.external_id);
            assert.ok(
              feature.external_id.startsWith(`${device.external_id}:`),
              `${at}: feature id outside its device`,
            );
            assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
            names.add(feature.name);
          }
        }
      } finally {
        app.stop();
      }
    });
  }
}
