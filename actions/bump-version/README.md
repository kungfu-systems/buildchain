# Bump Version Action

Buildchain v1 implementation of the bump-version GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-bump-version`
- Published action path: `kungfu-systems/buildchain/actions/bump-version@v1`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-bump-version build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
