#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

git -C "${REPO_ROOT}" config core.hooksPath .githooks
printf 'Configured core.hooksPath=.githooks in %s\n' "${REPO_ROOT}"