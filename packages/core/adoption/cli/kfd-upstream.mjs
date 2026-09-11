import fs from "node:fs";
import path from "node:path";
import { checkKfdUpstreamFacts, collectKfdUpstreamFacts, listKfdUpstreamRoles } from "../kfd.js";
import { printJson, readBooleanFlag, readFlag, readJsonInput } from "../../contracts/cli/options.mjs";

export async function runKfdUpstream(maybeStandardOrAction, rest) {
    const [action = "", ...upstreamArgs] = [maybeStandardOrAction, ...rest];
    const effectiveAction = action || "collect";
    const cwd = path.resolve(readFlag(upstreamArgs, "cwd", process.cwd()));
    const json = readBooleanFlag(upstreamArgs, "json");
    if (effectiveAction === "roles") {
      const result = listKfdUpstreamRoles();
      if (json) {
        printJson(result);
      } else {
        process.stdout.write("KFD upstream roles:\n");
        for (const entry of result.roles) {
          process.stdout.write(`- ${entry.role}: ${entry.description}\n`);
        }
      }
      return;
    }
    if (effectiveAction === "collect") {
      const result = collectKfdUpstreamFacts({ cwd });
      const output = readFlag(upstreamArgs, "output", "");
      if (output) {
        fs.mkdirSync(path.dirname(path.resolve(cwd, output)), {
          recursive: true,
        });
        fs.writeFileSync(
          path.resolve(cwd, output),
          `${JSON.stringify(result, null, 2)}\n`,
        );
      }
      if (json || !output) {
        printJson(result);
      } else {
        process.stdout.write(`kfd upstream collect: wrote ${output}\n`);
      }
      return;
    }
    if (effectiveAction === "check") {
      const aggregateInput = readFlag(upstreamArgs, "aggregate-json", "");
      const aggregate = aggregateInput
        ? readJsonInput(aggregateInput, {
            cwd,
            label: "kfd upstream aggregate",
          })
        : collectKfdUpstreamFacts({ cwd });
      const result = checkKfdUpstreamFacts(aggregate);
      if (json) {
        printJson(result);
      } else {
        process.stdout.write(
          `kfd upstream check: ${result.status} (${result.upstreamCount} upstreams)\n`,
        );
        for (const entry of result.issues) {
          process.stdout.write(
            `- ${entry.level}: ${entry.code}: ${entry.message}\n`,
          );
        }
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
      return;
    }
    throw new Error("usage: buildchain kfd upstream <roles|collect|check> ...");
  }
