#!/bin/bash
set -euo pipefail

for name in ROUTER_REF ROUTER_SHA SHELL_REF SHELL_SHA RUNTIME_REF RUNTIME_SHA LOCK_PATH LOCK_DIGEST PUBLICATION_CHANNEL ROUTED_TARGET_REF; do
  if [[ -z "${!name}" ]]; then
    echo "::error::Incomplete promotion router binding: ${name} is empty"
    exit 1
  fi
done

router_sha="$(git -C .buildchain/promotion-router rev-parse HEAD)"
shell_sha="$(git -C .buildchain/promotion-shell rev-parse HEAD)"
runtime_sha="$(git -C .buildchain/runtime rev-parse HEAD)"
expected_router_sha="${ROUTER_SHA:-}"
expected_shell_sha="${SHELL_SHA:-}"
expected_runtime_sha="${RUNTIME_SHA:-}"
expected_lock_digest="${LOCK_DIGEST:-}"
lock_file=".buildchain/promotion-source/${LOCK_PATH}"
if [[ ! -f "${lock_file}" ]]; then
  echo "::error::Selected promotion contract lock is missing: ${LOCK_PATH}"
  exit 1
fi
lock_digest="sha256:$(shasum -a 256 "${lock_file}" | awk '{print $1}')"
[[ "${router_sha}" = "${expected_router_sha}" ]] || { echo "::error::Promotion router SHA mismatch"; exit 1; }
[[ "${shell_sha}" = "${expected_shell_sha}" ]] || { echo "::error::Promotion shell SHA mismatch"; exit 1; }
[[ "${runtime_sha}" = "${expected_runtime_sha}" ]] || { echo "::error::Promotion runtime SHA mismatch"; exit 1; }
[[ "${lock_digest}" = "${expected_lock_digest}" ]] || { echo "::error::Promotion contract-lock digest mismatch"; exit 1; }
[[ "${ACTUAL_RUNTIME_SHA}" = "${RUNTIME_SHA}" ]] || { echo "::error::Promotion runtime SHA mismatch"; exit 1; }
[[ "${ACTUAL_LOCK_PATH}" = "${LOCK_PATH}" ]] || { echo "::error::Promotion contract-lock path mismatch"; exit 1; }
[[ "${ACTUAL_CHANNEL}" = "${PUBLICATION_CHANNEL}" ]] || { echo "::error::Promotion publication channel mismatch"; exit 1; }
[[ "${ACTUAL_TARGET_REF}" = "${ROUTED_TARGET_REF}" ]] || { echo "::error::Promotion target ref mismatch"; exit 1; }
[[ "${CALLED_WORKFLOW_SHA}" = "${SHELL_SHA}" ]] || { echo "::error::Called promotion shell SHA mismatch"; exit 1; }
called_ref="${CALLED_WORKFLOW_REF##*@}"
called_ref="${called_ref#refs/heads/}"
called_ref="${called_ref#refs/tags/}"
[[ "${called_ref}" = "${SHELL_REF}" ]] || { echo "::error::Called promotion shell ref ${called_ref} does not match ${SHELL_REF}"; exit 1; }
