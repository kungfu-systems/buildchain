#!/usr/bin/env node
import path from "node:path";
import { qualifyAdopterPlatform } from "../qualification/platform.js";
import { reconcileAdopterReports } from "../qualification/aggregate.js";
function flag(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function required(name) {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function repeated(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1])
      values.push(process.argv[++index]);
  }
  return values;
}


const mode = process.argv[2];
const result = mode === "run" ? qualifyAdopterPlatform({ runtimeRoot: path.resolve(required("runtime-root")), consumerRoot: path.resolve(flag("consumer-root", process.cwd())), output: path.resolve(required("output")), inputPath: required("input"), platform: required("platform"), consumer: required("consumer"), runtimeSha: required("runtime-sha"), consumerSha: required("consumer-sha") }) : mode === "aggregate" ? reconcileAdopterReports({ reportsRoot: path.resolve(required("reports-root")), consumers: repeated("consumer"), output: flag("output") }) : (() => { throw new Error("usage: cross-platform-adopter-qualification.mjs <run|aggregate> ..."); })();
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
