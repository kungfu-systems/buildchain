# Runtime Train Validation

Buildchain consumers should keep stable workflow refs such as `@v2` in
committed workflow YAML. Runtime trains provide a temporary validation pointer
for Buildchain changes that are ready for downstream testing but not yet
promoted through the normal `dev -> alpha -> release` chain.

Official floating channels are not runtime overrides. A consumer that
deliberately follows `@v2-alpha` gets the matching runtime on pull requests and
pushes because the reusable workflow reads the called workflow identity from
`job.workflow_ref`. Passing `buildchain-ref: v2-alpha` explicitly is also
accepted when the caller wants the channel binding visible in its input set.
The caller's `github.workflow_ref` is not used for this inference because it
identifies the caller workflow during reusable calls.

## Train refs

A train ref is a branch in the Buildchain repository:

```text
train/v2/v2.3/<capability>
```

It is a validation pointer, not a release channel:

- it does not move `v2`, `vX.Y`, `vX.Y-alpha`, exact tags, npm dist-tags, or
  production refs;
- it must not be pinned as a long-term production dependency;
- it should point at the Buildchain commit that downstream maintainers are
  expected to validate;
- it is not a pending merge target or a delivery state;
- the final durable path is still a pull request into the active `dev/*`
  channel, followed by the requested alpha or release promotion.
- it may remain for a retention window after release so initiating repositories
  have a stable fast-use and rollback channel while stable refs, caches, or
  rollout windows settle.

## Buildchain contributor requirement

When a Buildchain change needs downstream validation before stable refs move,
publish a train ref before asking consumers to test it:

```sh
git push origin HEAD:refs/heads/train/v2/v2.3/<capability>
```

Use a capability slug that names the behavior being validated, for example:

```text
train/v2/v2.3/runtime-loader
train/v2/v2.3/toolkit-diagnostics
train/v2/v2.3/site-source-of-truth
```

The pull request or validation request should include the train ref, the exact
commit SHA it points to, and the downstream evidence expected from consumers.
If the train is refreshed, state the new SHA in the validation thread.

After downstream validation succeeds, close out through the normal release
path. Merge the Buildchain pull request into the active `dev/*` mainline, run
the requested alpha or release promotion, and record the final mainline commit
plus release ref or tag in the delivery thread. Do not leave the train as the
item that still needs to be merged; it is only a temporary fast-use,
diagnostic, and rollback channel for initiating repositories. Retained trains
are cleaned up by a separate periodic Buildchain cleanup task.

## Consumer workflow requirement

Consumers keep their reusable workflow pinned to the stable shell:

```yaml
jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
```

To validate a train without committing temporary workflow refs, expose a
trusted manual pass-through once:

```yaml
on:
  workflow_dispatch:
    inputs:
      buildchain-ref:
        description: "Temporary Buildchain runtime ref for trusted manual validation"
        required: false
        default: ""

jobs:
  build:
    uses: kungfu-systems/buildchain/.github/workflows/.build.yml@v2
    with:
      buildchain-ref: ${{ inputs.buildchain-ref || '' }}
```

Buildchain initializes new package workflows with this pass-through. Existing
consumers that do not have it should add it once before validating a train.

## Validation request

Use this short request when a train is ready:

```text
Buildchain train ready: buildchain-ref=train/v2/v2.3/<capability>.
Keep uses: ...@v2; run workflow_dispatch with that buildchain-ref and report the runtime evidence summary.
```

The consumer should run a trusted `workflow_dispatch`, paste the train ref into
`buildchain-ref`, and report the workflow summary or aggregate Buildchain
summary. The evidence should include:

- workflow shell ref;
- requested runtime ref;
- resolved runtime ref;
- resolved runtime SHA;
- stability class;
- trust decision;
- rollback ref.

## Trust and limitation

Official floating channel refs such as `v2` and `v2-alpha` may be selected on
pull requests and pushes. Train refs and arbitrary exact-SHA overrides still
fail closed unless the event is `workflow_dispatch` and the actor has write,
maintain, or admin permission on the caller repository. Pull requests,
including fork-originated pull requests, cannot use train or exact-SHA
overrides.

Runtime train validation covers Buildchain runtime scripts, CLI code, local
actions, configuration parsing, and lifecycle behavior. It cannot validate
changes that require the outer reusable workflow YAML itself to change, such as
new jobs, permissions, workflow outputs, or matrix topology. Those changes need
a canary workflow path or a temporary explicit workflow ref.
