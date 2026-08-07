async function authorizePromotionRuntimeOverride({ github, context }) {
  if (context.eventName !== "workflow_dispatch") {
    throw new Error(
      "promotion runtime override is only allowed for trusted workflow_dispatch runs",
    );
  }
  const permission = await github.rest.repos.getCollaboratorPermissionLevel({
    owner: context.repo.owner,
    repo: context.repo.repo,
    username: context.actor,
  });
  const level =
    permission.data.user?.permissions || permission.data.permission || "none";
  if (!["write", "maintain", "admin"].includes(level)) {
    throw new Error(
      `promotion runtime override requires write, maintain, or admin permission; actor has ${level}`,
    );
  }
  return { actor: context.actor, permission: level };
}

module.exports = { authorizePromotionRuntimeOverride };
