#!/bin/bash

set -euo pipefail

rc_target_channel="${BUILDCHAIN_RC_TARGET_CHANNEL:-}"
if { [ -z "${rc_target_channel}" ] || [ "${rc_target_channel}" = "none" ]; } &&
  [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
  case "${BUILDCHAIN_RC_PR_BASE_REF:-}" in
    alpha/*) rc_target_channel="alpha" ;;
    release/*) rc_target_channel="release" ;;
    publish-gate/major|major-gate) rc_target_channel="major" ;;
  esac
fi

release_candidate_enabled=false
if [ "${BUILDCHAIN_RC_REQUESTED:-}" = "true" ] &&
  [ -n "${rc_target_channel}" ] && [ "${rc_target_channel}" != "none" ]; then
  release_candidate_enabled=true
fi

{
  echo "summary-artifact-name=${BUILDCHAIN_SUMMARY_ARTIFACT_NAME:-}"
  echo "diagnostics-summary-artifact-name=${BUILDCHAIN_DIAGNOSTICS_SUMMARY_ARTIFACT_NAME:-}"
  echo "release-candidate-enabled=${release_candidate_enabled}"
  echo "release-candidate-target-channel=${rc_target_channel}"
  if [ "${release_candidate_enabled}" = "true" ]; then
    echo "release-candidate-passport-artifact-name=${BUILDCHAIN_RC_PASSPORT_ARTIFACT_NAME:-}"
  else
    echo "release-candidate-passport-artifact-name="
  fi
} >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
