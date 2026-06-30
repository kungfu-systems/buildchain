# Update Dependencies Version Action

Buildchain v2 implementation of the update-dependencies-version GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-update-dependencies-version`
- Published action path: `kungfu-systems/buildchain/actions/update-dependencies-version@v2`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-update-dependencies-version build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
