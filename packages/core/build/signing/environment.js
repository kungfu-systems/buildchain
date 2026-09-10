export function buildSigningConsumerEnvironment(environment, readToken) {
  const result = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !key.startsWith("INPUT_") &&
        ![
          "BUILDCHAIN_CONTROL_TOKEN",
          "BUILDCHAIN_AUTHORITY_DISPATCH_TOKEN",
        ].includes(key),
    ),
  );
  return { ...result, GH_TOKEN: readToken, GITHUB_TOKEN: readToken };
}
