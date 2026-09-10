export async function repositoryActorPermission(
  { owner, repo, actor },
  github,
) {
  const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: actor,
  });
  return String(data.permission || "");
}
