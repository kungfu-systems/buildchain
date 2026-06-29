# promote-buildchain-ref

Internal buildchain action for promoting verified compatibility tags from
buildchain release channels:

- `alpha/v1/v1.0` promotes `v1-alpha`;
- `release/v1/v1.0` promotes `v1` and `v1.0`.

It does not bump package versions, publish packages, or merge release channels.
It only moves buildchain entrypoint tags after the target commit has already
passed Verify on the matching release channel.
