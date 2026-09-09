import { command, requireValue } from "../runtime/action-process.mjs";

export function exactRemoteBranch(branch, execute = command, cwd) {
  execute("git", ["check-ref-format", `refs/heads/${branch}`], {
    cwd,
    stdio: "pipe",
  });
  const ref = `refs/heads/${branch}`;
  const raw = execute("git", ["ls-remote", "--refs", "origin", ref], {
    cwd,
    stdio: "pipe",
  }).trim();
  if (!raw) return "";
  const rows = raw.split("\n");
  requireValue(rows.length === 1, "Remote branch lookup is ambiguous");
  const [sha, name] = rows[0].split(/\s+/);
  requireValue(
    name === ref && /^[0-9a-f]{40}$/.test(sha),
    "Remote branch lookup does not match its exact ref",
  );
  return sha;
}
