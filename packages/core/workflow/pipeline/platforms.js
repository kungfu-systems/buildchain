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
  return platforms.map((platform) => {
    const budgets = plan.products
      .filter((product) => product.platforms.includes(platform))
      .map((product) => product.timeout_minutes)
      .filter((value) => value !== undefined);
    if (
      budgets.some(
        (value) => !Number.isInteger(value) || value < 1 || value > 360,
      )
    )
      throw new Error("Pipeline build timeout exceeds its admitted bound");
    return {
      platform,
      runner: RUNNERS[platform],
      ...(budgets.length ? { timeoutMinutes: Math.max(...budgets) } : {}),
    };
  });
}
