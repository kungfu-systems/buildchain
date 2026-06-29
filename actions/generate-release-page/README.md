# Generate Release Page Action

Buildchain v1 implementation of the generate-release-page GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-generate-release-page`
- Published action path: `kungfu-systems/buildchain/actions/generate-release-page@v1`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-generate-release-page build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
