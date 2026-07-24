# Security policy

[中文](./SECURITY.md)

## Supported versions

Peerto supports only the latest version of the main branch. The project does not provide security updates for old PWA builds, signaling fields, or file protocols.

## Reporting a vulnerability

Use "Report a vulnerability" in the GitHub repository's Security Advisory section. Do not open a public Issue or run tests on the demo site that could affect other users.

Include:

- The affected commit or version
- Conditions and minimal reproduction steps
- The actual impact
- Checks you have already performed
- A suggested fix, if you have one

Do not send real user data, private TURN credentials, Cloudflare tokens, or server login details. If a sensitive sample is necessary, agree on a transfer method in the Security Advisory first.

Maintainers will acknowledge the report, assess its impact, and plan a fix. The publication date should be agreed after a fixed version is available.

## Scope

The following behaviors are not Peerto vulnerabilities by themselves:

- Some NAT and firewall combinations cannot connect directly without TURN
- A public STUN server can see the source IP address of a request
- A browser must know the TURN endpoint and credentials it uses
- Clearing browser site data removes local identity, history, and pairings
- A malicious extension with access to browser configuration can read site storage on the same device

Report the issue privately if one of these behaviors bypasses authentication, reads another session's data, causes unbounded server resource use, or exposes credentials that were not public.
