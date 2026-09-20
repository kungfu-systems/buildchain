#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  consumerAgentInstructions,
  planConsumerInitialization,
} from "../consumer-init.js";
import { PIPELINE_ENTRY } from "../../consumer/contract/entries.js";

function assertWritable(cwd, relative, force) {
  const parts = relative.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const name = path.join(cwd, ...parts.slice(0, index));
    const stat = fs.lstatSync(name, { throwIfNoEntry: false });
    if (!stat) continue;
    if (
      stat.isSymbolicLink() ||
      (index < parts.length ? !stat.isDirectory() : !stat.isFile())
    )
      throw new Error(
        `${relative}: initialization requires regular files and directories`,
      );
    if (index === parts.length && !force)
      throw new Error(`${relative} already exists; pass --force to overwrite`);
  }
}

export function initBuildchainRepo({
  cwd = process.cwd(),
  type = "package",
  force = false,
  packageManager = "",
  runnerPreset = "github-hosted",
  artifactName = "",
} = {}) {
  const resolvedCwd = fs.realpathSync(cwd);
  if (runnerPreset !== "github-hosted")
    throw new Error(
      "schema-2 init uses platform declarations; runner presets are internal runtime policy",
    );
  const planned = planConsumerInitialization({
    cwd: resolvedCwd,
    type,
    requestedManager: packageManager,
    artifactName,
  });
  // Validate the entire write set first: a later conflict must not leave partial wiring.
  for (const relative of Object.keys(planned.files))
    assertWritable(resolvedCwd, relative, force);
  const workflows = path.join(resolvedCwd, ".github/workflows");
  if (fs.existsSync(workflows))
    for (const file of fs.readdirSync(workflows))
      if (
        /\.ya?ml$/iu.test(file) &&
        !Object.hasOwn(planned.files, `.github/workflows/${file}`)
      )
        throw new Error(
          `Existing workflow ${file} is outside the generated consumer pair; migrate its product commands before initialization`,
        );
  assertWritable(resolvedCwd, "AGENTS.md", true);
  const agents = path.join(resolvedCwd, "AGENTS.md");
  planned.files["AGENTS.md"] = consumerAgentInstructions(
    fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "",
  );
  for (const [relative, bytes] of Object.entries(planned.files)) {
    const file = path.join(resolvedCwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return {
    schemaVersion: 2,
    type,
    productType: planned.productType,
    cwd: resolvedCwd,
    packageManager: planned.manager,
    workflowRef: `kungfu-systems/buildchain/${PIPELINE_ENTRY}@v4`,
    written: Object.keys(planned.files),
  };
}

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}
if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        initBuildchainRepo({
          cwd: readArg("cwd", process.cwd()),
          type: readArg("type", "package"),
          force: process.argv.includes("--force"),
          packageManager: readArg("package-manager"),
          runnerPreset: readArg("runner-preset", "github-hosted"),
          artifactName: readArg("artifact-name"),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`init-repo: ${error.message}`);
    process.exitCode = 1;
  }
}
