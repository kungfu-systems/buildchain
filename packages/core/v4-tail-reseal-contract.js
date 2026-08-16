export const V4_TAIL_RESEAL_REQUEST_CONTRACT =
  "kungfu-buildchain-v4-tail-reseal-request/v1";
export const V4_TAIL_RESEAL_PLAN_CONTRACT =
  "kungfu-buildchain-v4-tail-reseal-plan/v1";

export const V4_TAIL_RESEAL_PLATFORMS = Object.freeze([
  "linux-arm64",
  "linux-x64",
  "macos-arm64",
  "windows-x64",
]);

export const V4_TAIL_RESEAL_PLATFORM_RUNNERS = Object.freeze({
  "linux-arm64": '["ubuntu-24.04-arm"]',
  "linux-x64": '["ubuntu-24.04"]',
  "macos-arm64": '["macos-15"]',
  "windows-x64": '["windows-2025"]',
});

export const V4_TAIL_RESEAL_REUSED_STAGE_KEYS = Object.freeze(
  V4_TAIL_RESEAL_PLATFORMS.flatMap((platformId) =>
    ["build", "install", "package", "verify"].map(
      (stage) => `${platformId}:${stage}`,
    ),
  ).sort(),
);
