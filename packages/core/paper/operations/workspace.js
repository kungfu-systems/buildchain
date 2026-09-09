import { BUILDCHAIN_PACKAGE_NAME } from "./identity.js";
export function paperPnpmWorkspace(current, buildchainVersion) {
  const entry = `${BUILDCHAIN_PACKAGE_NAME}@${buildchainVersion}`;
  const source = String(current || "");
  const lines = source ? source.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const keyLines = lines
    .map((line, index) =>
      /^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(line) ? index : -1,
    )
    .filter((index) => index >= 0);
  const unsupportedKey = lines.some(
    (line) =>
      /^minimumReleaseAgeExclude\s*:/.test(line) &&
      !/^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(line),
  );
  if (unsupportedKey || keyLines.length > 1) {
    throw new Error(
      "paper migration requires minimumReleaseAgeExclude to be one top-level block sequence",
    );
  }
  if (keyLines.length === 0) {
    const prefix = lines.length > 0 ? [...lines, ""] : [];
    return `${[...prefix, "minimumReleaseAgeExclude:", `  - '${entry}'`].join(
      "\n",
    )}\n`;
  }
  const keyIndex = keyLines[0];
  let blockEnd = lines.length;
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    if (/^[^\s#]/.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }
  const retained = [];
  for (const line of lines.slice(keyIndex + 1, blockEnd)) {
    if (!line.trim() || /^\s*#/.test(line)) {
      retained.push(line);
      continue;
    }
    const item = line.match(/^\s*-\s+(.+?)\s*(?:#.*)?$/);
    if (!item) {
      throw new Error(
        "paper migration requires minimumReleaseAgeExclude to contain scalar package entries",
      );
    }
    const value = item[1]
      .trim()
      .replace(/^'(.*)'$/, "$1")
      .replace(/^"(.*)"$/, "$1");
    if (!value.startsWith(`${BUILDCHAIN_PACKAGE_NAME}@`)) retained.push(line);
  }
  return `${[
    ...lines.slice(0, keyIndex + 1),
    ...retained,
    `  - '${entry}'`,
    ...lines.slice(blockEnd),
  ].join("\n")}\n`;
}
