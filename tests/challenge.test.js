/* 过关斩将（连胜挑战）：UI 全流程 + 体力继承 + 三选一补给 + 存档成就 + 引擎对局稳定性
   手法与 ui-smoke / dual 一致：极简 DOM 桩直接加载 game.html 的两段真实脚本 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');
const scripts = html.match(/<script(?: id="engine")?>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/^<script(?: id="engine")?>/, '').replace(/<\/script>$/, ''));
if (scripts.length < 2) { console.error('未找到两段脚本'); process.exit(1); }

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}

function makeEl() {
  return {
    innerHTML: '', textContent: '', className: '', disabled: false,
    scrollTop: 0, scrollHeight: 0, offsetWidth: 1,
    style: {}, classList: { add() {}, remove() {} }
  };
}
/* localStorage 桩：挑战纪录、成就、常规战绩都走它，方便核对有没有串线 */
const LS = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
const store = {};
const sb = {
  console, module: { exports: {} }, localStorage: LS,
  document: { getElementById: id => (store[id] = store[id] || makeEl()), addEventListener() {} },
  window: { AudioContext: function () { throw new Error('no audio in test'); } },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  Math, Date, JSON
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(scripts[0], sb, { filename: 'engine.js' });
vm.runInContext(scripts[1], sb, { filename: 'ui.js' });
const SG = sb.SG;

/* 把当前局面直接改写成"我赢了"，再走真实 render() 结算 */
function simulateWin(hp) {
  sb.G.p[0].hp = hp;
  sb.G.winner = 0; sb.G.over = true; sb.G.overReason = '你 获胜！';
  sb.render();
}
function totalCards(st) {
  const eq = p => (st.p[p].equip.weapon ? 1 : 0) + (st.p[p].equip.armor ? 1 : 0);
  return st.deck.length + st.discard.length + st.p[0].hand.length + st.p[1].hand.length +
    eq(0) + eq(1);   /* 装上身的装备牌已离开手牌，也得算进总数 */
}

/* ===== 1. 规则面板与初始状态 ===== */
{
  ok(sb.CH_MAX === 5, '挑战共 5 关');
  ok(sb.ch === null, '初始不在挑战状态');
  ok(sb.ACHS.some(a => a.id === 'conqueror'), '成就表里有「过关斩将」');
  const r0 = sb.chLoad();
  ok(r0.best === 0 && r0.clears === 0, '首次进入：最高纪录 0 关、通关 0 次');
  sb.showChallenge();
  ok(store.chOv.className === 'ov on', '点按钮弹出规则面板');
  ok(store.chRec.innerHTML.indexOf('最高纪录') >= 0 && store.chStartBtn.disabled === false,
    '规则面板展示纪录，开始按钮可用');
  sb.closeChallenge();
  ok(store.chOv.className === 'ov', '可以关闭规则面板');
}

/* ===== 2. 开局：第一关对手受限、进度条、战绩隔离 ===== */
{
  sb.startChallenge();
  ok(sb.ch && sb.ch.stage === 1, '开始挑战：进入第 1 关');
  ok(sb.ch.hp === sb.G.p[0].maxHp && sb.G.p[0].hp === sb.G.p[0].maxHp,
    '第 1 关满血起手');
  ok(sb.G.p[1].hero.power <= 6, '第 1 关对手战力 ≤ 6（实际 ' + sb.G.p[1].hero.power + '）');
  ok(sb.G.p[1].hp === Math.max(1, sb.G.p[1].maxHp - 1),
    '车轮战：守关敌将带伤，起始体力 -1');
  ok(sb.ch.foes.length === 1 && sb.ch.hero === sb.myHero, '对手已登记且用当前选将出战');
  ok(sb.puzzleIdx === -1 && sb.mode === 'ai' && sb.recorded === true,
    '清掉闯关标记、强制人机、不写常规战绩');
  ok(store.deckInfo.innerHTML.indexOf('第 1/5 关') >= 0, '牌堆信息行显示挑战进度');
  ok(totalCards(sb.G) === 80, '第 1 关开局牌数守恒（' + totalCards(sb.G) + '/80）');
  ok(sb.loadStats().games === undefined, '开局没有污染常规战绩本');
}

/* ===== 3. 关卡胜利 → 三选一 → 🍑 休整（体力继承 + 回血封顶） ===== */
{
  simulateWin(2);
  ok(store.ov.className === 'ov on' && store.ovTitle.textContent.indexOf('第 1 关') >= 0,
    '弹出第 1 关胜利面板');
  ok(store.ovBtnsChallenge.style.display === '' && store.ovBtnsNormal.style.display === 'none',
    '显示挑战专属按钮，隐藏普通结算三键');
  ok(store.chBody.innerHTML.indexOf('pickSupply(\'rest\')') >= 0 &&
     store.chBody.innerHTML.indexOf('pickSupply(\'draw\')') >= 0 &&
     store.chBody.innerHTML.indexOf('pickSupply(\'reroll\')') >= 0,
    '三选一补给卡片齐全');
  ok(sb.ch.done === true && sb.ch.canSupply === true, '结算标记完成、允许补给');
  ok(sb.ch.hp === Math.min(sb.ch.maxHp, Math.max(2, 2)), '过关整备：2 血保持 2 点');
  ok(sb.chLoad().best === 1, '最高纪录更新为第 1 关');
  ok(sb.loadStats().games === undefined, '挑战胜利不计入常规胜场');
  const maxHp = sb.ch.maxHp;
  sb.pickSupply('rest');
  ok(sb.ch.stage === 2, '选完补给进入第 2 关');
  ok(sb.ch.hp === Math.min(maxHp, 4) && sb.G.p[0].hp === sb.ch.hp,
    '🍑 休整：2 血 +2（不超上限 ' + maxHp + '），并真实带进新局面');
  ok(sb.ch.supply === null && sb.ch.canSupply === false && sb.ch.done === false,
    '补给一次性消费，新关状态复位');
  ok(sb.G.p[1].hero.power <= 8, '第 2 关对手战力 ≤ 8');
  ok(store.deckInfo.innerHTML.indexOf('第 2/5 关') >= 0, '进度条推进到第 2 关');
  ok(totalCards(sb.G) === 80, '第 2 关开局牌数守恒');
}

/* ===== 4. 🃏 粮草：下一关起手多 2 张，且仍守恒 ===== */
{
  sb.startChallenge();
  simulateWin(1);
  ok(sb.ch.hp === Math.min(sb.ch.maxHp, 2), '1 血险胜也会自动整备到 2 点');
  sb.startChallenge();
  const base = SG.newGame({ seed: 1, p0: sb.ch.hero, p1: 'lvbu', aiLevel: 1 });
  const expected = base.p[0].hand.length + 2;
  simulateWin(3);
  sb.pickSupply('draw');
  ok(sb.G.p[0].hand.length === expected,
    '🃏 粮草：起手 ' + sb.G.p[0].hand.length + ' 张 = 常规 ' + base.p[0].hand.length + ' + 2');
  ok(totalCards(sb.G) === 80, '补给从牌堆摸牌，牌数仍守恒');
  /* 再赢一关且不选粮草，起手应回到常规张数 */
  simulateWin(3);
  sb.pickSupply('rest');
  ok(sb.G.p[0].hand.length === base.p[0].hand.length, '粮草只作用一关，不会永久叠加');
}

/* ===== 5. 🎲 择敌：重抽一次，对手登记不重复计入 ===== */
{
  sb.startChallenge();
  simulateWin(3);
  const usedBefore = sb.ch.foes.length;
  sb.pickSupply('reroll');
  ok(sb.ch.reroll === false && sb.ch.foes.length === usedBefore + 1,
    '🎲 择敌：重抽标记已消费，只登记 1 位新对手');
  ok(sb.ch.stage === 2, '择敌后正常进入第 2 关');
}

/* ===== 6. 五关通关：Boss 双将、纪录、成就、重复 render 不加次数 ===== */
{
  sb.startChallenge();
  for (let stage = 1; stage <= 5; stage++) {
    ok(sb.ch.stage === stage, '推进到第 ' + stage + ' 关');
    if (stage === 5) ok(sb.G.p[1].hero.dual === true, '第 5 关是双将 Boss（' + sb.G.p[1].hero.name + '）');
    simulateWin(3);
    if (stage < 5) sb.pickSupply('rest');
  }
  ok(store.ovTitle.textContent.indexOf('五关全胜') >= 0, '通关面板出现');
  ok(sb.ch.canSupply === false && store.chBtns.innerHTML.indexOf('再挑战一次') >= 0,
    '通关后不再给补给，提供重开按钮');
  const rec = sb.chLoad();
  ok(rec.best === 5 && rec.clears === 1, '存档：最高第 5 关、通关 1 次');
  ok(sb.loadStats().ach && sb.loadStats().ach.conqueror === 1, '解锁成就「过关斩将」');
  sb.render();
  ok(sb.chLoad().clears === 1, '重复 render 不会重复累加通关次数');
  ok(sb.loadStats().games === undefined, '整轮挑战都没写常规战绩');
}

/* ===== 7. 落败：止步面板、纪录保留、战绩隔离 ===== */
{
  sb.startChallenge();
  sb.G.winner = 1; sb.G.over = true; sb.G.overReason = '对手 获胜！';
  sb.render();
  ok(store.ovTitle.textContent.indexOf('止步第 1 关') >= 0, '落败显示「止步第 1 关」');
  ok(store.chBody.innerHTML.indexOf('pickSupply') < 0, '落败不给补给');
  ok(store.ovText.textContent.indexOf('最高纪录：第 5 关') >= 0, '落败面板显示历史最高纪录');
  ok(sb.chLoad().best === 5, '落败不会把最高纪录清零');
  ok(sb.loadStats().games === undefined, '落败也不写常规战绩');
}

/* ===== 8. 退出 / 普通开局 / 残局 三条入口互不串线 ===== */
{
  sb.quitChallenge();
  ok(sb.ch === null && sb.G === null && store.setup.style.display === 'block',
    '退出挑战回到选将页，状态清空');
  sb.startGame();
  ok(sb.ch === null && sb.puzzleIdx === -1 && sb.G !== null, '普通开局不受挑战残留影响');
  sb.startPuzzle(0);
  ok(sb.ch === null && sb.puzzleIdx === 0, '残局闯关会清掉挑战标记');
  sb.startChallenge();
  ok(sb.puzzleIdx === -1 && sb.ch !== null, '从选将再开挑战会清掉闯关标记');
  sb.quitChallenge();
  ok(sb.showStats() === undefined && store.statsBody.innerHTML.indexOf('过关斩将') >= 0,
    '战绩本展示挑战最高纪录与通关次数');
}

/* ===== 8b. 双将模式也能开挑战，阵容带进去且不串线 ===== */
{
  sb.setDual();
  sb.pick('machao');
  sb.startChallenge();
  ok(sb.G.p[0].hero.dual === true && sb.ch.hero.length === 2, '双将阵容带进挑战');
  ok(sb.G.p[1].hero.dual !== true, '第 1 关对手仍是单将');
  sb.quitChallenge();
  sb.setDual();
  ok(sb.dualMode === false, '退出挑战后双将开关可正常关闭');
}

/* ===== 9. 真实 AI 打完一整关（每步走真实 render），结算落到挑战面板 ===== */
{
  sb.startChallenge();
  let steps = 0;
  while (!sb.G.over && steps++ < 2500) {
    SG.apply(sb.G, SG.aiStep(sb.G));
    sb.render();
  }
  ok(sb.G.over === true, '整关 AI 自动对局能正常结束（' + steps + ' 步）');
  ok(store.ovBtnsChallenge.style.display === '', '整关结束后走的是挑战结算面板');
  ok(totalCards(sb.G) === 80, '整局结束牌数守恒（' + totalCards(sb.G) + '/80）');
  sb.quitChallenge();
}

/* ===== 10. 引擎级：低体力继承连打 5 关，多个种子都能收场 ===== */
{
  let allOver = true, maxSteps = 0;
  for (let s = 0; s < 3; s++) {
    let carry = null;
    for (let stage = 1; stage <= 5; stage++) {
      const foe = SG.HEROES[(s * 3 + stage * 2) % SG.HEROES.length].id;
      const st = SG.newGame({ seed: 1000 + s * 97 + stage, p0: 'boy', p1: foe, aiLevel: 1 });
      if (carry != null) st.p[0].hp = Math.max(1, Math.min(carry, st.p[0].maxHp));
      let n = 0;
      while (!st.over && n++ < 5000) SG.apply(st, SG.aiStep(st));
      if (!st.over) allOver = false;
      maxSteps = Math.max(maxSteps, n);
      carry = Math.max(1, st.p[0].hp);
    }
  }
  ok(allOver, '3 组种子 × 5 关低血继承对局全部正常分出胜负（最长 ' + maxSteps + ' 步）');
}

/* ===== 11. 难度回归：固定种子模拟整轮挑战，通关率不能失控 =====
   规则与 startChStage / render 结算保持一致：敌将起始 -1 血、过关保底 2 血、
   休整 +2、对手战力上限 6/8/10/12/不限（末关双将 Boss）。 */
{
  function rng(seed) {
    let x = seed | 0;
    return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  }
  const caps = [6, 8, 10, 12, 99];
  function runOne(seed) {
    const r = rng(seed);
    let hp = null, used = [], stage = 1;
    while (stage <= 5) {
      let pool = SG.HEROES.filter(h => h.power <= caps[stage - 1] &&
        used.indexOf(h.id) < 0 && h.id !== 'boy');
      if (!pool.length) pool = SG.HEROES.filter(h => h.id !== 'boy');
      const a = pool[Math.floor(r() * pool.length)];
      let foe = a.id;
      if (stage === 5) {
        const rest = SG.HEROES.filter(h => h.id !== a.id && h.id !== 'boy');
        foe = [a.id, rest[Math.floor(r() * rest.length)].id];
      }
      const st = SG.newGame({ seed: (r() * 1e9) | 0, p0: 'boy', p1: foe, aiLevel: 1 });
      if (hp != null) st.p[0].hp = Math.max(1, Math.min(hp, st.p[0].maxHp));
      st.p[1].hp = Math.max(1, st.p[1].maxHp - 1);
      let n = 0;
      while (!st.over && n++ < 5000) SG.apply(st, SG.aiStep(st));
      if (st.winner !== 0) return stage - 1;
      hp = Math.min(st.p[0].maxHp, Math.max(2, st.p[0].hp) + 2);
      used = used.concat(foe instanceof Array ? foe : [foe]);
      stage++;
    }
    return 5;
  }
  const N = 60;
  let cleared = 0, sum = 0, firstOut = 0;
  for (let s = 0; s < N; s++) {
    const r = runOne(7919 * s + 13);
    if (r === 5) cleared++;
    if (r === 0) firstOut++;
    sum += r;
  }
  const rate = cleared / N * 100, avg = sum / N, fo = firstOut / N * 100;
  console.log('  · 难度实测：通关率 ' + rate.toFixed(1) + '% · 平均 ' + avg.toFixed(2) +
    ' 关 · 首关淘汰 ' + fo.toFixed(1) + '%（' + N + ' 轮固定种子）');
  ok(rate >= 5 && rate <= 45, '通关率落在 5%–45%（有挑战但够得着）');
  ok(avg >= 1.8, '平均能打到第 2 关以后，不至于开局劝退');
  ok(fo <= 45, '首关淘汰率不过半');
}

console.log('\n过关斩将测试：' + pass + ' 通过，' + fail + ' 失败');
if (fail) process.exit(1);
