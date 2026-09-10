import path from "node:path";
import { qualifyMediaProfile } from "./media-qualification.js";

export async function mediaQualificationAction(core, env) {
  const fixture = JSON.parse(core.getInput("fixture-json", { required: true }));
  if (!fixture || Array.isArray(fixture) || typeof fixture !== "object")
    throw new Error("Media fixture must be an object");
  if (!path.isAbsolute(env.GITHUB_WORKSPACE || ""))
    throw new Error(
      "Media qualification requires an absolute runner workspace",
    );
  const evidence = await qualifyMediaProfile({
    workspace: env.GITHUB_WORKSPACE,
    fixture: fixture.fixture,
    profile: fixture.profile,
    evidence: fixture.evidence,
    rendererImage: fixture.rendererImage,
    rendererSourceRepository: "kungfu-systems/build-images",
    rendererSourceRef: fixture.rendererSourceRef,
    rendererSourceSha: fixture.rendererSourceSha,
  });
  core.info(
    JSON.stringify(
      evidence.qualification.renditions.map(
        ({ path, role, root, bytes, maximumBytes }) => ({
          path,
          role,
          root,
          bytes,
          maximumBytes,
        }),
      ),
      null,
      2,
    ),
  );
}
