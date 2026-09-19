import { createHash } from "node:crypto";
import { recordDigest } from "../../release/discussion/envelope.js";

const NAMES = [
  "plan",
  "qualification",
  "capsules",
  "invocation",
  "attestation",
  "release",
];
const LIMIT = 8 * 1024 * 1024;

async function inventory(request, prefix) {
  const assets = [],
    ids = new Set(),
    names = new Set();
  for (let page = 1; page <= 20; page++) {
    const values = await request(`${prefix}/assets?per_page=100&page=${page}`);
    if (!Array.isArray(values) || values.length > 100)
      throw new Error("Published evidence asset inventory is incomplete");
    for (const value of values) {
      if (
        !Number.isSafeInteger(value.id) ||
        value.id < 1 ||
        typeof value.name !== "string" ||
        !value.name ||
        ids.has(value.id) ||
        names.has(value.name)
      )
        throw new Error("Published evidence asset inventory is ambiguous");
      ids.add(value.id);
      names.add(value.name);
      assets.push(value);
    }
    if (values.length < 100) return assets;
  }
  throw new Error(
    "Published evidence inventory exceeds its complete-read bound",
  );
}

function selectedAssets(assets) {
  return NAMES.map((id) => {
    const name = `buildchain.${id}.json`;
    const asset = assets.find((value) => value.name === name);
    if (!asset) return { name, missing: true };
    if (
      asset.state !== "uploaded" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > LIMIT ||
      !/^sha256:[0-9a-f]{64}$/u.test(asset.digest || "")
    )
      throw new Error("Published evidence asset lacks bounded immutable bytes");
    return { id: asset.id, name, size: asset.size, digest: asset.digest };
  });
}

// Download only fixed evidence names from the exact already-observed release.
// There is no caller-supplied URL, artifact selector or provider write here.
export async function readPipelineReleaseEvidence(host, candidate) {
  const repository = host.repository;
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(repository || "") ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id < 1
  )
    throw new Error("Published evidence requires exact release coordinates");
  const prefix = `/repos/${repository}/releases/${candidate.id}`;
  const selected = selectedAssets(await inventory(host.request, prefix));
  const missing = selected
    .filter((value) => value.missing)
    .map(({ name }) => name);
  if (missing.length) return { status: "missing", missing };
  const [owner, repo] = repository.split("/");
  const values = {};
  let bundle;
  for (const asset of selected) {
    const result = await host.github.rest.repos.getReleaseAsset({
      owner,
      repo,
      asset_id: asset.id,
      headers: { accept: "application/octet-stream" },
    });
    const bytes = Buffer.from(result.data);
    if (
      bytes.length !== asset.size ||
      bytes.length > LIMIT ||
      `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
        asset.digest
    )
      throw new Error(
        "Published evidence download differs from provider bytes",
      );
    const id = asset.name.slice("buildchain.".length, -".json".length);
    if (id === "attestation") bundle = bytes;
    else
      values[id] = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
  }
  if (
    recordDigest(selectedAssets(await inventory(host.request, prefix))) !==
    recordDigest(selected)
  )
    throw new Error(
      "Published evidence assets changed during provider readback",
    );
  return { status: "present", values, bundle, assets: selected };
}
