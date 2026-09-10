function fault(code, kind = "conflict") {
  return Object.assign(new Error(`OCI publication: ${code}`), {
    releaseTailClass: kind,
    releaseTailCode: code,
  });
}

export function createRegistryClient(token, fetchImpl, actor) {
  const credentials = new Map();
  async function credential(repository, write) {
    const key = `${repository}:${write}`;
    if (credentials.has(key)) return credentials.get(key);
    if (write && (!token || !actor))
      throw fault("missing-registry-write-identity");
    const url = new URL("https://ghcr.io/token");
    url.searchParams.set("service", "ghcr.io");
    url.searchParams.set(
      "scope",
      `repository:${repository}:${write ? "pull,push" : "pull"}`,
    );
    const headers = write
      ? {
          authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}`,
        }
      : {};
    const response = await send(url, { headers });
    if (!response.ok) throw fault("registry-token-unavailable", "transient");
    const value = (await response.json()).token;
    if (typeof value !== "string" || !value)
      throw fault("registry-token-invalid");
    credentials.set(key, value);
    return value;
  }
  async function send(url, options = {}) {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.host !== "ghcr.io" ||
      target.username ||
      target.password
    )
      throw fault("unsafe-registry-endpoint");
    try {
      return await fetchImpl(target, {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      throw fault("registry-transport-uncertain", "transient");
    }
  }
  async function registry(
    image,
    suffix,
    { write = false, method = "GET", body, headers = {} } = {},
  ) {
    const repository = image.repository.slice("ghcr.io/".length);
    const auth = await credential(repository, write);
    return send(`https://ghcr.io/v2/${repository}/${suffix}`, {
      method,
      headers: { ...headers, authorization: `Bearer ${auth}` },
      ...(body ? { body, duplex: "half" } : {}),
    });
  }
  return { registry, send, credential };
}
