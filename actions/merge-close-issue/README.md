# Merge Close Issue Action

Buildchain v2 implementation of the merge-close-issue GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-merge-close-issue`
- Published action path: `kungfu-systems/buildchain/actions/merge-close-issue@v2`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-merge-close-issue build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
