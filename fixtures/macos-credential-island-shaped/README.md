# macOS credential-island shaped fixture

This Buildchain-owned fixture compiles a minimal native `.app` on the ordinary
credential-free macOS build runner. The reusable build seals that exact app,
then a separate protected job imports the Developer ID and App Store Connect
credentials into temporary files and an ephemeral keychain.

The fixture deliberately verifies that its build output is unsigned. A passing
fixture build is therefore only source/build integrity evidence; the retained
credential-island evidence is the authority for Developer ID signing, Apple
notarization, stapling, and Gatekeeper acceptance. Linux does not execute this
fixture and cannot make any of those macOS claims.
