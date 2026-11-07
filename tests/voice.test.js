/* 语音播报：TTS 音色挑选、江湖台词映射、节流与开关 */
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync('game.html', 'utf8');
const scripts = html.match(/<script(?: id="engine")?>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/^<script(?: id="engine")?>/, '').replace(/<\/script>$/, ''));

let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

const spoken = [];
let curVoice = null;
class Utterance {
  constructor(t) { this.text = t; this.voice = null; this.lang = ''; this.pitch = 1; this.rate = 1; this.volume = 1; }
}
const syn = {
  getVoices: () => [
    { name: 'Microsoft Huihui Desktop', lang: 'zh-CN' },
    { name: 'Microsoft Yunyang Online', lang: 'zh-CN' },
    { name: 'Google 普通话', lang: 'zh-CN' },
    { name: 'Alex', lang: 'en-US' }
  ],
  speak: u => { spoken.push({ text: u.text, pitch: u.pitch, rate: u.rate, voice: u.voice && u.voice.name }); },
  cancel: () => {},
  onvoiceschanged: null
};

function makeEl() {
  return { innerHTML: '', textContent: '', className: '', scrollTop: 0, scrollHeight: 0, offsetWidth: 1,
    style: {}, classList: { add() {}, remove() {} } };
}
const store = {};
const sb = {
  console, module: { exports: {} },
  document: { getElementById: id => (store[id] = store[id] || makeEl()), addEventListener() {}, createElement: null, body: null },
  window: { AudioContext: function () { throw new Error('no audio'); } },
  navigator: {},
  speechSynthesis: syn,
  SpeechSynthesisUtterance: Utterance,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: f => { f(); return 0; },
  Math, Date, JSON
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(scripts[0], sb, { filename: 'engine.js' });
vm.runInContext(scripts[1], sb, { filename: 'ui.js' });
const SG = sb.SG;

/* ---- 1) 音色挑选：应优先云扬（中文男声），且排除英文 ---- */
sb._vLast = 0;
vm.runInContext('speak("测试");', sb);
ok(spoken.length === 1, 'speak 触发一次');
ok(spoken[0].voice === 'Microsoft Yunyang Online', '选中中文男声（实际 ' + spoken[0].voice + '）');
ok(spoken[0].pitch < 0.9 && spoken[0].rate < 1, '武侠腔调：pitch ' + spoken[0].pitch + ' / rate ' + spoken[0].rate);

/* ---- 2) 实战对局：抓取全部播报 ---- */
spoken.length = 0;
sb.myHero = 'zhangfei';
vm.runInContext('G = SG.newGame({ seed: 12345, p0:"zhangfei", p1:"zhugeliang" }); recorded = true;', sb);
let n = 0;
while (!sb.G.over && n < 3000) {
  const mv = SG.aiStep(sb.G);
  if (!mv) break;
  SG.apply(sb.G, mv);
  sb._vLast = 0;                     /* 解除节流，抓全量 */
  vm.runInContext('render();', sb);
  n++;
}
const texts = spoken.map(x => x.text);
console.log('  播报样本：' + [...new Set(texts)].slice(0, 14).join(' / '));
ok(texts.includes('杀'), '出杀播报「杀」');
ok(texts.includes('闪') || texts.includes('桃'), '出闪/吃桃有播报');
const LINES = ['草船借箭', '空城之计', '锐气正盛', '咆哮！', '暴喝！'];
ok(texts.some(t => LINES.includes(t)), '技能播报换成江湖台词（实际含：' +
  texts.filter(t => LINES.includes(t)).join(',') + '）');
ok(!texts.includes('借箭'), '不再播报裸技能名「借箭」');

/* ---- 3) 无中生有播报 ---- */
const g2 = SG.newGame({ seed: 999, p0: 'boy', p1: 'lvbu' });
g2.p[0].hand = ['wzsy', 'slash', 'slash'];
g2.turn = 0; g2.awaiting = null;
SG.apply(g2, { t: 'wzsy' });
sb.G = g2; sb._vLast = 0;
vm.runInContext('render();', sb);
ok(spoken.some(x => x.text === '无中生有'), '无中生有播报卡名');

/* ---- 4) 关闭语音后不再播报 ---- */
vm.runInContext('voiceOn = false;', sb);
const before = spoken.length;
sb.G.events = [{ type: 'slash', p: 0, dmg: 1 }];
vm.runInContext('render();', sb);
ok(spoken.length === before, '语音关闭后静默');

/* ---- 5) 节流：连续两次播报只发一次 ---- */
vm.runInContext('voiceOn = true;', sb);
spoken.length = 0;
vm.runInContext('_vLast = 0; speak("杀"); speak("闪");', sb);
ok(spoken.length === 1, '260ms 内连续播报只保留第一条');

console.log(fail ? '\n失败 ' + fail + ' 项' : '\n全部通过');
process.exit(fail ? 1 : 0);
