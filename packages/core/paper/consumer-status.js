import path from "node:path";
import {
  loadBuildchainConfig,
  validateBuildchainConfig,
} from "../consumer/buildchain-config.js";
import { validateConsumerWiring } from "../consumer/contract/local-validation.js";
import {
  gitValue,
  readJson,
  resolvePaperRepository,
} from "./paper-repository.js";

// Local product/configuration facts only. Hosted attempt state is owned by the pipeline.
export function paperConsumerStatus(cwd) {
  const loaded = loadBuildchainConfig(cwd);
  if (loaded?.config.schema !== 2) return null;
  const checks = [];
  let configuration;
  let wiring;
  try {
    configuration = validateBuildchainConfig(cwd, {
      requireLifecycleStages: ["build", "verify"],
    });
    if (!configuration.products.some((product) => product.type === "paper"))
      throw new Error("The consumer policy has no Paper product");
    checks.push({
      id: "config.paper",
      status: "pass",
      message: "Schema-2 Paper product commands and artifacts are valid",
    });
  } catch (error) {
    checks.push({ id: "config.paper", status: "fail", message: error.message });
  }
  try {
    wiring = validateConsumerWiring(cwd, loaded.path);
    checks.push({
      id: "workflow.consumer-pair",
      status: "pass",
      message: "The shared normal and recovery callers match",
    });
  } catch (error) {
    checks.push({
      id: "workflow.consumer-pair",
      status: "fail",
      message: error.message,
    });
  }
  const head = gitValue(cwd, ["rev-parse", "HEAD"]);
  const sourcePackage = readJson(path.join(cwd, "package.json")).value;
  return {
    schemaVersion: 2,
    ok: checks.every((check) => check.status === "pass"),
    cwd: path.resolve(cwd),
    checks,
    configuration,
    wiring,
    source: { head, repository: resolvePaperRepository(cwd) },
    identity: {
      project: sourcePackage?.name || "",
      title: sourcePackage?.description || "",
      repository: resolvePaperRepository(cwd),
    },
    localOnly: true,
    publication: {
      status: "not-observed",
      authority: "published-pipeline-attempt",
    },
    nonClaims: [
      "Local configuration checks do not prove hosted admission, successful builds, publication, or recovery",
    ],
  };
}
