import fs from "node:fs";
import path from "node:path";
import { historicalPromotionContext } from "./promotion/compatibility-context.js";

export const RELEASE_METADATA_NAME = "buildchain.release-metadata.json";
const schema = "buildchain.github-release-metadata/v1";

// The metadata is an ordinary content-rooted release asset. The provider reads
// it only after validating every local asset against its qualified root.
export function historicalReleaseMetadata(context, outputDir) {
  const inputs = historicalPromotionContext(context)?.inputs;
  if (
    !inputs ||
    !(inputs["github-release-title"] || inputs["github-release-notes"])
  )
    return [];
  const metadata = {
    schema,
    ...(inputs["github-release-title"]
      ? { name: inputs["github-release-title"] }
      : {}),
    ...(inputs["github-release-notes"]
      ? { body: inputs["github-release-notes"] }
      : {}),
  };
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, RELEASE_METADATA_NAME);
  fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`);
  return [file];
}

export function releaseMetadata(artifacts) {
  const files = artifacts.filter(({ name }) => name === RELEASE_METADATA_NAME);
  if (!files.length) return null;
  if (files.length !== 1) throw new Error("Ambiguous GitHub Release metadata");
  const value = JSON.parse(fs.readFileSync(files[0].path, "utf8"));
  if (
    !value ||
    value.schema !== schema ||
    Object.keys(value).some(
      (key) => !["schema", "name", "body"].includes(key),
    ) ||
    !["name", "body"].some((key) => typeof value[key] === "string") ||
    ["name", "body"].some(
      (key) => Object.hasOwn(value, key) && typeof value[key] !== "string",
    )
  )
    throw new Error("Invalid GitHub Release metadata");
  const { schema: _schema, ...fields } = value;
  return fields;
}

export function releaseMetadataMatches(metadata, release) {
  return (
    !metadata ||
    Object.entries(metadata).every(([key, value]) => release[key] === value)
  );
}
