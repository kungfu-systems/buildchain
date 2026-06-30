# Check Format Action

Buildchain v2 implementation of the check-format GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-check-format`
- Published action path: `kungfu-systems/buildchain/actions/check-format@v2`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-check-format build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
