/* 本地音频语音：文件名规则两端对账、真实对局台词覆盖率、
   音频优先 / 队列不截断 / 缺文件与禁播自动回退 TTS / 开关与节流 / 联机 MIME */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'game.html'), 'utf8');
const scripts = html.match(/<script(?: id="engine")?>([\s\S]*?)<\/script>/g)
  .map(s => s.replace(/^<script(?: id="engine")?>/, '').replace(/<\/script>$/, ''));
const tool = require(path.join(ROOT, 'tools', 'build-voice.cjs'));
const VOICE_DIR = path.join(ROOT, 'art', 'voice');
const manifest = JSON.parse(fs.readFileSync(path.join(VOICE_DIR, 'lines.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}
function makeEl() {
  return { innerHTML: '', textContent: '', className: '', disabled: false,
    scrollTop: 0, scrollHeight: 0, offsetWidth: 1,
    style: {}, classList: { add() {}, remove() {} } };
}
class Utterance {
  constructor(t) { this.text = t; this.voice = null; this.lang = ''; this.pitch = 1; this.rate = 1; this.volume = 1; }
}

/* 每个沙箱独立的假 Audio：instances 记实例数，playLog 记每次播放的 src */
function mkSb(opts) {
  opts = opts || {};
  const spoken = [], instances = [], playLog = [];
  let cancels = 0;
  const tts = {
    getVoices: () => [{
      name: 'Microsoft Yunyang Online', lang: 'zh-CN'
    }],
    speak: u => spoken.push(u),
    cancel: () => { cancels++; },
    onvoiceschanged: null
  };
  function FakeAudio(src) {
    this.src = src || '';
    this.paused = false; this.volume = 1; this.played = false;
    this.onended = null; this.onerror = null;
    instances.push(this);
  }
  FakeAudio.prototype.pause = function () { this.paused = true; };
  FakeAudio.prototype.play = function () {
    this.played = true;
    playLog.push(this.src);
    if (opts.mode === 'reject') {
      return { catch: fn => fn(new Error('NotAllowedError')) };   /* 同步触发，模拟被浏览器拒绝 */
    }
    return undefined;                                              /* 老式浏览器：无 Promise */
  };
  const store = {};
  const sb = {
    console, module: { exports: {} },
    document: { getElementById: id => (store[id] = store[id] || makeEl()), addEventListener() {} },
    window: { AudioContext: function () { throw new Error('no audio in test'); } },
    navigator: {},
    speechSynthesis: tts, SpeechSynthesisUtterance: Utterance,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: f => { f(); return 0; },
    Math, Date, JSON
  };
  if (opts.audio) sb.Audio = FakeAudio;    /* 不传 = 无 Audio 环境，走纯 TTS（旧测试口径） */
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(scripts[0], sb, { filename: 'engine.js' });
  vm.runInContext(scripts[1], sb, { filename: 'ui.js' });
  return { sb, spoken, instances, playLog, get cancels() { return cancels; } };
}

/* ===== 1. 文件名规则：game.html 的 voiceKey 必须与生成脚本逐字一致 ===== */
console.log('\n[1] 文件名规则对账');
{
  const { sb } = mkSb({});
  const lines = tool.collectLines(html).lines;
  const probes = lines.concat(['杀！', '草船借箭', '轮到你出牌了', '🎭 双将', 'A\uD83D\uDE00B']);
  ok(probes.every(t => sb.voiceKey(t) === tool.voiceKey(t)),
    (probes.length) + ' 条文本（含标点 / emoji 代理对）两端编码一致');
  ok(sb.voiceKey('杀') === '6740', '纯 ASCII 文件名：杀 → 6740');
  ok(!/[^a-z0-9_.]/.test(tool.fileFor('草船借箭')), '文件名不含中文或特殊字符');
}

/* ===== 2. 音频素材完整性 ===== */
console.log('\n[2] 音频素材');
{
  const lines = tool.collectLines(html).lines;
  const files = Object.keys(manifest.files);
  ok(lines.length === 53, '台词全集 53 条（实际 ' + lines.length + '）');
  ok(files.length === 53, '对照表 53 项（实际 ' + files.length + '）');
  const mp3s = fs.readdirSync(VOICE_DIR).filter(f => /\.mp3$/.test(f));
  ok(mp3s.length === 53, 'art/voice 下 53 个 mp3（实际 ' + mp3s.length + '）');
  let missing = 0, small = 0, badHead = 0;
  for (const line of lines) {
    const f = path.join(VOICE_DIR, tool.fileFor(line));
    if (!fs.existsSync(f)) { missing++; continue; }
    const buf = fs.readFileSync(f);
    if (buf.length < 1024) small++;
    if (buf[0] !== 0xff) badHead++;
  }
  ok(missing === 0, '每条台词都有对应音频文件（缺 ' + missing + '）');
  ok(small === 0 && badHead === 0, '音频均非空的合法 MP3（过小 ' + small + ' / 坏头 ' + badHead + '）');
  ok(lines.every(l => manifest.files[l] === tool.fileFor(l)), '对照表与文件名规则完全一致');
  ok(manifest.voice === 'zh-CN-YunjianNeural', '音色记录为云健男声');
}

/* ===== 3. 真实对局动态覆盖率：跑多组武将，确认每一句都能找到音频 ===== */
console.log('\n[3] 真实对局台词覆盖');
{
  const { sb } = mkSb({});
  const SG = sb.SG;
  vm.runInContext(
    'var __cap = []; var __origSpeak = speak;' +
    'speak = function(t){ __cap.push(t); return __origSpeak(t); };', sb);
  const pairs = [
    ['boy', 'lvbu'], ['zhangfei', 'zhugeliang'], ['zhaoyun', 'diaochan'],
    ['guanyu', 'baiyu'], ['machao', 'jiangwei'], ['dengai', 'weiyan'],
    ['zhouyu', 'gushan'], ['qingluan', 'lvbu']
  ];
  let steps = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let s = 0; s < 3; s++) {
      sb.G = SG.newGame({ seed: 7919 * s + 13 + i * 104729, p0: pairs[i][0], p1: pairs[i][1], aiLevel: 2 });
      let n = 0;
      while (!sb.G.over && n < 900) {
        const mv = SG.aiStep(sb.G);
        if (!mv) break;
        SG.apply(sb.G, mv);
        sb._vLast = 0;                    /* 解除 260ms 节流，抓全量播报 */
        vm.runInContext('render();', sb);
        n++; steps++;
      }
    }
  }
  const texts = [...new Set(sb.__cap)].filter(Boolean);
  const unresolved = texts.filter(t => {
    const line = sb.VOICE_LINE[t] || t;
    return !fs.existsSync(path.join(VOICE_DIR, tool.fileFor(line)));
  });
  ok(texts.length > 20, '24 局共采集到 ' + texts.length + ' 种播报（' + steps + ' 步）');
  ok(unresolved.length === 0,
    '真实对局里的每句播报都有音频（未覆盖：' + unresolved.join('/') + '）');
}

/* ===== 4. 音频优先 + 队列不截断 ===== */
console.log('\n[4] 音频优先与队列');
{
  const { sb, spoken, instances, playLog } = mkSb({ audio: true });
  ok(sb._vAudioOK === true, '检测到 Audio 环境时启用本地音频');
  sb._vLast = 0; vm.runInContext('speak("杀");', sb);
  ok(playLog.length === 1, 'speak 触发一次音频播放');
  ok(playLog[0] === 'art/voice/' + tool.fileFor('杀'), '音频路径按 voiceKey 正确拼出');
  ok(spoken.length === 0, '有音频时不再调用浏览器 TTS');
  sb._vLast = 0; vm.runInContext('speak("闪");', sb);
  sb._vLast = 0; vm.runInContext('speak("桃");', sb);
  ok(instances.length === 1, '复用同一个 Audio 实例，不叠加');
  ok(playLog.length === 1 && sb._vQueue.length === 2, '后两句排队，正在播的这句不被截断');
  sb._vAud.onended();
  ok(playLog[1] === 'art/voice/' + tool.fileFor('闪'), '播完自动接第 2 句');
  sb._vAud.onended();
  ok(playLog[2] === 'art/voice/' + tool.fileFor('桃'), '再接第 3 句');
  sb._vAud.onended();
  ok(sb._vQueue.length === 0 && sb._vPlaying === false, '队列排空、状态复位');
  sb._vLast = 0; vm.runInContext('speak("杀"); speak("闪");', sb);
  ok(playLog.length === 4, '260ms 节流在音频路径同样生效（只 +1 条）');
}

/* ===== 5. 缺文件 / 禁播 → 自动回退 TTS ===== */
console.log('\n[5] 自动回退');
{
  const a = mkSb({ audio: true });
  a.sb._vLast = 0; vm.runInContext('speak("求桃");', a.sb);
  a.sb._vAud.onerror();                         /* 模拟 404 */
  ok(a.spoken.length === 1 && a.spoken[0].text === '求桃', '缺音频 → 浏览器 TTS 补播同一句');
  ok(a.sb._vMiss['求桃'] === 1, '缺文件被记住，避免反复 404');
  a.sb._vLast = 0; vm.runInContext('speak("求桃");', a.sb);
  ok(a.playLog.length === 1 && a.spoken.length === 2, '第二次直接走 TTS，不再请求音频');
  ok(a.spoken[1].pitch === 0.78 && a.spoken[1].rate === 0.88, '回退仍保持武侠腔调');

  const b = mkSb({ audio: true, mode: 'reject' });
  b.sb._vLast = 0; vm.runInContext('speak("杀");', b.sb);
  ok(b.sb._vBlocked === true, 'play() 被浏览器拒绝后标记全局回退');
  ok(b.spoken.length === 1, '该句当场由 TTS 补播，不会没声');
  b.sb._vLast = 0; vm.runInContext('speak("闪");', b.sb);
  ok(b.spoken.length === 2 && b.playLog.length === 1, '后续播报直接走 TTS');

  const c = mkSb({});                           /* 无 Audio 环境：老设备 / 旧测试桩 */
  ok(c.sb._vAudioOK === false, '无 Audio 环境自动判定为纯 TTS');
  c.sb._vLast = 0; vm.runInContext('speak("杀");', c.sb);
  ok(c.spoken.length === 1 && c.playLog.length === 0, '纯 TTS 路径行为与旧版一致');
}

/* ===== 6. 开关、解锁与联机 MIME ===== */
console.log('\n[6] 开关 / 解锁 / 联机');
{
  const a = mkSb({ audio: true });
  a.sb._vLast = 0; vm.runInContext('speak("杀");', a.sb);
  a.sb._vLast = 0; vm.runInContext('speak("闪");', a.sb);
  vm.runInContext('toggleVoice();', a.sb);      /* 关 */
  ok(a.sb.voiceOn === false && a.sb._vQueue.length === 0, '关语音时清空待播队列');
  ok(a.sb._vPlaying === false && a.sb._vAud.paused === true, '正在播的音频被暂停');
  ok(a.cancels >= 1, '浏览器 TTS 同步取消');
  const before = a.playLog.length;
  a.sb._vLast = 0; vm.runInContext('speak("桃");', a.sb);
  ok(a.playLog.length === before && a.spoken.length === 0, '关闭后完全静默');

  const b = mkSb({ audio: true });
  vm.runInContext('unlockAudio();', b.sb);
  ok(b.sb._vWarmed === true, '首次手势内完成 Audio 解锁');
  ok(b.instances.length === 1 && /^data:audio\/wav;base64,/.test(b.instances[0].src),
    '解锁用静音 data URI，不会发出声音');

  const srv = fs.readFileSync(path.join(ROOT, 'lan_server.py'), 'utf8');
  ok(/["']\.mp3["']\s*:\s*["']audio\/mpeg["']/.test(srv), '联机服务器补上 .mp3 的 audio/mpeg');
  ok(/["']\.ogg["']\s*:\s*["']audio\/ogg["']/.test(srv), '联机服务器补上 .ogg 的 audio/ogg');
}

console.log('\n本地音频语音测试：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
