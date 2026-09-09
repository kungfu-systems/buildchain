export default async function publicationGate(
  { github, context, core },
  env = process.env,
) {
  const gateRef = `publish-gate/${env.CHANNEL}/${env.TARGET_REF.replace(/^(alpha|release)\//, "")}/${env.VERSION}`;
  const ref = `heads/${gateRef}`;
  try {
    const current = await github.rest.git.getRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref,
    });
    if (current.data.object.sha !== env.TARGET_SHA) {
      throw new Error(
        "publication gate already binds a different source commit",
      );
    }
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.git.createRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: `refs/${ref}`,
      sha: env.TARGET_SHA,
    });
  }
  core.setOutput("ref", gateRef);
  core.setOutput("sha", env.TARGET_SHA);
  core.setOutput("locked", "true");
}
