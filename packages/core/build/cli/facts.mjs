import path from "node:path";
import {
  aggregateBuildFacts,
  collectModuleBuildFacts,
  verifyBuildFacts,
  writeBuildFacts,
} from "../build-facts.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";
import { runCompatibilityFactsCli } from "../../governance/cli/compatibility-facts.mjs";
import { root } from "../../contracts/cli/context.mjs";

export async function runBuildFactsCli(args = []) {
  const [subcommand = "", ...factArgs] = args;
  const cwd = path.resolve(readFlag(factArgs, "cwd", process.cwd()));
  if (subcommand === "compatibility") {
    return runCompatibilityFactsCli({ args: factArgs, cwd, packageRoot: root });
  }
  if (subcommand === "module") {
    validateModuleFactsOptions(factArgs);
    const fact = collectModuleBuildFacts({
      cwd,
      moduleId: readFlag(factArgs, "module", ""),
      moduleRoot: readFlag(factArgs, "module-root", ""),
      versionSourceId: readFlag(factArgs, "version-source", ""),
      outputs: readRepeatedFlag(factArgs, "output-path"),
      lifecycle: readFlag(factArgs, "lifecycle", ""),
      platform: readFlag(factArgs, "platform", "") || undefined,
    });
    const output = readFlag(factArgs, "output", "");
    const writeResult = output
      ? writeBuildFacts({ cwd, fact, output })
      : undefined;
    const result = {
      ...fact,
      ...(writeResult ? { written: writeResult } : {}),
    };
    if (readBooleanFlag(factArgs, "json") || !output) {
      printJson(result);
    } else {
      process.stdout.write(
        `buildchain facts module: ${fact.verification.ok ? "ok" : "failed"} ${writeResult.path}\n`,
      );
    }
    if (!fact.verification.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (subcommand === "aggregate") {
    const fact = aggregateBuildFacts({
      cwd,
      productId: readFlag(factArgs, "product", ""),
      moduleFacts: readRepeatedFlag(factArgs, "module-fact"),
      artifacts: readRepeatedFlag(factArgs, "artifact"),
    });
    const output = readFlag(factArgs, "output", "");
    const writeResult = output
      ? writeBuildFacts({ cwd, fact, output })
      : undefined;
    const result = {
      ...fact,
      ...(writeResult ? { written: writeResult } : {}),
    };
    if (readBooleanFlag(factArgs, "json") || !output) {
      printJson(result);
    } else {
      process.stdout.write(
        `buildchain facts aggregate: ${fact.verification.ok ? "ok" : "failed"} ${writeResult.path}\n`,
      );
    }
    if (!fact.verification.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (subcommand === "verify") {
    const factPath = readFlag(factArgs, "fact", "");
    if (!factPath) {
      throw new Error("usage: buildchain facts verify --fact <file>");
    }
    const result = verifyBuildFacts({ cwd, factPath });
    if (readBooleanFlag(factArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(
        `buildchain facts verify: ${result.ok ? "ok" : "failed"}\n`,
      );
      for (const issue of result.issues) {
        process.stdout.write(
          `- ${issue.level}: ${issue.id}: ${issue.message}\n`,
        );
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(
    "usage: buildchain facts <module|aggregate|verify|compatibility> ...",
  );
}

export async function handleFactsCommand(args) {
  await runBuildFactsCli(args);
  return;
}

function validateModuleFactsOptions(factArgs) {
    const allowed = new Set(["--cwd", "--module", "--module-root", "--version-source", "--output-path", "--lifecycle", "--platform", "--output", "--json"]);
    for (const arg of factArgs) if (arg.startsWith("--") && !allowed.has(arg)) throw new Error(`unsupported facts module option: ${arg}`);
}
