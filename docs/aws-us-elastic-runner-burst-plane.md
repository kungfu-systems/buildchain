---
status: draft
period: 2026-07-28
theme: aws-us-elastic-runner-burst-plane
doc_type: design
source_level: local-files-and-provider-docs
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-02
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-08-01
  invisible_information: No hidden model checkpoint, parameters, or private training data were available.
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

## Phase 2 contract

The Windows phase uses the explicit `aws-us-ec2-windows-jit` runner preset.
Its caller supplies one bounded label under
`aws-us-ec2-windows-jit-<campaign-id>-<qualification-id>`, and Buildchain
resolves exactly one Windows x64 native lane. The reusable trust gate still
runs on a GitHub-hosted runner before the JIT label can select EC2.

The provider creates repository-level GitHub JIT configuration for
`kungfu-systems/kungfu`. Its `labels` request must contain all four scheduling
labels: `self-hosted`, `Windows`, `X64`, and the card-scoped
`aws-us-ec2-windows-jit-<campaign-id>-<qualification-id>` label. The workflow
display title also carries both identities, allowing the launch controller to
verify the queued run against its campaign plan. GitHub's JIT endpoint does
not infer the default OS and architecture labels when they are omitted. The
encoded configuration is never placed in EC2 user data, a tag, a command log,
or an artifact. The operator writes it to a card-scoped SSM SecureString under
`/kungfu/burst/windows/`; the instance role can read and delete only that
prefix. Bootstrap reads the value once, deletes the parameter immediately, and
passes it only to the pinned runner process.

Each runner uses:

- Amazon's current Windows Server 2025 Full Base AMI, resolved through the
  public SSM AMI parameter and retained by exact AMI id and name;
- `c7i.4xlarge`, one instance and one JIT runner per job;
- GitHub Actions Runner 2.336.0 with the official Windows x64 SHA256;
- PowerShell 7.6.4 with the official Windows x64 MSI SHA256 and Microsoft
  Authenticode verification;
- pinned PortableGit 2.55.0.3 with its GitHub release SHA256, exposing only its
  `cmd` directory so POSIX compatibility tools cannot shadow Windows tools;
- a Microsoft Authenticode-verified Visual Studio 2022 Build Tools bootstrap;
- IMDSv2, an encrypted root volume with delete-on-termination, no inbound
  security-group rule, no key pair, and no warm Auto Scaling capacity.

Runner diagnostics and a redacted lifecycle record are uploaded to the
provider's encrypted, private evidence bucket under the exact campaign, run,
attempt, and instance identity. The runner process exits after one job, Windows
shuts down, and EC2's instance-initiated shutdown behavior is set to
`terminate`. A five-minute reaper terminates card-owned stopped or
three-hour-old instances and deletes only their dedicated JIT parameter.

At the 2026-07-29 AWS Price List rate of USD 1.45 per Windows
`c7i.4xlarge` hour, each accepted instance reserves its complete three-hour
USD 4.35 fail-closed lifetime before `RunInstances`. A DynamoDB transaction
binds the exact campaign and source, creates an idempotent run ledger entry,
and atomically refuses a sixth accepted instance. Five accepted instances
therefore reserve at most USD 21.75. The campaign also persists the
operator-observed spend from earlier Windows work, and refuses to arm unless
that baseline, all five reservations, and one USD 4.35 fail-closed race
allowance remain below the USD 110 phase cap.

The campaign starts unarmed and expires within 24 hours. Its `CONTROL` record
can be created only once: a killed or expired campaign cannot be re-armed by
the campaign tool. A budget notification or any instance lifetime violation
persists `KILLED` before cleanup, so later workflow dispatches fail before a
paid launch. Reservations are never refunded: a controller crash, ambiguous
launch, or successful launch all remain charged to the campaign, favoring a
false stop over an accidental budget overrun.

The 2026-08-03 timeout-only campaign decision narrows the campaign to two
accepted instances with one active instance at a time. The second reservation
is an operator-gated repair retry: it may be used only after the first attempt
is classified as non-counting and runner, EC2, EBS, SSM, and workflow residue
have returned to zero. The two-slot ledger is a maximum spend boundary, not an
authorization to consume both reservations.

Each stack owns a stack-scoped reaper log group, so an independent retained
one-shot campaign stack can be created without colliding with another
campaign's audit log resource.

The tag-filtered AWS Budget is defense in depth, not the authoritative launch
gate. It is disabled by default because a linked account cannot activate a
cost-allocation tag. Set `EnableTagFilteredBudget=true` only after the AWS
Organizations management account has activated `kungfu:provider` and a Cost
Explorer readback proves that `windows-ec2-jit` spend is visible. The DynamoDB
reservation cap remains mandatory in either mode.

Qualification requires one runner-profile smoke and three trusted exact-source
full Windows jobs all bound to the same campaign, independent cancellation and
timeout cleanup exercises, and zero repository runner, EC2 instance,
disposable volume, min capacity, and desired capacity within 15 minutes of the
final job.

### Phase 2 campaign controller

`scripts/aws-windows-jit-campaign.mjs` is the one-shot operator boundary.
Without a mutation mode it emits the arm plan. `arm-campaign` requires the
campaign id, exact source SHA, state table, observed prior phase spend, and a
bounded one-to-five accepted-instance ceiling to be repeated as confirmations,
then creates `CONTROL` and `CAMPAIGN#<id>` with
`attribute_not_exists`
conditions. DynamoDB therefore refuses a second campaign in the same retained
state table. The operator can always use `kill-campaign`; there is deliberately
no clear or re-arm operation.

Every `scripts/aws-windows-jit-controller.mjs --execute` call must provide the
same `--campaign-id`, `--confirm-campaign-id`, `--state-table`, and
`--confirm-state-table`. After the GitHub, AMI, active-instance, SSM, and EC2
DryRun checks pass, the controller
atomically reserves one run. Duplicate run-attempt-qualification identities,
source mismatch, expiry, `KILLED`, the sixth accepted instance, or a
reservation that would exceed the baseline-adjusted USD 110 phase ceiling all
fail closed before `RunInstances`.

Example dry-run and arm boundary (do not execute without a new campaign budget
decision):

```bash
windows_campaign=win-REPLACE_WITH_CAMPAIGN_ID
windows_source=REPLACE_WITH_EXACT_40_CHARACTER_SHA
windows_state_table=REPLACE_WITH_CAMPAIGN_STATE_TABLE
windows_expires_at=REPLACE_WITH_ISO_TIMESTAMP_WITHIN_24_HOURS
windows_phase_spend_baseline_usd=REPLACE_WITH_OBSERVED_PRIOR_WINDOWS_SPEND
windows_max_accepted_instances=REPLACE_WITH_INTEGER_FROM_1_THROUGH_5

node scripts/aws-windows-jit-campaign.mjs plan-arm \
  --campaign-id "$windows_campaign" \
  --source-sha "$windows_source" \
  --state-table "$windows_state_table" \
  --expires-at "$windows_expires_at" \
  --phase-spend-baseline-usd "$windows_phase_spend_baseline_usd" \
  --max-accepted-instances "$windows_max_accepted_instances"

node scripts/aws-windows-jit-campaign.mjs arm-campaign \
  --campaign-id "$windows_campaign" \
  --confirm-campaign-id "$windows_campaign" \
  --source-sha "$windows_source" \
  --confirm-source-sha "$windows_source" \
  --state-table "$windows_state_table" \
  --confirm-state-table "$windows_state_table" \
  --expires-at "$windows_expires_at" \
  --phase-spend-baseline-usd "$windows_phase_spend_baseline_usd" \
  --confirm-phase-spend-baseline-usd "$windows_phase_spend_baseline_usd" \
  --max-accepted-instances "$windows_max_accepted_instances" \
  --confirm-max-accepted-instances "$windows_max_accepted_instances"
```

Arming creates a permanent one-shot control record and admits only the
explicitly confirmed number of paid instances, never more than five. Its
rollback is fail-closed, not deletion: `kill-campaign` first
persists `KILLED`, then publishes to the dedicated SNS topic so the reaper
terminates active card-owned instances and removes their JIT parameters. The
command is idempotent, but the operator must read back DynamoDB, EC2, SSM, and
GitHub runners before treating cleanup as complete:

```bash
windows_kill_topic=REPLACE_WITH_DEDICATED_KILL_SWITCH_TOPIC_ARN

node scripts/aws-windows-jit-campaign.mjs kill-campaign \
  --campaign-id "$windows_campaign" \
  --confirm-campaign-id "$windows_campaign" \
  --source-sha "$windows_source" \
  --confirm-source-sha "$windows_source" \
  --state-table "$windows_state_table" \
  --confirm-state-table "$windows_state_table" \
  --kill-switch-topic "$windows_kill_topic" \
  --confirm-kill-switch-topic "$windows_kill_topic" \
  --reason operator-kill
```

## Phase 3 contract

The macOS phase uses the explicit `aws-us-ec2-macos-jit` runner preset. Its
caller supplies one unique label under
`aws-us-ec2-macos-jit-<qualification-id>`, and Buildchain resolves exactly one
native macOS ARM64 lane with `self-hosted`, `macOS`, `ARM64`, and the unique
campaign label. The reusable trust gate remains ahead of the JIT runner.

Unlike Windows, the Mac campaign deliberately reuses one instance on one
`mac2.metal` Dedicated Host. The operator allocates exactly one tagged host,
launches exactly one tagged instance, and sends three sequential SSM bootstrap
commands. Each command consumes and immediately deletes a distinct repository
JIT SecureString under `/kungfu/burst/macos/`, then runs GitHub Actions Runner
2.336.0 for exactly one job. The runner archive is pinned to the official
macOS ARM64 SHA256. No GitHub, signing, notarization, publication, SSH, or
static AWS credential is admitted to the instance.

The instance uses the exact retained Amazon EC2 macOS AMI, IMDSv2, an encrypted
delete-on-termination root volume, no inbound security-group rule, and the
AMI's preinstalled SSM Agent and AWS CLI v2. The three accepted jobs must bind
to the same host id, instance id, AMI id, source SHA, and campaign. At least one
job must exercise the full native lifecycle.

AWS imposes a 24-hour minimum Dedicated Host allocation. The contract therefore
keeps the one host for at least 24 hours even if all three jobs finish earlier.
At the recorded USD 0.6498 hourly rate, the minimum commitment rounds to USD
15.60. A 30-hour fail-closed ceiling rounds to USD 19.49, below the dedicated
USD 25 budget. A ten-minute reaper terminates an expired campaign instance and
retries host release after the minimum allocation and Apple scrub constraints
allow it. Budget notifications at 80% and 95% invoke the same card-scoped kill
switch.

Qualification requires three trusted exact-source one-job JIT runs on the one
host, including at least one full run, plus proof that:

- the instance terminated and the encrypted disposable volume disappeared;
- Apple host scrub completed;
- the Dedicated Host was released between 24 and 30 hours after allocation;
- the repository has no registered campaign runner;
- AWS has no active campaign instance or allocated campaign host;
- actual incremental spend remained below USD 25.

### Phase 3 lifecycle controller

`scripts/aws-macos-jit-controller.mjs` is the operator boundary for the paid
campaign. It has three explicit mutation modes:

- `launch-campaign` binds the exact repository source, AMI, availability zone,
  tagged Dedicated Host, and reusable instance. It rejects pre-existing Mac
  capacity and requires successful `AllocateHosts` and `RunInstances` DryRuns
  before either real call.
- `run-job` binds one queued exact-source GitHub job to the existing campaign
  host and instance. It writes the repository JIT configuration through a
  mode-0600 temporary file into a distinct SSM SecureString, sends only the
  credential-free bootstrap through SSM, and removes the parameter plus runner
  registration if command delivery fails.
- `close-campaign` refuses execution before the provider's 24-hour minimum,
  verifies the encrypted delete-on-termination root volume, removes scoped JIT
  residue, terminates the exact instance, and requires a `ReleaseHosts` DryRun
  before release. If Apple host scrubbing is still in progress, it reports
  `release-pending`; the ten-minute card-scoped reaper remains the bounded
  retry path.

Every execute mode requires the exact source SHA and campaign id to be repeated
through `--confirm-source-sha` and `--confirm-campaign-id`. `run-job` also
requires `--confirm-run-id`. Omitting `--execute` emits a deterministic plan
without changing AWS or GitHub state.

## Provider lifecycle

The three infrastructure templates live under
`infra/aws-us-elastic-runner-burst-plane/`. Creating a change set is the review
boundary. Executing it, completing the GitHub App connection, creating or
re-arming a webhook, allocating or releasing a Dedicated Host, writing cost
telemetry, dispatching paid jobs, operating a kill switch, and deleting a stack
are all explicit provider mutations.

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

The returned connection is `PENDING` until an operator completes the GitHub App
handshake in AWS. Read back `ConnectionStatus=AVAILABLE` before creating the
change set. Do not put an OAuth token or GitHub token in the shell:

AWS CodeConnections connection names are limited to 32 characters, so keep the
shorter connection name even when the stack and project use the longer
Buildchain-specific name.

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
