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

pr="$(gh pr view "$number" --repo "$repository" --json number,state,isDraft,baseRefName,headRefOid,headRepository,statusCheckRollup)"
jq -e --arg repository "$repository" '
  .state == "OPEN" and (.isDraft | not) and .headRepository.nameWithOwner == $repository
' >/dev/null <<<"$pr" || {
  echo "buildchain dev deliver: PR must be open, non-draft, and from the same repository" >&2
  exit 1
}
base="$(jq -r .baseRefName <<<"$pr")"
source_head="$(jq -r .headRefOid <<<"$pr")"
run_id="$(jq -r '[.statusCheckRollup[] | select(.workflowName == "Verify" and .conclusion == "SUCCESS") | .detailsUrl | capture("/runs/(?<id>[0-9]+)").id] | unique | last // empty' <<<"$pr")"
[ -n "$run_id" ] || { echo "buildchain dev deliver: no successful Verify run covers the PR head" >&2; exit 1; }
run="$(gh api "repos/$repository/actions/runs/$run_id")"
jq -e --arg head "$source_head" --argjson number "$number" '
  .conclusion == "success" and .event == "pull_request" and .head_sha == $head and
  ((.path | sub("@.*$"; "")) == ".github/workflows/verify.yml") and
  any(.pull_requests[]; .number == $number)
' >/dev/null <<<"$run" || { echo "buildchain dev deliver: Verify run does not exactly cover the PR head" >&2; exit 1; }
qualified_base="$(jq -r --argjson number "$number" '.pull_requests[] | select(.number == $number) | .base.sha' <<<"$run" | head -n 1)"

for revision in "$source_head" "$qualified_base"; do
  git cat-file -e "$revision^{commit}" 2>/dev/null || git fetch --no-tags origin "$revision"
done
affected_paths="$(git diff --name-only --no-renames "$qualified_base...$source_head" | jq -Rsc 'split("\n") | map(select(length > 0)) | sort')"
[ "$(jq length <<<"$affected_paths")" -gt 0 ] || { echo "buildchain dev deliver: PR has no source changes" >&2; exit 1; }

paths_at_head() {
  while IFS= read -r item; do
    if git cat-file -e "$source_head:$item" 2>/dev/null; then printf '%s\n' "$item"; fi
  done | jq -Rsc 'split("\n") | map(select(length > 0)) | sort'
}
existing_paths="$(jq -r '.[]' <<<"$affected_paths" | paths_at_head)"
policy_paths="$(printf '%s\n' .github/workflows/verify.yml .github/workflows/buildchain-dev-delivery.yml .github/workflows/native-dev-delivery.yml buildchain.toml .buildchain/buildchain.toml | paths_at_head)"
[ "$(jq length <<<"$policy_paths")" -gt 0 ] || policy_paths="$(jq '.[0:1]' <<<"$existing_paths")"
[ "$(jq length <<<"$existing_paths")" -gt 0 ] || existing_paths="$policy_paths"
dependency_paths="$(printf '%s\n' package.json pnpm-lock.yaml package-lock.json yarn.lock Cargo.toml Cargo.lock go.mod go.sum | paths_at_head)"
[ "$(jq length <<<"$dependency_paths")" -gt 0 ] || dependency_paths="$policy_paths"
required_contexts="$(jq '[.statusCheckRollup[] | select(.conclusion == "SUCCESS") | .name] | unique | sort' <<<"$pr")"
[ "$(jq length <<<"$required_contexts")" -gt 0 ] || { echo "buildchain dev deliver: exact PR head has no successful checks" >&2; exit 1; }

runtime_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_sha="$(git -C "$runtime_root" rev-parse 'HEAD^{commit}')"
predicates="$(node "$runtime_root/scripts/dev-delivery-source-proof-reuse.mjs" predicates \
  --cwd "$PWD" --repository "$repository" --branch "$base" --qualified-base "$qualified_base" \
  --source-head "$source_head" --runtime-ref "$runtime_sha" --runtime-sha "$runtime_sha" \
  --contract-digest "$runtime_sha" --node-version "${BUILDCHAIN_NODE_VERSION:-24}" \
  --policy-paths-json "$policy_paths" --closure-paths-json "$existing_paths" \
  --dependency-paths-json "$dependency_paths" --required-contexts-json "$required_contexts")"
workflow="buildchain-dev-delivery.yml"
gh api "repos/$repository/contents/.github/workflows/$workflow?ref=$base" >/dev/null 2>&1 || workflow="native-dev-delivery.yml"
payload="$(jq -n --arg ref "$base" --arg runtime "$runtime_sha" --arg number "$number" \
  --arg head "$source_head" --arg roots "$(jq -cn --arg root "$source_root" '{sourceRoot:$root}')" \
  --arg run "$run_id" --argjson proof "$predicates" '{ref:$ref,inputs:{
    "buildchain-ref":$runtime,"target-branch":$ref,"expected-pr-number":$number,
    "expected-head-sha":$head,"native-roots-json":$roots,"source-workflow-run-id":$run,
    "legacy-active-owner-binding-json":"","source-identity-root":$proof.sourceIdentityRoot,
    "source-patch-root":$proof.sourcePatchRoot,"plan-root":$proof.planRoot,
    "closure-root":$proof.closureRoot,"dependency-root":$proof.dependencyRoot,
    "toolchain-root":$proof.toolchainRoot,"environment-root":"",
    "affected-paths-json":($proof.affectedPaths|tojson),"shard-evidence-roots-json":"[]",
    "release-blocker-priority-json":"","native-proof-json":"","native-command":"",
    "native-command-root":"","native-heartbeat-seconds":"30","delivery-class":"non-native-fast",
    "delivery-priority":"ordinary"}}')"

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
