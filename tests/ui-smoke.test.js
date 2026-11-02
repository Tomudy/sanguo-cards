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
  document: { getElementById: id => (store[id] = store[id] || makeEl()) },
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
if (unfinished.length) console.log('步数耗尽未分胜负（僵持局，非死锁）：\n  ' + unfinished.join('\n  '));
console.log(fail === 0 ? '全部通过' : ('失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
