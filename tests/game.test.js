/* 抽取 game.html 里的纯逻辑引擎，跑大量 AI 自动对局验证不会崩/不会卡死 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');
const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 engine 脚本'); process.exit(1); }

const sandbox = { module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, { filename: 'engine.js' });
const SG = sandbox.module.exports;

let fail = 0;
function ok(cond, msg) { if (!cond) { fail++; console.error('  ✗ ' + msg); } }

const ids = SG.HEROES.map(h => h.id);
const TOTAL = 44; // 杀20 + 闪12 + 桃6 + 无中6
let finished = 0, draws = 0, maxSteps = 0;
const wins = {};

for (let g = 0; g < 400; g++) {
  const p0 = ids[(Math.random() * ids.length) | 0];
  let p1 = ids[(Math.random() * ids.length) | 0];
  const seed = (Math.random() * 1e9) | 0;
  const st = SG.newGame({ seed, p0, p1 });
  let steps = 0;

  while (!st.over && steps < 4000) {
    // 牌数守恒
    const all = st.deck.length + st.discard.length + st.p[0].hand.length + st.p[1].hand.length;
    ok(all === TOTAL, `牌总数不守恒: ${all}`);
    ok(st.p[0].hp <= st.p[0].maxHp && st.p[1].hp <= st.p[1].maxHp, '体力超过上限');
    ok(st.p[0].hand.length <= st.p[0].maxHp + 12, '手牌异常膨胀');
    ok(st.round <= 60, '轮数失控');

    const mv = SG.aiStep(st);
    if (!mv) break;
    SG.apply(st, mv);
    steps++;
    if (fail > 5) process.exit(1);
  }
  maxSteps = Math.max(maxSteps, steps);
  if (st.over) {
    finished++;
    if (st.winner < 0) draws++; else wins[st.p[st.winner].hero.id] = (wins[st.p[st.winner].hero.id] || 0) + 1;
  } else {
    fail++; console.error('  ✗ 对局未在 4000 步内结束，可能卡死 (seed ' + seed + ')');
  }
}

console.log('对局数 400，正常结束 ' + finished + ' 局，判和 ' + draws + ' 局，单局最大步数 ' + maxSteps);
console.log('各武将胜场（AI 随机对打，仅供平衡参考）：', wins);
console.log(fail === 0 ? '全部通过' : ('失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
