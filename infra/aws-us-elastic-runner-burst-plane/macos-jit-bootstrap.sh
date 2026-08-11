#!/bin/bash
set -euo pipefail

umask 077

Region="__REGION__"
JitParameterName="__JIT_PARAMETER_NAME__"
EvidenceBucket="__EVIDENCE_BUCKET__"
RunnerLabel="__RUNNER_LABEL__"
SourceSha="__SOURCE_SHA__"
ExpectedRunId="__GITHUB_RUN_ID__"
ExpectedRunAttempt="__GITHUB_RUN_ATTEMPT__"
AmiId="__AMI_ID__"
AmiName="__AMI_NAME__"
HostId="__HOST_ID__"
InstanceType="__INSTANCE_TYPE__"
HostAllocatedAt="__HOST_ALLOCATED_AT__"
RunnerVersion="2.336.0"
RunnerArchive="actions-runner-osx-arm64-${RunnerVersion}.tar.gz"
RunnerArchiveSha256="8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079"
RunnerUser="ec2-user"
RunnerRoot="/Users/${RunnerUser}/kungfu-actions-runner/${RunnerLabel}"
RunnerArchivePath="/private/tmp/${RunnerArchive}"
RunnerPath="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

export PATH="$RunnerPath"

for Command in aws curl tar shasum sudo; do
  if ! command -v "$Command" >/dev/null 2>&1; then
    echo "required command is unavailable: ${Command}" >&2
    exit 1
  fi
done

ImdsToken="$(curl --fail --silent --show-error --request PUT \
  --header "X-aws-ec2-metadata-token-ttl-seconds: 21600" \
  http://169.254.169.254/latest/api/token)"
InstanceId="$(curl --fail --silent --show-error \
  --header "X-aws-ec2-metadata-token: ${ImdsToken}" \
  http://169.254.169.254/latest/meta-data/instance-id)"
AvailabilityZone="$(curl --fail --silent --show-error \
  --header "X-aws-ec2-metadata-token: ${ImdsToken}" \
  http://169.254.169.254/latest/meta-data/placement/availability-zone)"
InstanceLaunchedAt="$(aws ec2 describe-instances \
  --region "$Region" \
  --instance-ids "$InstanceId" \
  --query "Reservations[0].Instances[0].LaunchTime" \
  --output text)"

JitConfig="$(aws ssm get-parameter \
  --region "$Region" \
  --name "$JitParameterName" \
  --with-decryption \
  --query "Parameter.Value" \
  --output text)"
aws ssm delete-parameter --region "$Region" --name "$JitParameterName"

if [[ -z "$JitConfig" || "$JitConfig" == "None" ]]; then
  echo "JIT configuration was empty" >&2
  exit 1
fi

install -d -o "$RunnerUser" -g staff -m 700 "$RunnerRoot"
curl --fail --location --silent --show-error \
  --output "$RunnerArchivePath" \
  "https://github.com/actions/runner/releases/download/v${RunnerVersion}/${RunnerArchive}"
printf "%s  %s\n" "$RunnerArchiveSha256" "$RunnerArchivePath" | shasum -a 256 -c -
tar -xzf "$RunnerArchivePath" -C "$RunnerRoot"
chown -R "${RunnerUser}:staff" "$RunnerRoot"

RunnerStartedAt="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
set +e
sudo -u "$RunnerUser" -H env \
  PATH="$RunnerPath" \
  AWS_EC2_MAC_HOST_ID="$HostId" \
  AWS_EC2_MAC_HOST_ALLOCATED_AT="$HostAllocatedAt" \
  AWS_EC2_INSTANCE_ID="$InstanceId" \
  AWS_EC2_INSTANCE_TYPE="$InstanceType" \
  AWS_EC2_AMI_ID="$AmiId" \
  AWS_EC2_AMI_NAME="$AmiName" \
  AWS_EC2_AVAILABILITY_ZONE="$AvailabilityZone" \
  AWS_EC2_LAUNCHED_AT="$InstanceLaunchedAt" \
  AWS_EC2_RUNNER_STARTED_AT="$RunnerStartedAt" \
  BUILDCHAIN_RUNNER_LABELS_JSON="[\"self-hosted\",\"macOS\",\"ARM64\",\"${RunnerLabel}\"]" \
  BUILDCHAIN_EXPECTED_SOURCE_SHA="$SourceSha" \
  BUILDCHAIN_EXPECTED_RUN_ID="$ExpectedRunId" \
  BUILDCHAIN_EXPECTED_RUN_ATTEMPT="$ExpectedRunAttempt" \
  "$RunnerRoot/run.sh" --jitconfig "$JitConfig"
RunnerExitCode=$?
set -e
unset JitConfig

RunnerExitedAt="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
EvidenceFile="/private/tmp/${RunnerLabel}-bootstrap-evidence.json"
cat >"$EvidenceFile" <<EOF
{
  "schemaVersion": 1,
  "contract": "kungfu-buildchain-aws-macos-jit-bootstrap/v1",
  "runnerLabel": "${RunnerLabel}",
  "sourceSha": "${SourceSha}",
  "githubRunId": "${ExpectedRunId}",
  "githubRunAttempt": "${ExpectedRunAttempt}",
  "hostId": "${HostId}",
  "instanceId": "${InstanceId}",
  "instanceType": "${InstanceType}",
  "amiId": "${AmiId}",
  "amiName": "${AmiName}",
  "availabilityZone": "${AvailabilityZone}",
  "hostAllocatedAt": "${HostAllocatedAt}",
  "instanceLaunchedAt": "${InstanceLaunchedAt}",
  "runnerStartedAt": "${RunnerStartedAt}",
  "runnerExitedAt": "${RunnerExitedAt}",
  "runnerExitCode": ${RunnerExitCode},
  "jitParameterDeleted": true
}
EOF
aws s3 cp \
  "$EvidenceFile" \
  "s3://${EvidenceBucket}/macos/${SourceSha}/${ExpectedRunId}-${ExpectedRunAttempt}-${RunnerLabel}.json" \
  --region "$Region" \
  --sse AES256

exit "$RunnerExitCode"
