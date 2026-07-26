# Release activation transaction

Buildchain exposes `release-activation-transaction` as the final cross-repository
contract between a qualified product release, its public web surface, and the
product-owned released-evidence projection.

The canonical order is:

1. `candidate-qualified`
2. `artifacts-published`
3. `passport-sealed`
4. `site-published`
5. `public-readback`
6. `evidence-synthesized`

`packages/core/release-activation-transaction.js` is the executable authority.
Every transaction binds an exact product source SHA, exact reviewed site source
SHA, tag, channel, version, environment, artifact-set root, and the three
repository owners. A later phase cannot pass while an earlier phase is
incomplete. Replaying a passed phase is idempotent only when its retained
receipt roots are unchanged.

Released evidence must be synthesized from a canonical receipt set containing
exactly one artifact-publication, release-passport, site-publication,
public-readback, and product-qualification receipt. Every receipt repeats the
same binding root. Missing, duplicated, stale, or substituted roots fail
closed.

Shadow rehearsal uses `mode=shadow`, `environment=shadow`, and always emits
`releasedUseClaim=false`. It is suitable for protected PR qualification and
must never be published as real release evidence. Activation mode requires the
production environment; actual channel mutation remains the caller's protected
publication responsibility.

The web-surface workflow accepts `production-source-sha` only for an explicitly
approved `workflow_dispatch`. It checks out and plans the exact reviewed
consumer commit, while the production environment and normal publication
authority gates remain intact.
