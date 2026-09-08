#!/usr/bin/env bash
# Unified verification entry: build → static (typecheck) → unit/integration tests.
# Used by both local (Stop hooks) and CI. Fails loudly, never SKIP-as-PASS.
#
# 先构建再测试: tests/s2/client-bundle.test.ts 会断言 dist/dsh/client.js 的模块 id,
# 不先构建就只会退化成"跳过产物断言"。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[verify] build: tsc (dist) + esbuild (client bundle)"
if ! pnpm run build >/dev/null || ! pnpm run build:client >/dev/null; then
  echo "[verify] FAILED: build" >&2
  exit 1
fi

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

echo "[verify] tests: vitest run (S1 + S2 + S3)"
if ! pnpm exec vitest run --passWithNoTests; then
  echo "[verify] FAILED: tests" >&2
  exit 1
fi

echo "[verify] OK (真机 DSH 行为门禁: bash scripts/smoke-dsh.sh)"
