#!/bin/bash
set -euo pipefail

if command -v actionlint >/dev/null 2>&1; then
  find .github/workflows -maxdepth 1 -name '*.yml' -print0 | xargs -0 actionlint -color=false
else
  find .github/workflows -maxdepth 1 -name '*.yml' -print0 | \
    xargs -0 go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color=false
fi
