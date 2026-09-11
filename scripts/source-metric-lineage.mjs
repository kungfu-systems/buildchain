import { execFileSync } from 'node:child_process';

// Measurement identity follows Git's observed renames. This does not resolve a
// runtime path or keep a removed entrypoint callable.
export function projectRenamedMetrics({ root, revision, metrics, currentPaths }) {
  const records = execFileSync('git', ['diff', '--name-status', '-z', '--find-renames=50%', '--diff-filter=R', revision],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0');
  const projected = { ...metrics }, renames = [];
  for (let index = 0; index < records.length && records[index]; index += 3) {
    const [status, source, target] = records.slice(index, index + 3);
    if (!/^R\d+$/.test(status) || !source || !target) throw Error('Invalid Git metric lineage');
    if (!metrics[source] || metrics[target] || !currentPaths.has(target)) continue;
    projected[target] = { ...metrics[source], file: target };
    renames.push({ source, target, similarity: Number(status.slice(1)) });
  }
  return { metrics: projected, renames };
}
