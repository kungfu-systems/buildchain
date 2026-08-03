#!/bin/bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

contract="kungfu-buildchain-aws-windows-jit-operator/v1"
region="us-east-1"
repository="kungfu-systems/kungfu"
workflow_id="322620360"
budget_guard_stack="kungfu-buildchain-windows-jit-budget-guard"
budget_name="kungfu-buildchain-windows-jit-actual-spend"
budget_tag_key="kungfu:provider"
budget_tag_value="windows-ec2-jit"
budget_usage_type="BoxUsage:c7i.4xlarge"
budget_operation="RunInstances:0002"
budget_kill_parameter="/kungfu/burst/windows/provider-budget-killed"
budget_limit_usd="110"
campaign_template="infra/aws-us-elastic-runner-burst-plane/windows-jit.template.yml"
budget_template="infra/aws-us-elastic-runner-burst-plane/windows-jit-budget-guard.template.yml"
mode="plan"
if [[ $# -gt 0 ]]; then
  case "$1" in
    plan|audit|install-budget|prepare|close|launch-gate)
      mode="$1"
      shift
      ;;
  esac
fi

aws_profile=""
account_id=""
campaign_id=""
source_sha=""
source_ref="refs/heads/dev/v4/v4.0"
observed_at=""
expires_at=""
cost_start=""
cost_end=""
max_accepted_instances=""
vpc_id=""
subnet_id=""
oidc_provider_arn=""
confirm_plan_digest=""
confirm_account_id=""
confirm_campaign_id=""
confirm_source_sha=""
confirm_budget_name=""
reason="operator-close"
execute="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aws-profile) aws_profile="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --account-id) account_id="${2:-}"; shift 2 ;;
    --campaign-id) campaign_id="${2:-}"; shift 2 ;;
    --source-sha) source_sha="${2:-}"; shift 2 ;;
    --source-ref) source_ref="${2:-}"; shift 2 ;;
    --observed-at) observed_at="${2:-}"; shift 2 ;;
    --expires-at) expires_at="${2:-}"; shift 2 ;;
    --cost-start) cost_start="${2:-}"; shift 2 ;;
    --cost-end) cost_end="${2:-}"; shift 2 ;;
    --max-accepted-instances) max_accepted_instances="${2:-}"; shift 2 ;;
    --workflow-id) workflow_id="${2:-}"; shift 2 ;;
    --vpc-id) vpc_id="${2:-}"; shift 2 ;;
    --subnet-id) subnet_id="${2:-}"; shift 2 ;;
    --oidc-provider-arn) oidc_provider_arn="${2:-}"; shift 2 ;;
    --confirm-plan-digest) confirm_plan_digest="${2:-}"; shift 2 ;;
    --confirm-account-id) confirm_account_id="${2:-}"; shift 2 ;;
    --confirm-campaign-id) confirm_campaign_id="${2:-}"; shift 2 ;;
    --confirm-source-sha) confirm_source_sha="${2:-}"; shift 2 ;;
    --confirm-budget-name) confirm_budget_name="${2:-}"; shift 2 ;;
    --reason) reason="${2:-}"; shift 2 ;;
    --execute) execute="true"; shift ;;
    *) echo "::error::unsupported argument: $1" >&2; exit 2 ;;
  esac
done

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_inputs() {
  [[ "$region" == "us-east-1" ]] || fail "--region must be us-east-1"
  [[ "$account_id" =~ ^[0-9]{12}$ ]] || fail "--account-id is invalid"
  [[ "$campaign_id" =~ ^win-[a-z0-9][a-z0-9-]{2,15}$ ]] || fail "--campaign-id is invalid"
  [[ "$source_sha" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--source-sha is invalid"
  [[ "$source_ref" =~ ^refs/heads/[A-Za-z0-9._/-]+$ ]] || fail "--source-ref is invalid"
  [[ "$observed_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || fail "--observed-at is required"
  [[ "$expires_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || fail "--expires-at is required"
  [[ "$cost_start" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "--cost-start is invalid"
  [[ "$cost_end" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "--cost-end is invalid"
  [[ "$cost_end" > "$cost_start" ]] || fail "--cost-end must be after --cost-start"
  [[ "$max_accepted_instances" =~ ^[1-5]$ ]] || fail "--max-accepted-instances must be 1 through 5"
  [[ "$workflow_id" =~ ^[0-9]+$ ]] || fail "--workflow-id is invalid"
  [[ "$vpc_id" =~ ^vpc-[0-9a-f]+$ ]] || fail "--vpc-id is invalid"
  [[ "$subnet_id" =~ ^subnet-[0-9a-f]+$ ]] || fail "--subnet-id is invalid"
  [[ "$oidc_provider_arn" == "arn:aws:iam::${account_id}:oidc-provider/token.actions.githubusercontent.com" ]] || fail "--oidc-provider-arn is invalid"
}

require_bounded_time_window() {
  node -e '
    const observed = Date.parse(process.argv[1]);
    const expires = Date.parse(process.argv[2]);
    if (!Number.isFinite(observed) || !Number.isFinite(expires)) process.exit(1);
    const duration = expires - observed;
    if (duration <= 0 || duration > 24 * 60 * 60 * 1000) process.exit(1);
  ' "$observed_at" "$expires_at" || fail "campaign expiry must be after observation and within 24 hours"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print "sha256:" $1}'
}

make_plan() {
  local campaign_template_digest budget_template_digest body digest source_sha_lower
  campaign_template_digest=$(sha256_file "$campaign_template")
  budget_template_digest=$(sha256_file "$budget_template")
  source_sha_lower=$(printf '%s' "$source_sha" | tr '[:upper:]' '[:lower:]')
  body=$(jq -cnS \
    --arg contract "$contract" \
    --arg account "$account_id" \
    --arg region "$region" \
    --arg campaign "$campaign_id" \
    --arg source_sha "$source_sha_lower" \
    --arg source_ref "$source_ref" \
    --arg observed_at "$observed_at" \
    --arg expires_at "$expires_at" \
    --arg cost_start "$cost_start" \
    --arg cost_end "$cost_end" \
    --arg workflow_id "$workflow_id" \
    --arg repository "$repository" \
    --arg vpc "$vpc_id" \
    --arg subnet "$subnet_id" \
    --arg oidc "$oidc_provider_arn" \
    --arg campaign_template "$campaign_template" \
    --arg campaign_template_digest "$campaign_template_digest" \
    --arg budget_template "$budget_template" \
    --arg budget_template_digest "$budget_template_digest" \
    --arg guard_stack "$budget_guard_stack" \
    --arg budget_name "$budget_name" \
    --arg tag_key "$budget_tag_key" \
    --arg tag_value "$budget_tag_value" \
    --arg usage_type "$budget_usage_type" \
    --arg operation "$budget_operation" \
    --arg kill_parameter "$budget_kill_parameter" \
    --argjson slots "$max_accepted_instances" \
    --argjson budget "$budget_limit_usd" \
    '{schemaVersion:1,contract:$contract,kind:"operator-plan",mode:"dry-run",account:{id:$account},aws:{region:$region,budgetGuard:{stackName:$guard_stack,budgetName:$budget_name,dimensionFilter:{usageType:$usage_type,operation:$operation,region:$region},killParameterName:$kill_parameter},campaignStackName:("kungfu-buildchain-windows-jit-"+$campaign),vpcId:$vpc,subnetId:$subnet,oidcProviderArn:$oidc,campaignTemplate:{path:$campaign_template,digest:$campaign_template_digest},budgetTemplate:{path:$budget_template,digest:$budget_template_digest}},campaign:{id:$campaign,observedAt:$observed_at,expiresAt:$expires_at,maxAcceptedInstances:$slots},source:{sha:$source_sha,ref:$source_ref},github:{repository:$repository,workflowId:$workflow_id,requiredState:"disabled_manually"},cost:{start:$cost_start,end:$cost_end,dimensionFilter:{usageType:$usage_type,operation:$operation,region:$region},resourceOwnershipTag:{key:$tag_key,value:$tag_value},phaseBudgetLimitUsd:$budget,maximumInstanceReservationUsd:4.35,providerTelemetryMayLag:true},safety:{defaultAction:"plan-only",workflowEnabledDuringPrepare:false,dispatchDuringPrepare:false,paidCapacityDuringPrepare:false,budgetRequired:true,budgetDimensionVisibilityRequired:true,budgetAlarmIsDefenseInDepth:true,atomicCampaignReservationIsAuthoritative:true,uniqueCampaignStackRequired:true,zeroResidueRequired:true}}')
  digest=$(printf '%s' "$body" | shasum -a 256 | awk '{print "sha256:" $1}')
  printf '%s' "$body" | jq --arg digest "$digest" '. + {digest:$digest}'
}

aws_json() {
  if [[ -n "$aws_profile" ]]; then
    aws --profile "$aws_profile" --region "$region" "$@"
  else
    aws --region "$region" "$@"
  fi
}

confirm_mutation() {
  local plan_digest="$1" confirmed_source expected_source
  confirmed_source=$(printf '%s' "$confirm_source_sha" | tr '[:upper:]' '[:lower:]')
  expected_source=$(printf '%s' "$source_sha" | tr '[:upper:]' '[:lower:]')
  [[ "$execute" == "true" ]] || fail "--execute is required for mutation"
  [[ "$confirm_plan_digest" == "$plan_digest" ]] || fail "--confirm-plan-digest must equal the plan digest"
  [[ "$confirm_account_id" == "$account_id" ]] || fail "--confirm-account-id must equal the account id"
  [[ "$confirm_campaign_id" == "$campaign_id" ]] || fail "--confirm-campaign-id must equal the campaign id"
  [[ "$confirmed_source" == "$expected_source" ]] || fail "--confirm-source-sha must equal the source SHA"
}

assert_identity() {
  local observed
  observed=$(aws_json sts get-caller-identity --output json)
  [[ "$(printf '%s' "$observed" | jq -r .Account)" == "$account_id" ]] || fail "AWS account mismatch"
}

workflow_json() {
  gh api "repos/${repository}/actions/workflows/${workflow_id}"
}

assert_workflow_disabled() {
  local state
  state=$(workflow_json | jq -r .state)
  [[ "$state" == "disabled_manually" ]] || fail "Windows workflow must be disabled_manually; observed ${state}"
}

optional_stack() {
  local name="$1" output
  if output=$(aws_json cloudformation describe-stacks --stack-name "$name" --output json 2>&1); then
    printf '%s' "$output"
  elif [[ "$output" == *"does not exist"* ]]; then
    printf 'null'
  else
    fail "CloudFormation stack readback failed: ${output}"
  fi
}

optional_budget() {
  local output
  if output=$(aws_json budgets describe-budget --account-id "$account_id" --budget-name "$budget_name" --show-filter-expression --output json 2>&1); then
    printf '%s' "$output"
  elif [[ "$output" == *"NotFoundException"* ]]; then
    printf 'null'
  else
    fail "AWS Budget readback failed: ${output}"
  fi
}

dimension_visible() {
  local dimension="$1" value="$2"
  aws_json ce get-dimension-values \
    --time-period "Start=${cost_start},End=${cost_end}" \
    --dimension "$dimension" \
    --search-string "$value" \
    --output json | jq -e --arg value "$value" \
      '.DimensionValues | any(.Value==$value)' >/dev/null
}

budget_dimensions_visible() {
  dimension_visible USAGE_TYPE "$budget_usage_type" &&
    dimension_visible OPERATION "$budget_operation" &&
    dimension_visible REGION "$region"
}

kill_sentinel_present() {
  local output
  if output=$(aws_json ssm get-parameter --name "$budget_kill_parameter" --output json 2>&1); then
    return 0
  elif [[ "$output" == *"ParameterNotFound"* ]]; then
    return 1
  fi
  fail "provider Budget kill sentinel readback failed: ${output}"
}

guard_topic() {
  aws_json cloudformation describe-stacks \
    --stack-name "$budget_guard_stack" \
    --query "Stacks[0].Outputs[?OutputKey==\`KillSwitchTopic\`].OutputValue | [0]" \
    --output text
}

budget_valid() {
  local budget_json="$1"
  [[ "$budget_json" != "null" ]] || return 1
  printf '%s' "$budget_json" | jq -e \
    --arg name "$budget_name" \
    --arg usage_type "$budget_usage_type" \
    --arg operation "$budget_operation" \
    --arg region "$region" \
    --argjson limit "$budget_limit_usd" \
    '.Budget.BudgetName==$name and
     (.Budget.BudgetLimit.Amount|tonumber)==$limit and
     .Budget.BudgetLimit.Unit=="USD" and
     .Budget.BudgetType=="COST" and
     .Budget.Metrics==["UnblendedCost"] and
     (.Budget.FilterExpression.And|length)==3 and
     all(.Budget.FilterExpression.And[]; has("Dimensions") and (keys|length)==1) and
     any(.Budget.FilterExpression.And[]; .Dimensions=={Key:"USAGE_TYPE",Values:[$usage_type],MatchOptions:["EQUALS"]}) and
     any(.Budget.FilterExpression.And[]; .Dimensions=={Key:"OPERATION",Values:[$operation],MatchOptions:["EQUALS"]}) and
     any(.Budget.FilterExpression.And[]; .Dimensions=={Key:"REGION",Values:[$region],MatchOptions:["EQUALS"]})' >/dev/null
}

notifications_valid() {
  local topic notifications notification subscribers ok="true"
  topic=$(guard_topic)
  notifications=$(aws_json budgets describe-notifications-for-budget \
    --account-id "$account_id" --budget-name "$budget_name" --output json)
  printf '%s' "$notifications" | jq -e \
    '[.Notifications[] | select(.NotificationType=="ACTUAL" and (.ThresholdType // "PERCENTAGE")=="PERCENTAGE") | .Threshold] | sort == [80,95]' >/dev/null || return 1
  while IFS= read -r notification; do
    subscribers=$(aws_json budgets describe-subscribers-for-notification \
      --account-id "$account_id" --budget-name "$budget_name" \
      --notification "$notification" --output json)
    printf '%s' "$subscribers" | jq -e --arg topic "$topic" \
      '.Subscribers | any(.SubscriptionType=="SNS" and .Address==$topic)' >/dev/null || ok="false"
  done < <(printf '%s' "$notifications" | jq -c '.Notifications[]')
  [[ "$ok" == "true" ]]
}

resource_counts() {
  local instances volumes nodes parameters runners
  instances=$(aws_json ec2 describe-instances --filters \
    Name=tag:kungfu:plane,Values=aws-us-elastic-runner-burst \
    Name=tag:kungfu:provider,Values=windows-ec2-jit \
    Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down \
    --output json | jq '[.Reservations[].Instances[]] | length')
  volumes=$(aws_json ec2 describe-volumes --filters \
    Name=tag:kungfu:plane,Values=aws-us-elastic-runner-burst \
    Name=tag:kungfu:provider,Values=windows-ec2-jit \
    --output json | jq '.Volumes | length')
  nodes=$(aws_json ssm describe-instance-information \
    --filters Key=tag:kungfu:provider,Values=windows-ec2-jit \
    --output json | jq '.InstanceInformationList | length')
  parameters=$(aws_json ssm describe-parameters \
    --parameter-filters Key=Name,Option=BeginsWith,Values=/kungfu/burst/windows/ \
    --output json | jq --arg sentinel "$budget_kill_parameter" '[.Parameters[] | select(.Name!=$sentinel)] | length')
  runners=$(gh api "repos/${repository}/actions/runners?per_page=100" | jq \
    '[.runners[] | select(any(.labels[]?; .name | startswith("aws-us-ec2-windows-jit-")))] | length')
  jq -cn --argjson instances "$instances" --argjson volumes "$volumes" \
    --argjson nodes "$nodes" --argjson parameters "$parameters" --argjson runners "$runners" \
    '{instances:$instances,volumes:$volumes,ssmNodes:$nodes,jitParameters:$parameters,githubRunners:$runners}'
}

cost_readback() {
  local filter queried_at
  filter=$(jq -cn --arg usage_type "$budget_usage_type" --arg operation "$budget_operation" --arg region "$region" \
    '{And:[{Dimensions:{Key:"USAGE_TYPE",Values:[$usage_type],MatchOptions:["EQUALS"]}},{Dimensions:{Key:"OPERATION",Values:[$operation],MatchOptions:["EQUALS"]}},{Dimensions:{Key:"REGION",Values:[$region],MatchOptions:["EQUALS"]}}]}')
  queried_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  aws_json ce get-cost-and-usage \
    --time-period "Start=${cost_start},End=${cost_end}" \
    --granularity DAILY \
    --metrics UnblendedCost UsageQuantity \
    --filter "$filter" \
    --output json | jq \
    --arg queried_at "$queried_at" --arg usage_type "$budget_usage_type" --arg operation "$budget_operation" --arg region "$region" \
    '{amountUsd:([.ResultsByTime[].Total.UnblendedCost.Amount|tonumber]|add//0),usageHours:([.ResultsByTime[].Total.UsageQuantity.Amount|tonumber]|add//0),estimated:any(.ResultsByTime[];.Estimated==true),rowCount:(.ResultsByTime|length),queriedAt:$queried_at,filter:{usageType:$usage_type,operation:$operation,region:$region}}'
}

audit() {
  local plan_digest="$1" workflow guard campaign budget dimensions_ok budget_ok notifications_ok sentinel residue status
  assert_identity
  workflow=$(workflow_json)
  guard=$(optional_stack "$budget_guard_stack")
  campaign=$(optional_stack "kungfu-buildchain-windows-jit-${campaign_id}")
  budget=$(optional_budget)
  dimensions_ok="false"; budget_dimensions_visible && dimensions_ok="true"
  budget_ok="false"; budget_valid "$budget" && budget_ok="true"
  notifications_ok="false"
  if [[ "$guard" != "null" && "$budget_ok" == "true" ]]; then
    notifications_valid && notifications_ok="true"
  fi
  sentinel="false"; kill_sentinel_present && sentinel="true"
  residue=$(resource_counts)
  status="fail-closed"
  if [[ "$(printf '%s' "$workflow" | jq -r .state)" == "disabled_manually" && "$guard" != "null" && "$dimensions_ok" == "true" && "$budget_ok" == "true" && "$notifications_ok" == "true" && "$sentinel" == "false" && "$(printf '%s' "$residue" | jq '[.[]]|add')" == "0" ]]; then
    status="ready"
  fi
  jq -n \
    --arg contract "$contract" --arg status "$status" --arg digest "$plan_digest" \
    --argjson workflow "$workflow" --argjson guard "$guard" --argjson campaign "$campaign" \
    --argjson dimensions "$dimensions_ok" --argjson budget_ok "$budget_ok" \
    --argjson notifications_ok "$notifications_ok" --argjson sentinel "$sentinel" \
    --argjson residue "$residue" \
    '{schemaVersion:1,contract:$contract,kind:"operator-audit",status:$status,workflow:{id:$workflow.id,name:$workflow.name,state:$workflow.state},budgetGuardStack:$guard,campaignStack:$campaign,budget:{dimensionsVisible:$dimensions,valid:$budget_ok,notificationsValid:$notifications_ok},killSentinel:{present:$sentinel},residue:{ok:([ $residue[] ]|add)==0,counts:$residue},planDigest:$digest}'
}

budget_launch_gate() {
  local identity guard budget sentinel account
  [[ "$region" == "us-east-1" ]] || fail "--region must be us-east-1"
  identity=$(aws_json sts get-caller-identity --output json)
  account=$(printf '%s' "$identity" | jq -r .Account)
  [[ "$account" =~ ^[0-9]{12}$ ]] || fail "AWS account identity is invalid"
  account_id="$account"
  guard=$(optional_stack "$budget_guard_stack")
  [[ "$guard" != "null" ]] || fail "provider Budget guard stack is missing"
  budget=$(optional_budget)
  budget_valid "$budget" || fail "provider Budget identity or dimension filter mismatch"
  notifications_valid || fail "provider Budget notification subscription mismatch"
  sentinel="false"; kill_sentinel_present && sentinel="true"
  [[ "$sentinel" == "false" ]] || fail "provider Budget kill sentinel is set"
  jq -n --arg contract "$contract" --arg account "$account" \
    --arg budget "$budget_name" --arg usage_type "$budget_usage_type" \
    --arg operation "$budget_operation" --arg region "$region" \
    '{schemaVersion:1,contract:$contract,kind:"budget-launch-gate",status:"ready",accountId:$account,budgetName:$budget,dimensionFilter:{usageType:$usage_type,operation:$operation,region:$region},killSentinelPresent:false}'
}

install_budget() {
  local plan_digest="$1" existing_budget existing_guard receipt residue sentinel
  confirm_mutation "$plan_digest"
  [[ "$confirm_budget_name" == "$budget_name" ]] || fail "--confirm-budget-name must equal the Budget name"
  assert_identity
  assert_workflow_disabled
  budget_dimensions_visible || fail "account-native Windows billing dimensions are not visible; installation fails closed"
  existing_budget=$(optional_budget)
  existing_guard=$(optional_stack "$budget_guard_stack")
  [[ "$existing_budget" == "null" || "$existing_guard" != "null" ]] || fail "provider Budget exists outside the guard stack"
  sentinel="false"; kill_sentinel_present && sentinel="true"
  [[ "$sentinel" == "false" ]] || fail "provider Budget kill sentinel is set"
  residue=$(resource_counts)
  [[ "$(printf '%s' "$residue" | jq '[.[]]|add')" == "0" ]] || fail "provider residue is not zero"
  aws_json cloudformation deploy \
    --template-file "$budget_template" \
    --stack-name "$budget_guard_stack" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      "BudgetName=${budget_name}" \
      "BudgetLimitUsd=${budget_limit_usd}" \
      "KillParameterName=${budget_kill_parameter}" \
    --no-fail-on-empty-changeset
  receipt=$(audit "$plan_digest")
  [[ "$(printf '%s' "$receipt" | jq -r .status)" == "ready" ]] || fail "Budget guard post-deploy audit failed"
  printf '%s' "$receipt" | jq '.kind="budget-install-result" | .status="installed"'
}

prepare_campaign() {
  local plan_digest="$1" guard budget sentinel residue cost stack_name stack outputs state_table
  confirm_mutation "$plan_digest"
  [[ "$confirm_budget_name" == "$budget_name" ]] || fail "--confirm-budget-name must equal the Budget name"
  assert_identity
  assert_workflow_disabled
  stack_name="kungfu-buildchain-windows-jit-${campaign_id}"
  [[ "$(optional_stack "$stack_name")" == "null" ]] || fail "campaign stack already exists; reuse is forbidden"
  guard=$(optional_stack "$budget_guard_stack")
  [[ "$guard" != "null" ]] || fail "Budget guard stack is missing"
  budget=$(optional_budget)
  budget_dimensions_visible || fail "account-native Windows billing dimensions are not visible"
  budget_valid "$budget" || fail "provider Budget identity or dimension filter mismatch"
  notifications_valid || fail "provider Budget notification subscription mismatch"
  sentinel="false"; kill_sentinel_present && sentinel="true"
  [[ "$sentinel" == "false" ]] || fail "provider Budget kill sentinel is set"
  residue=$(resource_counts)
  [[ "$(printf '%s' "$residue" | jq '[.[]]|add')" == "0" ]] || fail "provider residue is not zero"
  cost=$(cost_readback)
  node scripts/aws-windows-jit-campaign.mjs plan-arm \
    --campaign-id "$campaign_id" --source-sha "$source_sha" \
    --state-table "${stack_name}-CampaignState-preflight" \
    --armed-at "$observed_at" --expires-at "$expires_at" \
    --phase-spend-baseline-usd "$(printf '%s' "$cost" | jq -r .amountUsd)" \
    --max-accepted-instances "$max_accepted_instances" >/dev/null
  aws_json cloudformation deploy \
    --template-file "$campaign_template" --stack-name "$stack_name" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      "GitHubOidcProviderArn=${oidc_provider_arn}" "Repository=${repository}" \
      "TrustedRef=${source_ref}" "VpcId=${vpc_id}" "SubnetId=${subnet_id}" \
      "BudgetLimitUsd=${budget_limit_usd}" "MaximumInstanceLifetimeMinutes=180" \
      "ProviderBudgetKillParameterName=${budget_kill_parameter}" \
    --no-fail-on-empty-changeset
  stack=$(aws_json cloudformation describe-stacks --stack-name "$stack_name" --output json)
  outputs=$(printf '%s' "$stack" | jq '.Stacks[0].Outputs | map({key:.OutputKey,value:.OutputValue}) | from_entries')
  state_table=$(printf '%s' "$outputs" | jq -r .CampaignStateTable)
  node scripts/aws-windows-jit-campaign.mjs arm-campaign \
    --aws-profile "$aws_profile" --region "$region" \
    --campaign-id "$campaign_id" --confirm-campaign-id "$campaign_id" \
    --source-sha "$source_sha" --confirm-source-sha "$source_sha" \
    --state-table "$state_table" --confirm-state-table "$state_table" \
    --armed-at "$observed_at" --expires-at "$expires_at" \
    --phase-spend-baseline-usd "$(printf '%s' "$cost" | jq -r .amountUsd)" \
    --confirm-phase-spend-baseline-usd "$(printf '%s' "$cost" | jq -r .amountUsd)" \
    --max-accepted-instances "$max_accepted_instances" \
    --confirm-max-accepted-instances "$max_accepted_instances" >/dev/null
  jq -n --arg contract "$contract" --arg digest "$plan_digest" \
    --argjson cost "$cost" --argjson outputs "$outputs" \
    '{schemaVersion:1,contract:$contract,kind:"campaign-prepare-result",status:"armed-disabled",cost:$cost,stackOutputs:$outputs,paidCapacityCreated:false,workflowDispatched:false,planDigest:$digest}'
}

close_campaign() {
  local plan_digest="$1" stack_name stack outputs state_table topic residue
  confirm_mutation "$plan_digest"
  assert_identity
  gh workflow disable "$workflow_id" -R "$repository"
  stack_name="kungfu-buildchain-windows-jit-${campaign_id}"
  stack=$(optional_stack "$stack_name")
  if [[ "$stack" != "null" ]]; then
    outputs=$(printf '%s' "$stack" | jq '.Stacks[0].Outputs | map({key:.OutputKey,value:.OutputValue}) | from_entries')
    state_table=$(printf '%s' "$outputs" | jq -r .CampaignStateTable)
    topic=$(printf '%s' "$outputs" | jq -r .KillSwitchTopic)
    node scripts/aws-windows-jit-campaign.mjs kill-campaign \
      --aws-profile "$aws_profile" --region "$region" \
      --campaign-id "$campaign_id" --confirm-campaign-id "$campaign_id" \
      --source-sha "$source_sha" --confirm-source-sha "$source_sha" \
      --state-table "$state_table" --confirm-state-table "$state_table" \
      --kill-switch-topic "$topic" --confirm-kill-switch-topic "$topic" \
      --reason "$reason" >/dev/null
  fi
  residue=$(resource_counts)
  [[ "$(printf '%s' "$residue" | jq '[.[]]|add')" == "0" ]] || fail "campaign is killed but cleanup is not terminal; rerun close after the reaper settles"
  assert_workflow_disabled
  jq -n --arg contract "$contract" --arg digest "$plan_digest" --argjson residue "$residue" \
    --argjson stack_present "$([[ "$stack" != "null" ]] && printf true || printf false)" \
    '{schemaVersion:1,contract:$contract,kind:"campaign-close-result",status:"closed-zero-residue",campaignStackPresent:$stack_present,residue:$residue,planDigest:$digest}'
}

if [[ "$mode" == "launch-gate" ]]; then
  budget_launch_gate
  exit 0
fi

require_inputs
require_bounded_time_window
plan=$(make_plan)
plan_digest=$(printf '%s' "$plan" | jq -r .digest)

case "$mode" in
  plan) printf '%s\n' "$plan" ;;
  audit) audit "$plan_digest" ;;
  install-budget) install_budget "$plan_digest" ;;
  prepare) prepare_campaign "$plan_digest" ;;
  close) close_campaign "$plan_digest" ;;
  *) fail "unsupported Windows JIT operator mode: ${mode}" ;;
esac
