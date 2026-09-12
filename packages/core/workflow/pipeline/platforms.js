// Standard labels verified against GitHub's runner reference on 2026-09-13:
// https://docs.github.com/en/actions/reference/runners/github-hosted-runners
const RUNNERS = Object.freeze({
  "linux-x64": "ubuntu-24.04",
  "linux-arm64": "ubuntu-24.04-arm",
  "macos-arm64": "macos-15",
  "macos-x64": "macos-15-intel",
  "windows-x64": "windows-2025",
});

export function pipelinePlatforms(plan) {
  const platforms = [
    ...new Set(plan.products.flatMap((product) => product.platforms)),
  ].sort();
  if (
    !platforms.length ||
    platforms.some((platform) => !Object.hasOwn(RUNNERS, platform))
  )
    throw new Error("Pipeline product platform has no admitted hosted runner");
  return platforms.map((platform) => ({ platform, runner: RUNNERS[platform] }));
}
