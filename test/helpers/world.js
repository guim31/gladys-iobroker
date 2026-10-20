// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys (a real GladysIntegration on an
// in-memory transport), the integration wired on it by registerHandlers, and
// the fake ioBroker (rest-api). Short timings: everything settles in milliseconds.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createLogger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from '../../src/app.js';
import { createIobroker } from './fakeIobroker.js';

export const FAST_TIMINGS = {
  reconnectMin: 20,
  reconnectMax: 80,
  authRetry: 200,
  inventoryDebounce: 20,
  pollInterval: 60_000,
  resyncInterval: 5 * 60_000,
  refreshInterval: 60 * 60_000,
  streamRetryMax: 80,
  resubscribeDebounce: 10,
  commandReadBack: 20,
};
export const FAST_PUBLISHER = { flushInterval: 10 };

export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Waits for a condition, failing with `what` after a while. */
export async function until(check, { what = 'the condition', timeout = 2000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export const baseConfig = (extra = {}) => ({
  url: 'http://192.0.2.10:8093',
  ...extra,
});

/**
 * @param {object} [options]
 * @param {object} [options.iob] the fake ioBroker (default: the real objects, long polling)
 * @param {object} [options.config] integration config (default: the fake's address)
 * @param {object[]} [options.devices] devices already added in Gladys
 */
export async function createWorld({
  iob = createIobroker(),
  config,
  devices = [],
  connect = true,
  waitOnline = true,
  logger = createLogger({ level: 'silent' }),
  timings = FAST_TIMINGS,
} = {}) {
  const gladys = createFakeGladys({ config: config ?? baseConfig(), devices });
  const app = registerHandlers(gladys, {
    fetch: iob.fetch,
    timings,
    publisherTimings: FAST_PUBLISHER,
    logger,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
    if (waitOnline && !iob.down) {
      await until(() => app.bridge.status === 'online', { what: 'ioBroker online' });
      if (iob.polling !== false) {
        await until(() => app.bridge.live, { what: 'long polling' });
      }
    }
  }
  return { gladys, fake: gladys.fake, app, bridge: app.bridge, iob };
}

/** The discovered device holding the features of this state. */
export function deviceOf(world, id) {
  const deviceId = world.bridge.inventory.stateDevice.get(id);
  return world.fake.discoveredDevices.find((d) => d.external_id === deviceId);
}

/** The discovered feature of one state and role. */
export function featureOf(world, id, role) {
  const device = deviceOf(world, id);
  const feature = device?.features.find(
    (f) =>
      world.bridge.inventory.featureState.get(f.external_id) === id &&
      (f.external_id.endsWith(`-${role}`) || f.external_id.endsWith(`:${role}`)),
  );
  if (!feature) {
    throw new Error(`No feature ${role} for ${id}`);
  }
  return feature;
}

/** Adds a discovered device to Gladys, like the user in the Discovery tab. */
export async function addDevice(world, device) {
  const created = structuredClone(device);
  await world.fake.deviceCreated(created);
  await settle();
  return created;
}

/** Waits for the publisher's next flush. */
export async function flushed(world) {
  await settle();
  await world.bridge.publisher.flush();
  await settle();
}
