# Infra Contract

`project.type = "infra-contract"` models infrastructure release responsibility
without binding Buildchain core to one infrastructure tool. The state machine is:

```text
desired -> validate -> plan -> approval -> apply -> observe -> contract -> propagate
```

The first supported surface is mutation-free: Buildchain validates declarations,
creates a normalized plan, reads reviewed or adapter-shaped observed outputs,
publishes a deterministic contract artifact, and plans downstream consumer pull
requests. Real infrastructure mutation is not a PR or ordinary push side effect.

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
input hash still match the current repository. The current implementation plans
approved apply but fails closed before adapter mutation execution.

## CLI

```sh
buildchain infra-contract --mode validate
buildchain infra-contract --mode plan --source-sha "$GITHUB_SHA" \
  --output .buildchain/infra-contract-plan.json
buildchain infra-contract --mode contract \
  --plan .buildchain/infra-contract-plan.json \
  --source-sha "$GITHUB_SHA" \
  --output .buildchain/buildchain.infra-contract.json
buildchain infra-contract --mode propagation-plan \
  --artifact .buildchain/buildchain.infra-contract.json \
  --output .buildchain/infra-contract-propagation.json
buildchain infra-contract --mode apply \
  --plan .buildchain/infra-contract-plan.json \
  --source-sha "$GITHUB_SHA" \
  --approval-id "$APPROVAL_ID" \
  --dry-run true \
  --output .buildchain/infra-contract-apply.json
```

## Safety

- PR validation is mutation-free.
- `manual-observed` and observe-only modes cannot apply.
- Apply fails before mutation unless approval, adapter capability, and ownership
  mode are explicit.
- Apply rejects missing, stale, source-mismatched, or input-drifted plan
  artifacts before any adapter mutation can run.
- Terraform/OpenTofu state files and Pulumi state or secret JSON files are not
  accepted as contract inputs.
- Consumers are represented as pull request plans; Buildchain does not directly
  push mirrored contract files to consumer main branches.
