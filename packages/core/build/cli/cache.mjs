import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createPortableDevCachePlan,
  createPortableDevCacheReceipt,
} from "../portable-dev-cache.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

export async function handlePortableCacheCommand(args) {
  const [subcommand = "", ...cacheArgs] = args;
  if (subcommand === "plan") {
    const manifestValue = readFlag(cacheArgs, "manifest", "");
    if (!manifestValue)
      throw new Error(
        "usage: buildchain portable-cache plan --manifest <file-or-json>",
      );
    const value = createPortableDevCachePlan(
      readJsonInput(manifestValue, { label: "portable cache manifest" }),
    );
    const output = readFlag(cacheArgs, "output", "");
    if (output) writeJsonFile(path.resolve(output), value);
    const githubOutput = readFlag(cacheArgs, "github-output", "");
    if (githubOutput) {
      const delimiter = `BUILDCHAIN_PORTABLE_CACHE_${crypto.randomBytes(8).toString("hex")}`;
      const fields = {
        "cache-key": value.key,
        "restore-keys": value.restoreKeys.join("\n"),
        "cache-paths": value.paths.join("\n"),
        "plan-digest": value.planDigest,
        "plan-json": JSON.stringify(value),
      };
      const lines = Object.entries(fields).flatMap(([name, field]) => [
        `${name}<<${delimiter}`,
        field,
        delimiter,
      ]);
      fs.appendFileSync(path.resolve(githubOutput), `${lines.join("\n")}\n`);
    }
    if (!output || readBooleanFlag(cacheArgs, "json")) printJson(value);
    else process.stdout.write(`portable cache plan: ${output}\n`);
    return;
  }
  if (subcommand === "receipt") {
    const planValue = readFlag(cacheArgs, "plan", "");
    if (!planValue)
      throw new Error(
        "usage: buildchain portable-cache receipt --plan <file-or-json>",
      );
    const value = createPortableDevCacheReceipt({
      plan: readJsonInput(planValue, { label: "portable cache plan" }),
      matchedKey: readFlag(cacheArgs, "matched-key", ""),
      cacheHit: readFlag(cacheArgs, "cache-hit", ""),
      validationStatus: readFlag(cacheArgs, "validation-status", "pass"),
      validationReason: readFlag(cacheArgs, "validation-reason", ""),
      coldFallbackStatus: readFlag(
        cacheArgs,
        "cold-fallback-status",
        "not-run",
      ),
    });
    const output = readFlag(cacheArgs, "output", "");
    if (output) writeJsonFile(path.resolve(output), value);
    if (!output || readBooleanFlag(cacheArgs, "json")) printJson(value);
    else process.stdout.write(`portable cache receipt: ${output}\n`);
    return;
  }
  throw new Error("usage: buildchain portable-cache <plan|receipt> ...");
}
