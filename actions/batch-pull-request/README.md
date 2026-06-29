# Batch Pull Request Action

Buildchain v1 implementation of the batch-pull-request GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-batch-pull-request`
- Published action path: `kungfu-systems/buildchain/actions/batch-pull-request@v1`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-batch-pull-request build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
