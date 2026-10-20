// -----------------------------------------------------------------------------
// A fake ioBroker rest-api adapter, as a `fetch`: the objects and values of
// a real ioBroker (test/fixtures/iobroker/objects.json), the commands
// (PATCH, acknowledged by a fake adapter), and long polling with the
// behaviour of rest-api 4.0.3: one event per answer, an empty answer after
// the timeout, a session forgotten on restart.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const USER = 'gladys';
export const PASSWORD = 'secret-pass';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/iobroker/objects.json', import.meta.url), 'utf8'),
);

const json = (status, body) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** An ioBroker id pattern: `*` matches any text, case-sensitive. */
const globMatch = (pattern, id) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(id);

/**
 * @param {object} [options]
 * @param {boolean} [options.auth] basic authentication required
 * @param {boolean} [options.polling] long polling available (false: 404, like a proxy)
 * @param {boolean} [options.autoAck] the adapter acknowledges the commands
 * @param {number} [options.pollTimeout] ms before an empty long polling answer
 */
export function createIobroker({
  auth = false,
  polling = true,
  autoAck = true,
  pollTimeout = 50,
} = {}) {
  const objects = structuredClone({
    ...fixture.states,
    ...fixture.channels,
    ...fixture.devices,
    ...fixture.host,
  });
  for (const [id, obj] of Object.entries(objects)) {
    obj._id = id;
  }
  const values = new Map(Object.entries(structuredClone(fixture.values)));
  /** sid -> { patterns: [], objects: bool, queue: [], waiter } */
  const sessions = new Map();

  const fake = {
    down: false,
    polling,
    requests: [],
    commands: [],
    objects,
    values,
    sessions,

    /** Every session forgotten, like rest-api after a restart. */
    restart() {
      for (const session of sessions.values()) {
        session.waiter?.('');
      }
      sessions.clear();
    },

    emit(event, test) {
      for (const session of sessions.values()) {
        if (test(session)) {
          if (session.waiter) {
            const waiter = session.waiter;
            session.waiter = undefined;
            waiter(JSON.stringify(event));
          } else {
            session.queue.push(JSON.stringify(event));
          }
        }
      }
    },

    /** A state changes in ioBroker (a device, a script, the adapter acknowledging). */
    change(id, val, ack = true) {
      const state = { val, ack, ts: Date.now(), q: 0, from: 'system.adapter.test.0' };
      values.set(id, state);
      fake.emit({ id, state }, (s) => s.patterns.some((p) => globMatch(p, id)));
    },

    /** An object is created or changed. */
    setObject(id, obj) {
      objects[id] = { ...obj, _id: id };
      fake.emit({ id, obj: objects[id] }, (s) => s.objects);
    },

    deleteObject(id) {
      delete objects[id];
      values.delete(id);
      fake.emit({ id }, (s) => s.objects);
    },

    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      const { pathname, searchParams } = new URL(url);
      fake.requests.push({ method, path: pathname, auth: init.headers?.Authorization });
      if (fake.down) {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      }
      if (auth) {
        const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
        if (!init.headers?.Authorization) {
          return json(401, { error: 'User is required' });
        }
        if (init.headers.Authorization !== expected) {
          return new Response('Unauthorized', { status: 401 });
        }
      }
      const body = init.body ? JSON.parse(init.body) : undefined;
      const path = decodeURIComponent(pathname);

      if (path === '/v1/objects' && method === 'GET') {
        const filter = searchParams.get('filter') ?? '*';
        const type = searchParams.get('type') ?? 'state';
        const out = {};
        for (const [id, obj] of Object.entries(objects)) {
          if (obj.type === type && globMatch(filter, id)) {
            const { _id, ...rest } = obj;
            out[_id] = structuredClone(rest);
          }
        }
        return json(200, out);
      }
      if (path === '/v1/command/getStates' && method === 'POST') {
        const result = {};
        for (const id of body.pattern) {
          result[id] = values.get(id) ?? null;
        }
        return json(200, { error: null, result });
      }
      const stateMatch = path.match(/^\/v1\/state\/(.+)$/);
      if (stateMatch && method === 'PATCH') {
        const id = stateMatch[1];
        if (objects[id]?.type !== 'state') {
          return json(404, { error: 'ID not found', id });
        }
        fake.commands.push({ id, val: body.val, ack: body.ack });
        fake.change(id, body.val, false);
        if (autoAck) {
          setTimeout(() => fake.change(id, body.val, true), 1);
        }
        return json(200, { val: body.val, id });
      }
      const objectMatch = path.match(/^\/v1\/object\/(.+)$/);
      if (objectMatch && method === 'GET') {
        const obj = objects[objectMatch[1]];
        if (!obj) {
          return json(404, { error: 'ID not found', id: objectMatch[1] });
        }
        const { _id, ...rest } = obj;
        return json(200, { ...structuredClone(rest), _id });
      }

      // --- Long polling ---
      if (!polling && (path === '/v1/polling' || path.endsWith('/subscribe'))) {
        return json(404, { error: 'not found' });
      }
      const sid = searchParams.get('sid');
      if (path === '/v1/polling') {
        if (searchParams.has('connect')) {
          if (!sessions.has(sid)) {
            sessions.set(sid, { patterns: [], objects: false, queue: [] });
          }
          return new Response('_', { status: 200, headers: { 'Content-Type': 'text/plain' } });
        }
        if (!sessions.has(sid)) {
          // rest-api creates an empty session: nothing ever comes again.
          sessions.set(sid, { patterns: [], objects: false, queue: [] });
        }
        const session = sessions.get(sid);
        if (session.queue.length > 0) {
          return new Response(session.queue.shift(), { status: 200 });
        }
        const text = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            session.waiter = undefined;
            resolve('');
          }, pollTimeout);
          session.waiter = (data) => {
            clearTimeout(timer);
            resolve(data);
          };
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            session.waiter = undefined;
            resolve(undefined);
          });
        });
        if (text === undefined) {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          throw err;
        }
        return new Response(text, { status: 200 });
      }
      if (path === '/v1/states/subscribe' || path === '/v1/objects/subscribe') {
        const session = sessions.get(sid);
        if (method === 'GET') {
          return session
            ? json(200, { states: session.patterns })
            : json(404, { error: 'URL or session not found' });
        }
        if (!session) {
          return json(404, { error: 'URL or session not found' });
        }
        if (path === '/v1/objects/subscribe') {
          session.objects = true;
        } else {
          session.patterns.push(body.pattern);
        }
        return json(200, { result: 'OK' });
      }
      return json(404, { error: 'not found' });
    },
  };
  fake.fetch = fake.fetch.bind(fake);
  return fake;
}
