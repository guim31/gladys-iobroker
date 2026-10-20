// -----------------------------------------------------------------------------
// The bridge: one ioBroker (its rest-api adapter), its objects, the live
// states, the commands and the scene events.
//
//   connect    the js-controller version and the objects (states, channels,
//              devices) of the configured id patterns, with or without basic
//              authentication;
//   inventory  src/inventory.js -> publishDiscoveredDevices (Discovery tab);
//   live       a long polling session of rest-api, subscribed to the states
//              of the devices ADDED in Gladys (the others would be dropped by
//              the core and spend its 300 states/min) and of the watched
//              patterns, and to the object changes (the object list is read
//              again);
//   resync     the followed states are read again every 5 minutes (rest-api
//              drops an event it could not deliver within 3 s), every 30 s
//              without long polling;
//   watchdog   rest-api forgets a session when it restarts: its subscriptions
//              are checked every 30 s, the session opened again when lost;
//   commands   onSetValue -> PATCH the state with ack: false; the change that
//              follows is the feedback;
//   events     watched_states -> trigger `state_changed`;
//   failures   ioBroker lost -> unreachable badges, new attempt after 5 s,
//              doubling up to 60 s (refused credentials: every minute).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { matcher, normalizeConfig } from './config.js';
import { buildInventory, isSystemState } from './inventory.js';
import { WriteError, isSecurityState, pickText, toBoolean, toNumber } from './mapping.js';
import { IobAuthError, IobHttpError, IobrokerClient } from './iobroker/client.js';
import { StatePublisher } from './publisher.js';
import { ERRORS, STATUS, localizedError, testMessage } from './texts.js';

export const BRIDGE_TIMINGS = {
  reconnectMin: 5000,
  reconnectMax: 60_000,
  authRetry: 60_000,
  inventoryDebounce: 2000,
  // The watchdog and, without long polling, the reading of the states.
  pollInterval: 30_000,
  // With long polling, the followed states are read again this often anyway.
  resyncInterval: 5 * 60_000,
  // The objects are read again hourly: a safety net for a missed object event.
  refreshInterval: 60 * 60_000,
  streamRetryMax: 5 * 60_000,
  // Devices added or removed: the long polling session follows them after this delay.
  resubscribeDebounce: 1000,
  // A command while polling: its result is read back after this delay.
  commandReadBack: 1500,
};

export const TRIGGERS = { STATE_CHANGED: 'state_changed' };
export const WIDGET_KEY = 'status';

/** Scene events per minute: the core takes 300, a chatty state must not spend them all. */
export const EVENTS_PER_MINUTE = 120;

/** The core refuses a discovered list longer than this (setDiscoveredDevices, 5.2.0). */
export const MAX_DISCOVERED_DEVICES = 2000;

/** Ids allowed in a scene action: what ioBroker accepts, without wildcards. */
const STATE_ID = /^[^\s*?"'`\\[\],]+(?:[ ][^\s*?"'`\\[\],]+)*$/;

const short = (value, max = 255) => {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return text.length > max ? text.slice(0, max) : text;
};

/** What the inventory is built from: a change here offers the devices again. */
const structureOf = ({ states, parents }) =>
  JSON.stringify([
    Object.entries(states).map(([id, o]) => [id, o.common, Object.keys(o.enums ?? {})]),
    Object.entries(parents).map(([id, o]) => [id, o.type, o.common?.name, o.common?.role]),
  ]);

export class Bridge {
  constructor({
    gladys,
    logger,
    fetch,
    timers = globalThis,
    timings = BRIDGE_TIMINGS,
    clientTimings,
    publisherTimings,
    now = Date.now,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.fetch = fetch;
    this.timers = timers;
    this.timings = { ...BRIDGE_TIMINGS, ...timings };
    this.clientTimings = clientTimings;
    this.now = now;
    this.publisher = new StatePublisher({
      gladys,
      logger,
      now,
      timers,
      timings: publisherTimings,
    });
    this.config = normalizeConfig({});
    this.configKey = undefined;
    this.status = 'not_configured';
    this.version = undefined;
    this.client = undefined;
    this.objects = { states: {}, parents: {} };
    /** state id -> its value (`val`), kept up to date by the events */
    this.values = new Map();
    /** state id -> time of its last change received by long polling */
    this.changedAt = new Map();
    this.structure = undefined;
    this.inventory = this.emptyInventory();
    this.generation = 0;
    this.reconnectTimer = undefined;
    this.inventoryTimer = undefined;
    this.resubscribeTimer = undefined;
    this.tickTimer = undefined;
    this.streamTimer = undefined;
    this.stream = undefined;
    this.live = false;
    this.streamSeq = 0;
    this.streamFailing = false;
    this.lastResyncAt = 0;
    this.lastRefreshAt = 0;
    this.delay = this.timings.reconnectMin;
    this.streamDelay = this.timings.reconnectMin;
    this.transports = new Map();
    this.eventWindow = [];
    this.eventsDropped = false;
    this.watched = matcher([]);
  }

  emptyInventory() {
    return buildInventory({}, { externalIds: this.gladys.externalIds.bind(this.gladys) });
  }

  // --- Configuration and lifecycle -----------------------------------------------

  /** Applies a configuration; restarts the connection when it changed. */
  async configure(raw) {
    const key = JSON.stringify(raw ?? {});
    if (key === this.configKey && this.status !== 'not_configured') {
      return;
    }
    this.configKey = key;
    this.config = normalizeConfig(raw);
    this.watched = matcher(this.config.watched);
    this.publisher.setInterval(this.config.sensorInterval);
    await this.restart();
  }

  async restart() {
    this.disconnect();
    this.generation += 1;
    this.delay = this.timings.reconnectMin;
    this.streamDelay = this.timings.reconnectMin;
    this.structure = undefined;
    // Nothing of the previous server survives a new configuration.
    this.objects = { states: {}, parents: {} };
    this.values.clear();
    this.changedAt.clear();
    this.transports.clear();
    this.inventory = this.emptyInventory();
    this.publisher.clear();
    this.publisher.start();
    if (this.config.invalidUrl || !this.config.url) {
      this.status = this.config.invalidUrl ? 'invalid_url' : 'not_configured';
      await this.setConnectionStatus(false, STATUS[this.status]);
      return;
    }
    await this.connect(this.generation);
  }

  /** Stops everything (shutdown, tests). */
  stop() {
    this.generation += 1;
    this.disconnect();
    this.publisher.stop();
  }

  disconnect() {
    for (const timer of [
      this.reconnectTimer,
      this.inventoryTimer,
      this.streamTimer,
      this.resubscribeTimer,
    ]) {
      this.timers.clearTimeout(timer);
    }
    this.timers.clearInterval(this.tickTimer);
    this.reconnectTimer = undefined;
    this.inventoryTimer = undefined;
    this.streamTimer = undefined;
    this.resubscribeTimer = undefined;
    this.tickTimer = undefined;
    this.closeStream();
    this.client = undefined;
  }

  closeStream() {
    this.streamSeq += 1;
    const stream = this.stream;
    this.stream = undefined;
    this.live = false;
    stream?.close();
  }

  async setConnectionStatus(connected, message) {
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.logger.debug(`Connection status not sent: ${err.message}`);
    }
  }

  newClient() {
    return new IobrokerClient({
      baseUrl: this.config.url,
      username: this.config.username,
      password: this.config.password,
      fetch: this.fetch,
      timings: this.clientTimings,
    });
  }

  /** The objects of the configured patterns: states, and the channels and devices above them. */
  async readObjects(client) {
    const patterns = this.config.paths.length > 0 ? this.config.paths : ['*'];
    const states = {};
    const parents = {};
    for (const pattern of patterns) {
      Object.assign(states, await client.getObjects(pattern, 'state'));
      Object.assign(parents, await client.getObjects(pattern, 'channel'));
      Object.assign(parents, await client.getObjects(pattern, 'device'));
    }
    for (const [id, obj] of [...Object.entries(states), ...Object.entries(parents)]) {
      if (obj && typeof obj === 'object') {
        obj._id = id;
      }
    }
    return { states, parents };
  }

  async connect(generation) {
    if (generation !== this.generation) {
      return;
    }
    if (this.status !== 'unreachable' && this.status !== 'auth_failed') {
      this.status = 'connecting';
    }
    const client = this.newClient();
    let objects;
    try {
      // The version first: the cheapest request tells a refused access apart.
      this.version = await client.getVersion();
      objects = await this.readObjects(client);
    } catch (err) {
      if (generation === this.generation) {
        await this.onFailure(generation, err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    const wasDown = this.status === 'unreachable' || this.status === 'auth_failed';
    this.client = client;
    this.status = 'online';
    this.delay = this.timings.reconnectMin;
    await this.applyObjects(objects, { force: true });
    this.logger.info(
      `${wasDown ? 'Connected again' : 'Connected'} to ioBroker ${this.version ?? ''}: ${this.inventory.devices.length} devices, ${this.inventory.stateCount} states`.replace(
        '  ',
        ' ',
      ),
    );
    await this.setConnectionStatus(true);
    await this.publishTransports();
    this.requestWidgetRefresh();
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => {
      this.tick(generation).catch((err) => this.logger.debug(`Tick failed: ${err.message}`));
    }, this.timings.pollInterval);
    await this.resync(generation);
    this.openStream(generation);
  }

  async onFailure(generation, err) {
    const auth = err instanceof IobAuthError;
    const status = auth ? 'auth_failed' : 'unreachable';
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.timers.clearTimeout(this.streamTimer);
    this.closeStream();
    this.client = undefined;
    if (this.status !== status) {
      // One line at the first failure, one at the recovery: not one per attempt.
      this.logger.warn(
        auth
          ? `ioBroker refused the access (${err.message})`
          : `ioBroker is unreachable: ${err.message}`,
      );
    }
    this.status = status;
    await this.setConnectionStatus(false, STATUS[status]);
    await this.publishTransports();
    this.requestWidgetRefresh();
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.timers.setTimeout(
      () => {
        this.reconnectTimer = undefined;
        this.connect(generation).catch((e) => this.logger.error(e.message));
      },
      auth ? this.timings.authRetry : this.delay,
    );
    if (!auth) {
      this.delay = Math.min(this.delay * 2, this.timings.reconnectMax);
    }
  }

  // --- Long polling --------------------------------------------------------------

  /** The created devices of this bridge. */
  createdDevices() {
    const offered = new Set(this.inventory.devices.map((d) => d.external_id));
    return (this.gladys.devices ?? []).filter((d) => offered.has(d.external_id));
  }

  /** What long polling follows: the objects of the added devices, the watched patterns. */
  subscriptionPatterns() {
    const patterns = new Set(this.config.watched);
    for (const device of this.createdDevices()) {
      const holder = this.inventory.deviceObject.get(device.external_id);
      if (holder) {
        patterns.add(this.objects.states[holder] ? holder : `${holder}.*`);
      }
    }
    return [...patterns].sort();
  }

  async openStream(generation) {
    if (generation !== this.generation || this.status !== 'online' || !this.client) {
      return;
    }
    this.streamSeq += 1;
    const seq = this.streamSeq;
    const patterns = this.subscriptionPatterns();
    let stream;
    try {
      stream = await this.client.openEvents({
        patterns,
        onEvent: (event) => this.onStreamEvent(event, stream),
      });
    } catch (err) {
      if (generation === this.generation && seq === this.streamSeq) {
        this.onStreamDown(generation, err.message);
      }
      return;
    }
    // A newer attempt (after a loss and a reconnection) owns the stream now.
    if (generation !== this.generation || this.status !== 'online' || seq !== this.streamSeq) {
      stream.close();
      return;
    }
    this.stream?.close();
    this.stream = stream;
    this.live = true;
    this.streamDelay = this.timings.reconnectMin;
    if (this.streamFailing) {
      this.streamFailing = false;
      this.logger.info('ioBroker long polling works again');
      this.requestWidgetRefresh();
      // Changes may have been missed while it was down.
      this.resync(generation).catch(() => {});
    }
    stream.done.then((reason) => {
      if (this.stream === stream) {
        this.stream = undefined;
        this.live = false;
        this.onStreamDown(generation, reason);
      }
    });
  }

  onStreamDown(generation, reason) {
    if (generation !== this.generation || this.status !== 'online') {
      return;
    }
    if (!this.streamFailing) {
      this.streamFailing = true;
      this.logger.warn(`ioBroker long polling unavailable (${reason}): states read every 30 s`);
      this.requestWidgetRefresh();
    }
    this.timers.clearTimeout(this.streamTimer);
    this.streamTimer = this.timers.setTimeout(() => {
      this.streamTimer = undefined;
      this.openStream(generation).catch(() => {});
    }, this.streamDelay);
    this.streamDelay = Math.min(this.streamDelay * 2, this.timings.streamRetryMax);
  }

  /** The set of followed patterns changed (a device added or removed): a new session. */
  scheduleResubscribe() {
    if (this.resubscribeTimer || !this.stream) {
      return;
    }
    const generation = this.generation;
    this.resubscribeTimer = this.timers.setTimeout(() => {
      this.resubscribeTimer = undefined;
      if (
        this.stream &&
        JSON.stringify(this.stream.patterns) !== JSON.stringify(this.subscriptionPatterns())
      ) {
        this.logger.debug('Followed states changed: long polling session opened again');
        this.replaceStream(generation);
      }
    }, this.timings.resubscribeDebounce);
  }

  /** Opens a new session; the old one is closed once the new one is up. */
  replaceStream(generation) {
    const old = this.stream;
    this.stream = undefined;
    this.live = false;
    old?.close();
    this.openStream(generation)
      .then(() => this.resync(generation))
      .catch(() => {});
  }

  onStreamEvent(event, stream) {
    if (stream && stream !== this.stream) {
      return;
    }
    const { id } = event;
    if ('state' in event) {
      this.onStateChanged(id, event.state);
      return;
    }
    if (!isSystemState(id)) {
      // An object created, changed or deleted.
      this.scheduleInventory();
    }
  }

  onStateChanged(id, state) {
    if (!state || typeof state !== 'object') {
      return;
    }
    const known = this.values.has(id);
    const previous = this.values.get(id);
    this.values.set(id, state.val);
    this.changedAt.set(id, this.now());
    if (this.inventory.routes.has(id)) {
      this.pushState(id);
    }
    if (this.watched(id) && (!known || previous !== state.val)) {
      this.stateEvent(id, state.val, previous);
    }
  }

  stateEvent(id, value, previous) {
    this.sceneEvent(TRIGGERS.STATE_CHANGED, {
      id,
      name: short(pickText(this.objects.states[id]?.common?.name, this.config.language) || id),
      value: short(value),
      old_value: short(previous),
    });
  }

  /** Every 30 s: the watchdog of long polling, the states when it is down or 5 minutes passed. */
  async tick(generation) {
    if (generation !== this.generation || this.status !== 'online') {
      return;
    }
    const now = this.now();
    if (this.live && this.stream) {
      const stream = this.stream;
      let count;
      try {
        count = await stream.subscriptions();
      } catch {
        count = undefined;
      }
      if (count !== undefined && count < stream.patterns.length && stream === this.stream) {
        this.logger.debug('rest-api lost the long polling session (restarted?): opened again');
        this.replaceStream(generation);
        return;
      }
    }
    if (now - this.lastRefreshAt >= this.timings.refreshInterval) {
      await this.refresh(generation);
    }
    if (!this.live || now - this.lastResyncAt >= this.timings.resyncInterval) {
      await this.resync(generation);
    }
  }

  // --- Objects, inventory and values ----------------------------------------------

  /** Reads the objects again, the devices offered again when they changed. */
  async refresh(generation = this.generation) {
    if (generation !== this.generation || this.status !== 'online' || !this.client) {
      return;
    }
    let objects;
    try {
      objects = await this.readObjects(this.client);
    } catch (err) {
      if (generation === this.generation && this.status === 'online') {
        await this.onFailure(generation, err);
      }
      return;
    }
    if (generation === this.generation) {
      await this.applyObjects(objects);
      await this.resync(generation);
    }
  }

  async applyObjects(objects, { force = false } = {}) {
    this.objects = objects;
    this.lastRefreshAt = this.now();
    const structure = structureOf(objects);
    if (force || structure !== this.structure) {
      this.structure = structure;
      this.inventory = buildInventory(objects, {
        ...this.config,
        externalIds: this.gladys.externalIds.bind(this.gladys),
      });
      await this.publishDevices();
      if (!force) {
        await this.publishTransports();
        this.scheduleResubscribe();
      }
    }
  }

  /** The ids whose values matter: the routed states, and the watched ones already seen. */
  followedIds() {
    const created = new Set(this.createdDevices().map((d) => d.external_id));
    const ids = [];
    for (const [id, deviceId] of this.inventory.stateDevice) {
      if (created.has(deviceId) && this.inventory.routes.has(id)) {
        ids.push(id);
      }
    }
    return ids;
  }

  /** Reads the followed states (and the watched ones without long polling), then pushes them. */
  async resync(generation = this.generation) {
    if (generation !== this.generation || this.status !== 'online' || !this.client) {
      return;
    }
    const started = this.now();
    this.lastResyncAt = started;
    const ids = new Set(this.followedIds());
    if (this.config.watched.length > 0) {
      for (const id of Object.keys(this.objects.states)) {
        if (this.watched(id)) {
          ids.add(id);
        }
      }
    }
    if (ids.size === 0) {
      return;
    }
    let states;
    try {
      states = await this.client.getStates([...ids]);
    } catch (err) {
      if (generation === this.generation && this.status === 'online') {
        await this.onFailure(generation, err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    for (const [id, state] of states) {
      const changed = this.changedAt.get(id);
      // A change received while the states were read is newer: it is kept.
      if (changed !== undefined && changed >= started) {
        continue;
      }
      const known = this.values.has(id);
      const previous = this.values.get(id);
      this.values.set(id, state.val);
      // Without long polling, the watched states start their scenes from here.
      if (known && previous !== state.val && this.watched(id)) {
        this.stateEvent(id, state.val, previous);
      }
    }
    this.pushAll();
  }

  async publishDevices() {
    if (!this.gladys.connected) {
      return;
    }
    let devices = this.inventory.devices;
    if (devices.length > MAX_DISCOVERED_DEVICES) {
      // The core refuses the whole list beyond it: the first ones are offered.
      this.logger.warn(
        `${devices.length} devices: only the first ${MAX_DISCOVERED_DEVICES} are offered, narrow the selection`,
      );
      devices = devices.slice(0, MAX_DISCOVERED_DEVICES);
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  scheduleInventory(delay = this.timings.inventoryDebounce) {
    if (this.inventoryTimer) {
      return;
    }
    const generation = this.generation;
    this.inventoryTimer = this.timers.setTimeout(() => {
      this.inventoryTimer = undefined;
      this.refresh(generation).catch((err) =>
        this.logger.warn(`Reading the ioBroker objects failed: ${err.message}`),
      );
    }, delay);
  }

  /** Scan button, widget "Reload": the objects now, and the devices offered again. */
  async scan() {
    if (this.status === 'online' && this.client) {
      this.structure = undefined;
      await this.refresh();
    } else {
      await this.publishDevices();
    }
  }

  // --- States --------------------------------------------------------------------

  /** The external ids of the features of OUR devices added in Gladys. */
  createdFeatures() {
    const ids = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        ids.add(feature.external_id);
      }
    }
    return ids;
  }

  pushState(id, created = this.createdFeatures()) {
    if (!this.values.has(id)) {
      return;
    }
    const val = this.values.get(id);
    for (const route of this.inventory.routes.get(id) ?? []) {
      if (!created.has(route.featureId)) {
        continue;
      }
      let value;
      try {
        value = route.read(val);
      } catch {
        value = null;
      }
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        this.publisher.push(route.featureId, value, route.throttle);
      }
    }
  }

  pushAll() {
    const created = this.createdFeatures();
    for (const id of this.inventory.routes.keys()) {
      this.pushState(id, created);
    }
  }

  /** unreachable for every device while ioBroker is. */
  async publishTransports() {
    if (!this.gladys.connected) {
      return;
    }
    const transport =
      this.status === 'online' ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    const entries = [];
    for (const device of this.createdDevices()) {
      const id = device.external_id;
      if (this.transports.get(id) !== transport) {
        this.transports.set(id, transport);
        entries.push({ external_id: id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      try {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      } catch (err) {
        for (const entry of entries.slice(i, i + 100)) {
          this.transports.delete(entry.external_id);
        }
        this.logger.debug(`Transport badges not sent: ${err.message}`);
      }
    }
  }

  // --- Gladys events -------------------------------------------------------------

  async onGladysConnected() {
    this.transports.clear();
    if (
      this.configKey === undefined ||
      JSON.stringify(this.gladys.config ?? {}) !== this.configKey
    ) {
      await this.configure(this.gladys.config ?? {});
      return;
    }
    await this.publishDevices();
    this.pushAll();
    await this.publishTransports();
  }

  async onDeviceCreated(device) {
    // The SDK forgot the values of this device: they are sent again now.
    this.publisher.forget(device.external_id);
    this.transports.delete(device.external_id);
    this.scheduleResubscribe();
    if (this.status === 'online') {
      // Its states may never have been read: read them now.
      await this.resync();
    } else {
      this.pushAll();
    }
    await this.publishTransports();
    this.requestWidgetRefresh();
  }

  async onDeviceDeleted(device) {
    this.publisher.forget(device.external_id);
    this.transports.delete(device.external_id);
    this.scheduleResubscribe();
    this.requestWidgetRefresh();
  }

  requestWidgetRefresh() {
    if (this.gladys.connected) {
      // Fire-and-forget in the SDK: it may return nothing.
      Promise.resolve()
        .then(() => this.gladys.requestWidgetRefresh(WIDGET_KEY))
        .catch(() => {});
    }
  }

  // --- Commands ------------------------------------------------------------------

  error(key, detail = '') {
    return localizedError(ERRORS[key], this.config.language, detail);
  }

  /** One value to one state, the one way out for devices and scenes. */
  async writeState(id, val) {
    if (this.status !== 'online' || !this.client) {
      throw this.error('offline');
    }
    try {
      await this.client.setState(id, val);
    } catch (err) {
      throw this.translate(err, id);
    }
    if (!this.live) {
      // No long polling: the result is read back instead of waiting for the next poll.
      const generation = this.generation;
      this.timers.setTimeout(() => {
        this.resync(generation).catch(() => {});
      }, this.timings.commandReadBack);
    }
  }

  translate(err, id) {
    if (err instanceof IobAuthError) {
      return this.error('forbidden');
    }
    if (err instanceof IobHttpError && err.status === 404) {
      return this.error('not_found', id);
    }
    return this.error('refused', err.detail || err.message);
  }

  async setValue(device, feature, value) {
    const id = feature.external_id;
    const writer = this.inventory.writers.get(id);
    if (!writer) {
      const state = this.inventory.featureState.get(id);
      if (state && this.inventory.security.has(state) && !this.config.allowSecurity) {
        throw this.error('security_disabled');
      }
      throw this.error('unknown_feature');
    }
    let command;
    try {
      command = writer.write(value);
    } catch (err) {
      if (err instanceof WriteError) {
        throw this.error(err.key);
      }
      throw err;
    }
    this.logger.info(`Command: ${short(command.val, 40)} to ${command.id}`);
    await this.writeState(command.id, command.val);
  }

  /**
   * Scene action: a value to any state, typed by its object. Refused for
   * the security states unless allowed, and for the states ioBroker marks
   * read-only.
   */
  async setStateFromScene(rawId, rawValue) {
    const id = String(rawId ?? '').trim();
    if (!STATE_ID.test(id) || id.length > 500) {
      throw this.error('bad_state');
    }
    if (this.status !== 'online' || !this.client) {
      throw this.error('offline');
    }
    let obj = this.objects.states[id];
    if (!obj) {
      try {
        obj = await this.client.getObject(id);
      } catch (err) {
        throw this.translate(err, id);
      }
      if (obj) {
        obj._id = id;
      }
    }
    if (obj?.type !== 'state') {
      throw this.error('not_found', id);
    }
    const parents = this.objects.parents;
    const holder = Object.keys(parents)
      .filter((p) => id.startsWith(`${p}.`))
      .sort((a, b) => b.length - a.length)
      .map((p) => parents[p])[0];
    if (!this.config.allowSecurity && isSecurityState(obj, holder)) {
      throw this.error('security_disabled');
    }
    if (obj.common?.write === false) {
      throw this.error('read_only');
    }
    const text = String(rawValue ?? '').trim();
    let val;
    if (obj.common?.type === 'boolean') {
      val = toBoolean(text);
    } else if (obj.common?.type === 'number') {
      val = toNumber(text);
    } else {
      val = text.slice(0, 10_000);
    }
    if (val === null) {
      throw this.error('unsupported_value');
    }
    this.logger.info(`Scene action: ${short(val, 40)} to ${id}`);
    await this.writeState(id, val);
  }

  // --- Scene events --------------------------------------------------------------

  sceneEvent(key, data) {
    const now = this.now();
    this.eventWindow = this.eventWindow.filter((t) => now - t < 60_000);
    if (this.eventWindow.length >= EVENTS_PER_MINUTE) {
      if (!this.eventsDropped) {
        this.eventsDropped = true;
        this.logger.warn(
          `More than ${EVENTS_PER_MINUTE} ioBroker events in a minute: the next ones are dropped`,
        );
      }
      return;
    }
    this.eventsDropped = false;
    this.eventWindow.push(now);
    this.gladys
      .publishSceneEvent(key, data)
      .catch((err) => this.logger.debug(`Scene event ${key} not sent: ${err.message}`));
  }

  // --- Connection test, widget ---------------------------------------------------

  async testConnection() {
    if (this.status === 'online') {
      return testMessage({
        version: this.version ?? '?',
        devices: this.inventory.devices.length,
        states: this.inventory.stateCount,
        ignored: this.inventory.ignored,
      });
    }
    const status = ['connecting', 'online'].includes(this.status) ? 'unreachable' : this.status;
    throw localizedError(STATUS[status], this.config.language);
  }

  summary() {
    const created = new Set(this.createdDevices().map((d) => d.external_id));
    let followed = 0;
    for (const [, deviceId] of this.inventory.stateDevice) {
      if (created.has(deviceId)) {
        followed += 1;
      }
    }
    return {
      status: this.status,
      version: this.version,
      live: this.live,
      offered: this.inventory.devices.length,
      added: created.size,
      followed,
    };
  }
}
