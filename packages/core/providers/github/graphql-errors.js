export function createGitHubGraphqlError(errors) {
  const details = errors.map((error) => ({
    message: typeof error.message === "string" ? error.message : "",
    ...(error.type ? { type: error.type } : {}),
    ...(error.extensions?.code
      ? { extensions: { code: error.extensions.code } }
      : {}),
  }));
  return Object.assign(
    new Error(
      details
        .map((error) => error.message)
        .filter(Boolean)
        .join("; ") || "GitHub GraphQL request failed",
    ),
    { errors: details },
  );
}

export function isTransientGitHubGraphqlError(error) {
  const errors = error?.errors;
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((detail) => {
      const code = detail.type || detail.extensions?.code;
      return code
        ? code === "INTERNAL"
        : /^Something went wrong while executing your query on /u.test(
            detail.message || "",
          );
    })
  );
}
