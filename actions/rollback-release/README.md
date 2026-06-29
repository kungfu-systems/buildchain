# Rollback Release Action

Buildchain v1 implementation of the rollback-release GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-rollback-release`
- Published action path: `kungfu-systems/buildchain/actions/rollback-release@v1`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-rollback-release build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
