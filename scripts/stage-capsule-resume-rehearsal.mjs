#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { installationRoot } from "../packages/core/runtime/installation-root.js";
import { domainCanonicalBytes } from "../packages/core/contracts/canonical-contracts.js";
import { rehearseStageResume } from "../packages/core/build/stage-capsule/rehearsal/resume.js";
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const index = process.argv.indexOf("--platform");
  if (index < 0 || !process.argv[index + 1])
    throw new Error("--platform is required");
  process.stdout.write(
    domainCanonicalBytes(
      rehearseStageResume({
        runtimeRoot: installationRoot(import.meta.url),
        platform: process.argv[index + 1],
      }),
    ),
  );
}
