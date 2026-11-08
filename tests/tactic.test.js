/* 战术牌：酒 / 决斗 / 过河拆桥 / 顺手牵羊 —— 牌堆配比、特效、濒死当桃、AI 决策 */
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

/* 造一个"干净的出牌阶段"：断掉摸牌，指定双方手牌与装备 */
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
  st.jiuBoost = 0;
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
/* 牌数守恒：手牌 + 牌堆 + 弃牌堆 + 双方装备区 */
function eqN(pl){ const e = pl.equip || {}; return (e.weapon ? 1 : 0) + (e.armor ? 1 : 0); }
function total(st){
  return st.deck.length + st.discard.length + st.p[0].hand.length + st.p[1].hand.length +
         eqN(st.p[0]) + eqN(st.p[1]);
}

/* ===== 1. 牌堆配比 ===== */
{
  const st = SG.newGame({ seed: 1, p0: 'boy', p1: 'lvbu' });
  const all = st.p[0].hand.concat(st.p[1].hand, st.deck, st.discard);
  const cnt = id => all.filter(c => c === id).length;
  ok(all.length === 75, '整副牌 75 张（实际 ' + all.length + '）');
  ok(cnt('jiu') === 3 && cnt('juedou') === 3 && cnt('guohe') === 3 && cnt('shunshou') === 2,
     '战术牌：酒 3 / 决斗 3 / 拆桥 3 / 顺手 2');
}

/* ===== 2. 酒 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['jiu', 'slash', 'slash'], h1: [] });
  ok(SG.legal(st).jiu === true, '手里有酒时 legal.jiu 为真');
  SG.apply(st, { t: 'jiu' });
  ok(st.jiuBoost === 1 && st.p[0].used.jiu === true, '喝酒后酒劲 +1，本回合标记已喝');
  ok(SG.legal(st).jiu === false, '喝过一碗就不能再喝');
  const hp0 = st.p[1].hp;
  SG.apply(st, { t: 'slash' });               /* 吕布无闪硬吃：1 + 酒 1 = 2 点 */
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.p[1].hp === hp0 - 2, '酒劲让这一刀打到 2 点（' + (hp0 - st.p[1].hp) + '）');
  ok(st.jiuBoost === 0, '酒劲已用掉');
  SG.apply(st, { t: 'slash' });               /* 第二刀无加成 */
  SG.apply(st, { t: 'dodge', use: false });
  ok(hp0 - st.p[1].hp === 3, '第二刀回归 1 点伤害');
}
{
  /* 酒杀被闪掉：酒劲不保留，下一刀没有加成 */
  const st = scene('boy', 'lvbu', { h0: ['jiu', 'slash', 'slash'], h1: ['dodge'] });
  SG.apply(st, { t: 'jiu' });
  SG.apply(st, { t: 'slash' });
  ok(st.awaiting && st.awaiting.type === 'dodge', '酒杀进入对方响应');
  SG.apply(st, { t: 'dodge', use: true });
  ok(st.jiuBoost === 0, '被闪掉后酒劲也没了（跟着那一刀走）');
  const hp0 = st.p[1].hp;
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });
  ok(hp0 - st.p[1].hp === 1, '下一刀只是普通杀');
}
{
  /* 换回合后酒劲清零 */
  const st = scene('zhangfei', 'lvbu', { h0: ['jiu'] });
  SG.apply(st, { t: 'jiu' });
  ok(st.jiuBoost === 1, '喝酒待用');
  st.p[0].hand = [];
  SG.apply(st, { t: 'end' });                 /* 无超额手牌，直接换人 */
  ok(st.jiuBoost === 0 && st.turn === 1, '换人后酒劲清零');
}
{
  /* 濒死时酒当桃自救 */
  const st = scene('boy', 'lvbu', { h0: ['jiu', 'slash', 'slash'], h1: ['jiu'] });
  st.p[1].hp = 2;                             /* 酒刀 2 + 普刀 1 = 3 点，正好打穿 */
  SG.apply(st, { t: 'jiu' });
  SG.apply(st, { t: 'slash' });               /* 2 点 */
  SG.apply(st, { t: 'dodge', use: false });
  SG.apply(st, { t: 'slash' });               /* 再 2 点 → 吕布 4-4=0 濒死 */
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.awaiting && st.awaiting.type === 'dying' && st.p[1].dying === true, '吕布被打濒死');
  SG.apply(st, { t: 'dying', use: true });    /* 吕布手里那张酒当桃用 */
  ok(st.p[1].hp === 1 && st.p[1].dying === false, '吕布用【酒】续命回到 1 点');
  ok(st.p[1].hand.length === 0 && st.discard.indexOf('jiu') >= 0, '酒进了弃牌堆');
}
{
  /* 自己没救牌时，对手的酒也能救人 */
  const st = scene('boy', 'lvbu', { h0: ['jiu', 'slash', 'slash', 'jiu'], h1: [] });
  st.p[1].hand = [];
  st.p[1].hp = 2;
  SG.apply(st, { t: 'jiu' });
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });   /* 吕布空手濒死 */
  ok(st.awaiting && st.awaiting.type === 'dying', '吕布濒死且自己没牌');
  const mine = st.p[0].hand.length;
  SG.apply(st, { t: 'dying', use: false });   /* 吕布放弃自救 */
  ok(st.awaiting && st.awaiting.type === 'save' && st.awaiting.p === 0, '轮到小将军决定救不救');
  SG.apply(st, { t: 'save', use: true });     /* 小将军用酒救人 */
  ok(st.p[1].hp === 1, '小将军的【酒】救回吕布');
  ok(st.p[0].hand.length === mine - 1, '小将军少了一张牌');
}

/* ===== 3. 决斗 ===== */
{
  /* 对方没杀：直接掉 1 血，斗志（受伤摸2）能触发 → 伤害来源判定正确 */
  const st = scene('lvbu', 'gushan', { h0: ['juedou'], h1: ['dodge', 'peach'] });
  st.deck = ['slash'];                        /* 关山【斗志】要摸 1，给牌堆备着 */
  SG.apply(st, { t: 'juedou' });
  ok(st.awaiting && st.awaiting.type === 'duel' && st.awaiting.p === 1, '决斗先请对方出杀');
  SG.apply(st, { t: 'duel', use: false });    /* 关山没杀（闪和桃不算杀） */
  ok(st.p[1].hp === st.p[1].maxHp - 1, '关山接不上，掉 1 血');
  ok(st.p[1].hand.length === 3, '【斗志】因决斗伤害摸 1（2+1=3）');
  ok(!st.awaiting && st.phase === 'play', '决斗结算完回到出牌阶段');
}
{
  /* 轮流接杀：对方接 → 回到发起方 → 发起方没杀认输掉血 */
  const st = scene('lvbu', 'zhangfei', { h0: ['juedou'], h1: ['slash', 'slash'] });
  SG.apply(st, { t: 'juedou' });
  SG.apply(st, { t: 'duel', use: true });
  ok(st.awaiting && st.awaiting.p === 0 && st.awaiting.type === 'duel', '张飞出杀接住，轮回吕布');
  ok(st.p[1].hand.length === 1, '张飞打出一张杀');
  SG.apply(st, { t: 'duel', use: false });    /* 吕布手里没杀 */
  ok(st.p[0].hp === st.p[0].maxHp - 1, '吕布认输掉 1 血');
}
{
  /* 龙胆：赵云把闪当杀接 */
  const st = scene('lvbu', 'zhaoyun', { h0: ['juedou'], h1: ['dodge'] });
  SG.apply(st, { t: 'juedou' });
  SG.apply(st, { t: 'duel', use: true });
  ok(st.log.some(l => l.t.indexOf('龙胆') >= 0), '赵云发动【龙胆】把闪当杀接住');
  ok(st.awaiting && st.awaiting.p === 0, '赵云接住，轮回吕布');
}
{
  /* 决斗全程牌数守恒 */
  const st = scene('lvbu', 'zhangfei', { h0: ['juedou', 'slash'], h1: ['slash', 'slash'] });
  const t0 = total(st);
  SG.apply(st, { t: 'juedou' });
  SG.apply(st, { t: 'duel', use: true });
  SG.apply(st, { t: 'duel', use: true });
  ok(total(st) === t0, '决斗三轮牌数守恒（' + total(st) + '/' + t0 + '）');
}

/* ===== 4. 过河拆桥 ===== */
{
  const st = scene('boy', 'lvbu', { h0: ['guohe'], h1: ['slash', 'dodge'], w1: 'qinglong' });
  ok(SG.legal(st).guohe === true, '对方有牌可拆时 legal.guohe 为真');
  const none = scene('boy', 'lvbu', { h0: ['guohe'], h1: [] });
  ok(SG.legal(none).guohe === false, '对方没手牌没装备时拆不了');
  SG.apply(st, { t: 'guohe' });
  ok(st.awaiting && st.awaiting.type === 'guohe' && st.awaiting.t === 1, '打出后进入选牌状态');
  SG.apply(st, { t: 'guohe', slot: 'weapon' });
  ok(st.p[1].equip.weapon === null, '对方的青龙偃月刀被拆');
  ok(st.discard.indexOf('qinglong') >= 0, '拆掉的装备进弃牌堆');
  ok(st.p[1].hand.length === 2, '手牌不受影响');
}
{
  const st = scene('boy', 'lvbu', { h0: ['guohe'], h1: ['slash', 'dodge'] });
  const t0 = total(st);
  SG.apply(st, { t: 'guohe' });
  SG.apply(st, { t: 'guohe', slot: 'hand' });
  ok(st.p[1].hand.length === 1 && st.discard.length >= 1, '随机拆掉一张手牌');
  ok(total(st) === t0, '拆桥牌数守恒');
}

/* ===== 5. 顺手牵羊 ===== */
{
  /* 抢装备直接换上，自己的旧武器进弃牌堆 */
  const st = scene('boy', 'lvbu', { h0: ['shunshou'], h1: [], w0: 'guding', w1: 'qinglong' });
  SG.apply(st, { t: 'shunshou' });
  ok(st.awaiting && st.awaiting.type === 'shunshou', '打出后进入选牌状态');
  SG.apply(st, { t: 'shunshou', slot: 'weapon' });
  ok(st.p[0].equip.weapon === 'qinglong', '抢来的青龙偃月刀直接换上');
  ok(st.discard.indexOf('guding') >= 0, '自己的古锭刀被替换进弃牌堆');
  ok(st.p[1].equip.weapon === null, '对方武器没了');
  ok(SG.legal(st).shunshou === false || st.p[1].hand.length + eqN(st.p[1]) === 0,
     '对方没牌后不能再顺手');
}
{
  /* 抢手牌：对方少一张我多一张，守恒 */
  const st = scene('boy', 'lvbu', { h0: ['shunshou'], h1: ['slash', 'dodge', 'peach'] });
  const t0 = total(st);
  SG.apply(st, { t: 'shunshou' });
  SG.apply(st, { t: 'shunshou', slot: 'hand' });
  ok(st.p[1].hand.length === 2 && st.p[0].hand.length === 1, '手牌 3→2，自己 0→1');
  ok(total(st) === t0, '顺手牵羊牌数守恒');
}

/* ===== 6. AI ===== */
{
  /* 对方有装备时 AI 优先拆/抢 */
  const st = scene('lvbu', 'lvbu', { h0: ['guohe', 'slash'], h1: [], a1: 'bagua' });
  const mv = SG.aiStep(st);
  ok(mv.t === 'guohe', 'AI 有拆桥且对方有八卦阵 → 拆（实际 ' + mv.t + '）');
  const st2 = scene('lvbu', 'lvbu', { h0: ['shunshou', 'guohe'], h1: [], w1: 'qinggang' });
  const mv2 = SG.aiStep(st2);
  ok(mv2.t === 'shunshou', 'AI 同时有抢和拆 → 先抢（实际 ' + mv2.t + '）');
}
{
  /* 决斗响应：有杀就接；高手会数杀 */
  const st = scene('zhangfei', 'lvbu', { h0: ['slash'], h1: [] });
  st.awaiting = { p: 0, type: 'duel', foe: 1 };
  ok(SG.aiStep(st).t === 'duel' && SG.aiStep(st).use === true, 'AI 被决斗时有杀就接');
  const st2 = scene('lvbu', 'lvbu', { h0: [], h1: [] });
  st2.aiLevel = 2;
  st2.awaiting = { p: 0, type: 'duel', foe: 1 };
  ok(SG.aiStep(st2).use === false, '高手档没杀就认输（不掉更多血）');
}
{
  /* AI 抢装备优先补自己的空槽位（高手档） */
  const st = scene('lvbu', 'lvbu', { h0: [], h1: [], w1: 'qinggang', a1: 'bagua' });
  st.aiLevel = 2;
  st.awaiting = { p: 0, type: 'shunshou', t: 1 };
  const mv = SG.aiStep(st);
  ok(mv.slot === 'weapon' || mv.slot === 'armor', '高手抢一件装备补空槽（实际 ' + mv.slot + '）');
}

console.log(fail ? '\n失败 ' + fail + ' 项' : '\n全部通过（' + pass + ' 项）');
process.exit(fail ? 1 : 0);
