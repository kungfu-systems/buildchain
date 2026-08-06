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
  const declaredLevel = permission.data.permission;
  const userPermissions = permission.data.user?.permissions;
  const level =
    (typeof declaredLevel === "string" && declaredLevel) ||
    (typeof userPermissions === "string" && userPermissions) ||
    (userPermissions?.admin && "admin") ||
    (userPermissions?.maintain && "maintain") ||
    (userPermissions?.push && "write") ||
    (userPermissions?.triage && "triage") ||
    (userPermissions?.pull && "read") ||
    "none";
  if (!["write", "maintain", "admin"].includes(level)) {
    throw new Error(
      `promotion runtime override requires write, maintain, or admin permission; actor has ${level}`,
    );
  }
  return { actor: context.actor, permission: level };
}

module.exports = { authorizePromotionRuntimeOverride };
