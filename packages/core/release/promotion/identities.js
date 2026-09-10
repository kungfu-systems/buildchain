const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function normalized(value) {
  return String(value ?? "").trim();
}

function requireSha(value, label) {
  const sha = normalized(value).toLowerCase();
  if (!SHA_PATTERN.test(sha))
    throw new Error(`${label} must be an exact 40-character SHA`);
  return sha;
}

export async function resolvePromotionIdentities({
  routerRef,
  routerSha,
  shellRef,
  shellCallRef,
  runtimeRef,
  resolveRef,
} = {}) {
  const requested = {
    router: normalized(routerRef),
    shell: normalized(shellRef),
    shellCall: normalized(shellCallRef),
    runtime: normalized(runtimeRef),
  };
  if (Object.values(requested).some((value) => !value)) {
    throw new Error("router, shell, shell call, and runtime refs are required");
  }
  if (typeof resolveRef !== "function")
    throw new Error("resolveRef must be a function");

  const immutableRouterSha = requireSha(routerSha, "router SHA");
  const resolved = new Map([[requested.router, immutableRouterSha]]);
  const resolveOnce = async (ref) => {
    if (SHA_PATTERN.test(ref)) return ref.toLowerCase();
    if (!resolved.has(ref)) {
      resolved.set(
        ref,
        requireSha(await resolveRef(ref), `resolved SHA for ${ref}`),
      );
    }
    return resolved.get(ref);
  };

  return {
    routerRef: requested.router,
    routerSha: immutableRouterSha,
    shellRef: requested.shell,
    shellCallRef: requested.shellCall,
    shellSha: await resolveOnce(requested.shellCall),
    runtimeRef: requested.runtime,
    runtimeSha: await resolveOnce(requested.runtime),
  };
}
