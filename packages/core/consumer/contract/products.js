import {
  choice,
  list,
  object,
  relativePath,
  slug,
  text,
  unique,
} from "./shape.js";

export const PRODUCT_TYPES = ["npm", "binary", "paper"];
export const PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "macos-arm64",
  "macos-x64",
  "windows-x64",
];

function artifact(value, location) {
  object(value, ["id", "path", "kind"], ["filename"], location);
  slug(value.id, `${location}.id`);
  if (value.path !== "." || value.kind !== "npm-package")
    relativePath(value.path, `${location}.path`);
  choice(value.kind, ["npm-package", "archive", "pdf"], `${location}.kind`);
  if (value.filename !== undefined) {
    text(
      value.filename,
      `${location}.filename`,
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u,
    );
    const extension =
      value.kind === "npm-package"
        ? /\.tgz$/u
        : value.kind === "pdf"
          ? /\.pdf$/u
          : /\.(?:tar\.gz|tar\.xz|tgz|zip|tar)$/u;
    if (!extension.test(value.filename))
      throw new Error(
        `${location}.filename: artifact extension does not match its kind`,
      );
  }
  return { ...value };
}

function target(value, location) {
  object(value, ["provider", "artifacts"], ["access"], location);
  choice(value.provider, ["npm", "github-release"], `${location}.provider`);
  list(value.artifacts, `${location}.artifacts`, slug);
  unique(value.artifacts, `${location}.artifacts`);
  if (value.provider === "npm")
    choice(value.access, ["public", "restricted"], `${location}.access`);
  else if (Object.hasOwn(value, "access"))
    throw new Error(`${location}.access: npm only`);
  return structuredClone(value);
}

export function compileProducts(values) {
  const products = list(values, "products", (value, location) => {
    object(
      value,
      ["id", "type", "platforms", "build", "verify", "artifacts", "targets"],
      ["install", "directory"],
      location,
    );
    slug(value.id, `${location}.id`);
    choice(value.type, PRODUCT_TYPES, `${location}.type`);
    list(value.platforms, `${location}.platforms`, (item, field) =>
      choice(item, PLATFORMS, field),
    );
    unique(value.platforms, `${location}.platforms`);
    for (const operation of [
      "build",
      "verify",
      ...(value.install !== undefined ? ["install"] : []),
    ])
      list(value[operation], `${location}.${operation}`, text);
    if (value.directory !== undefined)
      relativePath(value.directory, `${location}.directory`);
    const artifacts = list(value.artifacts, `${location}.artifacts`, artifact);
    unique(
      artifacts.map((item) => item.id),
      `${location}.artifacts`,
    );
    const targets = list(value.targets, `${location}.targets`, target);
    unique(
      targets.map((item) => item.provider),
      `${location}.targets`,
    );
    const expectedKind = {
      npm: "npm-package",
      binary: "archive",
      paper: "pdf",
    }[value.type];
    if (artifacts.some((item) => item.kind !== expectedKind))
      throw new Error(`${location}: artifact kind does not match product type`);
    const published = targets.flatMap((item) => item.artifacts);
    if (
      artifacts.some((item) => !published.includes(item.id)) ||
      published.some((id) => !artifacts.some((item) => item.id === id))
    )
      throw new Error(
        `${location}: publication targets must cover exactly declared artifacts`,
      );
    if (
      targets.some((item) => item.provider === "npm") !==
      (value.type === "npm")
    )
      throw new Error(
        `${location}: npm products require an npm target; other products cannot publish to npm`,
      );
    return structuredClone({ ...value, artifacts, targets });
  });
  unique(
    products.map((item) => item.id),
    "products",
  );
  return products;
}
