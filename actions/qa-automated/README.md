# Qa Automated Action

Buildchain v1 implementation of the qa-automated GitHub Action.

## Runtime

- GitHub Actions runtime: Node 24
- Build tool: tsup
- Workspace package: `@kungfu-systems/buildchain-qa-automated`
- Published action path: `kungfu-systems/buildchain/actions/qa-automated@v1`

## Local Build

```bash
pnpm --filter @kungfu-systems/buildchain-qa-automated build
```

Generated bundles are committed under `dist/index.js` so consumers can use the action without installing workspace dependencies.
