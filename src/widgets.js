// -----------------------------------------------------------------------------
// Dashboard widget `status`: the connection to ioBroker, its version, how the
// states arrive (long polling or polling), the devices offered and added, the
// states followed, and a button that reads the object list again. Pre-localized
// from the `language` Gladys sends with the request.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { LANGUAGES } from './config.js';
import { WORDS } from './texts.js';

const STATE = {
  online: ['connected', WIDGET_COLORS.SUCCESS, 'check-circle'],
  connecting: ['connecting', WIDGET_COLORS.INFO, 'loader'],
  unreachable: ['unreachable', WIDGET_COLORS.DANGER, 'wifi-off'],
  auth_failed: ['auth_failed', WIDGET_COLORS.DANGER, 'lock'],
  invalid_url: ['not_configured', WIDGET_COLORS.WARNING, 'settings'],
  not_configured: ['not_configured', WIDGET_COLORS.WARNING, 'settings'],
};

/** One text in the four languages, from the WORDS table. */
const word = (key) => Object.fromEntries(LANGUAGES.map((lang) => [lang, WORDS[lang][key]]));

export function statusContent(summary, language = 'fr') {
  const words = WORDS[language] ?? WORDS.en;
  const [label, color, icon] = STATE[summary.status] ?? STATE.not_configured;
  const items = [{ label: words.connection, value: words[label], color, icon }];
  if (summary.status === 'online') {
    items.push({
      label: words.live,
      value: summary.live ? words.live_on : words.live_off,
      color: summary.live ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.WARNING,
      icon: summary.live ? 'zap' : 'clock',
    });
  }
  if (summary.version) {
    items.push({ label: words.version, value: summary.version, icon: 'home' });
  }
  return {
    ttl_seconds: 60,
    components: [
      { type: 'value', label: words.offered, value: summary.offered, icon: 'search' },
      { type: 'value', label: words.added, value: summary.added, icon: 'check-square' },
      { type: 'value', label: words.followed, value: summary.followed, icon: 'activity' },
      { type: 'status', items },
      {
        type: 'button',
        label: words.reload,
        icon: 'refresh-cw',
        style: 'secondary',
        action: { key: 'reload' },
      },
    ],
  };
}

export function widgets(bridge) {
  return {
    status: {
      get: async ({ language }) => statusContent(bridge.summary(), language),
      action: async (actionKey) => {
        if (actionKey !== 'reload') {
          throw new Error(`Unknown action ${actionKey}`);
        }
        await bridge.scan();
        return word('reloaded');
      },
    },
  };
}
