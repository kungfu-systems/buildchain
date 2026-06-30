# Sync Pr Action

Buildchain v2 implementation of the sync-pr GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-sync-pr`
- Published action path: `kungfu-systems/buildchain/actions/sync-pr@v2`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-sync-pr build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
