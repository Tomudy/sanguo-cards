/* 诸葛连弩：牌堆唯一性、本回合无限出杀、回合重置、AI 时机 */
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
ok(SG.CARDS.nu === '诸葛连弩', 'CARDS 里有诸葛连弩');
{
  const st = SG.newGame({ seed: 1, p0: 'boy', p1: 'zhangfei' });
  const all = st.p[0].hand.concat(st.p[1].hand, st.deck, st.discard);
  ok(all.filter(c => c === 'nu').length === 1, '整副牌只有 1 张连弩');
  ok(all.length === 64, '牌总数 64（实际 ' + all.length + '）');
}

/* 2. 架弩后本回合出杀不限次数（张飞基础 2 刀，连弩后可打第 3 刀） */
{
  const st = SG.newGame({ seed: 2, p0: 'zhangfei', p1: 'boy' });
  st.p[0].hand = ['nu', 'slash', 'slash', 'slash'];
  st.p[1].hand = ['dodge', 'dodge', 'dodge', 'dodge', 'dodge'];
  st.deck = [];        /* 断掉摸牌，避免手牌被补 */
  ok(SG.legal(st).nu === true, '手里有连弩时可以发动');

  SG.apply(st, { t: 'nu' });
  ok(st.nuActive === true, '架弩后 nuActive = true');
  ok(st.p[0].hand.indexOf('nu') < 0, '连弩已从手牌移除');
  ok(SG.legal(st).nu === false, '本回合不能再架第二张');

  /* 连打三刀，每刀都该被判为合法，且伤害为 1（连弩不再附带加伤） */
  const dmgs = [];
  for (let k = 0; k < 3; k++) {
    ok(SG.legal(st).slash === true, '第 ' + (k + 1) + ' 刀合法（超过张飞原上限 2）');
    SG.apply(st, { t: 'slash' });
    dmgs.push(st.awaiting.dmg);
    SG.apply(st, { t: 'dodge', use: false });   /* 硬吃，继续下一刀 */
  }
  ok(dmgs.join(',') === '1,1,1', '三刀伤害均为 1（实际 ' + dmgs.join(',') + '）');
}

/* 3. 换回合后失效 */
{
  const st = SG.newGame({ seed: 3, p0: 'boy', p1: 'zhangfei' });
  st.p[0].hand = ['nu'];
  st.p[1].hand = [];
  SG.apply(st, { t: 'nu' });
  ok(st.nuActive === true, '架弩生效');
  SG.apply(st, { t: 'end' });
  ok(st.nuActive === false, '换回合后连弩失效（不跨回合残留）');
}

/* 4. AI 只在手里至少两张杀时才架弩（否则白送一张） */
{
  let bad = 0, used = 0, oneSlash = 0;
  for (let s = 0; s < 80; s++) {
    const st = SG.newGame({ seed: (s * 7919 + 13) | 0, p0: 'boy', p1: 'zhangfei' });
    st.p[0].hand = s % 2 ? ['nu', 'slash', 'slash', 'peach'] : ['nu', 'slash', 'peach', 'peach'];
    st.p[1].hand = ['dodge', 'dodge', 'dodge', 'dodge'];
    let n = 0;
    while (!st.over && n < 400) {
      const L = SG.legal(st);
      const mv = SG.aiStep(st);
      if (!mv) break;
      if (mv.t === 'nu') {
        used++;
        const who = SG.active(st);
        const slashes = st.p[who].hand.filter(c => c === 'slash').length;
        if (slashes < 2) { bad++; oneSlash++; }
        if (!L.slash) bad++;
        st.p[who].hand.push('slash');   /* 续上出刀资源，便于观察后续 */
      }
      SG.apply(st, mv); n++;
    }
  }
  ok(used > 0, 'AI 在双杀手牌时确实会架弩（' + used + ' 次）');
  ok(bad === 0, 'AI 不会在只有一张杀时架弩（误用 ' + bad + ' 次）');
}

/* 5. 关山：猛力每回合只加一次伤害（为无限连弩让出空间） */
{
  const st = SG.newGame({ seed: 5, p0: 'gushan', p1: 'boy' });
  st.p[0].hp = 4;                       /* 已受伤 */
  st.p[0].hand = ['slash', 'slash'];
  st.p[1].hand = ['dodge', 'dodge', 'dodge'];
  st.deck = [];
  SG.apply(st, { t: 'slash' });
  const d1 = st.awaiting.dmg;
  ok(d1 === 2, '受伤后的第一刀伤害 2（实际 ' + d1 + '）');
  SG.apply(st, { t: 'dodge', use: false });
  ok(SG.legal(st).slash === false, '关山基础 1 刀，没连弩时第二刀打不出去');
}

console.log(fail === 0 ? '\n全部通过（' + pass + ' 项）' : '\n失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
