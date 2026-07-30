import fs from "node:fs";
import path from "node:path";

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] || "";
}

function readBooleanFlag(args, name) {
  return args.includes(`--${name}`);
}

function readRepeatedFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function artifactEnvelopeOptions(args) {
  const assessmentTime = readFlag(args, "assessment-time", "");
  return {
    ...(assessmentTime ? { assessmentTime: Number(assessmentTime) } : {}),
    expectedEnvelopeRoot: readFlag(args, "expected-root", ""),
    expectedIssuer: readFlag(args, "expected-issuer", ""),
    expectedPublisher: readFlag(args, "expected-publisher", ""),
    expectedContractVersion: readFlag(args, "expected-contract", ""),
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonFile(filePath, value) {
  if (!filePath) {
    return "";
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function readJsonInput(value, { cwd = process.cwd(), label = "json" } = {}) {
  const input = String(value || "").trim();
  if (!input) {
    throw new Error(`${label} is required`);
  }
  const filePath = path.isAbsolute(input) ? input : path.join(cwd, input);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  return JSON.parse(input);
}

function readRepeatedJsonInputs(args, name, { cwd = process.cwd(), label = name } = {}) {
  return readRepeatedFlag(args, name).map((value, index) => readJsonInput(value, {
    cwd,
    label: `${label}[${index}]`,
  }));
}

export {
  artifactEnvelopeOptions,
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
};
