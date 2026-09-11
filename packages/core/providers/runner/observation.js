export function runnerObservation(environment) {
  return {
    job: environment.GITHUB_JOB,
    name: environment.RUNNER_NAME,
    labels: JSON.parse(environment.BUILDCHAIN_RUNNER_LABELS_JSON || "[]"),
    codebuild: {
      buildId: environment.CODEBUILD_BUILD_ID,
      buildArn: environment.CODEBUILD_BUILD_ARN,
      initiator: environment.CODEBUILD_INITIATOR,
      region: environment.AWS_REGION || environment.AWS_DEFAULT_REGION || "",
    },
    ec2: {
      campaignId: environment.AWS_EC2_CAMPAIGN_ID,
      hostId: environment.AWS_EC2_MAC_HOST_ID,
      instanceId: environment.AWS_EC2_INSTANCE_ID,
      instanceType: environment.AWS_EC2_INSTANCE_TYPE,
      amiId: environment.AWS_EC2_AMI_ID,
      amiName: environment.AWS_EC2_AMI_NAME,
      availabilityZone: environment.AWS_EC2_AVAILABILITY_ZONE,
      hostAllocatedAt: environment.AWS_EC2_MAC_HOST_ALLOCATED_AT,
      launchedAt: environment.AWS_EC2_LAUNCHED_AT,
      runnerStartedAt: environment.AWS_EC2_RUNNER_STARTED_AT,
      runnerExitedAt:
        environment.AWS_EC2_RUNNER_EXITED_AT || new Date().toISOString(),
      terminatedAt: environment.AWS_EC2_TERMINATED_AT,
      cleanupResult:
        environment.AWS_EC2_CLEANUP_RESULT || "runner-exit-termination-pending",
    },
  };
}
