# macOS Credential Island

This action signs one sealed macOS application on an isolated macOS runner. It
does not check out consumer source and does not execute files from the input
artifact. Buildchain validates the source-bound input manifest, imports one
exact Developer ID Application identity into a temporary keychain, signs the
application, submits Apple notarization, staples the application and DMG,
verifies Gatekeeper, and writes bounded JSON evidence.

The reusable Buildchain workflow invokes this action from a job bound to the
caller's protected GitHub Environment. The job downloads the exact sealed
Buildchain input and immutable action runtime, then uploads the signed payload
and its Buildchain platform manifest. It has no consumer checkout. Do not add a
package manager, lifecycle, hook, or consumer-script execution to that job.

The supported `electron-desktop-v1` entitlements profile is owned by
Buildchain. Consumer-provided entitlement files are intentionally unsupported;
otherwise pull-request bytes could expand the signing authority.
