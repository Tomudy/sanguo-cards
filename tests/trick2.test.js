/* 锦囊补完：南蛮入侵 / 万箭齐发 / 无懈可击 —— 强制响应、无懈连锁、技能转换、守恒 */
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

function scene(a, b, opts) {
  opts = opts || {};
  const st = SG.newGame({ seed: opts.seed || 7, p0: a, p1: b });
  st.deck = []; st.discard = [];
  st.turn = 0; st.round = 1; st.phase = 'play';
  st.awaiting = null; st.slashUsed = 0; st.slashBonus = 0;
  st.nuActive = false; st.jiuBoost = 0;
  st.p[0].hand = (opts.h0 || []).slice();
  st.p[1].hand = (opts.h1 || []).slice();
  st.p[0].equip = { weapon: (opts.w0 || null), armor: (opts.a0 || null) };
  st.p[1].equip = { weapon: (opts.w1 || null), armor: (opts.a1 || null) };
  st.p[0].hp = st.p[0].maxHp; st.p[1].hp = st.p[1].maxHp;
  st.p[0].used = {}; st.p[1].used = {};
  return st;
}
function eqN(pl){ const e = pl.equip || {}; return (e.weapon ? 1 : 0) + (e.armor ? 1 : 0); }
function total(st){
  return st.deck.length + st.discard.length + st.p[0].hand.length + st.p[1].hand.length +
         eqN(st.p[0]) + eqN(st.p[1]);
}

/* ===== 1. 牌堆配比 ===== */
{
  const st = SG.newGame({ seed: 1, p0: 'boy', p1: 'lvbu' });
  const all = st.p[0].hand.concat(st.p[1].hand, st.deck, st.discard);
  ok(all.filter(c => c === 'nanman').length === 2, '南蛮入侵 ×2');
  ok(all.filter(c => c === 'wanjian').length === 1, '万箭齐发 ×1');
  ok(all.filter(c => c === 'wuxie').length === 2, '无懈可击 ×2');
  ok(all.length === 80, '整副牌 80 张（实际 ' + all.length + '）');
}

/* ===== 2. 南蛮入侵：出杀响应 / 硬吃掉血 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['nanman'], h1: ['slash'] });
  const L = SG.legal(st);
  ok(L.nanman === true, '手里有南蛮时 legal.nanman 为 true');
  SG.apply(st, { t: 'nanman' });
  ok(st.awaiting && st.awaiting.type === 'nanman' && st.awaiting.p === 1,
     '双方都没无懈：跳过询问直接进响应');
  const hp0 = st.p[1].hp;
  SG.apply(st, { t: 'nanman', use: true });
  ok(st.p[1].hand.length === 0, '吕布打出杀响应');
  ok(st.p[1].hp === hp0, '打出杀不掉血');
  ok(!st.awaiting && st.phase === 'play', '响应完回到出牌阶段');
}
{
  const st = scene('boy', 'lvbu', { h0: ['nanman'], h1: ['peach'] });
  SG.apply(st, { t: 'nanman' });
  const hp0 = st.p[1].hp;
  SG.apply(st, { t: 'nanman', use: false });
  ok(st.p[1].hp === hp0 - 1, '打不出杀：硬吃 1 点伤害');
}

/* ===== 3. 万箭齐发：出闪响应 / 涯角摸牌 / 龙胆转换 ===== */
{
  const st = scene('boy', 'zhaoyun', { h0: ['wanjian'], h1: ['dodge'] });
  st.deck = ['slash'];                        /* 涯角要摸 1 张 */
  SG.apply(st, { t: 'wanjian' });
  ok(st.awaiting && st.awaiting.type === 'wanjian' && st.awaiting.p === 1, '万箭进入赵云响应');
  const hp0 = st.p[1].hp;
  SG.apply(st, { t: 'wanjian', use: true });
  ok(st.p[1].hp === hp0, '打出闪不掉血');
  ok(st.p[1].hand.length === 1, '赵云打出真闪触发【涯角】摸 1 张');
  ok(st.p[1].hand[0] === 'slash', '摸到的正是牌堆顶那张杀');
}
{
  const st = scene('boy', 'zhaoyun', { h0: ['wanjian'], h1: ['slash'] });
  SG.apply(st, { t: 'wanjian' });
  SG.apply(st, { t: 'wanjian', use: true });
  ok(st.p[1].hand.length === 0, '赵云【龙胆】把杀当闪打出');
  ok(st.p[1].hp === st.p[1].maxHp, '龙胆转换不掉血');
}
{
  const st = scene('boy', 'zhaoyun', { h0: ['nanman'], h1: ['dodge'] });
  st.deck = ['slash'];
  SG.apply(st, { t: 'nanman' });
  SG.apply(st, { t: 'nanman', use: true });
  ok(st.p[1].hp === st.p[1].maxHp, '赵云【龙胆】把闪当杀杀退南蛮');
}

/* ===== 3.5 万箭闪成功可触发【惊鸿】 ===== */
{
  const st = scene('boy', 'qingluan', { h0: ['wanjian'], h1: ['dodge'] });
  st.deck = ['slash'];
  const hp0 = st.p[0].hp;
  SG.apply(st, { t: 'wanjian' });
  SG.apply(st, { t: 'wanjian', use: true });
  ok(st.awaiting && st.awaiting.type === 'jinghong' && st.awaiting.p === 1,
     '青鸾闪开箭雨后可发动惊鸿');
  SG.apply(st, { t: 'jinghong', use: true });
  ok(st.p[0].hp === hp0 - 1, '惊鸿反打放箭者 1 点');
}

/* ===== 4. 无懈可击：抵消 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['nanman'], h1: ['wuxie'] });
  SG.apply(st, { t: 'nanman' });
  ok(st.awaiting && st.awaiting.type === 'wuxie' && st.awaiting.p === 1,
     '对方有无懈：先问无懈');
  const hp0 = st.p[1].hp;
  SG.apply(st, { t: 'wuxie', use: true });    /* 吕布无懈，我手里没有 → 连锁终结 */
  ok(st.p[1].hand.length === 0, '无懈打掉了');
  ok(!st.awaiting && st.phase === 'play', '连锁结束回到出牌阶段');
  ok(st.p[1].hp === hp0, '南蛮被抵消，不掉血');
}

/* ===== 5. 反无懈：连锁为偶，锦囊生效 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['juedou', 'wuxie'], h1: ['wuxie'] });
  SG.apply(st, { t: 'juedou' });
  SG.apply(st, { t: 'wuxie', use: true });    /* 吕布无懈我的决斗 */
  ok(st.awaiting && st.awaiting.type === 'wuxie' && st.awaiting.p === 0 &&
     st.awaiting.count === 1, '球踢回给我（连锁 1 层）');
  SG.apply(st, { t: 'wuxie', use: true });    /* 我反无懈 */
  ok(st.awaiting && st.awaiting.type === 'duel' && st.awaiting.p === 1,
     '连锁 2 层（偶）：决斗生效，吕布先出杀');
  SG.apply(st, { t: 'duel', use: false });    /* 吕布没杀认输 */
  ok(st.p[1].hp === st.p[1].maxHp - 1, '决斗伤害照常结算');
}

/* ===== 6. 不无懈：让锦囊生效 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['nanman'], h1: ['wuxie', 'slash'] });
  SG.apply(st, { t: 'nanman' });
  SG.apply(st, { t: 'wuxie', use: false });   /* 吕布留着无懈不用 */
  ok(st.awaiting && st.awaiting.type === 'nanman', '放弃无懈后正常进入南蛮响应');
}

/* ===== 7. 无懈保住装备 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['guohe'], h1: ['wuxie'], a1: 'bagua' });
  SG.apply(st, { t: 'guohe' });
  ok(st.awaiting && st.awaiting.type === 'wuxie', '拆桥先过无懈询问');
  SG.apply(st, { t: 'wuxie', use: true });
  ok(st.p[1].equip.armor === 'bagua', '八卦阵保住了');
  ok(!st.awaiting, '没有进入选牌阶段');
}

/* ===== 8. 无懈不能主动打 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['wuxie', 'slash'], h1: [] });
  const L = SG.legal(st);
  ok(L.wuxie === undefined, '出牌阶段 legal 里没有 wuxie 动作');
}

/* ===== 9. 南蛮伤害能触发濒死 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['nanman'], h1: [] });
  st.p[1].hp = 1;
  SG.apply(st, { t: 'nanman' });
  SG.apply(st, { t: 'nanman', use: false });
  ok(st.awaiting && st.awaiting.type === 'dying' && st.p[1].dying, '南蛮把 1 血吕布打进濒死');
}

/* ===== 10. AI 对 AI 30 局：守恒 + 新动作出现 ===== */
{
  let bad = 0, used = { nanman: 0, wanjian: 0, wuxie: 0 };
  const ids = ['boy', 'lvbu', 'zhaoyun', 'gushan', 'zhangfei', 'baiyu'];
  for (let k = 0; k < 30; k++) {
    const st = SG.newGame({ seed: k * 31 + 5, p0: ids[k % 6], p1: ids[(k + 2) % 6] });
    let n = 0;
    while (!st.over && n < 2000) {
      const mv = SG.aiStep(st);
      if (!mv) break;
      if (used[mv.t] !== undefined) used[mv.t]++;
      SG.apply(st, mv);
      n++;
      if (total(st) !== 80) bad++;
    }
  }
  ok(bad === 0, '30 局牌数守恒');
  ok(used.nanman > 0 && used.wanjian > 0 && used.wuxie > 0,
     'AI 会用南蛮(' + used.nanman + ') / 万箭(' + used.wanjian + ') / 无懈(' + used.wuxie + ')');
}

console.log('\n' + pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : '，全部通过'));
process.exit(fail ? 1 : 0);
