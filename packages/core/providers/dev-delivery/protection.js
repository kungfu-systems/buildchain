export async function assertBranchUnlocked({ repository, branch }, provider) {
  const endpoint = `/repos/${repository}`;
  const encodedBranch = encodeURIComponent(branch);
  let locked = false;
  try {
    const protection = await provider.request(
      `${endpoint}/branches/${encodedBranch}/protection`,
    );
    locked = protection.lock_branch?.enabled === true;
  } catch (error) {
    if (error.status !== 404)
      throw new Error("Unable to read branch protection", { cause: error });
  }
  let applied;
  try {
    applied = await provider.request(
      `${endpoint}/rules/branches/${encodedBranch}`,
    );
  } catch (error) {
    throw new Error("Unable to read applied branch rules", { cause: error });
  }
  if (!Array.isArray(applied))
    throw new Error("Applied branch rules must be a list");
  locked ||= applied.some((rule) => rule.type === "update");
  if (locked)
    throw new Error(
      "Protected branch is locked by classic protection or an applied update rule; native merge queue admission cannot change a locked branch",
    );
}
