#!/usr/bin/env bash
# Unified verification entry: build → static (typecheck) → unit/integration tests.
# Used by both local (Stop hooks) and CI. Fails loudly, never SKIP-as-PASS.
#
# 先构建再测试: tests/s2/client-bundle.test.ts 会断言 dist/dsh/client.js 的模块 id,
# 不先构建就只会退化成"跳过产物断言"。
set -uo pipefail

# ---- 覆盖面记录 (2026-09-18, §589) ----
#
# 为什么需要它: 本脚本此前**只在失败时说话** —— 全绿时输出是一串各自独立的
# "[verify] X: ..." 行, 读不出"一共检查了什么"。同型缺口已在别处出现过两次:
#   · deploy-state.sh 只查服务端产物, 不查客户端 bundle (§586);
#   · verify-agent-note-coverage 只判"有没有 Note", 不判"覆盖了哪些改动" (§583)。
# 共同机制: **检查器的判据面比它声称的窄, 而它不报"我没检查这部分"**。
# 所以结尾显式列出跑过的检查 —— 让"检查了什么"本身可见。
COVERED=()
step() {
  COVERED+=("$1")
  printf "%s\n" "[verify] $1"
}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step "build: tsc (dist) + esbuild (client bundle)"
if ! pnpm run build >/dev/null || ! pnpm run build:client >/dev/null; then
  echo "[verify] FAILED: build" >&2
  exit 1
fi

step "static: tsc --noEmit (kernel)"
if ! pnpm exec tsc --noEmit; then
  echo "[verify] FAILED: typecheck (kernel)" >&2
  exit 1
fi

step "static: tsc --noEmit (client)"
if ! pnpm exec tsc -p tsconfig.client.json --noEmit; then
  echo "[verify] FAILED: typecheck (client)" >&2
  exit 1
fi

step "tests: vitest run (S1 + S2 + S3)"
if ! pnpm exec vitest run --passWithNoTests; then
  echo "[verify] FAILED: tests" >&2
  exit 1
fi

# Agent Note 硬约束: 结构 / 格式 / "非平凡改动必须带 Note"。
# 三条都是 gate 而不是文档 —— 文档可以被忽略, 退出码不行。
step "notes: classification"
if ! pnpm run verify-agent-note-classification; then
  echo "[verify] FAILED: agent-note-classification" >&2
  exit 1
fi

step "notes: format"
if ! pnpm run verify-agent-note-format; then
  echo "[verify] FAILED: agent-note-format" >&2
  exit 1
fi

# 代码质量: lint (未用变量/浮空 promise 类) 与结构 (文件规模/重复率/端口纯度/单一事实源)。
# 这两道是"防止架构慢慢长歪"的机械约束 —— 它们不会让功能测试变红, 但能拦住持续劣化。
step "lint: oxlint"
if ! pnpm run lint; then
  echo "[verify] FAILED: lint" >&2
  exit 1
fi

step "structure: file size / duplication / port purity / single source"
if ! pnpm run verify-structure; then
  echo "[verify] FAILED: verify-structure" >&2
  exit 1
fi

# 跨层字段契约: 面板渲染的字段必须**有服务端来源** (§568 —— §565 那个"面板显示空白"
# 就是跨层的: 两侧类型各自声明, tsc 挡不住)。
step "client contract: rendered fields have server-side declarations"
if ! pnpm run verify-client-contract; then
  echo "[verify] FAILED: verify-client-contract (面板渲染了服务端没有的字段)" >&2
  exit 1
fi

# 变异探针: **故意破坏实现, 看测试是否变红** —— 全绿不等于断言有效 (§653)。
# 成本约 5 秒 (4 个变异, 每个只跑相关测试文件), 而它守的是"我做过的修复不会被悄悄退回去"。
step "mutation: 断言是否有防护力 (破坏实现看测试红不红)"
if ! pnpm run mutation-probe >/dev/null 2>&1; then
  echo "[verify] FAILED: mutation-probe (有变异逃逸 ⇒ 对应断言无效; 跑 pnpm run mutation-probe 看是哪个)" >&2
  exit 1
fi

# 元验证: **每个判定项都必须能真的失败** (§716) —— 一个永远不触发的检查等于没有。
# 成本约 16 次 verify-structure (每次秒级), 而它守的是"检查器自己不是摆设"。
step "checks: 判定项都能真的失败 (元验证)"
if ! pnpm run verify-checks-can-fail >/dev/null 2>&1; then
  echo "[verify] FAILED: verify-checks-can-fail (有判定项抓不到它该抓的东西; 跑该脚本看是哪个)" >&2
  exit 1
fi

# 文档同步: 引用可达 + 结构合规 (学习 DSH 的 doc-sync, 轻量版)。
step "docs: refs + structure"
if ! pnpm run verify-docs; then
  echo "[verify] FAILED: verify-docs (引用不存在或缺少文档声明)" >&2
  exit 1
fi

# 门禁**每一步**都必须有"它能失败"的证据 (§759):
# `verify-checks-can-fail` 只守 `verify-structure` 的判定项, 而门禁各步是**各自独立**的脚本 ——
# "某一步从来没红过"查不出来 (它每次打印 OK, 与"真的检查过"长得一样)。
# 沉睡字段登记 (§771): "零填充"的字段必须有明确理由, 否则"有读者却无产出点"会重演 (§765)。
step "field coverage: 沉睡字段都有理由"
if ! pnpm run verify-field-coverage >/dev/null 2>&1; then
  pnpm run verify-field-coverage >&2 || true
  echo "[verify] FAILED: verify-field-coverage (登记表过期: 理由里引用的机制已消失)" >&2
  exit 1
fi

step "gate evidence: 每一步都有'它能失败'的证据"
if ! pnpm run verify-gate-evidence >/dev/null 2>&1; then
  pnpm run verify-gate-evidence >&2 || true
  echo "[verify] FAILED: verify-gate-evidence (有步骤从未被证明能失败; 见上面的步名)" >&2
  exit 1
fi

# 输出面覆盖 (§756): 每个 `@Remote` 端点都要在**某个验证面**上出现过。
# 判据必须**同时搜两层**并把面打进输出 —— §753 我只搜 tests/ 就把 6 个已在真机 smoke 里
# 被真的调用的端点报成"零测试"(虚报缺陷)。本步把那件事机械化。
step "rpc coverage: 每个 @Remote 端点都在某个验证面上出现"
if ! pnpm run verify-rpc-coverage; then
  echo "[verify] FAILED: verify-rpc-coverage (有端点不在任何验证面上; 见上面的端点名)" >&2
  exit 1
fi

# 真库一致性验收 (§747 接入): 前三层 (单元/端到端/smoke) 全用**隔离空库** ——
# 它们看不到"索引与真相文件的历史不一致""历史写入的产物""真实数据分布的长尾形态"。
# 本步补第四层, **只读**地核对 `~/.dsh/hx-memory`。
#
# 为什么现在才敢接: 此前它在空库下会报 2 项 FAIL (那两条断言的前提是"数据得存在"),
# 于是**无法进 CI**。加了 `skip` 之后: 空库 → "N 通过 / 0 失败 / 2 跳过" (退出码 0),
# 真库 → "15 通过 / 0 失败"。跳过项**必须打出来**, 否则"13 通过"会掩盖"2 项没跑"。
# (与下一行 bench 的"缺语料时明确跳过而不是假装通过"同一原则。)
step "real-library: 真库一致性 (只读; 空库下自动跳过 2 项)"
if ! pnpm run verify-real-library; then
  echo "[verify] FAILED: verify-real-library (真库与索引不一致; 跑 pnpm run verify-real-library 看细节)" >&2
  exit 1
fi

# 评测指标快照: 报告里的数字必须与当前实现一致 (防"改了行为但报告没改")。
# 语料含真实记忆、不入库, 因此缺语料时本步会明确跳过而不是假装通过。
step "bench: metric snapshot (无私有语料时自动跳过)"
if ! pnpm run verify-bench-snapshot; then
  echo "[verify] FAILED: verify-bench-snapshot (指标漂移; 有意变更请跑 bench/snapshot.ts --write)" >&2
  exit 1
fi

if [[ "${HX_SKIP_NOTE_COVERAGE:-0}" != "1" ]]; then
  step "notes: coverage (非平凡改动必须带 Note)"
  # CI 里工作区是干净的, 必须给出比较基线才判得出来; 本地默认比较 HEAD + 工作区。
  coverage_args=()
  if [[ -n "${HX_NOTE_COVERAGE_BASE:-}" ]]; then
    coverage_args=(--base "${HX_NOTE_COVERAGE_BASE}")
  elif [[ -n "${HX_NOTE_COVERAGE_RANGE:-}" ]]; then
    coverage_args=(--range "${HX_NOTE_COVERAGE_RANGE}")
  fi
  # ⚠ 与其余各步一致走 npm script (§750): 本步此前**唯一**用直接 `node scripts/xxx.ts` 路径 ——
  # 那意味着改文件名/挪目录时它**不会随 package.json 一起被发现**(其余步都会)。
  if ! pnpm run verify-agent-note-coverage -- "${coverage_args[@]}"; then
    echo "[verify] FAILED: agent-note-coverage (纯机械改动可加 --allow-missing)" >&2
    exit 1
  fi
fi

# ---- 覆盖总结: 显式列出**跑过什么** (而不只是"没失败") ----
printf "%s\n" "[verify] ---- 覆盖总结:  ${#COVERED[@]} 项检查 ----"
for c in "${COVERED[@]}"; do
  printf "%s\n" "[verify]   ok: $c"
done
echo "[verify] OK (真机 DSH 行为门禁: bash scripts/smoke-dsh.sh)"
