#!/usr/bin/env bash
# Unified verification entry: static (typecheck) → S1 (pure kernel) → S2 (integration).
# Used by both local (Stop hooks) and CI. Fails loudly, never SKIP-as-PASS.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[verify] static: tsc --noEmit (kernel)"
if ! pnpm exec tsc --noEmit; then
  echo "[verify] FAILED: typecheck (kernel)" >&2
  exit 1
fi

echo "[verify] static: tsc --noEmit (client)"
if ! pnpm exec tsc -p tsconfig.client.json --noEmit; then
  echo "[verify] FAILED: typecheck (client)" >&2
  exit 1
fi

echo "[verify] S1+S2: vitest run"
if ! pnpm exec vitest run --passWithNoTests; then
  echo "[verify] FAILED: tests" >&2
  exit 1
fi

echo "[verify] OK"
