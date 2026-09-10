# macOS Credential Island

This action signs one sealed macOS application on an isolated macOS runner. It
does not check out consumer source and does not execute files from the input
artifact. Buildchain validates the source-bound input manifest, imports one
exact Developer ID Application identity into a temporary keychain, signs the
application, submits Apple notarization, staples the application and DMG,
verifies Gatekeeper, and writes bounded JSON evidence.

DMG assembly uses a unique execution- and attempt-bound image path and volume
name. Only the exact `hdiutil: create failed - Resource busy` failure is retried,
with three attempts and a total retry delay of seven seconds. Certificate,
entitlement, signature, notarization, provenance, and policy failures remain
terminal. Attempt artifacts stay below the owned temporary root, and successful
evidence binds the request, unsigned archive, runtime, runner attempt, toolchain,
retry history, cleanup result, and signed output digests.

The reusable Buildchain workflow invokes this action from a job bound to the
caller's protected GitHub Environment. The job downloads the exact sealed
Buildchain input and immutable action runtime, then uploads the signed payload
and its Buildchain platform manifest. It has no consumer checkout. Do not add a
package manager, lifecycle, hook, or consumer-script execution to that job.

The supported `electron-desktop-v1` entitlements profile is owned by
Buildchain. Consumer-provided entitlement files are intentionally unsupported;
otherwise pull-request bytes could expand the signing authority.
