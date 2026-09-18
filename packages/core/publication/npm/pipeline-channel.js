const REGISTRY = "https://registry.npmjs.org";

export function pipelineNpmChannel({
  environment = process.env,
  fetchImpl = globalThis.fetch,
}) {
  async function json(url, options = {}) {
    const response = await fetchImpl(url, { ...options, redirect: "error" });
    if (!response.ok)
      throw new Error(
        `npm channel provider rejected the operation with HTTP ${response.status}`,
      );
    return response.json();
  }
  return {
    async observe(effect) {
      if (effect.access === "restricted" && !environment.NODE_AUTH_TOKEN)
        throw new Error(
          "Restricted npm readback requires a configured package read credential",
        );
      const headers = environment.NODE_AUTH_TOKEN
        ? { authorization: `Bearer ${environment.NODE_AUTH_TOKEN}` }
        : {};
      const tags = await json(
        `${REGISTRY}/-/package/${encodeURIComponent(effect.name)}/dist-tags`,
        { headers },
      );
      const version = tags[effect.tag] || null;
      if (version !== null && typeof version !== "string")
        throw new Error("npm channel has no exact version");
      return version
        ? { state: "present", version }
        : { state: "absent", version: null };
    },
  };
}
