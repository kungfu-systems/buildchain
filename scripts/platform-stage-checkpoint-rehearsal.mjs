#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installationRoot } from "../packages/core/runtime/installation-root.js";
import { domainCanonicalBytes } from "../packages/core/contracts/canonical-contracts.js";
import {
  emitCheckpointRehearsal,
  restoreCheckpointRehearsal,
} from "../packages/core/build/stage-capsule/rehearsal/checkpoint.js";
import { rehearseStageCheckpoint } from "../packages/core/build/stage-capsule/rehearsal/run.js";
export function stageCheckpointRehearsalCli(args = process.argv.slice(2)) {
  const option = (name, fallback = "") => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const required = (name) => {
    const value = option(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const common = {
    runtimeRoot: installationRoot(import.meta.url),
    workRoot: path.resolve(required("work-root")),
    platformId: required("platform"),
    stageId: option("stage", "build"),
    recordedAt: required("recorded-at"),
  };
  if (args[0] === "emit") return emitCheckpointRehearsal(common);
  if (args[0] === "restore") return restoreCheckpointRehearsal(common);
  if (args[0] === "rehearse") return rehearseStageCheckpoint(common);
  throw new Error("action must be emit, restore, or rehearse");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = stageCheckpointRehearsalCli();
  if (result !== undefined) process.stdout.write(domainCanonicalBytes(result));
}
