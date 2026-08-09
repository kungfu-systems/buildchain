export const BUILDCHAIN_USAGE = `Usage:
  buildchain --help
  buildchain version
  buildchain layout [--cwd <dir>] [--json]
  buildchain architecture validate [--cwd <dir>] [--json]
  buildchain architecture list [--cwd <dir>] [--json]
  buildchain architecture show <capability-id> [--cwd <dir>] [--json]
  buildchain architecture qualify --authority-revision <git-revision>
                                      [--candidate-revision <git-revision>]
                                      [--cwd <dir>] [--json]
  buildchain portable-cache plan --manifest <file-or-json> [--output <file>]
                                 [--github-output <file>] [--json]
  buildchain portable-cache receipt --plan <file-or-json> [--matched-key <key>]
                                    [--cache-hit true|false]
                                    [--validation-status pass|fail]
                                    [--validation-reason <text>]
                                    [--cold-fallback-status not-run|passed|failed]
                                    [--output <file>] [--json]
  buildchain candidate timeline --input <file-or-json> [--output <file>] [--json]
  buildchain init [--cwd <dir>] [--type package|native|web-surface|infra-contract|publication-artifact|anchored-package] [--force]
                  [--package-manager pnpm|npm|yarn] [--runner-preset <preset>]
                  [--artifact-name <template>]
  buildchain validate [--cwd <dir>] [--require-version-state]
                      [--require-lifecycle-stages <comma-list>]
  buildchain lifecycle run <stage> [--cwd <dir>] [--required]
                             [--artifact-name <name>] [--artifact-path <path>]...
                             [--platform-id <id>] [--platform-name <name>]
                             [--manifest-path <path>] [--summary-path <path>]
                             [--process-summary <json>]
  buildchain npm dry-run [--cwd <dir>] [--expected-tag <tag>] [--registry <url>]
                         [--dist-tag <tag>] [--skip-npm-publish-dry-run] [--json]
  buildchain release --dry-run --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                 [--tags <comma-list>] [--json]
  buildchain release explain --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                     [--tags <comma-list>] [--json]
  buildchain release dry-run --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                      [--tags <comma-list>] [--json]
  buildchain release line open --major <n> --minor <n> [--source-ref <ref>]
                               [--initial-version <version>] [--write] [--json]
  buildchain release-governance reconcile --repository <owner/repo>
                               --branch <dev|alpha|release/vN/vN.N>
                               --candidate-sha <sha> [--apply] [--json]
  buildchain github-governance <plan|apply|rollback|protection-policy-plan|ruleset-policy-plan> ...
  buildchain release <inspect|recover|finalize|abort> ...
  buildchain transaction inspect ...
  buildchain collect github-release --tag <tag> [--repository <owner/repo>]
                                    [--assets-dir <dir>] [--assets-json <json-or-path>]
                                    [--release-json <json-or-path>] [--package-set-json <json-or-path>]
                                    [--product-name <name>]
                                    [--publish-evidence-json <json-or-path>]
                                    [--trusted-publishing-json <json-or-path>]
                                    [--transaction-json <json-or-path>]
                                    [--anchor-manifest-json <json-or-path>]
                                    [--impact-json <json-or-path>]
                                    [--build-summary-json <json-or-path>]
                                    [--build-facts-json <json-or-path>]...
                                    [--platform-manifest-json <json-or-path>]...
                                    [--dist-tag-evidence-json <json-or-path>]
                                    [--kfd-1-witness-json <json-or-path>]...
                                    [--kfd-2-claim-json <json-or-path>]...
                                    [--kfd-3-prebuild-witness-json <json-or-path>]...
                                    [--kfd-3-artifact-witness-json <json-or-path>]...
                                    [--kfd-3-artifact-verify-cmd <command>]
                                    [--kfd-support-matrix-json <json-or-path>]
                                    [--kfd-product-gate-json <json-or-path>]...
                                    [--invariant-passport-json <json-or-path>]...
                                    [--invariant-passport-cmd <command>]
                                    [--release-evidence-json <json-or-path>]...
                                    [--github-artifact-attestation-policy-json <json-or-path>]...
                                    [--kfd-agent-hub-evidence-json <json-or-path>]
                                    [--base-passport-json <json-or-path>] [--require-base-kfd]
                                    [--release-extra-json <json-or-path>]
                                    [--publish-json <json-or-path>] [--output-dir <dir>] [--json]
  buildchain create publication-admission --input-json <file-or-json> [--output <file>] [--json]
  buildchain create runner-provenance --input-json <file-or-json> [--output <file>] [--json]
  buildchain create github-artifact-attestation-policy --input-json <file-or-json> [--output <file>] [--json]
  buildchain verify release-passport <file-or-url> [--json]
  buildchain verify github-artifact-attestation <artifact>
                          --evidence <file> --bundle <file>
                          --platform-manifest <file> --release-passport <file> [--json]
  buildchain verify publication-admission <file-or-json>
                          --registry-json <file-or-json>
                          --runner-json <file-or-json>
                          --control-plane-audit-json <file-or-json>
                          --publication-evidence-json <file-or-json>
                          [--expected-json <file-or-json>] [--used-nonce <nonce>]... [--json]
  buildchain audit publication-control-plane --repository <owner/repo> --branch <protected-branch>
  buildchain audit github-governance [--organization <owner>] [--repository <owner/repo>]
                                     [--output <file>] [--require-qualifying] [--json]
                          [--source-sha <merged-branch-sha>] [--workflow-repository <owner/repo>]
                          [--workflow <path>] [--workflow-ref <sha-or-ref>]
                          [--job <id>] [--environment <name>] [--package <name>]
                          [--publisher-mode npm-trusted-publisher|github-token|oidc-role]
                          [--npm-trust-json <file-or-json>]
                          [--provider-audit-json <file>] [--output <file>] [--allow-nonqualifying]
  buildchain verify artifact <file|dir|url|npm:...|oci:...|github-release:...>
                             [--passport <file-or-url>] [--locator-config <json>]
                             [--repository <owner/repo>] [--tag <tag>]
                             [--npm-registry <url>] [--json]
  buildchain verify artifact-envelope <file-or-json> [--assessment-time <epoch>]
                             [--expected-root <sha256:...>] [--expected-issuer <issuer>]
                             [--expected-publisher <publisher>]
                             [--expected-contract <version>] [--json]
  buildchain project kfx-admission <file-or-json> [--assessment-time <epoch>]
                             [--expected-root <sha256:...>] [--expected-issuer <issuer>]
                             [--expected-publisher <publisher>]
                             [--expected-contract <version>] [--json]
  buildchain verify infra-contract-evidence-bundle <file> [--json]
  buildchain verify observability-log <jsonl> [--min-events <n>]
                                             [--require-phase <csv>]
                                             [--require-component <csv>]
                                             [--require-event <csv>] [--allow-errors] [--json]
  buildchain explain release --passport <file-or-url> [--for human|agent] [--json]
  buildchain explain artifact <subject> [--passport <file-or-url>] [--npm-registry <url>] [--for human|agent] [--json]
  buildchain inspect release --passport <file-or-url> [--json]
  buildchain inspect artifact <subject> [--passport <file-or-url>] [--npm-registry <url>] [--json]
  buildchain doctor [--cwd <dir>] [--require-publish-source-lock] [--json]
  buildchain dev pr-admit --repository <owner/repo> --branch <dev/vN/vN.M>
                             --pull-request <n> --expected-head <sha>
                             [--execute] [--output <file>] [--json]
  buildchain dev merge-queue --repository <owner/repo> --branch <dev/vN/vN.M>
                             [--from-config | --workflow <required-workflow.yml>...] [--cwd <dir>]
                             [--check-response-timeout-minutes <n>]
                             [--max-entries-to-build <n>] [--apply]
  buildchain dev warrant <submit|select|heartbeat|recover|close|cancel-queued|observe>
                             --repository <owner/repo> --branch <dev/vN/vN.M>
                             [--execute] [--output <file>] [--json]
  buildchain dev proof <source|verify-source|classify|replay|integration|verify-integration>
                             [--output <file>] [--json]
  buildchain log <info|warn|error> --event <name> [--phase <phase>]
                 [--component <name>] [--source <name>] [--attribute key=value]...
                 [--path <jsonl>] [--json]
  buildchain log summary [--path <jsonl>] [--json]
  buildchain diagnostics summary <diagnostics.json>... [--artifact <file>]...
                                      [--output <file>] [--json]
  buildchain facts module [--cwd <dir>] [--module <id>] [--module-root <path>]
                          [--version-source <id>] [--output <file>]
                          [--output-path <path>]... [--legacy-kungfu-buildinfo <file>] [--json]
  buildchain facts aggregate [--cwd <dir>] [--product <id>]
                             [--module-fact <file>]... [--artifact <path>]...
                             [--output <file>] [--json]
  buildchain facts verify [--cwd <dir>] --fact <file> [--json]
  buildchain kfd ...
  buildchain kfd hub <init|inspect|test|explain> [--cwd <dir>]
                     [--declaration <path>] [--output-dir <path>]
                     [--write] [--force] [--for agent] [--json]
  buildchain kfd status [--cwd <dir>] [--json]
  buildchain kfd migrate-layout [--cwd <dir>] [--write] [--force] [--json]
  buildchain kfd schema list [--standard kfd-1|kfd-2|kfd-3|kfd-4] [--json]
  buildchain kfd schema show <kfd-1|kfd-2|kfd-3|kfd-4> [--schema <name>] [--json]
  buildchain kfd upstream roles [--json]
  buildchain kfd upstream collect [--cwd <dir>] [--output <file>] [--json]
  buildchain kfd upstream check [--cwd <dir>] [--aggregate-json <file-or-json>] [--json]
  buildchain kfd aggregate [--cwd <dir>] [--json]
  buildchain kfd 1 schema [--schema <name>] [--json]
  buildchain kfd 1 witness [--cwd <dir>] [--source-sha <sha>] [--output <file>] [--json]
  buildchain kfd 1 gate --witness-json <file-or-json>... [--cwd <dir>] [--artifact-root <dir>]
                        [--output <file>] [--json]
  buildchain kfd 1 verify --gate-json <file-or-json> [--json]
  buildchain kfd 2 schema [--schema <name>] [--json]
  buildchain kfd 2 taxonomy --entry-json <file-or-json>... [--kind residualRisk|downgradeReason] [--json]
  buildchain kfd 2 claims [--cwd <dir>] [--output-dir <dir>] [--json]
  buildchain kfd 2 product-claims <check|write|render> [--cwd <dir>] [--registry <path>]
                                      [--output-dir <dir>] [--version <version>]
                                      [--channel <channel>] [--tag <tag>] [--source-sha <sha>] [--json]
  buildchain kfd 2 trust-claims [--claims-json <file-or-json>] [--json]
  buildchain kfd 2 trust-assessment [--assessment-json <file-or-json>] [--json]
  buildchain kfd 3 ...
  buildchain kfd 3 detect [--cwd <dir>] [--kind <kind>]... [--artifact <path>] [--json]
  buildchain kfd 3 register <node-api|python-api|cli|binary|documentation|site-bundle>
                           [--cwd <dir>] [--registry <path>] [--artifact <path>]
                           [--product <name>] [--json]
  buildchain kfd 3 audit [--cwd <dir>] [--registry <path>] [--artifact <path>] [--json]
  buildchain kfd 3 witness [--cwd <dir>] [--registry <path>] [--kind prebuild|artifact]
                            [--source-sha <sha>] [--artifact <path>] [--output <file>] [--json]
  buildchain kfd 3 query [<product>] [--cwd <dir>] [--registry <path>]
                          [--passport <file-or-url>] [--artifact <path>] [--json]
  buildchain kfd 4 schema [--schema <name>] [--json]
  buildchain kfd 4 gate --input-json <file-or-json> [--cwd <dir>] [--output <file>] [--json]
  buildchain kfd 4 verify --gate-json <file-or-json> [--expected-source-sha <sha>] [--json]
  buildchain kfd 5 schema [--schema <name>] [--json]
  buildchain kfd 5 gate --input-json <file-or-json> [--cwd <dir>] [--output <file>] [--json]
  buildchain kfd 5 verify --gate-json <file-or-json> [--expected-source-sha <sha>] [--json]
  buildchain kfd 7 schema [--schema <name>] [--json]
  buildchain kfd 7 gate --input-json <file-or-json> [--cwd <dir>] [--output <file>] [--json]
  buildchain kfd 7 verify --gate-json <file-or-json> [--expected-source-sha <sha>] [--json]
  buildchain kfd support project --matrix-json <file-or-json> --gate-json <file-or-json>...
                                  [--expected-source-sha <sha>] [--checked-at <date-time>]
                                  [--output <file>] [--json]
  buildchain kfd support verify --projection-json <file-or-json>
                                  [--expected-source-sha <sha>] [--checked-at <date-time>] [--json]
  buildchain sample process-tree [--interval-ms <n>] [--label <name>]
                                 [--output <jsonl>] [--summary-output <json>]
                                 [--requested-parallelism <n>] [--json]
                                 -- <command> [args...]
  buildchain mark --event <name> [--phase <phase>] [--component <name>]
                  [--attribute key=value]... [--path <jsonl>] [--json]
  buildchain span --event <name> [--phase <phase>] [--component <name>]
                  [--path <jsonl>] -- <command> [args...]
  buildchain web-surface ...
  buildchain infra-contract ...
  buildchain publication-artifact manifest [--cwd <dir>] [--source-sha <sha>]
                                           [--output <file>] [--passport-output <file>]
                                           [--registry-output <file>] [--source-bundle <file>]
                                           [--no-source-bundle] [--json]
  buildchain publication-artifact npm-package [--cwd <dir>] [--output-dir <dir>] [--package-name <name>] [--json]
  buildchain publication-artifact reproducibility [--cwd <dir>] [--source-sha <sha>]
                                                   [--output <file>] [--promote]
                                                   [--no-toolchain-pull]
                                                   [--allow-unpinned-toolchain] [--json]
  buildchain paper scaffold --package <name> --repository <owner/repo> [--write] [--json]
  buildchain paper migrate [--cwd <dir>] [--write] [--json]
  buildchain paper work start <topic> [--cwd <dir>] [--branch <branch>] [--execute] [--json]
  buildchain paper work submit [--cwd <dir>] [--title <title>] [--body <body>] [--execute] [--json]
  buildchain paper fleet audit [--root <dir>] [--offline] [--json]
  buildchain paper fleet update [--root <dir>] [--write] [--json]
  buildchain paper agent verify [--cwd <dir>] [--offline] [--json]
  buildchain paper preflight [--cwd <dir>] [--offline] [--json]
  buildchain paper bootstrap npm [--cwd <dir>] [--execute]
                                  [--confirm-public-package <name>] [--json]
  buildchain paper build [--cwd <dir>] [--execute] [--json]
  buildchain paper alpha [--cwd <dir>] [--source-ref <ref>] [--target-ref <ref>]
                          [--execute] [--json]
  buildchain paper status [--cwd <dir>] [--json]
  buildchain paper resume [--cwd <dir>] [--buildchain-ref <ref>] [--execute] [--json]
  buildchain release-propagation <plan|write-lock|work|entry|pickup> ...
  buildchain badges readme [--cwd <dir>] [--readme <path>] [--check] [--write] [--json]
  buildchain badges bundle [--cwd <dir>] [--readme <path>] [--claims <csv>] [--check] [--write] [--json]
  buildchain homebrew update-formula --package <name> --release-passport <file-or-url> [--write] [--json]
  buildchain homebrew check [--cwd <dir>] [--package <name>] [--release-passport <file-or-url>] [--json]
  buildchain publish-source <lock|manifest|verify-lock|verify-channel-ref|validate-anchored-release> ...
  buildchain build-contract ...

Examples:
  buildchain init --type package --package-manager pnpm
  buildchain validate --require-version-state --require-lifecycle-stages build,verify
  buildchain lifecycle run build --artifact-path dist --artifact-name "{repo}-{version}-{platform}"
  buildchain npm dry-run --json
  buildchain release --dry-run --target-ref alpha/v3/v3.0
  buildchain release line open --major 3 --minor 1 --source-ref release/v3/v3.0 --json
  buildchain span --event native.build -- cmake --build build
  buildchain collect github-release --tag v3.0.0 --assets-dir dist --output-dir .buildchain/release-passport
  buildchain create publication-admission --input-json admission-input.json --output admission.json
  buildchain create runner-provenance --input-json runner-input.json --output runner.json
  buildchain verify release-passport .buildchain/release-passport/buildchain.release.json
  buildchain verify publication-admission admission.json --registry-json publication-authority-registry.json --runner-json runner.json --control-plane-audit-json control-plane.json --expected-json expected.json --json
  buildchain audit publication-control-plane --repository kungfu-systems/buildchain --branch release/v3/v3.0
  buildchain verify artifact ./dist/buildchain-x86_64-unknown-linux-gnu.tar.gz --passport .buildchain/release-passport/buildchain.release.json
  buildchain verify artifact-envelope .buildchain/kfx/artifact-verification-envelope.json --json
  buildchain project kfx-admission .buildchain/kfx/artifact-verification-envelope.json --json
  buildchain verify infra-contract-evidence-bundle .buildchain/infra-contract-evidence-bundle.json
  buildchain verify observability-log .buildchain/logs/events.jsonl --min-events 4 --require-phase build
  buildchain infra-contract --mode plan --source-sha <sha>
  buildchain infra-contract --mode ci --source-sha <sha>
  buildchain infra-contract --mode plan --source-sha <sha> --execute-adapter-commands true
  buildchain infra-contract --mode apply --plan <plan.json> --source-sha <sha> --approval-id <id>
  buildchain infra-contract --mode apply --plan <plan.json> --source-sha <sha> --approval-id <id> --dry-run false --execute-adapter-commands true
  buildchain infra-contract --mode propagation-apply --propagation-plan <plan.json> --dry-run true
  buildchain infra-contract --mode evidence-bundle --artifact <artifact.json> --propagation-result <result.json>
  buildchain publication-artifact manifest --source-sha <sha> --json
  buildchain paper preflight --json
  buildchain paper status --json
  buildchain release-propagation plan --graph graph.json --upstream-release release.json --json
  buildchain release-propagation pickup plan --config manual-upstreams.json --source-id buildchain --channel release --current-version 3.0.3 --json
  buildchain kfd status --json
  buildchain kfd schema list --json
  buildchain kfd 1 witness --json
  buildchain kfd 2 claims --json
  buildchain kfd 2 trust-assessment --json
  buildchain kfd upstream collect --json
  buildchain kfd aggregate --json
  buildchain kfd 3 query buildchain --json
`;
