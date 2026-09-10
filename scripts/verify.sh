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

# Agent Note 硬约束: 结构 / 格式 / "非平凡改动必须带 Note"。
# 三条都是 gate 而不是文档 —— 文档可以被忽略, 退出码不行。
echo "[verify] notes: classification"
if ! pnpm run verify-agent-note-classification; then
  echo "[verify] FAILED: agent-note-classification" >&2
  exit 1
fi

echo "[verify] notes: format"
if ! pnpm run verify-agent-note-format; then
  echo "[verify] FAILED: agent-note-format" >&2
  exit 1
fi

if [[ "${HX_SKIP_NOTE_COVERAGE:-0}" != "1" ]]; then
  echo "[verify] notes: coverage (非平凡改动必须带 Note)"
  # CI 里工作区是干净的, 必须给出比较基线才判得出来; 本地默认比较 HEAD + 工作区。
  coverage_args=()
  if [[ -n "${HX_NOTE_COVERAGE_BASE:-}" ]]; then
    coverage_args=(--base "${HX_NOTE_COVERAGE_BASE}")
  elif [[ -n "${HX_NOTE_COVERAGE_RANGE:-}" ]]; then
    coverage_args=(--range "${HX_NOTE_COVERAGE_RANGE}")
  fi
  if ! node --experimental-strip-types scripts/verify-agent-note-coverage.ts "${coverage_args[@]}"; then
    echo "[verify] FAILED: agent-note-coverage (纯机械改动可加 --allow-missing)" >&2
    exit 1
  fi
fi

echo "[verify] OK (真机 DSH 行为门禁: bash scripts/smoke-dsh.sh)"
