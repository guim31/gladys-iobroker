// -----------------------------------------------------------------------------
// Entry point: the SDK client, the handlers (src/app.js), the connection.
// The supervisor gives GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN and
// GLADYS_INTEGRATION_SELECTOR: `new GladysIntegration()` reads them.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { registerHandlers } from './src/app.js';

const gladys = new GladysIntegration();
const app = registerHandlers(gladys);

gladys.handleShutdown(async () => {
  app.stop();
});

logger.info('Starting the ioBroker bridge');
await gladys.connect();
