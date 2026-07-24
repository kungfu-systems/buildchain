# Product Mechanism

Buildchain's product boundary is the Release Passport: a mature product release
record for artifacts that users or agents depend on.

## Design Pressure

Many repositories can already compile, test, and upload artifacts. The hard
problem is proving what a release means after it has been promoted:

- which reviewed source state was released;
- which exact version-state commit and tag represent that release;
- which artifacts were created;
- which checks and publish steps were allowed to run;
- which floating channel refs now point at that release;
- how another human or agent can verify, explain, mirror, or roll back the
  release without asking the maintainer to reconstruct the story.

Buildchain uses GitHub as the substrate for this proof. It does not require a
project to abandon its existing build system.

## What the Passport Solves

The passport turns a release into a durable record:

- exact tags are immutable release identities;
- floating refs are explicitly machine-updated channel pointers;
- version files are changed by version-state commits, not by unpublished local
  edits;
- build and publish evidence is machine-readable;
- release checks fail closed when evidence is incomplete;
- site and documentation facts can be generated from the package instead of
  being copied by hand.

## Why Binary Distribution Matters

Binary artifacts are a strong proof case because users and agents may execute
them directly. That makes checksums, runner facts, package evidence, and
rollback instructions more urgent.

The protocol is not binary-bound. The same release passport model applies to
npm packages, Python wheels, OCI images, native SDK archives, web-surface
deployments, and multi-artifact product releases.

## Naming

Use these names consistently:

- Product name: `Buildchain`
- Formal first mention: `Buildchain by Kungfu`
- Category anchor: `Buildchain Release Passport`
- Core release record: `buildchain.release.json`

Avoid defining Buildchain as only a workflow collection, a binary distributor,
or a replacement CI/CD platform.

