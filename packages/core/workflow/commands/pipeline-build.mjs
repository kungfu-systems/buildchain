#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { normalInputs } from "../../consumer/contract/entries.js";
import { compileConsumerPlan } from "../../consumer/contract/plan.js";
import { buildPipelineProducts } from "../pipeline/build.js";

const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== "--platform" ||
  args[2] !== "--config-path"
)
  throw new Error(
    "usage: pipeline-build --platform <platform> --config-path <TOML>",
  );
const { configPath } = normalInputs({ "config-path": args[3] });
const cwd = fs.realpathSync(process.cwd());
const config = fs.realpathSync(path.join(cwd, configPath));
if (!config.startsWith(`${cwd}${path.sep}`))
  throw new Error("Candidate TOML escapes its checkout");
const plan = compileConsumerPlan(fs.readFileSync(config, "utf8"));
await buildPipelineProducts({ cwd, plan, platform: args[1] });
