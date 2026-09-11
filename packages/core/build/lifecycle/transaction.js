import { persistLifecycleDiagnostics } from "./diagnostics.js";
import { normalizeLifecycleOptions } from "./context.js";
import { createLifecycleContext } from "./context.js";
import { executeLifecycle } from "./execution.js";
import { collectLifecycleArtifacts } from "./artifacts.js";
import { createLifecycleManifest } from "./manifest.js";
export function runLifecycle(options = {}) {
  const context = createLifecycleContext(normalizeLifecycleOptions(options));
  executeLifecycle(context);
  const artifacts = collectLifecycleArtifacts(context);
  const product = createLifecycleManifest(context, artifacts);
  return persistLifecycleDiagnostics(context, artifacts, product);
}
