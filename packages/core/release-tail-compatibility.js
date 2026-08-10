export const RELEASE_TAIL_COMPATIBILITY_CONTRACT =
  "kungfu.buildchain.release-tail.compatibility-diagnostics/v1";

export const RELEASE_TAIL_LEGACY_HOOKS = Object.freeze({
  "publication-gate-command": "declarative admission predicates",
  "publication-consumer-qualification-command":
    "declarative readback predicates",
  "publish-command": "artifact.publish",
  "lifecycle.publish": "artifact.publish",
  "publication-commit-command": "signed-channel.commit",
  "release-activation-command": "release.activate",
  "release-passport-evidence-command": "released-evidence.synthesize",
  "release-passport-attachment-command": "typed evidence requirements",
  "verification-command": "the separate version-state verification contract",
});

function present(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

export function diagnoseLegacyReleaseTailHooks(hooks = {}) {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("legacy release-tail hook diagnostics require an object");
  }
  const diagnostics = [];
  for (const name of Object.keys(hooks).sort()) {
    if (!present(hooks[name])) continue;
    const replacement = RELEASE_TAIL_LEGACY_HOOKS[name];
    if (!replacement) {
      diagnostics.push({
        code: "release-tail-command-forbidden",
        hook: name,
        level: "error",
        message: `unregistered executable release-tail hook '${name}' is forbidden`,
        replacement: "none",
      });
      continue;
    }
    diagnostics.push({
      code: "release-tail-hook-deprecated",
      hook: name,
      level: "warning",
      message: `legacy release-tail hook '${name}' is deprecated; use ${replacement}`,
      replacement,
    });
  }
  return {
    schema: RELEASE_TAIL_COMPATIBILITY_CONTRACT,
    compatible: diagnostics.every((entry) => entry.level !== "error"),
    migrationWindow: {
      startsAt: "train/v3/v3.0/release-tail-contract",
      closesAt: "earlier-of-90-days-or-first-v3.2-stable",
      maximumMinorLines: 2,
      permanentEscapeHatch: false,
    },
    diagnostics,
  };
}
