// -----------------------------------------------------------------------------
// ioBroker objects -> Gladys devices and routing tables (pure).
//
// ioBroker keeps a tree of ids: `hm-rpc.0.ABC123` (a device) holds
// `hm-rpc.0.ABC123.1` (a channel), which holds the states
// `hm-rpc.0.ABC123.1.STATE`... One Gladys device per ioBroker DEVICE (else
// per channel, else per state of its own), holding the features of its
// states. External ids are built from the ioBroker ids, which never change:
//   device   ext:<selector>:object:<device, channel or state id>
//   feature  <device id>:<state id below it>-<role>
//
// Rooms come from `enum.rooms` (rest-api gives each object the enums it is
// in, inherited from its channel and device). Selection (configuration):
// the id patterns read from ioBroker, the rooms, the states to exclude. The
// states of ioBroker itself (`system.*`, the `info` channel of every adapter
// instance) are never imported.
// -----------------------------------------------------------------------------

import { matcher } from './config.js';
import { isSecurityState, lastPart, mapState, pickText, roleOf } from './mapping.js';
import { ROLE_NAMES } from './texts.js';

const cut = (text, max = 100) => String(text ?? '').slice(0, max);

/** ioBroker's own states: never devices. */
export const isSystemState = (id) =>
  /^system\./.test(id) || /^[^.]+\.\d+\.info(\.|$)/.test(id) || /^[^.]+\.admin\./.test(id);

/** The room names of an object (enums `enum.rooms.*`), in one language. */
export function roomsOf(obj, language) {
  return Object.entries(obj?.enums ?? {})
    .filter(([id]) => id.startsWith('enum.rooms.'))
    .map(([id, name]) => pickText(name, language) || lastPart(id))
    .filter(Boolean);
}

/** Every room name of an object, in every language and its id, lower case (selection). */
function roomKeys(obj) {
  const keys = [];
  for (const [id, name] of Object.entries(obj?.enums ?? {})) {
    if (!id.startsWith('enum.rooms.')) {
      continue;
    }
    keys.push(lastPart(id).toLowerCase());
    if (typeof name === 'string') {
      keys.push(name.toLowerCase());
    } else if (name && typeof name === 'object') {
      keys.push(...Object.values(name).map((n) => String(n).toLowerCase()));
    }
  }
  return keys;
}

/** Every channel and device above a state id, nearest first. */
export function ancestorsOf(id, parents) {
  const parts = String(id).split('.');
  const found = [];
  for (let i = parts.length - 1; i >= 2; i -= 1) {
    const parent = parents[parts.slice(0, i).join('.')];
    if (parent?.type === 'device' || parent?.type === 'channel') {
      found.push(parent);
    }
  }
  return found;
}

/**
 * The name of a state, without the device name some adapters put in front
 * (hm-rpc: "Bedroom shutter:4.LEVEL" -> "4.LEVEL").
 */
export function stateLabel(obj, holder, language) {
  const name = pickText(obj?.common?.name, language) || lastPart(obj?._id);
  const base = holder ? pickText(holder.common?.name, language) : '';
  if (base && name.startsWith(`${base}:`) && name.length > base.length + 1) {
    return name.slice(base.length + 1).trim();
  }
  return name;
}

/**
 * @param {object} objects { states, parents } id -> object (GET /v1/objects)
 * @param {object} options the normalized configuration (src/config.js) + { externalIds }
 */
export function buildInventory(objects, options) {
  const { externalIds, language = 'fr' } = options;
  const states = Object.entries(objects?.states ?? {}).filter(
    ([id, obj]) => typeof id === 'string' && obj?.type === 'state',
  );
  const parents = objects?.parents ?? {};
  const excluded = matcher(options.exclude ?? []);
  const rooms = new Set(options.rooms ?? []);
  const roles = ROLE_NAMES[language] ?? ROLE_NAMES.en;

  /** The device above a state, else its channel, else the state itself. */
  const holderOf = (id) => {
    const parts = id.split('.');
    let channel;
    for (let i = parts.length - 1; i >= 2; i -= 1) {
      const parentId = parts.slice(0, i).join('.');
      const parent = parents[parentId];
      if (parent?.type === 'device') {
        return parent;
      }
      if (parent?.type === 'channel' && !channel) {
        channel = parent;
      }
    }
    return channel;
  };

  /** States of each holder: the siblings that change how a state maps. */
  const siblings = new Map();
  for (const [id, obj] of states) {
    const holder = holderOf(id);
    const key = holder?._id ?? id;
    const list = siblings.get(key) ?? [];
    list.push(obj);
    siblings.set(key, list);
  }

  /** device external id -> { device, names } */
  const devices = new Map();
  /** state id -> [{ featureId, read, throttle }] */
  const routes = new Map();
  /** feature external id -> { state, write } */
  const writers = new Map();
  /** feature external id -> state id, read-only features included */
  const featureState = new Map();
  /** state id -> device external id */
  const stateDevice = new Map();
  /** device external id -> holder id (the ioBroker object of the device) */
  const deviceObject = new Map();
  /** state ids whose commands are a security choice */
  const security = new Set();
  const ignored = new Map();
  let stateCount = 0;

  for (const [id, obj] of states) {
    if (isSystemState(id)) {
      continue;
    }
    const holder = holderOf(id);
    const secure = isSecurityState(obj, ancestorsOf(id, parents));
    if (secure) {
      security.add(id);
    }
    if (excluded(id)) {
      continue;
    }
    if (rooms.size > 0) {
      const keys = [...roomKeys(obj), ...roomKeys(holder)];
      if (!keys.some((k) => rooms.has(k))) {
        continue;
      }
    }
    const around = siblings.get(holder?._id ?? id) ?? [obj];
    const aroundRoles = around.map(roleOf);
    const holderRole = roleOf(holder);
    const hasSwitch = aroundRoles.some((r) => /^switch(\.light)?$|^state$/.test(r));
    const features = mapState(obj, {
      allowSecurity: options.allowSecurity,
      security: secure,
      light:
        /^light/.test(holderRole) ||
        aroundRoles.some((r) => /^level\.(dimmer|brightness)$|^switch\.light$/.test(r)),
      standaloneDimmer: !hasSwitch,
      stopButton: around.find((o) => /^(button|action)\.stop(\.blind)?$/.test(roleOf(o)))?._id,
    });
    if (!Array.isArray(features)) {
      ignored.set(features.skipped, (ignored.get(features.skipped) ?? 0) + 1);
      continue;
    }

    const holderId = holder?._id ?? id;
    const ids = externalIds('object', holderId);
    let entry = devices.get(ids.device);
    if (!entry) {
      const base = pickText((holder ?? obj).common?.name, language) || lastPart(holderId);
      const where = roomsOf(holder ?? obj, language)[0] ?? roomsOf(obj, language)[0] ?? '';
      const name =
        where && !base.toLowerCase().includes(where.toLowerCase()) ? `${base} (${where})` : base;
      entry = {
        names: new Set(),
        device: {
          name: cut(name),
          external_id: ids.device,
          should_poll: false,
          features: [],
          params: [
            { name: 'iobroker_id', value: cut(holderId, 255) },
            ...(where ? [{ name: 'iobroker_room', value: cut(where) }] : []),
          ],
        },
      };
      devices.set(ids.device, entry);
      deviceObject.set(ids.device, holderId);
    }
    stateCount += 1;
    stateDevice.set(id, ids.device);
    const below = holder ? id.slice(holderId.length + 1) : '';
    const label = stateLabel(obj, holder, language);
    for (const f of features) {
      const featureId = ids.feature(below ? `${below}-${f.role}` : f.role);
      let name = f.main ? label : `${label} – ${roles[f.role] ?? f.role}`;
      if (entry.names.has(name)) {
        name = `${name} (${below || lastPart(id)})`;
      }
      entry.names.add(name);
      entry.device.features.push({ name: cut(name), external_id: featureId, ...f.spec });
      featureState.set(featureId, id);
      if (f.read) {
        const stateRoutes = routes.get(id) ?? [];
        stateRoutes.push({ featureId, read: f.read, throttle: Boolean(f.throttle) });
        routes.set(id, stateRoutes);
      }
      if (f.write) {
        writers.set(featureId, { state: id, write: f.write });
      }
    }
  }

  return {
    devices: [...devices.values()].map((e) => e.device),
    routes,
    writers,
    featureState,
    stateDevice,
    deviceObject,
    stateCount,
    security,
    ignored: [...ignored.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}
