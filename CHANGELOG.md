# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-20

### Added

- ioBroker bridge through the rest-api adapter: the states of ioBroker offered
  in the Discovery tab, one device per ioBroker device (else per channel, else
  per state), named with its room, filtered by id pattern, room and excluded
  states.
- Switches, lights (on/off, brightness, RGB colour), shutters (position, open,
  close, stop), thermostat setpoints, opening sensors, detectors (motion,
  presence, leak, smoke, CO, tamper, vibration, low battery), locks, and
  measurements by role or unit (temperature, humidity, pressure, illuminance,
  power, energy, voltage, current, CO2, UV, wind, battery).
- Live values through the long polling of rest-api, a full reading every
  5 minutes (every 30 seconds without long polling), unreachable badges when
  ioBroker is down.
- Commands only for the states marked writable by ioBroker; locks, gates, garage
  doors and alarms read-only unless allowed in the configuration.
- Optional basic authentication with an ioBroker user.
- Scene trigger "ioBroker state changed" for the watched states, scene action
  "set an ioBroker state", dashboard widget, connection test.
- English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-iobroker/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-iobroker/releases/tag/v1.0.0
