/* 双将模式：组合属性、技能叠加生效、转换牌优先级、AI 全自动对局稳定性 */
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

/* 造一个"干净的出牌阶段"（与 equip.test.js 同手法），支持双将入参。
   牌堆放 10 张无中生有做填充：义释/涯角等"弃完立刻摸"的技能
   才不会把刚弃的牌从空弃牌堆里洗回来（那是真规则，不是 bug）。 */
function scene(a, b, opts) {
  opts = opts || {};
  const st = SG.newGame({ seed: opts.seed || 7, p0: a, p1: b });
  st.deck = opts.emptyDeck ? [] : ['wzsy','wzsy','wzsy','wzsy','wzsy','wzsy','wzsy','wzsy','wzsy','wzsy'];
  st.discard = [];
  st.turn = 0; st.round = 1; st.phase = 'play'; st.awaiting = null;
  st.slashUsed = 0; st.slashBonus = 0; st.nuActive = false; st.jiuBoost = 0;
  st.p[0].hand = (opts.h0 || []).slice();
  st.p[1].hand = (opts.h1 || []).slice();
  st.p[0].equip = { weapon: (opts.w0 || null), armor: (opts.a0 || null) };
  st.p[1].equip = { weapon: (opts.w1 || null), armor: (opts.a1 || null) };
  st.p[0].hp = st.p[0].maxHp; st.p[1].hp = st.p[1].maxHp;
  st.p[0].used = {}; st.p[1].used = {};
  return st;
}

/* ===== 1. 组合属性 ===== */
{
  const st = SG.newGame({ seed: 1, p0: ['zhaoyun', 'machao'], p1: ['gushan', 'lvbu'] });
  const h0 = st.p[0].hero, h1 = st.p[1].hero;
  ok(h0.dual === true && h0.name === '赵云·马超', '双将名 = 主·副（' + h0.name + '）');
  ok(h0.hp === 4 && st.p[0].maxHp === 4, '赵云4+马超4 → 体力 4（均值上取整）');
  ok(h1.hp === 5, '关山5+吕布4 → 体力 5（4.5 上取整）');
  ok(h0.power === 18, '战力 = 两者之和（8+10=18，实际 ' + h0.power + '）');
  ok(h0.slashLimit === 2, '出杀上限取较大值（赵云2/马超1 → 2）');
  const names = h0.skills.map(s => s.name).join('/');
  ok(names === '龙胆/涯角/铁骑/西凉', '两套技能全部合并（' + names + '）');
  ok(SG.has(st.p[0], 'longdan') && SG.has(st.p[0], 'tieji'), 'has() 对两位武将的技能都生效');
  ok(st.p[1].hero.id2 === 'lvbu', 'id2 记住副将');
  /* 弱弱组合下限：两员 3 血将 → 3 */
  const st2 = SG.newGame({ seed: 1, p0: ['qingluan', 'baiyu'], p1: 'lvbu' });
  ok(st2.p[0].hp === 3, '双 3 血 → 体力 3');
  /* 单将入参不受影响 */
  const st3 = SG.newGame({ seed: 1, p0: 'zhaoyun', p1: 'machao' });
  ok(st3.p[0].hero.dual !== true && st3.p[0].hero.hp === 4 && st3.p[0].hero.power === 8,
     '字符串入参仍是单将（联机壳零影响）');
}

/* ===== 2. 出杀上限：取最大值（张飞2 + 神姜维3 → 3） ===== */
{
  const st = scene(['zhangfei', 'jiangwei'], 'lvbu', { h0: ['slash', 'slash', 'slash'] });
  ok(SG.legal(st).slash === true, '双将可出杀');
  SG.apply(st, { t: 'slash' }); SG.apply(st, { t: 'dodge', use: false });
  SG.apply(st, { t: 'slash' }); SG.apply(st, { t: 'dodge', use: false });
  ok(SG.legal(st).slash === true, '第 2 刀后仍可出（上限 3）');
  SG.apply(st, { t: 'slash' }); SG.apply(st, { t: 'dodge', use: false });
  ok(SG.legal(st).slash === false, '第 3 刀后到达上限');
}

/* ===== 3. 龙胆 + 勇烈：转换牌优先级 真杀 > 闪当杀 > 桃当杀 ===== */
{
  const duo = ['zhaoyun', 'weiyan'];
  const s1 = scene(duo, 'lvbu', { h0: ['dodge'], h1: [] });
  SG.apply(s1, { t: 'slash' });
  ok(s1.p[0].hand.indexOf('dodge') < 0, '手里只有闪 → 龙胆把闪当杀（闪已消耗）');
  ok(s1.awaiting && s1.awaiting.type === 'dodge', '杀已掷出，进入对方响应');
  ok(s1.log.some(l => l.t.indexOf('龙胆') >= 0), '日志记录了【龙胆】转换');
  const s2 = scene(duo, 'lvbu', { h0: ['peach'], h1: [] });
  SG.apply(s2, { t: 'slash' });
  ok(s2.p[0].hand.indexOf('peach') < 0, '手里只有桃 → 勇烈把桃当杀');
  ok(s2.log.some(l => l.t.indexOf('勇烈') >= 0), '日志记录了【勇烈】转换');
  const s3 = scene(duo, 'lvbu', { h0: ['slash', 'dodge', 'peach'], h1: [] });
  SG.apply(s3, { t: 'slash' });
  ok(s3.p[0].hand.indexOf('slash') < 0 && s3.p[0].hand.indexOf('dodge') >= 0,
     '有真杀先出真杀，闪桃保留');
}

/* ===== 4. 义释 + 锐气：关羽吃桃不限次 + 小将军弃 1 摸 2 同场生效 ===== */
{
  const st = scene(['guanyu', 'boy'], 'lvbu', { h0: ['peach', 'peach'] });
  st.p[0].hp = 2; st.p[0].used = {};
  ok(SG.legal(st).peach === true, '受伤时可吃桃');
  SG.apply(st, { t: 'peach' });
  ok(st.p[0].hp === 3, '第一颗桃回 1 血（2→3）');
  ok(st.p[0].hand.filter(c => c === 'peach').length === 1 && st.p[0].hand.length === 2,
     '义释吃桃后再摸 1（剩 1 桃 + 1 张新摸的）');
  ok(SG.legal(st).peach === true, '义释：第一颗桃后还能继续吃');
  SG.apply(st, { t: 'peach' });
  ok(st.p[0].hp === 4 && st.p[0].hand.filter(c => c === 'peach').length === 0,
     '第二颗桃也生效（不限次，桃全部用完）');
  const st2 = scene(['guanyu', 'boy'], 'lvbu', { h0: ['slash', 'dodge'] });
  SG.apply(st2, { t: 'ruiqi', idx: 1 });
  ok(st2.p[0].hand.length === 3, '锐气：2 张弃 1 摸 2 → 3 张（净 +1）');
}

/* ===== 5. 触发技叠加：铁骑（杀伤害+1）与穿杨（命中摸牌）同场 ===== */
{
  const st = scene(['machao', 'qingluan'], 'lvbu', { h0: ['slash'], h1: [] });
  const before = st.p[0].hand.length;
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.p[1].hp === 2, '铁骑：双将的杀伤害 +1（4→2 血）');
  ok(st.p[0].hand.length === before, '穿杨：命中后摸 1（弃杀 -1 + 摸 1 = 持平）');
}

/* ===== 6. 每局一次技能不因双将重复：继志只救一次 ===== */
{
  /* 吕布砍双将（无双：硬吃 2 点），双将 1 血 → 濒死 → 继志撑回 1 */
  const st = scene(['jiangwei', 'weiyan'], 'lvbu', { h0: [], h1: ['slash', 'slash'], emptyDeck: true });
  st.turn = 1; st.slashUsed = 0;
  st.p[0].hp = 1; st.p[1].hp = 2;
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });        /* 硬吃：1 + 无双1 = 2 伤，双将濒死 */
  ok(st.p[0].hp === 1 && st.p[0].used.jizhi === true, '继志发动，回到 1 血');
  /* 第二刀：继志每局一次，这次真死（双方都没桃） */
  st.awaiting = null; st.phase = 'play'; st.turn = 1; st.slashUsed = 0;
  SG.apply(st, { t: 'slash' });
  SG.apply(st, { t: 'dodge', use: false });
  ok(st.awaiting && st.awaiting.type === 'dying', '继志已用过，这次进入濒死求桃');
  SG.apply(st, { t: 'dying', use: false });
  ok(st.over === true && st.winner === 1, '无人施救，吕布获胜');
}

/* ===== 7. AI 全自动：双将对双将，多种子多组合跑满不抛异常 ===== */
{
  const pairs = [
    [['zhaoyun', 'machao'], ['guanyu', 'dengai']],
    [['baiyu', 'qingluan'], ['gushan', 'zhangfei']],
    [['jiangwei', 'weiyan'], ['zhouyu', 'diaochan']],
    [['zhugeliang', 'guanyu'], ['lvbu', 'machao']],
    [['diaochan', 'qingluan'], ['dengai', 'zhaoyun']]
  ];
  let games = 0, errs = 0, steps = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let s = 0; s < 8; s++) {
      const st = SG.newGame({
        seed: 1000 + s * 7919 + i * 104729,
        p0: pairs[i][0], p1: pairs[i][1], aiLevel: (s % 3)
      });
      let n = 0;
      while (!st.over && n++ < 4000) SG.apply(st, SG.aiStep(st));
      if (!st.over) errs++;
      games++; steps += n;
    }
  }
  ok(errs === 0, games + ' 局双将 AI 对局全部正常收尾');
  ok(games === 40, '覆盖 5 组组合 × 8 种子 × 3 档 AI');
}

/* ===== 8. 牌数守恒：一局双将对局后 牌不凭空多出来 ===== */
{
  const st = SG.newGame({ seed: 77, p0: ['guanyu', 'zhangfei'], p1: ['machao', 'dengai'], aiLevel: 2 });
  let n = 0;
  while (!st.over && n++ < 4000) SG.apply(st, SG.aiStep(st));
  const total = st.deck.length + st.discard.length +
    st.p[0].hand.length + st.p[1].hand.length +
    (st.p[0].equip.weapon ? 1 : 0) + (st.p[0].equip.armor ? 1 : 0) +
    (st.p[1].equip.weapon ? 1 : 0) + (st.p[1].equip.armor ? 1 : 0);
  ok(total === 80, '整局结束牌数守恒（' + total + '/80）');
}

/* ===== 9. 双将 UI 冒烟：DOM 桩加载界面层，开关→选将→开局→整局渲染不抛异常 ===== */
{
  const scripts = html.match(/<script(?: id="engine")?>([\s\S]*?)<\/script>/g)
    .map(s => s.replace(/^<script(?: id="engine")?>/, '').replace(/<\/script>$/, ''));
  function makeEl() {
    return { innerHTML: '', textContent: '', className: '', scrollTop: 0, scrollHeight: 0,
      offsetWidth: 1, style: {}, classList: { add() {}, remove() {} }, disabled: false, value: '' };
  }
  const store = {};
  const sb2 = {
    console, module: { exports: {} },
    document: { getElementById: id => (store[id] = store[id] || makeEl()), addEventListener() {} },
    window: { AudioContext: function () { throw new Error('no audio in test'); } },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Math, Date, JSON
  };
  sb2.globalThis = sb2;
  vm.createContext(sb2);
  vm.runInContext(scripts[0], sb2, { filename: 'engine.js' });
  vm.runInContext(scripts[1], sb2, { filename: 'ui.js' });

  /* 开关与选将交互 */
  sb2.setDual();
  ok(sb2.dualMode === true && store.btnDual.textContent.indexOf('开') >= 0, '双将开关打开，文案更新');
  ok(store.pickTip.textContent.indexOf('主将') >= 0 || store.pickTip.innerHTML.indexOf('主将') >= 0,
    '选将提示切换成双将说明');
  ok(store.foeLbl.textContent === '对手主将：', '对手下拉标签切换成"对手主将"');
  /* 开双将时当前武将（boy）先当主将——把它取消掉，从零开始验证选将逻辑 */
  ok(sb2.myDuo.length === 1 && sb2.myDuo[0] === 'boy', '开双将时当前武将自动成为主将');
  sb2.pick('boy');
  ok(sb2.myDuo.length === 0 && store.btnStart.disabled === true, '清空后开始按钮禁用');
  sb2.pick('zhaoyun'); sb2.pick('machao');
  ok(sb2.myDuo.length === 2 && sb2.myDuo[0] === 'zhaoyun', '先点的是主将');
  ok(store.btnStart.disabled === false, '选满两位后可以开战');
  sb2.pick('lvbu');
  ok(sb2.myDuo[1] === 'lvbu' && sb2.myDuo[0] === 'zhaoyun', '已满两位再点 → 顶替副将');
  sb2.pick('zhaoyun');
  ok(sb2.myDuo.length === 1 && sb2.myDuo[0] === 'lvbu', '点主将取消 → 副将升主将');
  ok(store.btnStart.disabled === true, '只剩一位时开始按钮禁用');
  sb2.pick('machao');
  /* 下拉里不能出现自己选的两位 */
  ok(store.foeSel.innerHTML.indexOf('value="lvbu"') < 0 &&
     store.foeSel.innerHTML.indexOf('value="machao"') < 0, '对手下拉排除了自己的双将');
  /* 选将不足时开战被拦下（点 machao 取消副将，只剩主将 lvbu） */
  sb2.pick('machao');
  const Gbefore = sb2.G;
  sb2.startGame();
  ok(sb2.G === Gbefore, '只选一位时点开始不会开局');
  sb2.pick('machao');
  /* 正常开局：双方都是双将 */
  sb2.startGame();
  ok(sb2.G && sb2.G.p[0].hero.dual === true && sb2.G.p[0].hero.id === 'lvbu' &&
     sb2.G.p[0].hero.id2 === 'machao', '开局：我方双将生效');
  ok(sb2.G.p[1].hero.dual === true, '开局：对手也是双将');
  /* 整局：人类随机走 + AI 走，每步走真实 render()，不抛异常 */
  function humanMove(st) {
    const a = st.awaiting;
    if (a) {
      if (a.type === 'yusuan') return { t: 'yusuan', use: true };
      if (a.type === 'trim') return { t: 'trim', idxs: [0] };
      if (a.type === 'jinglan') return { t: 'jinglan', use: true };
      if (a.type === 'dodge') return { t: 'dodge', use: !!a.canDodge };
      if (a.type === 'jinghong') return { t: 'jinghong', use: true };
      if (a.type === 'discard') return { t: 'discard', idxs: Array.from({ length: a.n }, (_, i) => i) };
      if (a.type === 'dying') return { t: 'dying', use: st.p[a.p].hand.indexOf('peach') >= 0 };
      if (a.type === 'save') return { t: 'save', use: false };
      if (a.type === 'wuxie') return { t: 'wuxie', use: false };
      if (a.type === 'nanman') return { t: 'nanman', use: st.p[a.p].hand.indexOf('slash') >= 0 };
      if (a.type === 'wanjian') return { t: 'wanjian', use: st.p[a.p].hand.indexOf('dodge') >= 0 };
      if (a.type === 'duel') return { t: 'duel', use: st.p[a.p].hand.indexOf('slash') >= 0 };
    }
    const L = SG.legal(st);
    if (L.slash) return { t: 'slash' };
    if (L.peach) return { t: 'peach' };
    if (L.wzsy) return { t: 'wzsy' };
    return { t: 'end' };
  }
  let steps = 0, uiErr = 0;
  try {
    while (!sb2.G.over && steps++ < 800) {
      const st = sb2.G;
      const mv = (SG.active(st) === 1) ? SG.aiStep(st) : humanMove(st);
      if (!mv) break;
      SG.apply(st, mv);
      sb2.render();
    }
  } catch (e) { uiErr = 1; console.log('  ✗ UI 渲染抛异常：' + e.message); }
  ok(uiErr === 0, '双将整局走真实 render() 无异常（' + steps + ' 步）');
  ok(store.sideBot.innerHTML.indexOf('face2') >= 0, '战场头像渲染成双将拼合版');
  ok(store.sideBot.innerHTML.indexOf('战力合') >= 0, '信息行显示双将合计战力');
  /* 关回单将：主将保留为当前武将 */
  sb2.setDual();
  ok(sb2.dualMode === false && sb2.myHero === 'lvbu', '关双将后主将保留为当前武将');
}

console.log('\n双将模式测试：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
