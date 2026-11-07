/* 诸葛连弩：牌堆唯一性、架弩加成、加成消耗与回合重置、AI 时机 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');
const src = html.match(/<script id="engine">([\s\S]*?)<\/script>/)[1];
const sb = { module: { exports: {} }, console }; vm.createContext(sb); vm.runInContext(src, sb);
const SG = sb.module.exports;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* 1. 牌堆里只有一张连弩 */
ok(JSON.stringify(SG.CARDS).indexOf('连弩') > 0 || SG.CARDS.nu === '诸葛连弩', 'CARDS 里有诸葛连弩');
{
  const st = SG.newGame({ seed: 1, p0: 'boy', p1: 'zhangfei' });
  const all = st.p[0].hand.concat(st.p[1].hand, st.deck, st.discard);
  const n = all.filter(c => c === 'nu').length;
  ok(n === 1, '整副牌只有 1 张连弩（实际 ' + n + '）');
  ok(all.length === 45, '牌总数 45（实际 ' + all.length + '）');
}

/* 2. 架弩：下一张【杀】伤害 +1，且只加成一次 */
{
  const st = SG.newGame({ seed: 2, p0: 'zhangfei', p1: 'boy' });
  st.p[0].hand = ['nu', 'slash', 'slash'];
  st.p[1].hand = ['dodge', 'dodge', 'dodge', 'dodge'];
  st.deck = []; /* 避免摸牌干扰 */
  const L1 = SG.legal(st);
  ok(L1.nu === true, '手里有连弩时可以发动');
  ok(L1.slash === true, '有杀时可出杀');

  SG.apply(st, { t: 'nu' });
  ok(st.nuBoost === 1, '架弩后 nuBoost = 1');
  ok(st.p[0].hand.indexOf('nu') < 0, '连弩已从手牌移除');

  const L2 = SG.legal(st);
  ok(L2.nu === false, '加成未用掉时不能再架第二张');

  SG.apply(st, { t: 'slash' });
  ok(st.nuBoost === 0, '第一刀消耗掉加成');
  const a = st.awaiting;
  ok(a && a.type === 'dodge' && a.dmg === 2, '第一刀伤害为 2（实际 ' + (a && a.dmg) + '）');

  SG.apply(st, { t: 'dodge', use: false });   /* 硬吃，触发结算 */
  SG.apply(st, { t: 'slash' });               /* 第二刀 */
  const b = st.awaiting;
  ok(b && b.type === 'dodge' && b.dmg === 1, '第二刀恢复 1 点伤害（实际 ' + (b && b.dmg) + '）');
}

/* 3. 回合结束/开始时清零 */
{
  const st = SG.newGame({ seed: 3, p0: 'boy', p1: 'zhangfei' });
  st.p[0].hand = ['nu'];
  st.p[1].hand = [];
  SG.apply(st, { t: 'nu' });
  ok(st.nuBoost === 1, '架弩后持有加成');
  SG.apply(st, { t: 'end' });
  ok(st.nuBoost === 0, '换回合后加成清零（不跨回合残留）');
}

/* 4. AI 只在真能再砍一刀时才架弩 */
{
  let bad = 0, used = 0;
  for (let s = 0; s < 60; s++) {
    const st = SG.newGame({ seed: (s * 7919 + 13) | 0, p0: 'boy', p1: 'zhangfei' });
    st.p[0].hand = ['nu', 'slash'];        /* 两刀武将，手里还有一张杀但额度未满 */
    let n = 0;
    while (!st.over && n < 400) {
      const L = SG.legal(st);
      const mv = SG.aiStep(st);
      if (!mv) break;
      if (mv.t === 'nu') {
        used++;
        if (!L.slash) bad++;
        st.p[0].hand.push('slash');        /* 补一张，让后续流程可继续 */
      }
      SG.apply(st, mv); n++;
    }
  }
  ok(bad === 0, 'AI 架弩时必定还有出刀额度（误用 ' + bad + ' 次 / 共 ' + used + ' 次）');
}

console.log(fail === 0 ? '\n全部通过（' + pass + ' 项）' : '\n失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
