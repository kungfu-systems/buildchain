# Publish Prebuilt Action

Buildchain v2 implementation of the publish-prebuilt GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-publish-prebuilt`
- Published action path: `kungfu-systems/buildchain/actions/publish-prebuilt@v2`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-publish-prebuilt build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
