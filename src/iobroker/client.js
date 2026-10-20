// -----------------------------------------------------------------------------
// The ioBroker REST API: the `rest-api` adapter (4.x, port 8093), with the
// fetch of Node 22.
//
//   GET   /v1/objects?filter=<pattern>&type=state|channel|device
//                                     objects, each with the enums it is in
//                                     (`enums`: rooms and functions, inherited
//                                     from its channel and device)
//   POST  /v1/command/getStates       { pattern: [ids] } -> { result: { id: state | null } }
//   PATCH /v1/state/<id>              { val, ack: false }: a command
//   GET   /v1/object/<id>             one object (scene action on any state)
//   GET   /v1/polling?sid=…           long polling: one event per answer,
//                                     `{ id, state }` or `{ id, obj }`, an
//                                     empty answer after `timeout` ms
//   POST  /v1/states/subscribe        { method: 'polling', pattern } for a sid
//   GET   /v1/states/subscribe?sid=…&method=polling
//                                     the subscriptions of a sid (watchdog)
//
// Authentication: none (the adapter default), or HTTP basic with an ioBroker
// user when "Authentication" is ticked in the adapter. Verified against
// rest-api 4.0.3 in Docker: no or wrong credentials -> 401, an unknown id ->
// 404 { error: 'ID not found' }.
// -----------------------------------------------------------------------------

export const CLIENT_TIMINGS = {
  requestTimeout: 15_000,
  // rest-api ends an idle long poll after this (1 to 60 s), with an empty answer.
  pollTimeout: 30_000,
};

/** ioBroker refused the credentials (401, 403). */
export class IobAuthError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = 'IobAuthError';
    this.status = status;
  }
}

/** ioBroker answered with an error status. */
export class IobHttpError extends Error {
  constructor(status, detail) {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    this.name = 'IobHttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** Builds the Authorization header; never logged. */
export function authorization({ username, password }) {
  return username
    ? `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`
    : undefined;
}

/** States read per request: a POST body stays small. */
const STATES_PER_REQUEST = 500;

export class IobrokerClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl normalized by src/config.js (no /v1)
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {typeof fetch} [options.fetch]
   * @param {object} [options.timings]
   */
  constructor({ baseUrl, username, password, fetch = globalThis.fetch, timings }) {
    this.baseUrl = baseUrl;
    this.auth = authorization({ username, password });
    this.fetch = fetch;
    this.timings = { ...CLIENT_TIMINGS, ...timings };
  }

  async request(method, path, { body, timeout, signal, raw = false } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(this.auth ? { Authorization: this.auth } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(timeout ?? this.timings.requestTimeout),
        redirect: 'error',
      });
    } catch (err) {
      // undici hides the reason (ECONNREFUSED, ENOTFOUND...) in `cause`.
      const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
      throw new Error(err?.name === 'TimeoutError' ? 'timeout' : reason, { cause: err });
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new IobAuthError(response.status);
    }
    if (raw && response.ok) {
      return text;
    }
    let data;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new IobHttpError(response.status, text.slice(0, 200));
        }
        throw new Error('not a JSON answer: is it the rest-api adapter?');
      }
    }
    if (!response.ok) {
      const detail = typeof data?.error === 'string' ? data.error.slice(0, 200) : undefined;
      throw new IobHttpError(response.status, detail);
    }
    return data;
  }

  /**
   * @param {string} pattern an ioBroker id pattern (`*`, `hm-rpc.0.*`)
   * @param {'state'|'channel'|'device'|'host'} type
   * @returns {Promise<Record<string, object>>} id -> object
   */
  async getObjects(pattern, type) {
    const data = await this.request(
      'GET',
      `/v1/objects?filter=${encodeURIComponent(pattern)}&type=${type}`,
    );
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('unexpected answer to /v1/objects');
    }
    return data;
  }

  async getObject(id) {
    return this.request('GET', `/v1/object/${encodeURIComponent(id)}`);
  }

  /** Version of js-controller (the first host), or undefined. */
  async getVersion() {
    const hosts = await this.getObjects('system.host.*', 'host');
    const host = Object.values(hosts).find((h) => h?.common?.installedVersion);
    return host ? String(host.common.installedVersion) : undefined;
  }

  /**
   * @param {string[]} ids
   * @returns {Promise<Map<string, object>>} id -> state ({ val, ack, ts… }); missing ids left out
   */
  async getStates(ids) {
    const states = new Map();
    for (let i = 0; i < ids.length; i += STATES_PER_REQUEST) {
      const data = await this.request('POST', '/v1/command/getStates', {
        body: { pattern: ids.slice(i, i + STATES_PER_REQUEST) },
      });
      if (data?.error) {
        throw new IobHttpError(500, String(data.error).slice(0, 200));
      }
      for (const [id, state] of Object.entries(data?.result ?? {})) {
        if (state && typeof state === 'object') {
          states.set(id, state);
        }
      }
    }
    return states;
  }

  /** A command: ack false, the adapter of the state carries it out and acknowledges it. */
  async setState(id, val) {
    await this.request('PATCH', `/v1/state/${encodeURIComponent(id)}`, {
      body: { val, ack: false },
    });
  }

  /**
   * Opens a long polling session subscribed to these state patterns and to
   * the object changes. Resolves once subscribed; `onEvent(data)` gets every
   * event, `done` resolves when the session ends (error, disconnect, close).
   * @param {object} options
   * @param {string[]} options.patterns
   * @param {(event: object) => void} options.onEvent
   */
  async openEvents({ patterns, onEvent }) {
    const sid = `gladys_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    const query = `sid=${encodeURIComponent(sid)}`;
    const controller = new AbortController();
    const pollTimeout = this.timings.pollTimeout;
    // The connect answer is "_", in plain text.
    const first = await this.request('GET', `/v1/polling?${query}&connect&timeout=${pollTimeout}`, {
      raw: true,
    });
    if (first !== '_') {
      throw new Error('the long polling of rest-api did not answer');
    }
    const subscribe = (kind, pattern) =>
      this.request('POST', `/v1/${kind}/subscribe?${query}&method=polling`, {
        body: { method: 'polling', pattern },
      });
    await subscribe('objects', '*');
    for (const pattern of patterns) {
      await subscribe('states', pattern);
    }

    let closed = false;
    const loop = async () => {
      while (!closed) {
        let data;
        try {
          data = await this.request('GET', `/v1/polling?${query}`, {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(pollTimeout + this.timings.requestTimeout),
            ]),
          });
        } catch (err) {
          if (!closed) {
            return err.message;
          }
          return 'closed';
        }
        if (data?.disconnect) {
          return 'ioBroker ended the session';
        }
        if (data && typeof data === 'object' && typeof data.id === 'string') {
          try {
            onEvent(data);
          } catch {
            // A faulty event never stops the stream.
          }
        }
      }
      return 'closed';
    };
    const done = loop();
    return {
      sid,
      patterns,
      done,
      /** Number of state subscriptions rest-api keeps for this session, or -1 when it lost it. */
      subscriptions: async () => {
        try {
          const data = await this.request('GET', `/v1/states/subscribe?${query}&method=polling`);
          return Array.isArray(data?.states) ? data.states.length : -1;
        } catch (err) {
          if (err instanceof IobHttpError && err.status === 404) {
            return -1;
          }
          throw err;
        }
      },
      close: () => {
        closed = true;
        controller.abort();
      },
    };
  }
}
