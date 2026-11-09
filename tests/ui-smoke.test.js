/* 用极简 DOM 桩加载 game.html 的界面层，跑通选将→对战→各技能分支，验证不抛异常 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');
const scripts = html.match(/<script(?: id="engine")?>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/^<script(?: id="engine")?>/, '').replace(/<\/script>$/, ''));
if (scripts.length < 2) { console.error('未找到两段脚本'); process.exit(1); }

let fail = 0;
function ok(c, m) { if (!c) { fail++; console.error('  ✗ ' + m); } }

function makeEl() {
  const e = {
    innerHTML: '', textContent: '', className: '', scrollTop: 0, scrollHeight: 0, offsetWidth: 1,
    style: {}, classList: { add() {}, remove() {} }
  };
  return e;
}

const store = {};
const sandbox = {
  console,
  module: { exports: {} },
  document: { getElementById: id => (store[id] = store[id] || makeEl()), addEventListener() {} },
  window: { AudioContext: function () { throw new Error('no audio in test'); } },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  Math, Date, JSON
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(scripts[0], sandbox, { filename: 'engine.js' });
vm.runInContext(scripts[1], sandbox, { filename: 'ui.js' });
const SG = sandbox.SG;

ok(typeof SG === 'object', '引擎未暴露到 UI 上下文');
ok(store.picks && store.picks.innerHTML.length > 0, '选将界面未渲染');

function humanMove(st) {
  const a = st.awaiting;
  if (a) {
    if (a.type === 'yusuan') return { t: 'yusuan', use: Math.random() < 0.5 };
    if (a.type === 'keep') return { t: 'keep', idxs: Array.from({ length: a.n }, (_, i) => i) };
    if (a.type === 'jinglan') return { t: 'jinglan', use: true };
    if (a.type === 'dodge') return { t: 'dodge', use: !!a.canDodge };
    if (a.type === 'jinghong') return { t: 'jinghong', use: true };
    if (a.type === 'discard') return { t: 'discard', idxs: Array.from({ length: a.n }, (_, i) => i) };
    // 濒死：有桃就自救；被求救时一半概率出手相救（覆盖两条分支）
    if (a.type === 'dying') { cov.dying++; return { t: 'dying', use: st.p[a.p].hand.indexOf('peach') >= 0 }; }
    if (a.type === 'save') { cov.save++; return { t: 'save', use: Math.random() < 0.5 }; }
  }
  const L = SG.legal(st);
  if (L.yehuo) return { t: 'yehuo', idxs: [0, 1] };
  if (L.qimou) return { t: 'qimou', idx: 0 };
  if (L.lijian) return { t: 'lijian', idx: 0 };
  if (L.slash) return { t: 'slash' };
  if (L.peach) return { t: 'peach' };
  if (L.wzsy) return { t: 'wzsy' };
  if (L.ruiqi) return { t: 'ruiqi', idx: 0 };
  return { t: 'end' };
}

const ids = SG.HEROES.map(h => h.id);
let runs = 0, ended = 0;
const cov = { dying: 0, save: 0 };
const unfinished = [];

for (const mode of ['ai', 'pvp']) {
  for (const heroId of ids) {
    sandbox.setMode(mode);
    sandbox.myHero = heroId;
    sandbox.startGame();
    runs++;
    let steps = 0;
    while (!sandbox.G.over && steps < 600) {
      const st = sandbox.G;
      const vi = SG.active(st);
      const isAI = (mode === 'ai' && vi === 1);
      const mv = isAI ? SG.aiStep(st) : humanMove(st);
      ok(!!mv, mode + '/' + heroId + ' 拿不到动作');
      if (!mv) break;
      SG.apply(st, mv);
      // 走真实渲染路径（含飘字、日志、按钮区、手牌区）
      sandbox.render();
      steps++;
      if (fail > 3) { console.error('中断'); process.exit(1); }
    }
    if (sandbox.G.over) ended++;
    else unfinished.push(mode + '/' + heroId + ' vs ' + sandbox.G.p[1].hero.id +
      '（' + steps + ' 步，hp ' + sandbox.G.p[0].hp + '/' + sandbox.G.p[1].hp + '）');
    // 双人模式下双方手牌都要能渲染出来
    if (mode === 'pvp') ok(store.hand.innerHTML.indexOf('card') >= 0 || !sandbox.G.p[SG.active(sandbox.G)].hand.length,
      'pvp 手牌区未渲染当前行动方手牌');
  }
}

console.log('界面冒烟：' + runs + ' 局（ai / pvp × 全部武将），正常结束 ' + ended + ' 局');
console.log('濒死分支覆盖：濒死自救 ' + cov.dying + ' 次，对手求救 ' + cov.save + ' 次');

/* ===== 界面三件套 + 配乐 的专项断言 ===== */
// 1) 对手下拉已渲染且含"随机对手"，选项不含自己（重渲染后再断言）
sandbox.renderPicks();
ok(store.foeSel && store.foeSel.innerHTML.indexOf('随机对手') >= 0, '对手下拉未渲染');
ok(store.foeSel.innerHTML.indexOf('value="' + sandbox.myHero + '"') < 0, '对手下拉里出现了自己');
// 2) 手牌带说明角标、回合横幅播过、战报浮层可打开
ok(store.hand.innerHTML.indexOf('cinfo') >= 0 || store.hand.innerHTML.indexOf('没有手牌') >= 0,
  '手牌缺少说明角标');
ok(store.banner && store.banner.textContent.length > 0, '回合横幅没有播放过');
sandbox.showCard('slash');
ok(store.cardName.textContent === '杀' && store.cardDesc.textContent.indexOf('攻击') >= 0,
  '卡牌说明浮层内容不对');
sandbox.showCard('bagua');
ok(store.cardDesc.textContent.indexOf('判定') >= 0, '装备说明浮层没用完整描述');
sandbox.closeCardOv();
ok(store.cardOv.className === 'ov', '说明浮层关不掉');
// 3) 再战一局复用同一对手；换个对手必换人
const foe1 = sandbox.foeHero;
sandbox.rematch(true);
ok(sandbox.G && sandbox.G.p[1].hero.id === foe1, '再战一局没有复用原对手');
sandbox.rematch(false);
ok(sandbox.G && sandbox.G.p[1].hero.id !== foe1, '换个对手没有换人');
// 4) 配乐开关可切换且不抛异常（桩环境无声，只验证状态与文案）
sandbox.toggleBgm();
ok(store.bgmTxt.textContent === '开', '配乐开关打开后文案未更新');
sandbox.toggleBgm();
ok(store.bgmTxt.textContent === '关', '配乐开关关闭后文案未更新');
// 5) 结构化 BGM 数据：双乐句各 16 步，旋律音都落在五声音阶内
ok(sandbox.BGM_BARS.length === 2 && sandbox.BGM_BARS.every(b => b.length === 16),
  'BGM 乐句结构不对');
const PENTA_SET = [262, 294, 330, 392, 440, 523, 587, 659];
ok(sandbox.BGM_BARS.every(b => b.every(f => f === 0 || PENTA_SET.indexOf(f) >= 0)),
  'BGM 旋律跑出五声音阶了');

console.log(fail === 0 ? '全部通过' : ('失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
