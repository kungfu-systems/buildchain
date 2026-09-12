import {
  recordDigest,
  validateRuntime,
} from "../../release/discussion/envelope.js";

const stages = {
  build: "actions/workflow/pipeline/build/dist",
  "publication-build": "actions/publication/pipeline/build/dist",
};

export async function qualifyRecoveryRuntime(
  previous,
  current,
  stage,
  request,
) {
  validateRuntime(previous);
  validateRuntime(current);
  if (
    ![previous.repository, current.repository].every(
      (repo) => repo === "kungfu-systems/buildchain",
    ) ||
    !stages[stage]
  )
    throw new Error(
      "Recovery runtime comparison requires a declared canonical execution stage",
    );
  if (
    previous.sha === current.sha &&
    previous.readerDigest !== current.readerDigest
  )
    throw new Error("An exact runtime changed its immutable reader bytes");
  async function closure(runtime) {
    const files = [];
    for (const name of ["index.js", "buildchain-domain.wasm"]) {
      const file = `${stages[stage]}/${name}`;
      const metadata = await request(
        `/repos/${runtime.repository}/contents/${file}?ref=${runtime.sha}`,
        { allow404: name.endsWith(".wasm") },
      );
      if (!metadata && name.endsWith(".wasm")) {
        files.push({ path: file, blob: null });
        continue;
      }
      if (
        metadata?.type !== "file" ||
        !/^[0-9a-f]{40}$/u.test(metadata.sha || "")
      )
        throw new Error(
          "Recovery runtime has no exact distributed stage implementation",
        );
      files.push({ path: file, blob: metadata.sha });
    }
    return files;
  }
  const before = await closure(previous);
  const after = previous.sha === current.sha ? before : await closure(current);
  const body = {
    schema: "buildchain.pipeline-recovery-runtime/v1",
    stage,
    previous,
    current,
    before,
    after,
    compatible: recordDigest(before) === recordDigest(after),
  };
  return { ...body, root: recordDigest(body) };
}
