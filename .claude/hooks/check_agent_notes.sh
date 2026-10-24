#!/usr/bin/env bash
# Agent Notes v2 checks only staged contents and returns the strict exit code.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec uv run scripts/redlines/agent_notes.py --staged
