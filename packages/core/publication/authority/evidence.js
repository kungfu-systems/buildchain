import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const filesNamed = (root, name) => {
  const matches = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === name) matches.push(full);
    }
  }
  return matches.sort();
};
export const one = (root, name) => {
  const matches = filesNamed(root, name);
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one ${name} under ${root}, found ${matches.length}`,
    );
  return JSON.parse(fs.readFileSync(matches[0], "utf8"));
};
export const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export const payloadFor = (manifest, payloadRoot) => {
  if (
    typeof manifest.artifactName !== "string" ||
    !manifest.artifactName ||
    /[\\/]/.test(manifest.artifactName) ||
    [".", ".."].includes(manifest.artifactName)
  )
    throw new Error(
      "candidate payload artifact name must be one safe path segment",
    );
  const root = path.join(payloadRoot, manifest.artifactName);
  if (!fs.existsSync(root))
    throw new Error(
      `candidate payload artifact is missing: ${manifest.artifactName}`,
    );
  return {
    artifactName: manifest.artifactName,
    files: (manifest.files || [])
      .filter((entry) => !entry.path.startsWith(".buildchain/"))
      .map((entry) => {
        if (
          !entry.path ||
          path.isAbsolute(entry.path) ||
          entry.path.includes("\\") ||
          entry.path.split("/").includes("..")
        ) {
          throw new Error(
            `candidate payload manifest contains an unsafe path: ${entry.path}`,
          );
        }
        const file = path.join(root, entry.path);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          throw new Error(
            `candidate payload file is missing: ${manifest.artifactName}/${entry.path}`,
          );
        }
        const relative = path.relative(
          fs.realpathSync(root),
          fs.realpathSync(file),
        );
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          throw new Error("candidate payload file escapes the artifact root");
        return {
          path: entry.path,
          size: fs.statSync(file).size,
          sha256: sha256File(file),
        };
      }),
  };
};

export function oneEvidenceFile(root, name) {
  const files = filesNamed(root, name);
  if (files.length !== 1)
    throw new Error(
      `Expected exactly one ${name} under ${root}, found ${files.length}`,
    );
  return files[0];
}
export function referencedControllerArtifact(evidenceRoot) {
  const passport = one(
    path.join(evidenceRoot, "passport"),
    "release-candidate-passport.json",
  );
  if (
    !Array.isArray(passport.controllerReceipts) ||
    passport.controllerReceipts.length !== 1
  )
    throw new Error(
      "Publication evidence requires exactly one qualifying controller receipt reference",
    );
  const artifact = passport.controllerReceipts[0].artifact;
  if (
    typeof artifact !== "string" ||
    !artifact.trim() ||
    /[\r\n]/.test(artifact)
  )
    throw new Error(
      "Release-candidate passport controller receipt artifact is missing or invalid",
    );
  return artifact;
}
