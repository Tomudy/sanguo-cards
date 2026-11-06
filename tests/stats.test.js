/* 战绩本+成就：真实引擎对局 + localStorage 桩，验证记录、连胜、成就解锁与弹窗渲染 */
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync('game.html', 'utf8');
const scripts = html.match(/<script(?: id="engine")?>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/^<script(?: id="engine")?>/, '').replace(/<\/script>$/, ''));

let fail = 0;
function ok(c, m) { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); }

/* localStorage 桩 */
const mem = {};
const ls = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

function makeEl() {
  return { innerHTML: '', textContent: '', className: '', scrollTop: 0, scrollHeight: 0, offsetWidth: 1,
    style: {}, classList: { add() {}, remove() {} } };
}
const store = {};
const sb = {
  console, module: { exports: {} },
  localStorage: ls,
  document: { getElementById: id => (store[id] = store[id] || makeEl()), addEventListener() {}, createElement: null, body: null },
  window: { AudioContext: function () { throw new Error('no audio'); } },
  navigator: {},
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: f => { f(); return 0; },
  Math, Date, JSON
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(scripts[0], sb, { filename: 'engine.js' });
vm.runInContext(scripts[1], sb, { filename: 'ui.js' });

const SG = sb.SG;

/* ---- 1) 打若干局，验证记录与成就 ---- */
let sawOver = 0;
for (let i = 0; i < 60; i++) {
  const p0 = SG.HEROES[i % SG.HEROES.length].id;
  const p1 = SG.HEROES[(i + 7) % SG.HEROES.length].id;
  sb.myHero = p0;
  vm.runInContext('G = SG.newGame({ seed:(' + (i * 31 + 7) + '), p0:myHero, p1:' + JSON.stringify(p1) + ' }); recorded = false;', sb);
  let n = 0;
  while (!sb.G.over && n < 4000) {
    const mv = SG.aiStep(sb.G);
    if (!mv) break;
    SG.apply(sb.G, mv);
    n++;
  }
  vm.runInContext('render();', sb);
  if (sb.G.over) sawOver++;
}
ok(sawOver === 60, '60 局全部正常结束并触发记录（实际 ' + sawOver + '）');

const s = JSON.parse(mem['sg_stats_v1']);
ok(s && s.games === 60, '总场次 = 60（实际 ' + (s && s.games) + '）');
ok(s.wins + Object.keys(s.heroes).reduce((a, k) => a + s.heroes[k].l, 0) === 60, '胜负计数守恒');
ok(s.ach && s.ach.first_win === 1, '旗开得胜已解锁');
ok(s.best >= 1, '最高连胜 ≥1（实际 ' + s.best + '）');
const heroRec = Object.keys(s.heroes).length;
ok(heroRec >= 1, '记录了武将战绩（' + heroRec + ' 位）');

/* ---- 2) 构造局：残血/满血/低点数胜 ---- */
function craft(p0, p1, hp0) {
  sb.myHero = p0;
  vm.runInContext(
    'G = SG.newGame({ seed:42, p0:' + JSON.stringify(p0) + ', p1:' + JSON.stringify(p1) + ' }); recorded = false;', sb);
  sb.G.p[0].hp = hp0;
  sb.G.winner = 0; sb.G.over = true; sb.G.overReason = '测试';
  vm.runInContext('render();', sb);
}

/* 清档重来，逐个验证成就 */
delete mem['sg_stats_v1'];
craft('qingluan', 'jiangwei', 1);   // 青鸾6点 胜 神姜维13点，血1 → comeback + david + first_win
let s2 = JSON.parse(mem['sg_stats_v1']);
ok(s2.ach.first_win === 1, '构造局：旗开得胜');
ok(s2.ach.comeback === 1, '构造局：绝地反击（1 血取胜）');
ok(s2.ach.david === 1, '构造局：以下克上（6 点胜 13 点）');
ok(!s2.ach.flawless, '构造局：毫发无损未误触发');
ok(s2.heroes.qingluan && s2.heroes.qingluan.w === 1, '构造局：青鸾战绩 +1 胜');

craft('zhangfei', 'lvbu', 4);       // 满血 → flawless
s2 = JSON.parse(mem['sg_stats_v1']);
ok(s2.ach.flawless === 1, '构造局：毫发无损');
ok(s2.streak === 2, '连胜累计 = 2（实际 ' + s2.streak + '）');

craft('zhangfei', 'lvbu', 4);       // 第 3 连胜
s2 = JSON.parse(mem['sg_stats_v1']);
ok(s2.ach.streak3 === 1, '三连胜解锁');
ok(!s2.ach.streak5, '五连胜未误触发');

/* ---- 3) 平局不计入 ---- */
const gamesBefore = s2.games;
sb.myHero = 'lvbu';
vm.runInContext('G = SG.newGame({ seed:42, p0:"lvbu", p1:"zhangfei" }); recorded = false;', sb);
sb.G.winner = -1; sb.G.over = true; sb.G.overReason = '平局';
vm.runInContext('render();', sb);
s2 = JSON.parse(mem['sg_stats_v1']);
ok(s2.games === gamesBefore, '平局不计入总场次');
ok(s2.streak === 3, '平局不清连胜');

/* ---- 4) showStats 渲染不抛异常 ---- */
try { vm.runInContext('showStats();', sb); ok(true, 'showStats 渲染正常'); }
catch (e) { ok(false, 'showStats 抛异常: ' + e.message); }
ok(store.statsBody && store.statsBody.innerHTML.includes('武将战绩'), '战绩弹窗含武将列表');
ok(store.statsBody.innerHTML.includes('成就徽章'), '战绩弹窗含徽章墙');

console.log(fail ? '\n失败 ' + fail + ' 项' : '\n全部通过');
process.exit(fail ? 1 : 0);
