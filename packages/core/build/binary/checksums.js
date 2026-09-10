import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { requireValue } from "../../runtime/action-process.mjs";
export async function writeChecksums(directory = "dist/binary") {
  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "checksums.txt")
    .map((entry) => entry.name)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  requireValue(files.length > 0, "Binary evidence contains no files");
  const lines = [];
  for (const name of files) {
    requireValue(
      !/[\\\x00-\x1f\x7f]/u.test(name),
      "Binary evidence filename contains an unsupported control or escape character",
    );
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(path.join(directory, name)))
      hash.update(chunk);
    lines.push(`${hash.digest("hex")}  ./${name}\n`);
  }
  const temporary = path.join(
    directory,
    `.buildchain-checksums-${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, lines.join(""), { flag: "wx" });
    fs.renameSync(temporary, path.join(directory, "checksums.txt"));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
