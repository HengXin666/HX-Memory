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

# 代码质量: lint (未用变量/浮空 promise 类) 与结构 (文件规模/重复率/端口纯度/单一事实源)。
# 这两道是"防止架构慢慢长歪"的机械约束 —— 它们不会让功能测试变红, 但能拦住持续劣化。
echo "[verify] lint: oxlint"
if ! pnpm run lint; then
  echo "[verify] FAILED: lint" >&2
  exit 1
fi

echo "[verify] structure: file size / duplication / port purity / single source"
if ! pnpm run verify-structure; then
  echo "[verify] FAILED: verify-structure" >&2
  exit 1
fi

# 文档同步: 引用可达 + 结构合规 (学习 DSH 的 doc-sync, 轻量版)。
echo "[verify] docs: refs + structure"
if ! pnpm run verify-docs; then
  echo "[verify] FAILED: verify-docs (引用不存在或缺少文档声明)" >&2
  exit 1
fi

# 评测指标快照: 报告里的数字必须与当前实现一致 (防"改了行为但报告没改")。
# 语料含真实记忆、不入库, 因此缺语料时本步会明确跳过而不是假装通过。
echo "[verify] bench: metric snapshot (无私有语料时自动跳过)"
if ! pnpm run verify-bench-snapshot; then
  echo "[verify] FAILED: verify-bench-snapshot (指标漂移; 有意变更请跑 bench/snapshot.ts --write)" >&2
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
