# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Do not open a public issue.

Expect an acknowledgement within three working days. If you have not heard
back, assume the message was lost and say so publicly enough that we notice —
silence is our failure, not your cue to stay quiet indefinitely.

**Disclosure window.** We aim to ship a fix within 90 days of the
acknowledgement and will tell you where we are at 30 and 60. Publish at 90
whether or not we are done; if we need longer we will ask, and the answer is
yours to give. Nothing here asks you to wait indefinitely, and we will not
treat a deadline you set as bad faith. Credit is yours by default — tell us if
you would rather not be named.

## What Standfast promises

**Source code never leaves the machine.** This is a founding invariant, not a
configuration option. Reconciliation runs inside the customer's own agent
session; what returns is a verdict and a `path:line`. An API endpoint that
accepts a code snippet is a bug of the highest severity, and a schema
constraint should have refused it before a reviewer had to.

Two design rules follow, and both are in scope for a report:

- **Privacy boundaries are enforced at the wire.** Schema constraint, database
  constraint, permanent regression test. If you can construct a request that
  crosses a tenant boundary and is *not* rejected by row-level security, that
  is a vulnerability regardless of what the application layer would have done.
- **Allowlist, never denylist**, for anything that leaves the machine. A field
  that escapes because it was not on a block list is a vulnerability.

## Knowledge is an instruction channel

A canonical atom is injected into every future agent session. Treat it as a
security surface, not as content. Reports about prompt injection through
ratified knowledge, provenance spoofing, or a path by which an agent could
promote its own writing to canonical without human ratification are in scope
and are taken as seriously as a memory-safety bug would be elsewhere.

See `docs/13-threat-model.md`.

## Supply chain

GitHub Actions are pinned by commit SHA and container images by digest. Release
publishing is configured for npm provenance attestations, and nothing has been
published yet — so that is a promise about the first release, not a property of
an artifact you can check today. A report that some pin has silently become
mutable is in scope.

## Scope

This repository, its published `@standfast/*` packages, and the CI that builds
them. Findings in third-party dependencies should go upstream first; tell us
too if Standfast's use of them makes the impact worse.
