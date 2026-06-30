# Generate Download Page Action

Buildchain v2 implementation of the generate-download-page GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-generate-download-page`
- Published action path: `kungfu-systems/buildchain/actions/generate-download-page@v2`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-generate-download-page build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
