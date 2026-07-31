---
status: active
period: ongoing
theme: buildchain-config-validation-action
doc_type: technical-reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-31
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-31
  invisible_context: not asserted
---

# validate-config

Buildchain v3 action for validating `.buildchain/buildchain.toml` without running lifecycle
commands.

Use this action during repository migration when a heavyweight project needs to
prove that its Buildchain version state and lifecycle declaration are ready, but
the actual build should not run yet.

## Usage

```yaml
- uses: kungfu-systems/buildchain/actions/validate-config@v3
  with:
    require-version-state: "true"
    require-lifecycle-stages: "install,build,verify"
```

The action checks:

- `buildchain.toml` exists and uses schema `1`;
- configured version-state files exist and expose a string version;
- anchored/manual version strategy declarations and JSON/TOML anchor manifests
  are structurally valid when configured;
- web-surface project, channel, deploy adapter, retention, and staging security
  declarations are structurally valid when configured;
- required lifecycle stages are declared and structurally valid.

It does not execute `lifecycle.install`, `lifecycle.build`, `lifecycle.verify`,
or any other lifecycle command.

Outputs include `project-type`, `project-name`, `project-site`, `channels`, and
`deploy-adapters-json`, so callers can route site workflows without reparsing
TOML in every repository.
