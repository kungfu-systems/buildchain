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
- `pulumi` for preview/output JSON shapes;
- `custom-command` for user-defined validate, plan, observe, and approved apply
  hooks.

`custom-command` adapters declare command hooks under `[infra.commands]`.
Buildchain records them as planned adapter evidence by default. Passing
`--execute-adapter-commands true` to `plan` or `contract` executes the
non-mutating `validate`, `plan`, or `observe` hooks and stores their exit status,
stdout/stderr, and JSON stdout when present. The `apply` hook is only available
through the saved-plan apply path and is never executed by ordinary PR
validation.

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
`adoption_mode = "managed-apply"` and an explicit approval id before mutation.
Apply also requires a saved plan artifact whose `sourceSha`, `plannedAt`, and
input hash still match the current repository. Real apply execution is currently
implemented only for `custom-command`, and it still requires `--dry-run false`
plus `--execute-adapter-commands true`. Other adapters fail closed before
mutation execution until their concrete executors are implemented.

## CLI

```sh
buildchain infra-contract --mode validate
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
```

For projects where apply is disabled, omit `--apply-result`. For projects with
no consumers, omit `--propagation-result`.

## Safety

- PR validation is mutation-free.
- `manual-observed` and observe-only modes cannot apply.
- Apply fails before mutation unless approval, adapter capability, and ownership
  mode are explicit.
- Apply rejects missing, stale, source-mismatched, or input-drifted plan
  artifacts before any adapter mutation can run.
- Custom-command apply requires saved plan freshness, an approval id,
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
