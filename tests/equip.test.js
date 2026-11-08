/* 装备牌：牌堆配比、进出装备区、六件装备的特效、判定机制、AI 决策 */
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

/* 造一个"干净的出牌阶段"：断掉摸牌，指定双方手牌与装备，直接进 play 阶段 */
function scene(a, b, opts) {
  opts = opts || {};
  const st = SG.newGame({ seed: opts.seed || 7, p0: a, p1: b });
  st.deck = [];
  st.discard = [];
  st.turn = 0;
  st.round = 1;
  st.phase = 'play';
  st.awaiting = null;
  st.slashUsed = 0;
  st.slashBonus = 0;
  st.nuActive = false;
  st.p[0].hand = (opts.h0 || []).slice();
  st.p[1].hand = (opts.h1 || []).slice();
  st.p[0].equip = { weapon: (opts.w0 || null), armor: (opts.a0 || null) };
  st.p[1].equip = { weapon: (opts.w1 || null), armor: (opts.a1 || null) };
  st.p[0].hp = st.p[0].maxHp;
  st.p[1].hp = st.p[1].maxHp;
  st.p[0].used = {};
  st.p[1].used = {};
  return st;
}
/* 固定判定结果：0.3 → ♥4（红）；0.05 → ♠1（黑） */
function fixJudge(st, v) { st.rnd = () => v; }

/* ===== 1. 牌堆配比 ===== */
{
  const st = SG.newGame({ seed: 1, p0: 'boy', p1: 'lvbu' });
  const all = st.p[0].hand.concat(st.p[1].hand, st.deck, st.discard);
  const cnt = id => all.filter(c => c === id).length;
  ok(all.length === 75, '整副牌 75 张（实际 ' + all.length + '）');
  ok(Object.keys(SG.EQUIPS).length === 6, '装备共 6 种');
  ok(cnt('qinggang') === 2 && cnt('qinglong') === 2 && cnt('guding') === 1,
     '武器：青釭 2 / 青龙 2 / 古锭 1');
  ok(cnt('bagua') === 2 && cnt('shizi') === 1 && cnt('huxin') === 1,
     '防具：八卦 2 / 白银狮子 1 / 护心镜 1');
  ok(SG.EQUIPS.bagua.slot === 'armor' && SG.EQUIPS.qinggang.slot === 'weapon',
     '槽位定义正确');
}

/* ===== 2. 装备进出装备区 ===== */
{
  const st = scene('boy', 'zhangfei', { h0: ['bagua', 'slash'] });
  ok(SG.legal(st).equip === true, '手里有装备牌时 legal.equip 为真');
  SG.apply(st, { t: 'equip', idx: 0 });
  ok(st.p[0].equip.armor === 'bagua', '八卦阵进了防具位');
  ok(st.p[0].hand.length === 1, '装备牌已从手牌移出');
  ok(st.discard.indexOf('bagua') < 0, '装上的牌不重复进弃牌堆（牌数守恒）');

  /* 同槽位替换：旧装备进弃牌堆 */
  st.p[0].hand = ['shizi'];
  SG.apply(st, { t: 'equip', idx: 0 });
  ok(st.p[0].equip.armor === 'shizi', '新防具顶替旧防具');
  ok(st.discard.filter(c => c === 'bagua').length === 1, '被替换的八卦阵进了弃牌堆');
  ok(st.p[0].equip.weapon === null, '换上防具不影响武器位');
}

/* ===== 3. 装备不占手牌上限 ===== */
{
  const st = scene('boy', 'zhangfei', { h0: ['bagua', 'slash'], a0: 'bagua' });
  st.p[0].hand = ['slash', 'slash', 'slash', 'slash'];
  const before = SG.maxHand(st, 0);
  st.p[0].equip = { weapon: 'qinggang', armor: 'shizi' };
  ok(SG.maxHand(st, 0) === before, '装备不影响手牌上限');
}

/* ===== 4. 八卦阵：判红当作闪，且不扣手牌 ===== */
{
  const st = scene('boy', 'zhangfei', { h0: ['slash'], h1: [], a1: 'bagua' });
  SG.apply(st, { t: 'slash' });
  ok(st.awaiting && st.awaiting.type === 'dodge', '出杀后进入响应闪');
  ok(st.awaiting.canDodge === false, '对方没闪，canDodge 为假');
  ok(st.awaiting.canBagua === true, '有八卦阵时 canBagua 为真');

  fixJudge(st, 0.3);                       /* ★ 红色 */
  SG.apply(st, { t: 'bagua' });
  ok(st.p[1].hp === st.p[1].maxHp, '八阵判红：视为出闪，没有掉血');
  ok(st.p[1].hand.length === 0, '八卦阵的闪不消耗手牌');
  ok(st.awaiting === null || st.awaiting.type !== 'dodge', '响应结束');
}

/* ===== 5. 八卦阵：判黑作废，还能改出真闪 ===== */
{
  const st = scene('boy', 'zhangfei', { h0: ['slash'], h1: ['dodge'], a1: 'bagua' });
  SG.apply(st, { t: 'slash' });
  fixJudge(st, 0.05);                      /* ★ 黑色 */
  SG.apply(st, { t: 'bagua' });
  ok(st.p[1].hp === st.p[1].maxHp, '判黑时还没掉血');
  ok(st.awaiting && st.awaiting.type === 'dodge', '判黑后重新询问是否出闪');
  ok(st.awaiting.canBagua === false, '同一张杀不能重复判定');
  ok(st.awaiting.canDodge === true, '判黑后仍可以出真闪');

  SG.apply(st, { t: 'dodge', use: true });
  ok(st.p[1].hp === st.p[1].maxHp, '改出真闪成功挡住');
  ok(st.p[1].hand.length === 0, '真闪消耗了手牌');

  /* 判黑且手里没闪 → 硬吃 */
  const st2 = scene('boy', 'zhangfei', { h0: ['slash'], h1: [], a1: 'bagua' });
  SG.apply(st2, { t: 'slash' });
  fixJudge(st2, 0.05);
  SG.apply(st2, { t: 'bagua' });
  SG.apply(st2, { t: 'dodge', use: false });
  ok(st2.p[1].hp === st2.p[1].maxHp - 1, '判黑又没闪，照常掉 1 点');
}

/* ===== 6. 青釭剑：无视八卦阵 / 白银狮子 ===== */
{
  const st = scene('boy', 'zhangfei', { h0: ['slash'], h1: [], a1: 'bagua', w0: 'qinggang' });
  SG.apply(st, { t: 'slash' });
  ok(st.awaiting.canBagua === false, '青釭剑在手，八卦阵用不出来');

  const st2 = scene('machao', 'zhangfei', { h0: ['slash'], h1: [], a1: 'shizi', w0: 'qinggang' });
  SG.apply(st2, { t: 'slash' });
  SG.apply(st2, { t: 'dodge', use: false });
  ok(st2.p[1].hp === st2.p[1].maxHp - 2, '青釭剑破白银狮子，铁骑 2 点打满');
}

/* ===== 7. 白银狮子：只卸杀的力道，技能直伤照打 ===== */
{
  const st = scene('machao', 'zhangfei', { h0: ['slash'], h1: [], a1: 'shizi' });
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.p[1].hp === st.p[1].maxHp - 1, '铁骑本应 2 点，被白银狮子压成 1 点');

  const st2 = scene('zhouyu', 'zhangfei', { h0: ['slash', 'slash', 'slash'], a1: 'shizi' });
  SG.apply(st2, { t: 'yehuo' });
  ok(st2.p[1].hp === st2.p[1].maxHp - 2, '业火是技能直伤，白银狮子挡不住');
}

/* ===== 8. 古锭刀：对方空手伤害 +2 ===== */
{
  const st = scene('boy', 'zhangfei', { h0: ['slash'], h1: [], w0: 'guding' });
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.p[1].hp === st.p[1].maxHp - 3, '空手吃古锭刀 3 点（实际掉 ' + (st.p[1].maxHp - st.p[1].hp) + '）');

  /* 对方有手牌就没有加成 */
  const st2 = scene('boy', 'zhangfei', { h0: ['slash'], h1: ['peach'], w0: 'guding' });
  SG.apply(st2, { t: 'slash' });
  SG.apply(st2, { t: 'dodge', use: false });
  ok(st2.p[1].hp === st2.p[1].maxHp - 1, '对方有牌时古锭刀不加伤');
}

/* ===== 9. 护心镜：濒死自动保命一次，之后碎掉 ===== */
{
  const st = scene('boy', 'zhangfei', { h0: ['slash'], h1: [], a1: 'huxin' });
  st.p[1].hp = 1;
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.p[1].hp === 1, '护心镜挡下致命一击，体力回到 1 点');
  ok(st.p[1].equip.armor === null, '护心镜已碎（装备位清空）');
  ok(st.discard.indexOf('huxin') >= 0, '碎掉的护心镜进弃牌堆');
  ok(st.over === false, '没有判负，能继续打');

  /* 第二次就不灵了 */
  st.turn = 0; st.phase = 'play'; st.awaiting = null; st.slashUsed = 0;
  st.p[0].hand = ['slash'];
  st.p[1].hand = [];
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.p[1].hp === 0 && (st.over || st.awaiting.type === 'dying'), '护心镜只保一次命');
}

/* ===== 10. 青龙偃月刀：被闪开后追砍一刀，每回合一次 ===== */
{
  const st = scene('boy', 'zhangfei', { h0: ['slash', 'slash', 'slash'], h1: ['dodge'], w0: 'qinglong' });
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: true });
  ok(st.awaiting && st.awaiting.type === 'qinglong', '被闪开后弹出追砍询问');

  SG.apply(st, { t: 'qinglong', use: true });
  ok(st.p[0].used.qinglong === true, '追砍已标记（本回合限一次）');
  ok(st.p[0].hand.length === 1, '追砍消耗了第二张杀');
  ok(st.slashUsed === 1, '追砍不计入本回合出刀次数');
  ok(st.awaiting && st.awaiting.type === 'dodge', '追砍这一刀要对方再响应一次');
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.p[1].hp === st.p[1].maxHp - 1, '追砍这一刀打中了');

  /* 再被闪一次也不再追砍 */
  st.turn = 0; st.phase = 'play'; st.awaiting = null; st.slashUsed = 0;
  st.p[0].hand = ['slash', 'slash'];
  st.p[1].hand = ['dodge'];
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: true });
  ok(!st.awaiting || st.awaiting.type !== 'qinglong', '同一回合不会二次追砍');
}

/* ===== 11. AI 会主动装备 ===== */
{
  const st = SG.newGame({ seed: 5, p0: 'boy', p1: 'zhangfei', aiLevel: 1 });
  st.deck = [];
  st.turn = 1; st.phase = 'play'; st.awaiting = null; st.slashUsed = 0;
  st.p[1].hand = ['bagua', 'slash'];
  st.p[1].equip = { weapon: null, armor: null };
  const mv = SG.aiStep(st);
  ok(mv && mv.t === 'equip' && mv.idx === 0, 'AI 空槽时会先装八卦阵（实际 ' + (mv && mv.t) + '）');

  SG.apply(st, mv);
  ok(st.p[1].equip.armor === 'bagua', 'AI 的八卦阵已上身');
}

/* ===== 12. 一整局 AI 对局里牌数守恒（含装备区） ===== */
{
  let bad = 0, equipped = 0;
  for (let g = 0; g < 30; g++) {
    const st = SG.newGame({ seed: 1000 + g, p0: 'boy', p1: 'lvbu' });
    let n = 0;
    while (!st.over && n < 800) {
      const eqn = ['weapon', 'armor'].reduce((k, slot) =>
        k + (st.p[0].equip[slot] ? 1 : 0) + (st.p[1].equip[slot] ? 1 : 0), 0);
      const all = st.deck.length + st.discard.length + st.p[0].hand.length + st.p[1].hand.length + eqn;
      if (all !== 75) bad++;
      const mv = SG.aiStep(st);
      if (!mv) break;
      SG.apply(st, mv);
      n++;
    }
    if (st.p[0].equip.weapon || st.p[0].equip.armor ||
        st.p[1].equip.weapon || st.p[1].equip.armor) equipped++;
  }
  ok(bad === 0, '30 局全程牌数守恒（异常 ' + bad + ' 次）');
  ok(equipped > 15, '30 局里多数对局都出现了装备（' + equipped + ' 局）');
}

console.log('\n' + (fail === 0 ? '全部通过（' + pass + ' 项）' : '失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
