import { consumerWorkflows } from "./entries.js";
import { compileConsumerPlan, CONFIG_PATH } from "./plan.js";

const INTERNAL_WIRING = [
  /\b(?:request-json|native-roots-json|used-nonces-json|warrant-result|source-proof|integration-proof)\b/iu,
  /\bbuildchain\s+(?:dev\s+(?:warrant|proof)|release|promote|recover|publish)\b/iu,
  /\b(?:npm\s+publish|gh\s+release\s+(?:create|upload)|gh\s+run\s+download)\b/iu,
  /actions\/download-artifact@/u,
  /\.buildchain\/runtime\/|packages\/core\/(?:publication|release|dev-delivery)\//u,
  /\b(?:fencingToken|candidateRoot|sourceProofRoot|usedNonces|generationRoot|compareAndSwap)\b/u,
  /buildchain[-./][\w-]*(?:warrant|proof|fence|nonce|candidate|authority|transaction)/iu,
];

// The supplied file map must be the complete tracked consumer tree, including
// package scripts and the source files they invoke. Runtime source is never run.
export function inspectConsumerContract(
  files,
  { channel = "v4", configPath = CONFIG_PATH } = {},
) {
  const issues = [];
  let plan;
  try {
    plan = compileConsumerPlan(files[configPath]);
  } catch (error) {
    issues.push(`${configPath}: ${error.message}`);
  }
  const workflows = consumerWorkflows(channel, configPath);
  for (const [file, expected] of Object.entries(workflows))
    if (files[file] !== expected)
      issues.push(`${file}: must match the generated thin caller`);
  for (const [file, source] of Object.entries(files)) {
    if (
      /^\.github\/workflows\/.*\.ya?ml$/u.test(file) &&
      !Object.hasOwn(workflows, file)
    )
      issues.push(`${file}: extra consumer workflow is forbidden`);
    if (!/\.(?:toml|json|ya?ml|[cm]?js|ts|py|sh|ps1|rb)$/u.test(file)) continue;
    for (const pattern of INTERNAL_WIRING)
      if (pattern.test(String(source)))
        issues.push(
          `${file}: consumer owns internal orchestration (${pattern.source})`,
        );
  }
  return { ok: issues.length === 0, issues, plan };
}
