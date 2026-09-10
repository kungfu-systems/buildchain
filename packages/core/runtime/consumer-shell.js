import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { command } from "./action-process.mjs";

// Matches GitHub runner file-command framing, including multiline values.
// https://github.com/actions/runner/blob/main/src/Runner.Worker/FileCommandManager.cs
export function parseEnvironmentCommands(text, platform = process.platform) {
  let offset = 0;
  const line = () => {
    if (offset >= text.length) return null;
    const start = offset,
      lf = text.indexOf("\n", offset);
    if (lf < 0) {
      offset = text.length;
      return { value: text.slice(start), start, end: offset, newline: 0 };
    }
    const width = platform === "win32" && text[lf - 1] === "\r" ? 2 : 1;
    offset = lf + 1;
    return {
      value: text.slice(start, lf + 1 - width),
      start,
      end: lf + 1 - width,
      newline: width,
    };
  };
  const values = {};
  for (let row = line(); row; row = line()) {
    if (!row.value) continue;
    const equals = row.value.indexOf("="),
      heredoc = row.value.indexOf("<<");
    if (equals >= 0 && (heredoc < 0 || equals < heredoc)) {
      const key = row.value.slice(0, equals);
      if (!key) throw new Error("Environment command has an empty name");
      values[key] = row.value.slice(equals + 1);
      continue;
    }
    if (heredoc < 1) throw new Error("Invalid environment command framing");
    const key = row.value.slice(0, heredoc),
      delimiter = row.value.slice(heredoc + 2);
    if (!delimiter)
      throw new Error("Environment command has an empty delimiter");
    const start = offset;
    let end = start,
      part = line();
    while (part?.value !== delimiter) {
      if (!part || !part.newline)
        throw new Error("Environment command is missing its closing delimiter");
      end = part.end;
      part = line();
    }
    values[key] = text.slice(start, end);
  }
  return values;
}
const read = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
function append(file, value) {
  if (file && value) fs.appendFileSync(file, value);
}
function environmentMessage(key, value) {
  const delimiter = `buildchain_${crypto.randomUUID()}`;
  return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
}

// A session belongs to one admitted consumer transaction. Each phase gets its
// own command files, so consumer outputs cannot become action authority outputs.
export function consumerCommandSession(baseEnvironment = process.env) {
  const initial = { ...baseEnvironment },
    environment = { ...initial };
  const pathKey =
    process.platform === "win32"
      ? Object.keys(initial).find((key) => key.toUpperCase() === "PATH") ||
        "PATH"
      : "PATH";
  return {
    environment,
    async run(
      { script, cwd, env = {}, strict = false, pipefail = strict },
      execute = command,
    ) {
      if (typeof script !== "string" || !script.trim())
        throw new Error("Consumer command must be explicitly declared");
      return this.phase(
        (phaseEnv) =>
          execute(
            "bash",
            [
              "--noprofile",
              "--norc",
              "-e",
              ...(strict ? ["-u"] : []),
              ...(pipefail ? ["-o", "pipefail"] : []),
              "-c",
              script,
            ],
            { cwd, env: phaseEnv },
          ),
        env,
      );
    },
    async phase(effect, env = {}) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "buildchain-consumer-phase-"),
      );
      const files = Object.fromEntries(
        [
          "GITHUB_ENV",
          "GITHUB_PATH",
          "GITHUB_OUTPUT",
          "GITHUB_STATE",
          "GITHUB_STEP_SUMMARY",
        ].map((key) => [key, path.join(directory, key)]),
      );
      for (const file of Object.values(files)) fs.writeFileSync(file, "");
      let result, failure;
      try {
        try {
          result = await effect({ ...environment, ...env, ...files });
        } catch (error) {
          failure = error;
        }
        try {
          const updates = parseEnvironmentCommands(read(files.GITHUB_ENV));
          if (
            Object.keys(updates).some(
              (key) => key.toUpperCase() === "NODE_OPTIONS",
            )
          )
            throw new Error(
              "GitHub environment commands cannot set NODE_OPTIONS",
            );
          for (const [key, value] of Object.entries(updates)) {
            // The runner owns default GitHub and runner identity variables.
            if (/^(GITHUB_|RUNNER_)/i.test(key)) continue;
            const actualKey =
              process.platform === "win32"
                ? Object.keys(environment).find(
                    (existing) => existing.toUpperCase() === key.toUpperCase(),
                  ) || key
                : key;
            environment[actualKey] = value;
            append(initial.GITHUB_ENV, environmentMessage(key, value));
          }
          for (const directory of read(files.GITHUB_PATH)
            .split(/\r?\n/)
            .filter(Boolean)) {
            const entries = (environment[pathKey] || "")
              .split(path.delimiter)
              .filter((value) => value !== directory);
            environment[pathKey] = [directory, ...entries].join(path.delimiter);
            append(initial.GITHUB_PATH, `${directory}\n`);
          }
          append(initial.GITHUB_STEP_SUMMARY, read(files.GITHUB_STEP_SUMMARY));
        } catch (error) {
          if (failure) {
            const combined = new AggregateError(
              [failure, error],
              `${failure.message}; ${error.message}`,
              { cause: failure },
            );
            combined.status = failure.status;
            failure = combined;
          } else failure = error;
        }
        if (failure) throw failure;
        return result;
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
