import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const ROOTS = new Set([
  "actions",
  "bin",
  "crates",
  "packages",
  "scripts",
  "tests",
]);
const GENERATION_PATH = /(?:^|[-_])v\d+(?:[-_]|$)/iu;
const PROTOCOL_VERSION_SYMBOLS = new Set([
  "createSourceQualificationProofV2",
  "loadedV2",
]);
const GENERATION_SYMBOL =
  /(?:^|_)V\d+(?:_|$)|V\d+(?=[A-Z]|$)|^v\d+(?=[A-Z]|$)/u;

export function inspectImplementationName(file, source) {
  const issues = [];
  if (!ROOTS.has(file.split("/")[0])) return issues;
  for (const component of file.split("/")) {
    if (GENERATION_PATH.test(component))
      issues.push(`${file}: implementation path contains a product generation`);
  }
  if (file.endsWith(".rs")) {
    for (const match of source.matchAll(
      /\b(?:fn|struct|enum|mod|const|let)\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
    ))
      if (
        GENERATION_SYMBOL.test(match[1]) ||
        /(?:^|_)v\d+(?:_|$)/u.test(match[1])
      )
        issues.push(`${file}: ${match[1]} must describe its responsibility`);
  }
  if (!/\.(?:[cm]?js|ts)$/u.test(file) || file.includes("/dist/"))
    return issues;
  const syntax = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isBindingElement(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      GENERATION_SYMBOL.test(node.name.text) &&
      !PROTOCOL_VERSION_SYMBOLS.has(node.name.text) &&
      !/_V\d+_SCHEMA$/u.test(node.name.text)
    ) {
      const line =
        syntax.getLineAndCharacterOfPosition(node.name.getStart()).line + 1;
      issues.push(
        `${file}:${line}: ${node.name.text} must describe its responsibility`,
      );
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      /\.buildchain\/[A-Za-z0-9_./-]*\bv\d+-/u.test(node.text)
    )
      issues.push(
        `${file}: runtime directory must describe its responsibility`,
      );
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return issues;
}

export function checkImplementationNaming(root = process.cwd()) {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const issues = files.flatMap((file) => {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute))
      return [`${file}: tracked implementation is missing`];
    const source =
      ROOTS.has(file.split("/")[0]) && /\.(?:[cm]?js|ts|rs)$/u.test(file)
        ? fs.readFileSync(absolute, "utf8")
        : "";
    return inspectImplementationName(file, source);
  });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  for (const name of Object.keys(manifest.scripts || {})) {
    if (/(?:^|:)v\d+(?:[-:]|$)/iu.test(name))
      issues.push(`package.json: script ${name} contains a product generation`);
  }
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(root, "architecture/implementation-naming.json"),
      "utf8",
    ),
  );
  for (const [file, identities] of Object.entries(policy.wireIdentities)) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const previousIdentity of identities) {
      const identity =
        policy.implementationIdentityMigrations?.[file]?.[previousIdentity] ||
        previousIdentity;
      if (
        !source.includes(JSON.stringify(identity)) &&
        !source.includes(`'${identity}'`)
      )
        issues.push(
          `${file}: published wire identity changed during implementation relocation: ${identity}`,
        );
    }
  }
  if (issues.length) throw new Error(issues.join("\n"));
  return { checkedFiles: files.length, issues: [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(checkImplementationNaming(), null, 2));
