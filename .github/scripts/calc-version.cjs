// .github/scripts/calc-version.cjs — release 流水线算下一个版本号。
// tag 触发: 用 tag 版本; 手动触发: 基于远程 git tags 最高版本 +1 (避免 E409)。
const fs = require('fs');
const { execSync } = require('child_process');
const k = (process.env.BUMP || 'patch').toLowerCase();
const ref = process.env.GITHUB_REF || '';
if (ref.indexOf('refs/tags/v') === 0) {
  process.stdout.write(ref.slice('refs/tags/v'.length));
  process.exit(0);
}
let base = null;
try {
  // 读远程 tags (无需 npm 认证): git ls-remote --tags
  const out = execSync('git ls-remote --tags origin "v*" 2>/dev/null || echo ""').toString();
  const tags = out.split('\n').map(function (line) {
    const m = line.match(/refs\/tags\/v(\d+\.\d+\.\d+)$/);
    return m ? m[1] : null;
  }).filter(Boolean);
  const nums = tags.map(function (x) { return x.split('.').map(Number); });
  nums.sort(function (x, y) { return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  if (nums.length) base = nums[nums.length - 1];
} catch (e) { base = null; }
if (!base) {
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  base = p.version.split('.').map(Number);
}
const a = base[0], b = base[1], c = base[2];
let v;
if (k === 'major') v = (a + 1) + '.0.0';
else if (k === 'minor') v = a + '.' + (b + 1) + '.0';
else v = a + '.' + b + '.' + (c + 1);
process.stdout.write(v);
