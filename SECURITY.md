# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes. The
integration stores nothing in `/data`: its configuration (the address of the
rest-api adapter, the optional ioBroker user name and password) is kept by
Gladys and given to the container at start-up. It only talks to the rest-api
adapter configured, on the local network, over HTTP or HTTPS; the password is
never written to the logs, and an address holding credentials is refused.
Commands of locks, gates, garage doors and alarms are refused unless the user
allows them, from devices and scenes alike.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and ioBroker, its adapters and the devices they talk to.
