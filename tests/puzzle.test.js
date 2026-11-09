/* 残局闯关：每关按内置解法脚本走一遍必须赢；进度与锁定逻辑；战绩不被污染 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');
const scripts = html.match(/<script(?: id="engine")?>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/^<script(?: id="engine")?>/, '').replace(/<\/script>$/, ''));

let fail = 0;
function ok(c, m) { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); }

function makeEl() {
  return { innerHTML: '', textContent: '', className: '', scrollTop: 0, scrollHeight: 0,
           offsetWidth: 1, style: {}, value: '', classList: { add() {}, remove() {} } };
}
const store = {};
const memLS = {};
const sandbox = {
  console, module: { exports: {} },
  document: { getElementById: id => (store[id] = store[id] || makeEl()), addEventListener() {} },
  window: { AudioContext: function () { throw new Error('no audio in test'); } },
  localStorage: {
    getItem: k => (k in memLS ? memLS[k] : null),
    setItem: (k, v) => { memLS[k] = String(v); },
    removeItem: k => { delete memLS[k]; }
  },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  Math, Date, JSON
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(scripts[0], sandbox, { filename: 'engine.js' });
vm.runInContext(scripts[1], sandbox, { filename: 'ui.js' });
const SG = sandbox.SG;

/* 驱动器：我方按解法脚本动，对方交给标准档 AI */
function runPuzzle(solution) {
  const G = sandbox.G;
  let i = 0, steps = 0;
  while (!G.over && steps < 500) {
    steps++;
    const a = G.awaiting, act = SG.active(G);
    if (a && a.p === 1) { SG.apply(G, SG.aiStep(G)); continue; }   /* 对方响应 */
    if (!a && act === 1) { SG.apply(G, SG.aiStep(G)); continue; }  /* 对方回合 */
    if (i >= solution.length)
      return { win: false, why: '解法动作用完（卡在 ' + (a ? a.type : 'play') + '）' };
    SG.apply(G, solution[i++]);
  }
  return { win: G.over && G.winner === 0, why: G.overReason };
}

/* ===== 1. 十关全部可解 ===== */
ok(sandbox.PUZZLES.length === 10, '共 10 关（实际 ' + sandbox.PUZZLES.length + '）');
sandbox.PUZZLES.forEach(function (P, i) {
  ok(Array.isArray(P.solution) && P.solution.length > 0, '第' + (i + 1) + '关带解法脚本');
  sandbox.startPuzzle(i);
  ok(sandbox.G && sandbox.G.p[0].hero.id === P.hero && sandbox.G.p[1].hero.id === P.foe,
     '第' + (i + 1) + '关「' + P.name + '」场面就位');
  const r = runPuzzle(P.solution);
  sandbox.render();                       /* 驱动器只 apply，结算弹窗靠 render 填 */
  ok(r.win, '第' + (i + 1) + '关「' + P.name + '」按解法获胜' + (r.win ? '' : '（' + r.why + '）'));
  ok(store.ovTitle.textContent === '通关！', '第' + (i + 1) + '关结算显示「通关！」');
});

/* ===== 2. 进度：全通后 progress=10，解锁「破局者」成就 ===== */
ok(sandbox.puzzleProgress() === 10, '通关进度 = 10（实际 ' + sandbox.puzzleProgress() + '）');
const ach = JSON.parse(memLS.sg_stats_v1 || '{}').ach || {};
ok(ach.puzzler === 1, '「破局者」成就已解锁');

/* ===== 3. 闯关局不进战绩本 ===== */
const st0 = JSON.parse(memLS.sg_stats_v1 || '{}');
ok(!st0.games, '闯关 10 局后战绩本总局数仍为 0（实际 ' + (st0.games || 0) + '）');

/* ===== 4. 锁定逻辑：进度重置后只有第 1 关可进 ===== */
memLS.sg_puzzle_v1 = '2';
sandbox.showPuzzles();
const html2 = store.puzzleBody.innerHTML;
const locks = html2.match(/pz locked/g) || [];
ok(locks.length === 7, '进度 2 时锁着 7 关（已通 2 关 + 解锁第 3 关，实际 ' + locks.length + '）');
ok(html2.indexOf('✅ 已通关') >= 0, '已通关关卡带勾');

/* ===== 5. 失败分支：故意乱放决斗会输（第 9 关的诱饵） ===== */
memLS.sg_puzzle_v1 = '99';            /* 全部解锁，方便点任意关 */
sandbox.startPuzzle(8);               /* 沉住气：1 血，决斗是诱饵 */
/* 决斗：吕布两张杀轮流出，我接住一张后没有第二张，只能认输 → 掉血濒死 → 没桃 → 吕布不救 → 我输 */
const r9 = runPuzzle([{ t: 'juedou' }, { t: 'duel', use: true }, { t: 'duel', use: false },
                      { t: 'dying', use: false }]);
sandbox.render();
/* 决斗：吕布出杀接住 → 轮我没杀认输 → 我掉血濒死 → 没桃 → 吕布不救 → 我输 */
ok(sandbox.G.over && sandbox.G.winner === 1, '第 9 关踩诱饵（先决斗）会输');
ok(store.ovTitle.textContent === '棋差一着', '失败显示「棋差一着」');
ok(store.ovBtnNext.style.display === 'none', '失败时不出「下一关」按钮');

/* ===== 6. 退出闯关后普通开局不受影响 ===== */
sandbox.quitPuzzle();
ok(sandbox.puzzleIdx === -1, '退出后闯关标记清空');
sandbox.startGame('lvbu');
ok(sandbox.G && sandbox.G.p[0].hand.length === 6, '普通开局正常（发 4 + 回合摸 2 = 6，实际 ' + sandbox.G.p[0].hand.length + '）');

console.log(fail === 0 ? '\n全部通过' : '\n失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
