// -----------------------------------------------------------------------------
// SDK wiring: every handler of the manifest, registered on the Gladys client
// (the real one in index.js, the SDK's fake Gladys in the tests).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Bridge } from './bridge.js';
import { sceneActions } from './scenes.js';
import { widgets } from './widgets.js';

/**
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {object} [deps] test doubles: fetch, timers, timings, clientTimings, publisherTimings, now, logger
 */
export function registerHandlers(gladys, deps = {}) {
  const logger = deps.logger ?? createLogger({ name: 'iobroker' });
  const bridge = new Bridge({ gladys, logger, ...deps });

  gladys.onConfigUpdated((config) => bridge.configure(config));
  gladys.onScanRequest(() => bridge.scan());
  gladys.onSetValue((device, feature, value) => bridge.setValue(device, feature, value));
  gladys.onDeviceCreated((device) => bridge.onDeviceCreated(device));
  gladys.onDeviceUpdated((device) => bridge.onDeviceCreated(device));
  gladys.onDeviceDeleted((device) => bridge.onDeviceDeleted(device));
  gladys.onAction('test_connection', () => bridge.testConnection());

  for (const [key, handler] of Object.entries(sceneActions(bridge))) {
    gladys.onSceneAction(key, async (fields) => {
      await handler(fields ?? {});
    });
  }
  for (const [key, widget] of Object.entries(widgets(bridge))) {
    gladys.onWidgetGet(key, widget.get);
    gladys.onWidgetAction(key, widget.action);
  }

  let ready = Promise.resolve();
  gladys.on('connected', () => {
    ready = bridge.onGladysConnected().catch((err) => logger.error(err.message));
    return ready;
  });

  return {
    bridge,
    get ready() {
      return ready;
    },
    stop: () => bridge.stop(),
  };
}
