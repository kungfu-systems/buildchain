import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const LIMIT = 8 * 1024 * 1024;

export function readPublicBuildArchive(archive, digest) {
  if (
    archive.length > LIMIT ||
    `sha256:${createHash("sha256").update(archive).digest("hex")}` !== digest
  )
    throw new Error("public build artifact digest or size mismatch");
  const script = [
    "import io,sys,zipfile",
    "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "entries=[e for e in z.infolist() if e.filename=='build-summary.json']",
    "assert len(entries)==1 and entries[0].file_size <= 1048576, 'invalid public build archive'",
    "sys.stdout.buffer.write(z.read(entries[0]))",
  ].join("\n");
  return JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-c", script],
      { input: archive, encoding: "utf8", maxBuffer: 1048576 },
    ),
  );
}

export async function fetchQualificationArchive({
  apiUrl,
  token,
  endpoint,
  fetchImpl,
}) {
  let response = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}${endpoint}`, {
    redirect: "manual",
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 302) {
    const location = new URL(response.headers.get("location"));
    if (location.protocol !== "https:")
      throw new Error("invalid artifact download redirect");
    response = await fetchImpl(location.href, { redirect: "error" });
  }
  if (!response.ok)
    throw new Error(
      `public build artifact download failed: ${response.status}`,
    );
  if (Number(response.headers.get("content-length")) > LIMIT)
    throw new Error("public build archive exceeds size limit");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > LIMIT)
      throw new Error("public build archive exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readPublicBuildArtifact({
  api,
  fetchArchive,
  repository,
  run,
}) {
  const prefix = `/repos/${repository}/actions`;
  const assets = await api(`${prefix}/runs/${run.id}/artifacts?per_page=100`);
  const matches = (assets.artifacts || []).filter(
    (asset) => asset.name === `buildchain-summary-${run.head_sha}`,
  );
  if (
    matches.length !== 1 ||
    matches[0].expired ||
    matches[0].size_in_bytes > LIMIT
  )
    throw new Error(
      "public build summary artifact missing, ambiguous or expired",
    );
  const asset = matches[0];
  return readPublicBuildArchive(
    await fetchArchive(`${prefix}/artifacts/${asset.id}/zip`),
    asset.digest,
  );
}
