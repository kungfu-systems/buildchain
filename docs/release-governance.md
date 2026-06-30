# Release Governance

Buildchain v2 preserves the release semantics of the older ABV workflow while
moving the implementation into one modern repository.

The central idea is simple: a reviewed merge into a release channel is the
release intent. Automation must then create the version-state commit, exact tag,
floating tag, and next alpha state that make that intent true in Git.

## Design Problem

Kungfu release automation has to keep four facts aligned:

1. The source tree that was reviewed.
2. The package version recorded in manifests such as `package.json` or
   `lerna.json`.
3. The exact immutable release or prerelease tag.
4. The floating channel refs that consumers actually use.

If any one of these facts is updated by hand, the system can split:

- a consumer can fetch `v2.0` and receive a tree whose package version still
  says the previous release;
- a maintainer can move `v2` without producing an exact `v2.0.N` audit tag;
- an alpha can be promoted to production even though the release tree is not the
  same tree that was tested;
- a protected branch merge can succeed while the follow-up version commit is
  missing.

The older ABV workflow addressed this by letting GitHub PRs drive release
state. Buildchain keeps that choice because it makes release intent reviewable,
observable, and recoverable from Git history.

## What ABV Contributed

The old ABV model was not just "bump a version number." It encoded a governance
loop:

- release branches are named as channels: `dev`, `alpha`, `release`, and the
  administrative `major-gate`;
- a PR from one channel to the next is the release request;
- verify jobs check that the branch pair is valid before merge;
- a maintainer review is required before the branch moves;
- after merge, automation writes the version change and moves tags;
- exact tags and floating refs are aligned with the resulting commit;
- the next development channel is prepared automatically.

ABV also kept the version-state mutation in the repository. For JavaScript
repositories that usually meant changing `lerna.json` and/or `package.json`.
That commit is important because the tag alone is not enough evidence: the
source tree should also declare the version that the tag advertises.

Buildchain v2 treats that as a hard semantic requirement for its own release
line.

## Buildchain Implementation

Buildchain implements the same governance loop with:

- `.github/workflows/release-verify.yml` for PR verification;
- `.github/workflows/buildchain-ref-promotion.yml` for post-verify ref
  promotion;
- `actions/promote-buildchain-ref` for branch, tag, version-state, and
  governance checks;
- package-manager adapters that can update version state for pnpm, npm, and
  yarn style repositories;
- `buildchain.toml` lifecycle configuration for repositories whose version
  state or verification commands are not Node package-manager defaults.

The implementation is intentionally stricter than a local release script:

- manual workflow dispatch can only do dry-run promotion;
- non-dry-run promotion must be driven by a completed `Verify` workflow;
- target branch protection details must be readable, and branch protection must
  apply to administrators as well as regular contributors;
- alpha promotion must come from a merged same-repository PR from
  `dev/vX/vX.Y` to `alpha/vX/vX.Y`;
- release promotion must come from a merged same-repository PR from
  `alpha/vX/vX.Y` to `release/vX/vX.Y`;
- major promotion must come from a merged same-repository PR from
  `release/vX/vX.Y` to `major-gate`;
- release promotion requires an existing same-patch alpha tag and checks the
  release source tree against that tested alpha tree;
- generated version-state commits are verified before refs move.

## Version Lines

Kungfu uses Python-like version lines where a minor line can represent a
long-lived product train. A line such as `v2.0` can produce many production
patch releases:

```text
v2.0.0
v2.0.1
v2.0.2
...
v2.0.1234
```

This is why Buildchain maintains both exact and floating refs:

- `v2.0.2` is immutable release evidence;
- `v2.0` is the latest production release on the `2.0` line;
- `v2` is the selected stable major-line entrypoint;
- `v2.0.3-alpha.0` is immutable alpha evidence;
- `v2.0-alpha` is the latest test channel for the `2.0` line.

A release does not mean "minor is complete." It means "this patch on this minor
line is now production."

## Alpha Semantics

An alpha merge is:

```text
dev/vX/vX.Y -> alpha/vX/vX.Y
```

Buildchain then:

1. Computes the next prerelease for the minor line.
2. Writes version state such as `vX.Y.Z-alpha.N`.
3. Verifies the generated version-state tree.
4. Creates or reuses the exact alpha tag.
5. Moves `alpha/vX/vX.Y` to the generated alpha commit.
6. Moves `dev/vX/vX.Y` to the same generated alpha commit.
7. Moves `vX.Y-alpha` to the same generated alpha commit.

This keeps the test channel self-describing. If a consumer checks out
`v2.0-alpha`, the manifests and exact alpha tag agree.

## Release Semantics

A release merge is:

```text
alpha/vX/vX.Y -> release/vX/vX.Y
```

Buildchain then:

1. Finds the same-patch alpha tag that was tested.
2. Checks that the release source tree matches that alpha tag tree, excluding
   only generated version-state differences.
3. Writes final release version state such as `vX.Y.Z`.
4. Verifies the generated release tree.
5. Creates or reuses the exact release tag `vX.Y.Z`.
6. Moves `release/vX/vX.Y` to the exact release commit.
7. Moves `vX.Y` to the exact release commit.
8. Moves `vX` when this minor line should be the stable major entrypoint.
9. Prepares the next alpha version-state commit, such as
   `vX.Y.(Z+1)-alpha.0`.
10. Moves `alpha/vX/vX.Y`, `dev/vX/vX.Y`, and `vX.Y-alpha` to that next alpha
    commit.

The production channel and the test channel therefore intentionally diverge
after release: production stays on the release commit, while alpha/dev continue
at the next prerelease commit.

## Major Gate Semantics

A major-gate merge is:

```text
release/vX/vX.Y -> major-gate
```

`major-gate` is the explicit replacement for the older ABV `main` channel. The
name is intentionally operational: it is a gate for a rare administrator
decision, not the active trunk. Keeping this decision in the same PR UI as
alpha and release promotion keeps the human workflow simple while avoiding the
misleading meaning of `main`.

Buildchain then:

1. Verifies the source is a merged same-repository PR from a protected release
   line into `major-gate`.
2. Writes the next major production version state, such as `v(X+1).0.0`.
3. Creates or reuses the exact release tag `v(X+1).0.0`.
4. Moves `major-gate` and `release/v(X+1)/v(X+1).0` to that release commit.
5. Moves `v(X+1).0` and `v(X+1)` to that release commit.
6. Prepares the next alpha version-state commit, such as
   `v(X+1).0.1-alpha.0`.
7. Moves `alpha/v(X+1)/v(X+1).0`, `dev/v(X+1)/v(X+1).0`, and
   `v(X+1).0-alpha` to that next alpha commit.

Checking out `major-gate` should therefore look like a frozen release state, not
like a branch where day-to-day source work continues. Day-to-day source work
continues on `dev/vX/vX.Y`.

## Package-Manager Adapters

Old ABV assumed JavaScript repositories with root version state and often
Lerna. Buildchain keeps the version-state contract but does not assume every
repository is yarn/Lerna.

The promotion action discovers and updates:

- root `package.json`;
- `lerna.json`;
- package manifests from `package.json` workspaces;
- package manifests from `lerna.json` packages;
- package manifests from `pnpm-workspace.yaml`.

It then runs the repository's detected package manager semantics where needed:

- pnpm repositories use pnpm-oriented workspace discovery;
- npm repositories use npm/package-lock semantics where present;
- yarn repositories use yarn-style metadata where present.

For Buildchain itself, version state is required. For a consumer repository that
has no package manifest, the same action can degrade to ref-only behavior only
when that is explicitly allowed by the caller.

## Lifecycle Configuration

`buildchain.toml` is the v2 user configuration format. It lets a repository
declare version-state files and lifecycle commands without pretending every
project is a Node workspace. Supported version files include JSON, TOML, and
regex-based files such as `CMakeLists.txt` or `conanfile.py`.

The promotion action currently consumes `version.files` and `lifecycle.verify`.
The verify stage runs after generated version-state changes are applied locally
and before any release refs move. If `verification-command` is passed directly
to the action, that explicit command overrides `lifecycle.verify`.

Protected release-line branches keep their normal review gate. When generated
version state would move a protected alpha or release branch, Buildchain creates
a version-state PR instead of bypassing branch protection. After that PR is
reviewed, checked, and merged, the next promotion run verifies that only
declared version-state files changed from the legally merged source parent, then
moves the exact and floating tags.

## What This Guarantees

When the loop succeeds, maintainers and consumers can rely on these facts:

- every production release has an exact tag such as `v2.0.2`;
- every production minor line has a floating tag such as `v2.0`;
- every selected stable major has a floating tag such as `v2`;
- every next-major release is driven by a reviewed `release -> major-gate` PR,
  not a hidden manual button;
- every test channel has an exact alpha tag such as `v2.0.3-alpha.0`;
- every alpha minor line has a floating tag such as `v2.0-alpha`;
- version manifests match the tag visible from the same commit;
- production releases are derived from the alpha tree that was tested;
- manual non-dry-run promotion cannot bypass PR review and verification;
- admin users cannot make a channel promotion valid by temporarily bypassing
  branch protection.

This is the practical meaning of "governance closed loop" in Buildchain: the
decision, code, version state, and Git refs close over the same evidence chain.

## What This Does Not Do

Buildchain release promotion does not publish packages or external artifacts by
itself. Publishing remains the responsibility of explicit consumer workflows.

Buildchain also does not maintain bare exact tags such as `1.0.0`. The supported
exact release and alpha refs are v-prefixed:

```text
v2.0.0
v2.0.1-alpha.0
```

## Operational Reading Order

When debugging or extending release behavior, read in this order:

1. `docs/release-flow.md`
2. `.github/workflows/release-verify.yml`
3. `.github/workflows/buildchain-ref-promotion.yml`
4. `actions/promote-buildchain-ref/README.md`
5. `actions/promote-buildchain-ref/src/`
6. `docs/migration-inventory.md`

That path gives the policy first, the workflow trigger second, and the action
implementation last.
