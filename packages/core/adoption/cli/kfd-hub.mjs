import path from "node:path";
import { explainKfdAgentHub, initKfdAgentHub, inspectKfdAgentHub, testKfdAgentHub } from "../kfd-agent-hub.js";
import { printJson, readBooleanFlag, readFlag } from "../../contracts/cli/options.mjs";

export async function runKfdHub(maybeStandardOrAction, rest) {
    const action = maybeStandardOrAction || "inspect";
    const cwd = path.resolve(readFlag(rest, "cwd", process.cwd()));
    const declarationPath = readFlag(
      rest,
      "declaration",
      ".buildchain/kfd/agent-hub.json",
    );
    const common = { cwd, declarationPath };
    let result;
    if (action === "init") {
      result = initKfdAgentHub({
        ...common,
        write: readBooleanFlag(rest, "write"),
        force: readBooleanFlag(rest, "force"),
      });
    } else if (action === "inspect") {
      result = inspectKfdAgentHub(common);
    } else if (action === "test") {
      result = testKfdAgentHub({
        ...common,
        outputDir: readFlag(
          rest,
          "output-dir",
          ".buildchain/artifacts/kfd-agent-hub",
        ),
      });
    } else if (action === "explain") {
      result = explainKfdAgentHub(common);
    } else {
      throw new Error(
        "usage: buildchain kfd hub <init|inspect|test|explain> ...",
      );
    }
    if (
      readBooleanFlag(rest, "json") ||
      readFlag(rest, "for", "") === "agent" ||
      action !== "init"
    ) {
      printJson(result);
    } else {
      process.stdout.write(
        `kfd hub init: ${result.write ? "wrote" : "planned"} ${result.path}\n`,
      );
    }
    if (result.valid === false || result.status === "blocked")
      process.exitCode = 1;
    return;
  }
