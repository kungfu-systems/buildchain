import path from "node:path";
import {
  createCandidateTimeline,
  formatCandidateTimelineReport,
} from "../candidate-timeline.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

export async function handleCandidateCommand(args) {
  const [subcommand = "", ...candidateArgs] = args;
  if (subcommand !== "timeline") {
    throw new Error(
      "usage: buildchain candidate timeline --input <file-or-json>",
    );
  }
  const inputValue = readFlag(candidateArgs, "input", "");
  if (!inputValue) {
    throw new Error(
      "buildchain candidate timeline requires --input <file-or-json>",
    );
  }
  const input = readJsonInput(inputValue, {
    label: "candidate timeline input",
  });
  const timeline = createCandidateTimeline(input);
  const output = readFlag(candidateArgs, "output", "");
  if (output) writeJsonFile(path.resolve(output), timeline);
  if (readBooleanFlag(candidateArgs, "json") || !output) {
    printJson(timeline);
  } else {
    process.stdout.write(`${formatCandidateTimelineReport(timeline)}\n`);
    process.stdout.write(`wrote: ${output}\n`);
  }
  return;
}
