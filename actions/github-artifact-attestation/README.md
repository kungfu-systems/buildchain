# GitHub Artifact Attestation Evidence

This internal Buildchain action validates one downloaded Linux release artifact
against its platform manifest and Release Passport, writes the custom predicate
consumed by `actions/attest`, and finalizes the retained v1 evidence document.

Consumers should call
`.github/workflows/github-artifact-attestation.yml`; they should not call this
action directly. The action parses data files only. It never checks out or
executes consumer source or the downloaded subject.
