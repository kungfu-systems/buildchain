import fs from "node:fs";
import path from "node:path";
import { adaptCapture } from "./capture.js";
import { validateAdapterOutput } from "./adapter.js";
import { validateSourceCoordinate } from "./schema.js";
import { readJson, writeJson, sha256, stableJson } from "./io.js";
export const CAPTURE_ADAPTER = "packages/core/build/demo/capture.js";
export function adaptCapturedDemo({
  runtimeRoot,
  artifactRoot,
  sourceCoordinate,
  output,
  diagnostics,
}) {
  const coordinate = validateSourceCoordinate(
    readJson(sourceCoordinate, "source artifact coordinate"),
  );
  const result = adaptCapture({ artifactRoot, output });
  validateAdapterOutput(output);
  fs.mkdirSync(diagnostics, { recursive: true });
  writeJson(path.join(diagnostics, "adapter.json"), {
    schema: "buildchain.auditable-demo-capture-adaptation/v1",
    path: CAPTURE_ADAPTER,
    sha256: sha256(fs.readFileSync(path.join(runtimeRoot, CAPTURE_ADAPTER))),
    argumentsRoot: sha256(
      Buffer.from(
        stableJson({
          sourceCoordinate: coordinate,
          captureRoot: result.captureRoot || null,
        }),
      ),
    ),
    status: "qualified",
    implementationKind: "module",
  });
  return result;
}
