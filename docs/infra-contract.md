# Infra Contract

`project.type = "infra-contract"` models infrastructure release responsibility
without binding Buildchain core to one infrastructure tool. The state machine is:

```text
desired -> validate -> plan -> approval -> apply -> observe -> contract -> propagate
```

The first supported surface is mutation-free: Buildchain validates declarations,
creates a normalized plan, reads reviewed or adapter-shaped observed outputs,
publishes a deterministic contract artifact, and plans downstream consumer pull
requests. Propagation execution is also dry-run by default. Real infrastructure
mutation and real consumer pull request creation are not PR or ordinary push side
effects.

After apply and propagation produce their own result JSON, Buildchain can also
write a lifecycle evidence bundle. The bundle references the immutable contract
artifact by `artifactHash`, verifies that any apply result matches the artifact's
`sourceSha` and plan hash, verifies that propagation results target the same
artifact, and then hashes the combined desired, plan, approval, apply, observe,
contract, and propagation evidence.

## Configuration

```toml
schema = 1

[project]
type = "infra-contract"
name = "infra-kungfu-sites"

[infra]
adapter = "manual-observed"
adoption_mode = "manual-observed"
apply = "disabled"
environment = "staging"
desired = ["desired/site-kungfu-tech.json"]
contract = ["outputs/site-kungfu-tech.json"]

[[consumers]]
repo = "kungfu-systems/site-kungfu-tech"
path = "infra/outputs.json"
source = "outputs/site-kungfu-tech.json"
```

Supported adapters:

```text
manual-observed
aws-cloudformation
terraform
opentofu
pulumi
aws-cdk
aws-cli
custom-command
```

Buildchain's safe fixture set covers the provider-neutral shape without live
provider calls:

- `manual-observed` for existing reviewed resources;
- `aws-cloudformation` for template plus stack output shapes;
- `terraform` for plan/output JSON shapes;
- `opentofu` for plan/output JSON shapes;
- `pulumi` for preview/output JSON shapes;
- `aws-cdk` for synthesized assembly plus stack output shapes;
- `aws-cli` for generic desired request plus observed response shapes;
- `custom-command` for user-defined validate, plan, observe, and approved apply
  hooks.

For built-in provider adapters, Buildchain records planned adapter command
evidence for `validate`, `plan`, `apply`, and `observe` when a stage is
supported. These entries are command plans, not execution. They make the
adapter handoff auditable before a repository opts in to concrete commands,
and they stay `executed: false` even when `--execute-adapter-commands true` is
passed.

Any adapter can declare concrete command hooks under `[infra.commands]`.
Configured commands are the only executable provider surface. Buildchain records
them as planned adapter evidence by default. Passing
`--execute-adapter-commands true` to `plan` or `contract` executes the
non-mutating `validate`, `plan`, or `observe` hooks and stores their exit
status, stdout/stderr, and JSON stdout when present. The `apply` hook is only
available through the saved-plan apply path and is never executed by ordinary
PR validation.

Supported adoption modes:

```text
validate-only
plan-only
observe-only
manual-observed
import-planned
managed-apply
```

`apply = "disabled"` is the default. Non-disabled apply requires
`adoption_mode = "managed-apply"`, a non-empty `environment`, a non-empty
`identity_ref`, and an explicit approval id before mutation. `identity_ref` is a
provider-neutral reference to the runtime role, service account, or environment
credential name; it is not a secret value. Apply also requires a saved plan
artifact whose `sourceSha`, `plannedAt`, and input hash still match the current
repository. Real apply execution requires a configured `[infra.commands].apply`
command, `--dry-run false`, and `--execute-adapter-commands true`. Without a
configured apply command, built-in provider adapters still fail closed before
mutation execution.

For managed apply, bind the target and runtime identity explicitly:

```toml
adoption_mode = "managed-apply"
apply = "manual-approval"
environment = "preview"
identity_ref = "AWS_ROLE_ARN"
```

## CLI

```sh
buildchain infra-contract --mode validate
buildchain infra-contract --mode ci --source-sha "$GITHUB_SHA"
buildchain infra-contract --mode plan --source-sha "$GITHUB_SHA" \
  --output .buildchain/infra-contract-plan.json
buildchain infra-contract --mode plan --source-sha "$GITHUB_SHA" \
  --execute-adapter-commands true \
  --output .buildchain/infra-contract-plan.json
buildchain infra-contract --mode contract \
  --plan .buildchain/infra-contract-plan.json \
  --source-sha "$GITHUB_SHA" \
  --output .buildchain/buildchain.infra-contract.json
buildchain infra-contract --mode propagation-plan \
  --artifact .buildchain/buildchain.infra-contract.json \
  --output .buildchain/infra-contract-propagation.json
buildchain infra-contract --mode propagation-apply \
  --propagation-plan .buildchain/infra-contract-propagation.json \
  --dry-run true \
  --output .buildchain/infra-contract-propagation-apply.json
buildchain infra-contract --mode apply \
  --plan .buildchain/infra-contract-plan.json \
  --source-sha "$GITHUB_SHA" \
  --approval-id "$APPROVAL_ID" \
  --dry-run true \
  --output .buildchain/infra-contract-apply.json
buildchain infra-contract --mode apply \
  --plan .buildchain/infra-contract-plan.json \
  --source-sha "$GITHUB_SHA" \
  --approval-id "$APPROVAL_ID" \
  --dry-run false \
  --execute-adapter-commands true \
  --output .buildchain/infra-contract-apply.json
buildchain infra-contract --mode evidence-bundle \
  --artifact .buildchain/buildchain.infra-contract.json \
  --apply-result .buildchain/infra-contract-apply.json \
  --propagation-result .buildchain/infra-contract-propagation-apply.json \
  --output .buildchain/infra-contract-evidence-bundle.json
buildchain verify infra-contract-evidence-bundle \
  .buildchain/infra-contract-evidence-bundle.json
```

`ci` is the default mutation-free lifecycle entrypoint for repositories created
with `buildchain init --type infra-contract`. It validates the project, writes a
plan, writes an observed contract artifact, writes a propagation plan, runs
propagation apply in dry-run mode, creates an evidence bundle, and verifies that
bundle. It does not execute provider apply commands or open consumer PRs.

For projects where apply is disabled, omit `--apply-result`. For projects with
no consumers, omit `--propagation-result`.

The evidence-bundle verifier is read-only. It recomputes the bundle hash,
checks the contract artifact hash, verifies that desired, plan, approval,
apply, observe, contract, and propagate evidence are all present, recomputes
the bundle validation summary, and fails closed when apply or propagation
results are not bound to the same artifact.

## Safety

- PR validation is mutation-free.
- `buildchain infra-contract --mode ci` is mutation-free by default and produces
  auditable `.buildchain/infra-contract*.json` evidence for reusable workflow
  artifacts.
- `manual-observed` and observe-only modes cannot apply.
- Apply fails before mutation unless approval, target environment, identity
  reference, adapter capability, and ownership mode are explicit.
- Apply rejects missing, stale, source-mismatched, or input-drifted plan
  artifacts before any adapter mutation can run.
- Built-in provider adapter command evidence is planned-only unless the
  repository declares a concrete command for that stage under `[infra.commands]`.
- Provider apply requires saved plan freshness, an approval id, target
  environment, identity reference, a configured apply command,
  `--dry-run false`, and `--execute-adapter-commands true`; nonzero adapter
  exits fail closed and are recorded as adapter evidence.
- Terraform/OpenTofu state files and Pulumi state or secret JSON files are not
  accepted as contract inputs.
- Consumers are represented as pull request plans. `propagation-apply` defaults
  to dry-run; real PR creation requires `--dry-run false`, `--approval-id`, and
  explicit `--consumer-workspace owner/repo=/path/to/checkout` mappings.
- Buildchain never pushes mirrored contract files directly to consumer main
  branches. Real propagation creates reviewable branches and calls
  `gh pr create`.
- Evidence bundles do not execute adapters, mutate infrastructure, or open PRs.
  They only verify and hash already saved contract, apply, and propagation
  outputs.
- `buildchain verify infra-contract-evidence-bundle` is read-only and fails
  closed when the lifecycle evidence chain is incomplete, tampered, or carries
  a stale validation summary.
