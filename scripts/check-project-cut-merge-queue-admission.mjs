#!/usr/bin/env node
import fs from "node:fs";
import {
  ProjectCutAdmissionError,
  qualifyProjectCut,
  releaseFamilyQueueLease,
} from "./project-cut-merge-queue-admission.mjs";

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ["--base", "base"],
    ["--head", "head"],
    ["--initiative-id", "initiativeId"],
    ["--assignment-id", "assignmentId"],
    ["--delivery-class", "deliveryClass"],
    ["--queue-attempt", "queueAttempt"],
    ["--admission-proof-root", "admissionProofRoot"],
    ["--release-family-marker", "releaseFamilyMarker"],
    ["--expected-pr-head", "expectedPullRequestHead"],
    ["--terminal-reason", "terminalReason"],
    ["--evidence-root", "evidenceRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const key = names.get(name);
    if (!key) throw new Error(`unknown argument: ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    if (Object.hasOwn(options, key))
      throw new Error(`${name} was provided more than once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function markerText(path) {
  return path === "-"
    ? fs.readFileSync(0, "utf8")
    : fs.readFileSync(path, "utf8");
}

function repairReceipt(error) {
  return {
    schema: "project.cut.merge-queue-admission/v1",
    ok: false,
    decision: "repair-required",
    retryable: false,
    compositionChanged: false,
    reasonCodes: [error.reasonCode],
    error: error.message,
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.releaseFamilyMarker) {
      console.log(
        JSON.stringify(
          releaseFamilyQueueLease(
            markerText(options.releaseFamilyMarker),
            options,
          ),
        ),
      );
      return 0;
    }
    if (!options.base || !options.head)
      throw new Error("--base and --head are required");
    console.log(
      JSON.stringify(qualifyProjectCut({ cwd: process.cwd(), ...options })),
    );
    return 0;
  } catch (error) {
    if (error instanceof ProjectCutAdmissionError) {
      console.log(JSON.stringify(repairReceipt(error)));
      return 1;
    }
    console.error(`project-cut admission error: ${error.message}`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
