// tests/s1/secret-shape.test.ts — 凭据形态判定的契约 (真库实测发现的明文口令)。
//
// 为什么有它: 真库里**已经躺着**明文凭据  `pw=qq282000500`、"使用 W@daodun666 作为解压密码"、
// "loli 的密码为 qq282000500"。记忆库的性质是"下次能查到", 而这正是凭据最不该有的性质:
// 它会被注入上下文、被检索返回、被面板展示、被 git 提交。一旦落盘就没有撤回 (shadow 只影响检索)。
//
// 本文件钉住**两侧**:
//   · 拦得住: 赋值式 / 中文口令句 (值在前与值在后两种语序) / 带前缀的密钥字面量;
//   · 不误杀: "关于凭据的做法"必须放行  那是记忆库**最该**记的东西。
import { describe, expect, it } from "vitest";
import { detectSecret } from "../../src/kernel/secret-shape.ts";

describe("拦得住: 本身就是凭据的内容", () => {
  it("赋值式 (真库实测样本)", () => {
    expect(detectSecret("pw=qq282000500").isSecret).toBe(true);
    expect(detectSecret("password: hunter2pass").isSecret).toBe(true);
    expect(detectSecret("api_key=abcdef1234567890").isSecret).toBe(true);
  });

  it("中文口令句  **值在前**的语序 (真库实测: '使用 X 作为解压密码')", () => {
    expect(detectSecret("使用 W@daodun666 作为解压密码").isSecret).toBe(true);
  });

  it("中文口令句  **值在后**的语序 (真库实测: 'loli 的密码为 qq282000500')", () => {
    expect(
      detectSecret("登录进不去的真因是凭据错配loli 的密码为 qq282000500 而").isSecret,
    ).toBe(true);
  });

  it("带前缀的密钥字面量", () => {
    expect(detectSecret("token: sk-abcdefghijklmnopqrstuvwxyz0123").isSecret).toBe(true);
    expect(detectSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789").isSecret).toBe(true);
  });

  it("判定给出**可审计的理由** (面板/账本要能解释为什么没进库)", () => {
    const v = detectSecret("pw=qq282000500");
    expect(v.reason).toContain("凭据形态");
  });
});

describe("不误杀: **关于凭据的做法**必须放行", () => {
  it("在说'怎么读凭据'而不是给值", () => {
    expect(detectSecret("必须用 credentials.py 读 .secrets/credentials.json").isSecret).toBe(false);
  });

  it("在说'保存方式'而不是给值", () => {
    expect(detectSecret("密码要用 scrypt 存哈希, 不要明文").isSecret).toBe(false);
    expect(detectSecret("password 字段要用 argon2id").isSecret).toBe(false);
  });

  it("在说'过期处理'而不是给值", () => {
    expect(detectSecret("token 过期了要重新申请").isSecret).toBe(false);
  });

  it("普通短指令与闲聊不受影响", () => {
    for (const t of ["继续", "y", "2", "今天天气不错", "先跑测试再改代码"]) {
      expect(detectSecret(t).isSecret, t).toBe(false);
    }
  });

  it("空输入不判为凭据", () => {
    expect(detectSecret("").isSecret).toBe(false);
    expect(detectSecret("   ").isSecret).toBe(false);
  });
});

describe("接入捕获链: 命中即**不落盘**", () => {
  it("凭据不入库, 且 signal 说明原因 (不是静默丢弃)", async () => {
    const { captureTurn } = await import("../../src/capture/engine.ts");
    const r = captureTurn({ text: "pw=qq282000500", session: "s", project: "P" });
    expect(r.entries.length).toBe(0);
    expect(r.signal).toContain("no-secret");
    expect(r.signal).toContain("凭据形态");
  });

  it("关于凭据的正确做法仍会落库 (闸门不能把知识一起拦掉)", async () => {
    const { captureTurn } = await import("../../src/capture/engine.ts");
    // "记住: X" 走显式通道 (优先级最高, 绕过凭据闸门是**有意的**  用户明确要存)
    const r = captureTurn({ text: "记住: 密码要用 scrypt 存哈希", session: "s", project: "P" });
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.kind).toBe("fact");
  });
});
