import fs from "node:fs";
import path from "node:path";
import { stringify } from "smol-toml";
import { compileConsumerPlan, CONFIG_PATH } from "../consumer/contract/plan.js";
import { consumerWorkflows } from "../consumer/contract/entries.js";
import {
  assertPackageManager,
  detectPackageManager,
} from "../build/package-manager.js";

const TYPES = {
  package: "npm",
  npm: "npm",
  native: "binary",
  binary: "binary",
  "publication-artifact": "paper",
  paper: "paper",
  "anchored-package": "npm",
};
const START = "<!-- buildchain:consumer:start -->";
const END = "<!-- buildchain:consumer:end -->";

function packageManager(cwd, requested) {
  if (requested) return assertPackageManager(requested);
  try {
    return detectPackageManager(cwd).name;
  } catch {
    return "pnpm";
  }
}

function product(type, manager, artifactName) {
  const lifecycle = {
    npm: {
      install: [
        manager === "npm"
          ? "npm ci"
          : manager === "yarn"
            ? "corepack yarn install --immutable"
            : "corepack pnpm install --frozen-lockfile",
      ],
      build: [
        manager === "npm" ? "npm run build" : `corepack ${manager} run build`,
      ],
      verify: [
        manager === "npm" ? "npm run check" : `corepack ${manager} run check`,
      ],
    },
    binary: {
      build: [
        "cmake -S . -B build -DCMAKE_BUILD_TYPE=Release",
        "cmake --build build --config Release",
        "cmake --install build --prefix dist/stage",
        "cmake -E tar czf dist/product.tar.gz --format=gnutar dist/stage",
      ],
      verify: ["ctest --test-dir build --output-on-failure"],
    },
    paper: { build: ["make pdf"], verify: ["make check"] },
  }[type];
  const artifact = {
    npm: { path: ".", kind: "npm-package", extension: ".tgz" },
    binary: {
      path: "dist/product.tar.gz",
      kind: "archive",
      extension: ".tar.gz",
    },
    paper: { path: "_build/main.pdf", kind: "pdf", extension: ".pdf" },
  }[type];
  return {
    id: "main",
    type,
    platforms: ["linux-x64"],
    ...lifecycle,
    artifacts: [
      {
        id: "main",
        path: artifact.path,
        kind: artifact.kind,
        ...(artifactName
          ? {
              filename: artifactName.endsWith(artifact.extension)
                ? artifactName
                : `${artifactName}${artifact.extension}`,
            }
          : {}),
      },
    ],
    targets: [
      {
        provider: type === "npm" ? "npm" : "github-release",
        artifacts: ["main"],
        ...(type === "npm" ? { access: "public" } : {}),
      },
    ],
  };
}

function versionSource(cwd, type) {
  const packagePath = path.join(cwd, "package.json");
  for (const file of ["package.json", "release.json"]) {
    const stat = fs.lstatSync(path.join(cwd, file), { throwIfNoEntry: false });
    if (stat && !stat.isFile())
      throw new Error(`${file}: version authority must be a regular file`);
  }
  const manifest = fs.existsSync(packagePath)
    ? JSON.parse(fs.readFileSync(packagePath, "utf8"))
    : null;
  if (type === "npm" && typeof manifest?.version !== "string")
    throw new Error(
      "npm initialization requires the product's package.json with a version",
    );
  const file = manifest?.version ? "package.json" : "release.json";
  const existing =
    file === "package.json"
      ? manifest
      : fs.existsSync(path.join(cwd, file))
        ? JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8"))
        : null;
  if (existing && typeof existing.version !== "string")
    throw new Error(`${file}: version must be a string`);
  const version = existing?.version || "0.1.0-alpha.0";
  return {
    file,
    version,
    files: existing
      ? {}
      : { [file]: `${JSON.stringify({ version }, null, 2)}\n` },
  };
}

function versionLine(version) {
  const line =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      version,
    );
  if (!line)
    throw new Error("The product version must be semantic version text");
  return `v${line[1]}/v${line[1]}.${line[2]}`;
}

export function consumerAgentInstructions(current = "") {
  for (const name of ["next-development", "paper-agent-entry"]) {
    const legacyStart = `<!-- buildchain:${name}:v1:start -->`;
    const legacyEnd = `<!-- buildchain:${name}:v1:end -->`;
    if (current.includes(legacyStart) || current.includes(legacyEnd)) {
      const start = current.indexOf(legacyStart),
        end = current.indexOf(legacyEnd);
      if (
        start < 0 ||
        end < start ||
        current.indexOf(legacyStart, start + 1) !== -1 ||
        current.indexOf(legacyEnd, end + 1) !== -1
      )
        throw new Error(
          "Incomplete or ambiguous legacy Buildchain instructions",
        );
      current = current.slice(0, start) + current.slice(end + legacyEnd.length);
    }
  }
  const section = `${START}
## Buildchain consumer

Maintain product install, build and verification commands in schema-2
\`.buildchain/buildchain.toml\`. Keep the generated \`buildchain.yml\` and
\`buildchain-recover.yml\` caller bytes unchanged across product types.
Open a protected channel PR to request delivery or publication. The published
runtime owns version preparation, publication and next-development completion.
Recover only an exact attempt, with an optional temporary repaired runtime.
Tool-maintained \`.buildchain/contract-lock.json\` and
\`.buildchain/alpha-contract-lock.json\` bind the published runtime.
Consumer scripts must not implement release controllers or provider protocols.
${END}`;
  if (current.includes(START) !== current.includes(END))
    throw new Error("Incomplete managed Buildchain consumer instructions");
  if (current.includes(START)) {
    const start = current.indexOf(START),
      end = current.indexOf(END) + END.length;
    if (
      end < start ||
      current.indexOf(START, start + START.length) !== -1 ||
      current.indexOf(END, end) !== -1
    )
      throw new Error("Ambiguous managed Buildchain consumer instructions");
    return current.slice(0, start) + section + current.slice(end);
  }
  const header =
    current.trimEnd() ||
    `---
status: active
period: ongoing
theme: buildchain-consumer
doc_type: process-rule
source_level: generated-template
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-09-20
---

# Repository instructions`;
  return `${header}\n\n${section}\n`;
}

export function planConsumerInitialization({
  cwd,
  type,
  requestedManager = "",
  artifactName = "",
}) {
  const productType = TYPES[type];
  if (!productType)
    throw new Error(
      "init supports npm/package, binary/native, paper/publication-artifact, and anchored-package; legacy web-surface and infra-contract initialization is not part of the schema-2 pipeline",
    );
  const manager = packageManager(cwd, requestedManager);
  const version = versionSource(cwd, productType);
  return {
    manager,
    productType,
    files: {
      ...version.files,
      [CONFIG_PATH]: consumerConfiguration({
        type,
        manager,
        artifactName,
        version: version.version,
        versionFile: version.file,
      }),
      ...consumerWorkflows(),
    },
  };
}

// Shared pure plan construction for init and product-source scaffolders.
export function consumerConfiguration({
  type,
  manager = "pnpm",
  artifactName = "",
  version,
  versionFile = "package.json",
}) {
  const productType = TYPES[type];
  if (!productType)
    throw new Error(`Unsupported consumer product type: ${type}`);
  if (productType === "npm") assertPackageManager(manager);
  const line = versionLine(version);
  const plan = {
    schema: 2,
    products: [product(productType, manager, artifactName)],
    version: {
      strategy: type === "anchored-package" ? "anchored" : "semver",
      files: [{ path: versionFile, format: "json", key: "version" }],
    },
    channels: [
      ...["feature", "fix", "chore", "docs", "ci", "refactor"].map(
        (prefix) => ({
          from: `${prefix}/*`,
          to: `dev/${line}`,
          operation: "develop",
        }),
      ),
      {
        from: `dev/${line}`,
        to: `alpha/${line}`,
        operation: "alpha",
      },
      {
        from: `alpha/${line}`,
        to: `release/${line}`,
        operation: "stable",
      },
    ],
    review: { minimum_approvals: 1, code_owners: true, merge_queue: true },
  };
  const toml = stringify(plan);
  compileConsumerPlan(toml);
  return toml;
}
