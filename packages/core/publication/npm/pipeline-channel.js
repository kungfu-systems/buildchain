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
  async function credential(name) {
    if (environment.NODE_AUTH_TOKEN) return environment.NODE_AUTH_TOKEN;
    if (
      !environment.ACTIONS_ID_TOKEN_REQUEST_URL ||
      !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    )
      throw new Error(
        "npm channel publication requires its hosted package-scoped OIDC or configured publisher credential",
      );
    const url = new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (url.protocol !== "https:")
      throw new Error("OIDC request requires the provider HTTPS endpoint");
    url.searchParams.set("audience", "npm:registry.npmjs.org");
    const identity = await json(url.href, {
      headers: {
        authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
        accept: "application/json",
      },
    });
    if (typeof identity.value !== "string" || !identity.value)
      throw new Error("Hosted OIDC provider omitted its identity token");
    const exchange = await json(
      `${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${identity.value}`,
          accept: "application/json",
        },
      },
    );
    if (typeof exchange.token !== "string" || !exchange.token)
      throw new Error(
        "npm OIDC exchange omitted its package-scoped credential",
      );
    return exchange.token;
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
    async apply(effect) {
      const token = await credential(effect.name);
      await json(
        `${REGISTRY}/-/package/${encodeURIComponent(effect.name)}/dist-tags/${encodeURIComponent(effect.tag)}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(effect.version),
        },
      );
    },
  };
}
