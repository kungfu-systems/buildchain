#!/bin/bash
set -euo pipefail

: "${BUILDCHAIN_SIGNED_PAYLOAD:?BUILDCHAIN_SIGNED_PAYLOAD is required}"
: "${BUILDCHAIN_SIGNING_EVIDENCE:?BUILDCHAIN_SIGNING_EVIDENCE is required}"
: "${BUILDCHAIN_APPLE_CERTIFICATE_P12_BASE64:?Buildchain Apple certificate is required}"
: "${BUILDCHAIN_APPLE_CERTIFICATE_PASSWORD:?Buildchain Apple certificate password is required}"
: "${BUILDCHAIN_APPLE_CERTIFICATE_SHA1:?Buildchain Apple certificate fingerprint is required}"
: "${BUILDCHAIN_APPLE_TEAM_ID:?Buildchain Apple Team ID is required}"
: "${BUILDCHAIN_APPLE_NOTARY_KEY_P8_BASE64:?Buildchain Apple notary key is required}"
: "${BUILDCHAIN_APPLE_NOTARY_KEY_ID:?Buildchain Apple notary key ID is required}"
: "${BUILDCHAIN_APPLE_NOTARY_ISSUER:?Buildchain Apple notary issuer is required}"

case "${BUILDCHAIN_APPLE_CERTIFICATE_SHA1}" in
  *[!0-9A-Fa-f]*|'') echo "invalid Apple certificate fingerprint" >&2; exit 1 ;;
esac

authority_tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/buildchain-macho-authority.XXXXXX")"
keychain_path="${authority_tmp}/authority.keychain-db"
keychain_password="$(openssl rand -hex 32)"
certificate_path="${authority_tmp}/certificate.p12"
notary_key_path="${authority_tmp}/AuthKey_${BUILDCHAIN_APPLE_NOTARY_KEY_ID}.p8"
notary_archive="${authority_tmp}/notary-submission.zip"
notary_submission="${authority_tmp}/notary-submission.json"
notary_result="${authority_tmp}/notary-result.json"
signature_details="${authority_tmp}/codesign-details.txt"
notary_timeout="${BUILDCHAIN_APPLE_NOTARY_TIMEOUT:-55m}"

cleanup() {
  security delete-keychain "${keychain_path}" >/dev/null 2>&1 || true
  rm -rf "${authority_tmp}"
}
trap cleanup EXIT INT TERM

printf '%s' "${BUILDCHAIN_APPLE_CERTIFICATE_P12_BASE64}" | openssl base64 -d -A > "${certificate_path}"
printf '%s' "${BUILDCHAIN_APPLE_NOTARY_KEY_P8_BASE64}" | openssl base64 -d -A > "${notary_key_path}"
chmod 600 "${certificate_path}" "${notary_key_path}"

security create-keychain -p "${keychain_password}" "${keychain_path}"
security set-keychain-settings -lut 21600 "${keychain_path}"
security unlock-keychain -p "${keychain_password}" "${keychain_path}"
security import "${certificate_path}" -k "${keychain_path}" -P "${BUILDCHAIN_APPLE_CERTIFICATE_PASSWORD}" -T /usr/bin/codesign -T /usr/bin/security
echo "Buildchain macOS authority: configure imported private-key access"
security set-key-partition-list -S apple-tool:,apple:,codesign: -k "${keychain_password}" "${keychain_path}" >/dev/null
security list-keychains -d user -s "${keychain_path}"
echo "Buildchain macOS authority: verify requested signing identity"
security find-identity -v -p codesigning "${keychain_path}" | grep -Fqi "${BUILDCHAIN_APPLE_CERTIFICATE_SHA1}" || {
  echo "configured Developer ID identity was not imported" >&2
  exit 1
}

echo "Buildchain macOS authority: sign exact Mach-O payload"
codesign --force --options runtime --timestamp --keychain "${keychain_path}" --sign "${BUILDCHAIN_APPLE_CERTIFICATE_SHA1}" "${BUILDCHAIN_SIGNED_PAYLOAD}"
codesign --verify --strict --verbose=4 "${BUILDCHAIN_SIGNED_PAYLOAD}"
codesign --display --verbose=4 "${BUILDCHAIN_SIGNED_PAYLOAD}" 2> "${signature_details}"
grep -Fqx "TeamIdentifier=${BUILDCHAIN_APPLE_TEAM_ID}" "${signature_details}" || {
  echo "signed Mach-O TeamIdentifier mismatch" >&2
  exit 1
}
grep -Fq "Runtime Version" "${signature_details}" || {
  echo "signed Mach-O does not prove hardened runtime" >&2
  exit 1
}

/usr/bin/ditto -c -k --keepParent "${BUILDCHAIN_SIGNED_PAYLOAD}" "${notary_archive}"
echo "Buildchain macOS authority: submit exact signed Mach-O for notarization"
xcrun notarytool submit "${notary_archive}" --key "${notary_key_path}" --key-id "${BUILDCHAIN_APPLE_NOTARY_KEY_ID}" --issuer "${BUILDCHAIN_APPLE_NOTARY_ISSUER}" --output-format json > "${notary_submission}"
notary_id="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!value.id)throw new Error("Apple notarization submission did not return an id");process.stdout.write(value.id)' "${notary_submission}")"
echo "Buildchain macOS authority: notarization submission ${notary_id}; wait up to ${notary_timeout}"
xcrun notarytool wait "${notary_id}" --key "${notary_key_path}" --key-id "${BUILDCHAIN_APPLE_NOTARY_KEY_ID}" --issuer "${BUILDCHAIN_APPLE_NOTARY_ISSUER}" --timeout "${notary_timeout}" --output-format json > "${notary_result}"
node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(value.status!=="Accepted"||value.id!==process.argv[2])throw new Error("Apple notarization was not accepted for the submitted artifact")' "${notary_result}" "${notary_id}"
echo "Buildchain macOS authority: Apple accepted notarization ${notary_id}; standalone ticket is available online and cannot be stapled"

node - "${notary_result}" "${BUILDCHAIN_SIGNING_EVIDENCE}" "${BUILDCHAIN_APPLE_CERTIFICATE_SHA1}" "${BUILDCHAIN_APPLE_TEAM_ID}" <<'NODE'
const fs = require("fs");
const notary = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const evidence = {
  schemaVersion: 1,
  contract: "kungfu-buildchain-apple-developer-id-evidence/v1",
  status: "passed",
  provider: "apple",
  certificateSha1: process.argv[4].toUpperCase(),
  teamId: process.argv[5],
  notarization: { id: notary.id, status: notary.status, ticketDelivery: "online" },
  stapling: { status: "not-applicable", reason: "standalone Mach-O executables do not support stapled notarization tickets" },
  gatekeeper: { status: "not-directly-assessable", reason: "spctl execute assessment applies app semantics and does not directly assess standalone Mach-O executables" },
  checks: ["codesign-strict", "developer-id-team", "hardened-runtime", "notarytool-accepted", "standalone-notary-ticket-online"],
};
fs.writeFileSync(process.argv[3], `${JSON.stringify(evidence, null, 2)}\n`);
NODE
