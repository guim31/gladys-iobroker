# gladys-iobroker

[Gladys Assistant](https://gladysassistant.com) external integration that
bridges **ioBroker**: the states of an ioBroker installation become Gladys
devices, their values follow ioBroker live, and Gladys controls them through
ioBroker, which keeps its adapters. Local only. Not affiliated with ioBroker
GmbH or the ioBroker project.

> Tested against a real ioBroker (js-controller 7.2.5, `rest-api` adapter
> 4.0.3, Docker image `buanet/iobroker`) with objects reproduced from the
> Homematic IP, Shelly and Zigbee adapters, without their hardware: feedback
> from real installations is welcome.

## What it does

- **Discovery**: one Gladys device per ioBroker device (a Homematic IP actuator
  with all its channels), else per channel, else per state, named with its room
  (`enum.rooms`). Filters by id pattern, by room and by excluded states.
- **Roles**: switches and lights (on/off, brightness, RGB colour), shutters
  (position, open/close/stop), thermostat setpoints, opening sensors (boolean
  and Homematic `value.window`), motion, presence, leak, smoke, CO, tamper,
  vibration, low battery, locks, and measurements by role or unit
  (temperature, humidity, pressure, illuminance, power, energy, voltage,
  current, CO2, UV, wind, battery…).
- **Live values** through the long polling of the `rest-api` adapter,
  subscribed only to the devices added in Gladys; the followed states are read
  again every 5 minutes, every 30 s without long polling; a watchdog opens a new
  session when rest-api restarts.
- **Commands** like the ioBroker interface (`ack: false`), only for the states
  whose object says `write: true`.
- **Safety**: locks, gates, garage doors and alarms are read-only unless
  allowed; a scene cannot get around it.
- **Scene trigger** "ioBroker state changed" for the watched states, **scene
  action** "set an ioBroker state", a **dashboard widget** with the connection
  and a reload button, and a **connection test** listing the roles not imported.
- Four languages (English, French, German, Spanish).

## Requirements

- Gladys Assistant 5.1.0 or later.
- ioBroker reachable from the Gladys machine, with the **REST API** adapter
  (`rest-api`, port 8093). Authentication optional (basic, an ioBroker user).

## Installation

In Gladys: **Integrations → Install from GitHub**, address
`https://github.com/guim31/gladys-iobroker`. Then follow the
[documentation](docs/en.md).

## How it works

- `GET /v1/objects?filter=<pattern>&type=state|channel|device` builds the
  inventory (`src/inventory.js`, `src/mapping.js`); rest-api gives each object
  the enums it belongs to, inherited from its channel and device.
- `POST /v1/command/getStates` reads the followed states in bulk.
- `GET /v1/polling?sid=…` (long polling) carries one change per answer, after
  `POST /v1/states/subscribe` for each added device (`<device id>.*`) and each
  watched pattern, and `POST /v1/objects/subscribe` for the object changes.
- Commands are `PATCH /v1/state/<id>` with `{ val, ack: false }`; the value the
  adapter acknowledges is the feedback.
- External ids are built from the ioBroker ids, which never change:
  `object:<device, channel or state id>` for devices, `<state id below it>-<role>`
  for features.
- States are sent only for the devices added in Gladys, only when they change
  (12 h heartbeat), within the 300 states per minute of the core.

Why `rest-api` and not `simple-api`: simple-api has no push at all, rest-api has
long polling, bulk reading and object listing in one adapter. Pitfalls met on the
real adapter are in `CLAUDE.md`.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/iobroker/objects.json` is the object tree of a real ioBroker
(states, channels, devices and their values), metadata removed.
`test/helpers/fakeIobroker.js` serves it through an injected `fetch`, with the
long polling behaviour of rest-api 4.0.3; `test/gladys-rules.test.js` checks
every device against the feature table of the Gladys core.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

- [ioBroker](https://github.com/ioBroker) (MIT): the
  [rest-api adapter](https://github.com/ioBroker/ioBroker.rest-api), the
  [state roles](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/stateroles.md)
  and [@iobroker/type-detector](https://github.com/ioBroker/ioBroker.type-detector),
  read as documentation; the logo of the cover, from
  [ioBroker.admin](https://github.com/ioBroker/ioBroker.admin) (MIT); the Docker image
  [buanet/iobroker](https://github.com/buanet/ioBroker.docker) for the fixtures
  and the tests.
- [guim31/gladys-openhab](https://github.com/guim31/gladys-openhab) and
  [guim31/gladys-homeassistant](https://github.com/guim31/gladys-homeassistant)
  (Apache-2.0), whose bridge structure is reused, and
  [LM1LC3N7/gladys-homey](https://github.com/LM1LC3N7/gladys-homey)
  (Apache-2.0), the origin of the state publisher (`src/publisher.js`).

## Limits

Not imported: texts, JSON and states with a generic role and no unit (watch
them with the scene trigger, write them with the scene action), colour
temperature, hue and tilt. Developed without real Homematic, Shelly or Zigbee
hardware. See the [documentation](docs/en.md#limits).

## License

Apache-2.0, see [LICENSE](LICENSE). ioBroker is a trademark of its owners; this
project is not affiliated with them.
