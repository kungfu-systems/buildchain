import path from "node:path";
import {
  checkKfdUpstreamFacts,
  collectKfdAggregate,
  collectKfdStatus,
  collectKfdUpstreamFacts,
  kfd1,
  kfd2,
  layout as buildchainLayout,
  listKfdUpstreamRoles,
  listKfdSchemas,
  normalizeKfdStandardId,
  readKfdSchema,
} from "../kfd.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";
import { printKfdSchemaOrJson } from "./output.mjs";

export function runKfd1Cli(args = []) {
  const [rawAction = "schema", ...rest] = args;
  const action = rawAction || "schema";
  const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
  const json = readBooleanFlag(rest, "json");
  if (action === "schema") {
    printKfdSchemaOrJson({
      result: readKfdSchema({
        standard: "kfd-1",
        schema: readFlag(rest, "schema", ""),
      }),
      json,
    });
    return;
  }
  if (action === "witness") {
    const witness = kfd1.createBuildchainWitness({
      root: cwd,
      sourceSha: readFlag(rest, "source-sha", process.env.GITHUB_SHA || ""),
    });
    const output = readFlag(rest, "output", "");
    if (output) {
      writeJsonFile(path.resolve(cwd, output), witness);
    }
    if (json || !output) {
      printJson(witness);
    } else {
      process.stdout.write(`kfd 1 witness: wrote ${output}\n`);
    }
    return;
  }
  if (action === "gate") {
    const witnesses = readRepeatedJsonInputs(rest, "witness-json", {
      cwd,
      label: "kfd-1 witness",
    });
    if (witnesses.length === 0) {
      throw new Error(
        "buildchain kfd 1 gate requires at least one --witness-json",
      );
    }
    const gate = kfd1.createReleaseGateEvidence({
      cwd,
      artifactRoot: readFlag(rest, "artifact-root", ""),
      witnesses,
    });
    const output = readFlag(rest, "output", "");
    if (output) {
      writeJsonFile(path.resolve(cwd, output), gate);
    }
    if (json || !output) {
      printJson(gate);
    } else {
      process.stdout.write(`kfd 1 gate: wrote ${output}\n`);
    }
    return;
  }
  if (action === "verify") {
    const gate = readJsonInput(readFlag(rest, "gate-json", ""), {
      cwd,
      label: "kfd-1 gate",
    });
    const issues = kfd1.validateReleaseGateEvidence(gate);
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-1-verify-result",
      ok: issues.length === 0,
      issues,
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(`kfd 1 verify: ${result.ok ? "ok" : "failed"}\n`);
      for (const issue of issues) {
        process.stdout.write(
          `- ${issue.level || "error"}: ${issue.code || "kfd-1"}: ${issue.message || issue}\n`,
        );
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("usage: buildchain kfd 1 <schema|witness|gate|verify> ...");
}

export function runKfd2Cli(args = []) {
  const [rawAction = "schema", ...rest] = args;
  const action = rawAction || "schema";
  const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
  const json = readBooleanFlag(rest, "json");
  if (action === "schema") {
    printKfdSchemaOrJson({
      result: readKfdSchema({
        standard: "kfd-2",
        schema: readFlag(rest, "schema", ""),
      }),
      json,
    });
    return;
  }
  if (action === "taxonomy") {
    const kind = readFlag(rest, "kind", "residualRisk");
    const entries = readRepeatedJsonInputs(rest, "entry-json", {
      cwd,
      label: "kfd-2 taxonomy entry",
    });
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-taxonomy-validation",
      ok: true,
      kind,
      entries: kfd2.validateTaxonomyEntries({ entries, kind }),
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd 2 taxonomy: ${result.entries.length} ${kind} entries ok\n`,
      );
    }
    return;
  }
  if (action === "claims") {
    const claims = kfd2.createBuildchainClaims({ root: cwd });
    const outputDir = readFlag(rest, "output-dir", "");
    if (outputDir) {
      for (const claim of claims) {
        const slug = String(claim.id || "claim").replace(
          /[^a-z0-9._-]+/gi,
          "-",
        );
        writeJsonFile(path.resolve(cwd, outputDir, `${slug}.json`), claim);
      }
    }
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-claims",
      count: claims.length,
      claims,
    };
    if (json || !outputDir) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd 2 claims: wrote ${claims.length} claims to ${outputDir}\n`,
      );
    }
    return;
  }
  if (action === "product-claims") {
    return runProductClaims(rest, cwd, json);
  }
  if (action === "trust-claims") {
    const document = readFlag(rest, "claims-json", "")
      ? readJsonInput(readFlag(rest, "claims-json", ""), {
          cwd,
          label: "kfd-2 trust claims",
        })
      : kfd2.readFoundationTrustClaims();
    const validation = kfd2.validateTrustClaims(document);
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-trust-claims",
      source: readFlag(rest, "claims-json", "")
        ? "input"
        : "@kungfu-tech/kfd foundation trust claims",
      document,
      validation,
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd 2 trust-claims: ${validation.ok ? "ok" : "failed"} (${validation.claimCount} claims)\n`,
      );
    }
    if (!validation.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (action === "trust-assessment") {
    const document = readFlag(rest, "assessment-json", "")
      ? readJsonInput(readFlag(rest, "assessment-json", ""), {
          cwd,
          label: "kfd-2 trust assessment",
        })
      : kfd2.readFoundationTrustAssessment();
    const validation = kfd2.validateTrustAssessment(document);
    const result = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-kfd-2-trust-assessment",
      source: readFlag(rest, "assessment-json", "")
        ? "input"
        : "@kungfu-tech/kfd foundation trust assessment",
      document,
      validation,
    };
    if (json) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd 2 trust-assessment: ${validation.ok ? "ok" : "failed"} (${validation.result || "unknown"}, ${validation.assessmentCount} assessments)\n`,
      );
    }
    if (!validation.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(
    "usage: buildchain kfd 2 <schema|taxonomy|claims|product-claims|trust-claims|trust-assessment> ...",
  );
}

function runProductClaims(rest, cwd, json) {
    const mode = !rest[0] || rest[0].startsWith("--") ? "check" : rest[0];
    const productArgs = mode === rest[0] ? rest.slice(1) : rest;
    const options = {
      cwd,
      ...(readFlag(productArgs, "registry", "")
        ? { registryPath: readFlag(productArgs, "registry", "") }
        : {}),
      ...(readFlag(productArgs, "output-dir", "")
        ? { outputDir: readFlag(productArgs, "output-dir", "") }
        : {}),
      version: readFlag(productArgs, "version", ""),
      channel: readFlag(productArgs, "channel", ""),
      tag: readFlag(productArgs, "tag", ""),
      sourceSha: readFlag(productArgs, "source-sha", ""),
    };
    let result;
    if (mode === "check") result = kfd2.checkProductClaimOutputs(options);
    else if (mode === "write") result = kfd2.writeProductClaimOutputs(options);
    else if (mode === "render")
      result = kfd2.renderProductClaimOutputs(options);
    else
      throw new Error(
        "usage: buildchain kfd 2 product-claims <check|write|render> ...",
      );
    if (json || mode === "render") {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd 2 product-claims ${mode}: ${result.ok ? "ok" : "failed"} (${result.summary.claimCount} claims, ${result.status || "rendered"})\n`,
      );
      for (const entry of result.issues || []) {
        process.stdout.write(
          `- ${entry.level || "error"}: ${entry.code}: ${entry.message}\n`,
        );
      }
    }
    if (!result.ok) process.exitCode = 1;
    return;
}
