# KFD Agent Runtime Passport fixture

This fixture records the first real product canary for the Buildchain KFD Agent
Runtime Passport contract.

`kungfu-canary.json` is a coordinate-only retained-evidence record for
`kungfu-systems/kungfu` PR #1169. It intentionally does not copy the private
local build directory or pretend that a digest coordinate can replace the full
KFD report. The executable Passport tests use the KFD package's complete valid
Runtime 100 report and packaged WASM verifier; the canary proves that the same
contract can name the exact Kungfu adapter, source, tree, report, verifier,
suite and observed platform without widening the claim.

The canary's claim ceiling is `independently-verified`. It does not assert
external adoption, certification, unobserved platforms, or normative status for
the Experimental partition.
