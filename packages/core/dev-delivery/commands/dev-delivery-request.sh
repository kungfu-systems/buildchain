#!/bin/bash
set -euo pipefail

usage() {
  echo "usage: buildchain dev deliver <pull-request-url-or-number> [--execute] [--json]" >&2
  exit 2
}

pull_request="${1:-}"
shift || true
if [ -z "$pull_request" ] || [[ "$pull_request" == --* ]]; then usage; fi
execute=false
json=false
for argument in "$@"; do
  case "$argument" in
    --execute) execute=true ;;
    --json) json=true ;;
    *) usage ;;
  esac
done

source_root="${BUILDCHAIN_WORK_SOURCE_ROOT:-}"
[[ "$source_root" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "buildchain dev deliver: BUILDCHAIN_WORK_SOURCE_ROOT is required" >&2
  exit 1
}
command -v gh >/dev/null || { echo "buildchain dev deliver: gh is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "buildchain dev deliver: jq is required" >&2; exit 1; }

case "$pull_request" in
  https://github.com/*/pull/*)
    coordinate="${pull_request#https://github.com/}"
    repository="${coordinate%/pull/*}"
    number="${coordinate#*/pull/}"
    number="${number%%/*}"
    ;;
  *#*) repository="${pull_request%#*}"; number="${pull_request##*#}" ;;
  *) repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; number="$pull_request" ;;
esac
[[ "$repository" =~ ^[^/]+/[^/]+$ && "$number" =~ ^[1-9][0-9]*$ ]] || usage

pr="$(gh pr view "$number" --repo "$repository" --json number,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,statusCheckRollup)"
jq -e --arg repository "$repository" '
  .state == "OPEN" and (.isDraft | not) and .headRepository.nameWithOwner == $repository
' >/dev/null <<<"$pr" || {
  echo "buildchain dev deliver: PR must be open, non-draft, and from the same repository" >&2
  exit 1
}
base="$(jq -r .baseRefName <<<"$pr")"
source_head="$(jq -r .headRefOid <<<"$pr")"
runtime_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
runtime_ref="${BUILDCHAIN_RUNTIME_REF:-}"
workflow_ref="$(jq -er '.headRefName | select(type == "string" and length > 0)' <<<"$pr")"

run_id="$(jq -r '[.statusCheckRollup[] | select(.workflowName == "Verify" and .conclusion == "SUCCESS") | .detailsUrl | capture("/runs/(?<id>[0-9]+)").id] | unique | last // empty' <<<"$pr")"
[ -n "$run_id" ] || { echo "buildchain dev deliver: no successful Verify run covers the PR head" >&2; exit 1; }
run="$(gh api "repos/$repository/actions/runs/$run_id")"
jq -e --arg head "$source_head" --argjson number "$number" '
  .conclusion == "success" and .event == "pull_request" and .head_sha == $head and
  ((.path | sub("@.*$"; "")) == ".github/workflows/self-build-verify.yml") and
  any(.pull_requests[]; .number == $number)
' >/dev/null <<<"$run" || { echo "buildchain dev deliver: Verify run does not exactly cover the PR head" >&2; exit 1; }
qualified_base="$(jq -r --argjson number "$number" '.pull_requests[] | select(.number == $number) | .base.sha' <<<"$run" | head -n 1)"

for revision in "$source_head" "$qualified_base"; do
  git cat-file -e "$revision^{commit}" 2>/dev/null || git fetch --no-tags origin "$revision"
done
affected_paths="$(git diff --name-only --no-renames "$qualified_base...$source_head" | jq -Rsc 'split("\n") | map(rtrimstr("\r")) | map(select(length > 0)) | sort')"
[ "$(jq length <<<"$affected_paths")" -gt 0 ] || { echo "buildchain dev deliver: PR has no source changes" >&2; exit 1; }

paths_at_head() {
  while IFS= read -r item; do
    if git cat-file -e "$source_head:$item" 2>/dev/null; then printf '%s\n' "$item"; fi
  done | jq -Rsc 'split("\n") | map(select(length > 0)) | sort'
}
existing_paths="$(jq -r '.[]' <<<"$affected_paths" | paths_at_head)"
policy_paths="$(printf '%s\n' .github/workflows/self-build-verify.yml .github/workflows/self-ops-dev-delivery.yml buildchain.toml .buildchain/buildchain.toml | paths_at_head)"
[ "$(jq length <<<"$policy_paths")" -gt 0 ] || policy_paths="$(jq '.[0:1]' <<<"$existing_paths")"
[ "$(jq length <<<"$existing_paths")" -gt 0 ] || existing_paths="$policy_paths"
dependency_paths="$(printf '%s\n' package.json pnpm-lock.yaml package-lock.json yarn.lock Cargo.toml Cargo.lock go.mod go.sum | paths_at_head)"
[ "$(jq length <<<"$dependency_paths")" -gt 0 ] || dependency_paths="$policy_paths"
required_contexts="$(jq '[.statusCheckRollup[] | select(.conclusion == "SUCCESS") | .name] | unique | sort' <<<"$pr")"
[ "$(jq length <<<"$required_contexts")" -gt 0 ] || { echo "buildchain dev deliver: exact PR head has no successful checks" >&2; exit 1; }

predicates="$(node "$runtime_root/packages/core/dev-delivery/commands/dev-delivery-source-proof-reuse.mjs" predicates \
  --cwd "$PWD" --repository "$repository" --branch "$base" --qualified-base "$qualified_base" \
  --source-head "$source_head" --node-version "${BUILDCHAIN_NODE_VERSION:-24}" \
  --policy-paths-json "$policy_paths" --closure-paths-json "$existing_paths" \
  --dependency-paths-json "$dependency_paths" --required-contexts-json "$required_contexts")"

# Observe current ownership before submitting a new delivery request.
github_token="${GITHUB_TOKEN:-${GH_TOKEN:-$(gh auth token 2>/dev/null || true)}}"
if [ -n "$github_token" ]; then
  observation="$(GITHUB_TOKEN="$github_token" node "$runtime_root/packages/core/dev-delivery/commands/dev-delivery-warrant.mjs" observe --repository "$repository" --branch "$base" --json 2>/dev/null || true)"
  active_pr="$(jq -r '.observation.activeWarrant.pullRequestNumber // empty' <<<"${observation:-}" 2>/dev/null || true)"
  active_head="$(jq -r '.observation.activeWarrant.sourceHead // empty' <<<"${observation:-}" 2>/dev/null || true)"
  if [ -n "$active_pr" ] && ! jq -e '.observation.activeWarrant.phase | IN("ready", "provisional", "qualified")' <<<"$observation" >/dev/null; then
    echo "Active Warrant must declare its current phase; historical recovery is unsupported." >&2
    exit 1
  fi
  if [ "$execute" = true ] && [ -n "$active_pr" ] && { [ "$active_pr" != "$number" ] || [ "$active_head" != "$source_head" ]; }; then
    active_pr_state="$(gh pr view "$active_pr" --repo "$repository" --json state,headRefOid 2>/dev/null || true)"
    observed_state="$(jq -r '.state // empty' <<<"${active_pr_state:-}" 2>/dev/null || true)"
    observed_head="$(jq -r '.headRefOid // empty' <<<"${active_pr_state:-}" 2>/dev/null || true)"
    stale_outcome=""
    if [ "$observed_state" = CLOSED ]; then
      stale_outcome="cancelled"
    elif [ "$active_pr" = "$number" ] && [ -n "$observed_head" ] && [ "$observed_head" != "$active_head" ]; then
      stale_outcome="dequeued"
    fi
    if [ -n "$stale_outcome" ]; then
      stale_fact="$(jq -cn --arg repository "$repository" --arg base "$base" --argjson pr "$active_pr" --arg recorded "$active_head" \
        --arg observed "${observed_head:-$active_head}" --arg state "$observed_state" '{repository:$repository,protectedBase:$base,pullRequestNumber:$pr,recordedHead:$recorded,observedHead:$observed,observedState:$state}')"
      stale_evidence_root="$(node --input-type=module -e 'const {pathToFileURL}=await import("node:url");const {devDeliveryContentRoot:root}=await import(pathToFileURL(process.argv[1]).href);process.stdout.write(root(JSON.parse(process.argv[2])))' "$runtime_root/packages/core/dev-delivery/dev-delivery-warrant.js" "$stale_fact")"
      GITHUB_TOKEN="$github_token" node "$runtime_root/packages/core/dev-delivery/commands/dev-delivery-warrant.mjs" settle \
        --repository "$repository" --branch "$base" --pull-request "$active_pr" --expected-source-head "$active_head" \
        --fencing-token "$(jq -er '.observation.activeWarrant.fencingToken' <<<"$observation")" --lease-generation "$(jq -er '.observation.activeWarrant.generation' <<<"$observation")" \
        --outcome "$stale_outcome" \
        --evidence-root "$stale_evidence_root" \
        --reason "Buildchain observed a terminal PR or changed PR head before a new minimal delivery request." --execute >/dev/null
      observation="$(GITHUB_TOKEN="$github_token" node "$runtime_root/packages/core/dev-delivery/commands/dev-delivery-warrant.mjs" observe --repository "$repository" --branch "$base" --json)"
    fi
  fi

fi
workflow="self-ops-dev-delivery.yml"
payload="$(jq --arg ref "$workflow_ref" --arg base "$base" --arg runtime "$runtime_ref" --arg number "$number" \
  --arg head "$source_head" --arg roots "$(jq -cn --arg root "$source_root" '{sourceRoot:$root}')" \
  --arg run "$run_id" '. as $proof | {ref:$ref,inputs:{
    "runtime-ref":$runtime,"target-branch":$base,"expected-pr-number":$number,
    "expected-head-sha":$head,"native-roots-json":$roots,"source-workflow-run-id":$run,
    "source-identity-root":$proof.sourceIdentityRoot,
    "source-patch-root":$proof.sourcePatchRoot,"plan-root":$proof.planRoot,
    "closure-root":$proof.closureRoot,"dependency-root":$proof.dependencyRoot,
    "toolchain-root":$proof.toolchainRoot,"environment-root":"",
    "affected-paths-json":"[]","shard-evidence-roots-json":"[]",
    "release-blocker-priority-json":"","native-proof-json":"","native-command":"",
    "native-command-root":"","native-heartbeat-seconds":"30","delivery-class":"non-native-fast",
    "delivery-priority":"ordinary"}}' <<<"$predicates")"

if [ "$execute" = true ]; then
  gh api --method POST "repos/$repository/actions/workflows/$workflow/dispatches" --input - <<<"$payload" >/dev/null
fi
mode=plan
[ "$execute" = true ] && mode=execute
if [ "$json" = true ]; then
  jq -n --arg mode "$mode" --arg repository "$repository" \
    --arg workflow "$workflow" --argjson number "$number" --arg head "$source_head" \
    '{ok:true,mode:$mode,repository:$repository,workflowId:$workflow,pullRequestNumber:$number,sourceHead:$head}'
else
  echo "Buildchain dev delivery: $mode PR #$number"
fi
