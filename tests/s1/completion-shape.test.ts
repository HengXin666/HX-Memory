// tests/s1/completion-shape.test.ts — 「这条记忆读起来像不像一条还没办的祈使句」的判据回归。
//
// 为什么需要它 (2026-10-06 用户实测指控): 真库 1188 条 active 里, 含祈使/未完成语气且
// 无收尾断言的条目按本判据是 **233 条 (19.6%)**(细词表口径; 粗词表是 577 条);
// 其中被实际注入过的 44 条、累计注入 **171 次**。最典型的一条是 2026-09-28 存的
// 「现在有一个非常严重的bug! gh-pool … 2FA 队列并不会帮我们执行」 那个 bug 早已修完
// (任务台账 T20), 而它到 10-06 仍被注入 8 次, 模型据此把已完结的事当成新问题重做。
//
// 判据的边界 (三条都钉住, 少一条就会误伤):
//   ① 祈使句 **不**进常驻通道;
//   ② 有收尾断言的正文是「记录」, 必须放行;
//   ③ 但「完成后…你去…」是**条件式待办**  完成词出现在祈使句**之前**不算数。
import { describe, expect, it } from 'vitest';
import { looksUnfinished, UNFINISHED_TAG } from '../../src/kernel/completion-shape.ts';

describe('looksUnfinished: 祈使/未完成形状的判据', () => {
  it('真实的库内实例被判成未完成 (逐字取自真库, 见 docs/memory-failure-audit-20261006.md)', () => {
    const real = [
      '现在有一个非常严重的bug! gh-pool 这整个项目, 似乎后面这个 2FA 授权这个步骤 他那个队列并不会帮我们执行，或者说执行失败了，总之有问题',
      '你去看看，修改一下就可以 另外这个红线你也修改一下',
      '然后这个你记得把它补回这个等待队列里面去啊',
      '另外请你维护1套这个登录态，就是可用的这种登录态。下次如果其他服务要用的话，他们直接就可以复用',
      '想办法。继续多开 sub agent 看看怎么协议化',
      '你看看这个页面，它那个列表的元素做的都溢出来了',
    ];
    for (const text of real) expect(looksUnfinished(text), text.slice(0, 20)).toBe(true);
  });

  it('### 负例: 带收尾断言的正文是记录, 不是待办  必须放行', () => {
    const done = [
      '已完成: 发版 v1.26.3 已推送, CI 6 job 全绿',
      '修复完成。改 version 后 UA 自洽, 已提交。',
      '这批改造已落地并验证, 收口。',
    ];
    for (const text of done) expect(looksUnfinished(text), text.slice(0, 20)).toBe(false);
  });

  it('### 边界: 完成词在祈使句**之前** ⇒ 仍是待办 (条件式待办的真实实例)', () => {
    // 取自真库 cb76628b490069077  同时含「完成后」与「你去」, 但它是一件**还没办**的事。
    const conditional =
      'https://github.com/HengXin666/freebuff-proxy/issues/22\\n发布发版完成后，注意必须要完成后全部走通后，你去给我review一下这个PR';
    expect(looksUnfinished(conditional)).toBe(true);
  });

  it('普通知识型条目不被误伤 (它们才是常驻通道该有的内容)', () => {
    const knowledge = [
      '派生索引必须可全量重建, 带版本身份, 不符即重建',
      '本机 libass 是经过魔改的版本, 1img 等 VSFilterMod 扩展标签可以生效',
      'freebuff 远程站点存在用户手动管理的账号',
    ];
    for (const text of knowledge) expect(looksUnfinished(text), text.slice(0, 20)).toBe(false);
  });

  it('完成断言出现在祈使句**之后** ⇒ 判成记录 (已修复的那条, 你去看下新的这个)', () => {
    expect(looksUnfinished('已修复的那条不管了, 你去看下新的这个')).toBe(true);
    expect(looksUnfinished('你把那个 bug 修完了, 已提交。')).toBe(false);
  });

  it('空文本返回 false (不臆造形状)', () => {
    expect(looksUnfinished('')).toBe(false);
    expect(looksUnfinished('   ')).toBe(false);
  });

  it('三次调用同一输入结果一致 (词表正则不得带残留 lastIndex)', () => {
    const text = '已完成: 已提交。';
    expect([looksUnfinished(text), looksUnfinished(text), looksUnfinished(text)]).toEqual([false, false, false]);
  });

  it('状态前缀是常量且有方括号形态 (注入行据此可读)', () => {
    expect(UNFINISHED_TAG).toBe('[待办]');
  });
});
