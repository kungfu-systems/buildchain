import fs from "node:fs";
import path from "node:path";
import { runGitFetchSync } from "../git/fetch-process.js";
import { assertSha } from "./values.js";
export function createCheckoutGitOperations(environment) {
  function git(
    args,
    {
      cwd,
      env = {},
      timeoutMs = 60000,
      stdio = ["ignore", "pipe", "pipe"],
    } = {},
  ) {
    try {
      const commandEnv = { ...environment, ...env };
      if (cwd) {
        const count = Number.parseInt(commandEnv.GIT_CONFIG_COUNT || "0", 10);
        if (!Number.isSafeInteger(count) || count < 0)
          throw new Error("Invalid command-scoped Git configuration count");
        commandEnv.GIT_CONFIG_COUNT = String(count + 1);
        commandEnv[`GIT_CONFIG_KEY_${count}`] = "safe.directory";
        commandEnv[`GIT_CONFIG_VALUE_${count}`] = path.resolve(cwd);
      }
      const output = runGitFetchSync({
        args,
        cwd,
        env: commandEnv,
        timeoutMs,
        stdio,
      });
      return output ? String(output).trim() : "";
    } catch (error) {
      const stderr = error?.stderr ? String(error.stderr).trim() : "";
      const stdout = error?.stdout ? String(error.stdout).trim() : "";
      const detail = [stderr, stdout].filter(Boolean).join("\n").trim();
      if (detail && !String(error.message || "").includes(detail)) {
        error.message = `${error.message}\n${detail}`;
      }
      throw error;
    }
  }

  function hasCommit(targetPath, sha, timeoutMs) {
    try {
      git(["cat-file", "-e", `${sha}^{commit}`], {
        cwd: targetPath,
        timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  function checkoutFetchedCommit(targetPath, sha, timeoutMs) {
    // The locked Git tree is also the byte-level source of release evidence.
    // Override runner-global autocrlf only at checkout time so this also works
    // when a container workspace uses an external Git metadata pointer.
    git(
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "checkout",
        "--force",
        "--detach",
        sha,
      ],
      {
        cwd: targetPath,
        timeoutMs,
      },
    );
  }

  function verifyCheckout({
    targetPath,
    sourceSha,
    sourceTreeSha = "",
    fetchRef = "",
  }) {
    const head = git(["rev-parse", "HEAD"], { cwd: targetPath });
    const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: targetPath });
    const headOk = head === sourceSha;
    const treeOk = !sourceTreeSha || tree === sourceTreeSha;
    const pullMergeTreeEquivalent =
      !headOk &&
      /^refs\/pull\/\d+\/merge$/.test(fetchRef) &&
      Boolean(sourceTreeSha) &&
      treeOk;
    if (!headOk && !pullMergeTreeEquivalent) {
      throw new Error(
        `locked source checkout head mismatch: expected ${sourceSha}, got ${head}`,
      );
    }
    if (!treeOk) {
      throw new Error(
        `locked source checkout tree mismatch: expected ${sourceTreeSha}, got ${tree}`,
      );
    }
    return {
      head,
      expectedHead: sourceSha,
      tree,
      headOk,
      treeOk,
      identityOk: headOk || pullMergeTreeEquivalent,
      identityMode: pullMergeTreeEquivalent
        ? "tree-equivalent-pull-merge"
        : "commit",
    };
  }

  return {
    git,
    ensureCheckoutTarget,
    directoryBytes,
    writeAlternates,
    hasCommit,
    checkoutFetchedCommit,
    verifyCheckout,
    retryableGitFetchError,
  };
}

function ensureCheckoutTarget(targetPath, workspace) {
  const resolvedWorkspace = path.resolve(workspace || process.cwd());
  const resolvedTarget = path.resolve(resolvedWorkspace, targetPath || ".");
  const relative = path.relative(resolvedWorkspace, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `checkout path must stay inside the workspace: ${targetPath}`,
    );
  }
  fs.mkdirSync(resolvedTarget, { recursive: true });
  for (const entry of fs.readdirSync(resolvedTarget)) {
    if ((relative === "" || relative === ".") && entry === ".buildchain") {
      continue;
    }
    fs.rmSync(path.join(resolvedTarget, entry), {
      recursive: true,
      force: true,
    });
  }
  return resolvedTarget;
}

function gitObjectDirectory(referencePath) {
  if (!referencePath) {
    return "";
  }
  const resolved = path.resolve(referencePath);
  const candidates = [
    path.join(resolved, "objects"),
    path.join(resolved, ".git", "objects"),
  ];
  return (
    candidates.find(
      (candidate) =>
        fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(),
    ) || ""
  );
}

function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) bytes += fs.statSync(child).size;
    }
  }
  return bytes;
}

function writeAlternates(targetPath, referencePath) {
  const objectDirectory = gitObjectDirectory(referencePath);
  if (!objectDirectory) {
    return false;
  }
  const alternatesPath = path.join(
    targetPath,
    ".git",
    "objects",
    "info",
    "alternates",
  );
  fs.mkdirSync(path.dirname(alternatesPath), { recursive: true });
  fs.writeFileSync(alternatesPath, `${objectDirectory}\n`);
  return true;
}

function retryableGitFetchError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EPIPE",
    ].includes(code)
  )
    return true;
  const commandOutput = [error?.stderr, error?.stdout]
    .filter(Boolean)
    .map(String)
    .join("\n")
    .trim();
  return /timed?\s*out|timeout|connection (?:reset|refused)|remote end hung up|early eof|rpc failed|http (?:429|5\d\d)|temporary failure|network is unreachable/i.test(
    commandOutput || String(error?.message || error || ""),
  );
}
