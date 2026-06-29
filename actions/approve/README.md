# Approve Action

Buildchain v1 implementation of the approve GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-approve`
- Published action path: `kungfu-systems/buildchain/actions/approve@v1`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-approve build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
