/* AI 三档难度：陪玩/标准/高手 强度梯度 + 默认档零回归验证 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'game.html'), 'utf8');
const src = html.match(/<script id="engine">([\s\S]*?)<\/script>/)[1];
const sb = { module: { exports: {} }, console };
vm.createContext(sb);
vm.runInContext(src, sb);
const SG = sb.module.exports;

let fail = 0;
function ok(c, m) { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); }

/* 用 aiLevel 随行动方切换的方式，让两侧 AI 用不同难度对打 */
function play(seed, a, b, lv0, lv1){
  const st = SG.newGame({ seed, p0: a, p1: b });
  let n = 0;
  while (!st.over && n < 4000) {
    st.aiLevel = (SG.active(st) === 0 ? lv0 : lv1);
    const mv = SG.aiStep(st);
    if (!mv) break;
    SG.apply(st, mv);
    n++;
  }
  return st;
}

const ids = SG.HEROES.map(h => h.id);

/* ---- 1) 默认档与显式标准档逐局完全一致（零回归） ---- */
{
  let same = 0, tot = 0;
  for (const a of ids.slice(0, 5)) for (const b of ids.slice(0, 5)) {
    if (a === b) continue;
    for (let s = 0; s < 4; s++) {
      const seed = (s * 31 + 7) | 0;
      const g1 = SG.newGame({ seed, p0: a, p1: b });
      const g2 = SG.newGame({ seed, p0: a, p1: b, aiLevel: 1 });
      let n = 0;
      while (!g1.over && n < 4000) {
        SG.apply(g1, SG.aiStep(g1));
        SG.apply(g2, SG.aiStep(g2));
        n++;
      }
      tot++;
      if (g1.over === g2.over && g1.winner === g2.winner &&
          JSON.stringify(g1.log) === JSON.stringify(g2.log)) same++;
    }
  }
  ok(same === tot, '默认档 = 标准档（' + same + '/' + tot + ' 局日志逐条一致）');
}

/* ---- 2) 陪玩档明显弱于标准档 ---- */
{
  let w1 = 0, N = 0;
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    for (let s = 0; s < 10; s++) {
      const st = play((s * 7919 + 13) | 0, a, b, 1, 0);
      N++;
      if (st.winner === 1) w1++;
    }
  }
  const r = w1 * 100 / N;
  ok(r < 30, '陪玩档胜率 ' + r.toFixed(1) + '% < 30%（实测基线约 13%）');
}

/* ---- 3) 高手档明显强于标准档：与后手基线对比，而不是写死阈值 ---- */
{
  let base = 0, hi = 0, N = 0;
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    for (let s = 0; s < 10; s++) {
      const seed = (s * 7919 + 13) | 0;
      if (play(seed, a, b, 1, 1).winner === 1) base++;   /* 标准 vs 标准，后手席 */
      if (play(seed, a, b, 1, 2).winner === 1) hi++;     /* 高手坐后手席 */
      N++;
    }
  }
  const rb = 100 * base / N, rh = 100 * hi / N;
  /* 后手席天然吃亏，关键是"高手档坐后手能比标准档多赢多少" */
  ok(rh > rb + 5, '高手档后手 ' + rh.toFixed(1) + '% 比后手基线 ' + rb.toFixed(1) + '% 高 5 点以上');
}

/* ---- 4) 陪玩档行为合法性：懒回合也不出非法动作 ---- */
{
  let bad = 0;
  for (let s = 0; s < 30; s++) {
    const st = SG.newGame({ seed: (s * 101 + 3) | 0, p0: 'zhangfei', p1: 'jiangwei', aiLevel: 0 });
    let n = 0;
    while (!st.over && n < 4000) {
      st.aiLevel = 0;
      const mv = SG.aiStep(st);
      if (!mv) break;
      const L = SG.legal(st);
      /* 引擎 apply 自带校验，非法动作会抛错 */
      try { SG.apply(st, mv); } catch (e) { bad++; break; }
      n++;
    }
    if (!st.over && n >= 4000) bad++;
  }
  ok(bad === 0, '陪玩档 30 局无非法动作、无卡死');
}

console.log(fail ? '\n失败 ' + fail + ' 项' : '\n全部通过');
process.exit(fail ? 1 : 0);
