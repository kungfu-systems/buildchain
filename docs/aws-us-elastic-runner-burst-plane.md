---
status: draft
period: 2026-07-28
theme: aws-us-elastic-runner-burst-plane
doc_type: design
source_level: local-files-and-provider-docs
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-29
---

# AWS US elastic runner burst plane

The local runner fleet remains the normal Kungfu build plane. This AWS US plane
is an explicit, temporary overflow mechanism with sequential qualification:

1. Linux CodeBuild proof of concept under USD 50.
2. Windows EC2 one-job JIT runners.
3. One bounded 24-hour EC2 Mac campaign.

No later phase can start from design intent alone. The preceding phase must
produce a qualifying source-bound receipt, actual cost, and zero-resource
cleanup proof.

## Phase 1 contract

`aws-us-codebuild-linux` is a Linux-only runner preset. It requires the exact
CodeBuild project name and resolves the runner label at workflow evaluation
time:

```text
codebuild-<project>-<github.run_id>-<github.run_attempt>
```

The GitHub-hosted `trust-gate` remains ahead of the matrix job. A fork pull
request therefore fails or skips before the CodeBuild `runs-on` label exists as
a queued job. The dedicated consumer workflow is manual-only and does not add
the preset to dev, alpha, release, signing, notarization, deployment, or
publication workflows.

The CodeBuild project is:

- repository-scoped through an AWS CodeConnections GitHub App;
- one ephemeral runner and one GitHub job per CodeBuild build;
- outside a VPC, with no idle VM, NAT gateway, public ingress, SSH, or persistent
  workspace;
- limited to two concurrent builds, 15 queued minutes, and 40 execution
  minutes;
- allowed to write only its dedicated CloudWatch log group and request a token
  from its dedicated GitHub App connection;
- forbidden from receiving signing, notarization, package publication, release,
  deploy, static AWS, long-lived GitHub, or SSH credentials.

The AWS-managed Ubuntu 24.04 standard image is the immutable base. Before a
native lifecycle starts, Buildchain installs the distribution's `gcc-14` and
`g++-14` packages, exposes only per-job `gcc`/`g++` aliases, and downloads the
pinned Kitware CMake 3.31.6 archive after verifying its reviewed SHA256. The
resolved package manager, versions, and CMake source digest are retained as
`aws-native-toolchain.json`; no toolchain state survives the ephemeral
CodeBuild execution. The toolchain adapter also retains the reviewed Amazon
Linux 2023 `gcc14` path for compatible projects.

## Cost and kill-switch envelope

The 2026-07-28 AWS Price List entry for
`BUILD_GENERAL1_XLARGE` Linux in `us-east-1` is USD 0.0798 per build minute.
The contract rounds that rate up to USD 0.08. Twelve fully timed-out accepted
builds reserve at most USD 38.40. At project concurrency two, the fail-closed
controller can see at most two over-cap builds. The envelope conservatively
charges both race builds for their complete 40-minute timeout rather than
assuming fast EventBridge delivery. The bounded CodeBuild maximum is therefore
USD 44.80, below the dedicated USD 49 budget and leaving USD 4.20 for the small
controller, state, notification, and log charges.

The controller stores an idempotent build-id ledger, an atomic accepted-build
counter, and worst-case reservation in DynamoDB. Duplicate EventBridge delivery
does not consume the bounded build allowance. It deletes the CodeBuild webhook
and stops the triggering build when:

- the accepted-build or reserved-cost cap is reached;
- actual-cost telemetry is missing or more than six hours old;
- actual CodeBuild spend reaches the budget;
- AWS Budgets sends the 80% or 95% actual-spend notification;
- the kill switch was already set.

The stack starts fail closed: it has no cost telemetry item and CloudFormation
does not create the webhook. Before arming the webhook, the operator must write
a current Cost Explorer observation to the `COST` item, clear only the dedicated
controller's killed state, and create the exact workflow-filtered webhook.
Re-arming after any kill is a separate provider mutation and requires a new
explicit approval.

## Qualification evidence

Each successful job uploads `aws-runner-burst.json`, binding:

- consumer repository, exact source SHA and ref;
- GitHub run id, attempt and job;
- CodeBuild project, build id, build ARN and initiator;
- observation timestamp and canonical digest.

Linux qualification requires:

- at least 10 trusted exact-source successful jobs;
- observed concurrency of at least two;
- p95 queue-to-start of at most five minutes;
- actual incremental AWS spend below USD 49;
- no idle build and no active cloud residue.

`node scripts/aws-runner-burst.mjs verify-linux --input <snapshot.json>` fails
closed when cost telemetry is missing/stale or any acceptance predicate is
false.

### Phase 1 recorded outcome

The Linux phase passed on 2026-07-29. Ten trusted exact-source Kungfu jobs
completed successfully, including four overlapping two-job waves. The observed
CodeBuild queue-to-start p95 was 0.696 seconds. All 16 paid executions,
including six diagnostic runs, produced a conservative incremental compute
upper bound of USD 25.798 by rounding every execution up to a whole minute at
the live AWS Price List rate.

The global webhook kill switch was exercised after the tenth qualifying job.
The project then reported no webhook or in-progress build, and the card-owned
EC2 inventory was empty. AWS Billing and Cost Explorer still reported an
estimated zero during their provider ingestion delay; the retained
execution-derived upper bound is therefore the immediate cost proof and must be
reconciled with the eventual AWS line item in the final campaign report.

The source-bound evidence and deterministic phase receipt are:

- `evidence/aws-us-elastic-runner-burst-plane/linux-codebuild-qualification-input.json`
- `evidence/aws-us-elastic-runner-burst-plane/linux-codebuild-qualification-receipt.json`

## Provider lifecycle

The infrastructure template is
`infra/aws-us-elastic-runner-burst-plane/codebuild-poc.template.yml`.
Creating a change set is the review boundary. Executing it, completing the
GitHub App connection, creating or re-arming a webhook, writing cost telemetry,
dispatching paid jobs, operating the kill switch, and deleting the stack are
all explicit provider mutations.

The reviewed Phase 1 provider sequence is below. It deliberately separates
connection creation, change-set inspection, stack execution, cost observation,
and webhook arming:

```bash
burst_profile=us
burst_region=us-east-1
burst_stack=kungfu-buildchain-linux-burst-poc
burst_project=kungfu-buildchain-linux-burst-poc
burst_connection_name=kungfu-linux-burst-poc
burst_change_set=phase1-linux-codebuild-poc

aws --profile "$burst_profile" --region "$burst_region" \
  codeconnections create-connection \
  --provider-type GitHub \
  --connection-name "$burst_connection_name" \
  --tags Key=kungfu:owner,Value=buildchain \
    Key=kungfu:plane,Value=aws-us-elastic-runner-burst
```

CodeConnections limits connection names to 32 characters. Keep the shorter
connection name above distinct from the longer CloudFormation stack and
CodeBuild project names.

The returned connection is `PENDING` until an operator completes the GitHub App
handshake in AWS. Read back `ConnectionStatus=AVAILABLE` before creating the
change set. Do not put an OAuth token or GitHub token in the shell:

```bash
burst_connection_arn=REPLACE_WITH_AVAILABLE_CONNECTION_ARN

aws --profile "$burst_profile" --region "$burst_region" \
  codeconnections get-connection \
  --connection-arn "$burst_connection_arn"

aws --profile "$burst_profile" --region "$burst_region" \
  cloudformation create-change-set \
  --stack-name "$burst_stack" \
  --change-set-name "$burst_change_set" \
  --change-set-type CREATE \
  --template-body \
    file://infra/aws-us-elastic-runner-burst-plane/codebuild-poc.template.yml \
  --capabilities CAPABILITY_IAM \
  --parameters \
    ParameterKey=GitHubConnectionArn,ParameterValue="$burst_connection_arn" \
    ParameterKey=ProjectName,ParameterValue="$burst_project"

aws --profile "$burst_profile" --region "$burst_region" \
  cloudformation wait change-set-create-complete \
  --stack-name "$burst_stack" \
  --change-set-name "$burst_change_set"

aws --profile "$burst_profile" --region "$burst_region" \
  cloudformation describe-change-set \
  --stack-name "$burst_stack" \
  --change-set-name "$burst_change_set"
```

Only after the change-set resource list and IAM diff are accepted:

```bash
aws --profile "$burst_profile" --region "$burst_region" \
  cloudformation execute-change-set \
  --stack-name "$burst_stack" \
  --change-set-name "$burst_change_set"

aws --profile "$burst_profile" --region "$burst_region" \
  cloudformation wait stack-create-complete \
  --stack-name "$burst_stack"
```

Arming requires a fresh, operator-observed CodeBuild cost value. `COST` is the
only mutable telemetry item and `CONTROL` is the only state cleared:

```bash
burst_table=$(
  aws --profile "$burst_profile" --region "$burst_region" \
    cloudformation describe-stacks \
    --stack-name "$burst_stack" \
    --query "Stacks[0].Outputs[?OutputKey=='StateTable'].OutputValue" \
    --output text
)
burst_observed_at=$(date -u +%s)
burst_actual_usd=REPLACE_WITH_CURRENT_CODEBUILD_ACTUAL_USD

aws --profile "$burst_profile" --region "$burst_region" \
  dynamodb put-item \
  --table-name "$burst_table" \
  --item "{\"pk\":{\"S\":\"COST\"},\"actual_usd\":{\"N\":\"$burst_actual_usd\"},\"observed_at\":{\"N\":\"$burst_observed_at\"}}"

aws --profile "$burst_profile" --region "$burst_region" \
  dynamodb delete-item \
  --table-name "$burst_table" \
  --key '{"pk":{"S":"CONTROL"}}'

aws --profile "$burst_profile" --region "$burst_region" \
  codebuild create-webhook \
  --project-name "$burst_project" \
  --filter-groups \
    '[[{"type":"EVENT","pattern":"WORKFLOW_JOB_QUEUED"},{"type":"WORKFLOW_NAME","pattern":"^AWS US Linux Burst Qualification$"}]]'
```

The immediate global kill is idempotent and targets only the dedicated project:

```bash
aws --profile "$burst_profile" --region "$burst_region" \
  codebuild delete-webhook \
  --project-name "$burst_project"
```

After preserving the qualification evidence and proving no build is in
progress, rollback removes only the card-owned stack and connection:

```bash
aws --profile "$burst_profile" --region "$burst_region" \
  cloudformation delete-stack \
  --stack-name "$burst_stack"

aws --profile "$burst_profile" --region "$burst_region" \
  cloudformation wait stack-delete-complete \
  --stack-name "$burst_stack"

aws --profile "$burst_profile" --region "$burst_region" \
  codeconnections delete-connection \
  --connection-arn "$burst_connection_arn"
```

Phase cleanup evidence must include:

- CodeBuild batch/list results showing no in-progress build;
- controller state and accepted-build ledger;
- CodeBuild actual cost observation and its timestamp;
- no EC2 instance, volume, launch template, Auto Scaling group, or dedicated
  host created by this phase;
- the CodeBuild webhook deleted or the whole stack deleted.

## Source boundaries

The design follows the current AWS CodeBuild GitHub Actions runner contract:
`WORKFLOW_JOB_QUEUED` starts an ephemeral runner, the run id maps cancellation,
and the build terminates after one job. It uses the current GitHub guidance to
prefer ephemeral autoscaled self-hosted runners and to retain runner logs
externally. Provider documentation and the live AWS Price List query are the
authoritative external sources; this document is an auditable cache.
