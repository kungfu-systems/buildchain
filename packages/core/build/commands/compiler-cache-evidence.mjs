import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCompilerCacheEvidence, verifyCompilerCacheActivity } from "../cache/compiler-evidence.js";
function main() {
  const command = process.argv[2] || "";
  if (!new Set(["prepare", "verify"]).has(command)) {
    throw new Error("usage: node packages/core/build/commands/compiler-cache-evidence.mjs <prepare|verify>");
  }
  if (command === "prepare") {
    const receipt = prepareCompilerCacheEvidence({ cwd: process.cwd(), env: process.env });
    if (receipt) {
      console.log(`compiler_cache_provider=${receipt.provider}`);
      console.log(`compiler_cache_preparation_root=${receipt.root}`);
    } else {
      console.log("compiler_cache_provider=none");
    }
  } else {
    const activity = verifyCompilerCacheActivity({ cwd: process.cwd(), env: process.env });
    if (activity) {
      console.log(`compiler_cache_compile_requests=${activity.compileRequests}`);
      console.log(`compiler_cache_hits=${activity.cacheHits}`);
      console.log(`compiler_cache_misses=${activity.cacheMisses}`);
    } else {
      console.log("compiler_cache_activity=not-applicable");
    }
  }
}

const isMain = process.argv[1] &&
  path.basename(process.argv[1]) === "compiler-cache-evidence.mjs" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
