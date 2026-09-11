import path from "node:path";
import {
  auditKfd3Surfaces,
  createKfd3SurfaceWitness,
  detectKfd3Surfaces,
  queryKfd3Capabilities,
  registerKfd3Surfaces,
} from "../kfd3-surface-register.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

export function kfd3Kinds(args = []) {
  return readRepeatedFlag(args, "kind")
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function runKfd3Cli(args = []) {
  const [subcommand = "", maybeKindOrProduct = "", ...rest] = args;
  if (
    !["detect", "register", "audit", "witness", "query"].includes(subcommand)
  ) {
    throw new Error(
      "usage: buildchain kfd 3 <detect|register|audit|witness|query> ...",
    );
  }
  const effectiveArgs =
    maybeKindOrProduct && maybeKindOrProduct.startsWith("--")
      ? [maybeKindOrProduct, ...rest]
      : rest;
  const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
  const registryPath = readFlag(effectiveArgs, "registry", "");
  const artifactPath = readFlag(effectiveArgs, "artifact", "");
  const json = readBooleanFlag(effectiveArgs, "json");

  if (subcommand === "detect") {
    const result = detectKfd3Surfaces({
      cwd,
      kinds: kfd3Kinds(effectiveArgs),
      artifactPath,
    });
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd 3 detect: ${result.summary.surfaceCount} surfaces\n`,
      );
      for (const entry of result.surfaces) {
        process.stdout.write(
          `- ${entry.kind}: ${entry.id} (${entry.detectionMethod})\n`,
        );
      }
    }
    return;
  }

  if (subcommand === "register") {
    const registerKind =
      maybeKindOrProduct && !maybeKindOrProduct.startsWith("--")
        ? maybeKindOrProduct
        : "";
    if (!registerKind) {
      throw new Error(
        "usage: buildchain kfd 3 register <node-api|python-api|cli|binary|documentation|site-bundle>",
      );
    }
    const result = registerKfd3Surfaces({
      cwd,
      registryPath,
      kinds: [registerKind],
      artifactPath,
      product: {
        name: readFlag(effectiveArgs, "product", ""),
      },
    });
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd 3 register: ${result.registeredCount} ${registerKind} surfaces -> ${registryPath}\n`,
      );
    }
    return;
  }

  if (subcommand === "audit") {
    const report = auditKfd3Surfaces({
      cwd,
      registryPath,
      kinds: kfd3Kinds(effectiveArgs),
      artifactPath,
    });
    if (json) {
      printJson(report);
    } else {
      process.stdout.write(`kfd 3 audit: ${report.status}\n`);
      process.stdout.write(
        `detected=${report.summary.detected} declared=${report.summary.declared} enforced=${report.summary.enforced}\n`,
      );
      for (const issue of report.issues) {
        process.stdout.write(
          `- ${issue.level}: ${issue.code}: ${issue.surfaceId}\n`,
        );
      }
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (subcommand === "witness") {
    const witness = createKfd3SurfaceWitness({
      cwd,
      registryPath,
      kind: readFlag(effectiveArgs, "kind", "prebuild"),
      sourceSha: readFlag(
        effectiveArgs,
        "source-sha",
        process.env.GITHUB_SHA || "",
      ),
      artifactPath,
    });
    const output = readFlag(effectiveArgs, "output", "");
    if (output) {
      writeJsonFile(path.resolve(cwd, output), witness);
    }
    if (json || !output) {
      printJson(witness);
    } else {
      process.stdout.write(`kfd 3 witness: wrote ${output}\n`);
    }
    return;
  }

  return queryRegisteredSurfaces({ maybeKindOrProduct, effectiveArgs, cwd, registryPath, artifactPath, json });
}

async function queryRegisteredSurfaces({ maybeKindOrProduct, effectiveArgs, cwd, registryPath, artifactPath, json }) {
  const product =
    maybeKindOrProduct && !maybeKindOrProduct.startsWith("--")
      ? maybeKindOrProduct
      : readFlag(effectiveArgs, "product", "");
  const result = await queryKfd3Capabilities({
    cwd,
    product,
    registryPath,
    passportLocation: readFlag(effectiveArgs, "passport", ""),
    artifactPath,
  });
  if (json) {
    printJson(result);
  } else {
    process.stdout.write(
      `kfd 3 query: ${result.product} (${result.status || result.kfd?.kfd3 || "unknown"})\n`,
    );
    process.stdout.write(`capabilities: ${result.capabilities?.length || 0}\n`);
    for (const entry of result.capabilities || []) {
      process.stdout.write(
        `- ${entry.kind}: ${entry.id} [${entry.state || "declared"}]\n`,
      );
    }
  }
}
