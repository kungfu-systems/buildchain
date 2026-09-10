import { command, requireValue } from "../../runtime/action-process.mjs";
export function resolvePaperTarget({ workspace, ref, sha }, execute = command) {
  requireValue(
    /^(alpha|release)\/v\d+\/v\d+\.\d+$/.test(ref),
    "Paper release requires an exact alpha or release channel branch",
  );
  requireValue(
    /^[0-9a-f]{40}$/.test(sha),
    "Paper publication source SHA must be exact",
  );
  requireValue(
    execute("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      stdio: "pipe",
    }).trim() === sha,
    "Paper source checkout differs from the publication target",
  );
  return { ref, sha, channel: ref.split("/")[0] };
}
export async function lockPaperPublicationTarget({
  github,
  repository,
  target,
  version,
}) {
  const [owner, repo] = repository.split("/");
  const gateRef = `publish-gate/${target.channel}/${target.ref.replace(/^(alpha|release)\//, "")}/${version}`,
    ref = `heads/${gateRef}`;
  try {
    const current = await github.rest.git.getRef({ owner, repo, ref });
    requireValue(
      current.data.object.sha === target.sha,
      "publication gate already binds a different source commit",
    );
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await github.rest.git.createRef({
        owner,
        repo,
        ref: `refs/${ref}`,
        sha: target.sha,
      });
    } catch (createError) {
      if (createError.status !== 422) throw createError;
    }
    const readback = await github.rest.git.getRef({ owner, repo, ref });
    requireValue(
      readback.data.object.sha === target.sha,
      "publication gate readback differs from the admitted source commit",
    );
  }
  return { ...target, gateRef, locked: true };
}
