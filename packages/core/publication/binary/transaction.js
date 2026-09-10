import fs from "node:fs";
import path from "node:path";
import { validateBinaryCapability } from "./capability.js";
import { prepareBinaryAssetPaths } from "./evidence.js";
import { writeChecksums } from "../../build/binary/checksums.js";
export async function publishBinaryAssets(
  { workspace, repository, tag, sourceSha, capability, now },
  client,
) {
  const passportDir = path.join(workspace, ".buildchain/release-passport");
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(passportDir, "buildchain-release-bundle.json"),
      "utf8",
    ),
  );
  validateBinaryCapability({ capability, manifest, tag, sourceSha, now });
  const capabilityPath = path.join(
    workspace,
    ".buildchain/publication-authority/capability.json",
  );
  fs.mkdirSync(path.dirname(capabilityPath), { recursive: true });
  fs.writeFileSync(capabilityPath, `${JSON.stringify(capability, null, 2)}\n`);
  const binaryDir = path.join(workspace, "dist/binary"),
    outputDir = path.join(workspace, ".buildchain/binary-publication");
  await writeChecksums(binaryDir);
  const release = await client.release(tag);
  const files = prepareBinaryAssetPaths({
    binaryDir,
    passportDir,
    outputDir,
    capabilityPath,
  });
  const assets = await client.publish(release, files);
  const result = { repository, tag, assets };
  client.write(path.join(outputDir, "readback.json"), result);
  return result;
}
