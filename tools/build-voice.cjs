/* build-voice.cjs —— 批量生成游戏语音音频（本地 mp3）
 *
 * 音源：微软 Edge「大声朗读」在线神经 TTS（与 Azure Neural TTS 同源音色），
 *      通过 msedge-tts 调用，无需账号、无需 API key、无需付费。
 * 产物：art/voice/v_<十六进制码点>.mp3 + lines.json（文本 → 文件名对照表）
 *      音频是本地文件，游戏运行时不联网；本脚本只在「重新生成 / 换音色」时才需要网络。
 *
 * 用法：
 *   cd tools && npm install
 *   node build-voice.cjs                       # 增量：已有音频跳过
 *   node build-voice.cjs --force              # 全部重生成
 *   node build-voice.cjs --voice zh-CN-YunxiNeural --force   # 换音色重生成
 *
 * 文件名规则必须与 game.html 里的 voiceKey() 完全一致（tests/voice-file.test.js 会对账）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'game.html');
const OUT = path.join(ROOT, 'art', 'voice');
const DEFAULT_VOICE = 'zh-CN-YunjianNeural';   /* 云健 · 浑厚男声，武侠旁白 */
const FORMAT = 'AUDIO_24KHZ_48KBITRATE_MONO_MP3';
const RATE = 0.92;                              /* 略慢，一字一顿 */
const PITCH = '-6Hz';                           /* 略压低，旁白腔 */

/* 纯 ASCII 文件名：把每个字符的 UTF-16 码点转成 4 位十六进制拼接 */
function voiceKey(text) {
  let s = '';
  for (let i = 0; i < text.length; i++) {
    s += ('0000' + text.charCodeAt(i).toString(16)).slice(-4);
  }
  return s;
}
function fileFor(text) { return 'v_' + voiceKey(text) + '.mp3'; }

function splitScripts(html) {
  const list = html.match(/<script(?: id="engine")?>([\s\S]*?)<\/script>/g) || [];
  return list.map(s => s.replace(/^<script(?: id="engine")?>/, '').replace(/<\/script>$/, ''));
}
function loadEngine(src) {
  const sb = { module: { exports: {} }, console };
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'engine.js' });
  return sb.module.exports;
}
function loadVoiceLine(uiSrc) {
  const m = uiSrc.match(/var VOICE_LINE = \{[\s\S]*?\n\};/);
  if (!m) throw new Error('game.html 里找不到 VOICE_LINE 定义');
  const sb = { module: { exports: {} } };
  vm.createContext(sb);
  vm.runInContext(m[0] + '\nmodule.exports = VOICE_LINE;', sb);
  return sb.module.exports;
}

/* 收集「可能被 speak() 念出来」的原文，再映射成江湖台词。
   来源：全部牌名 / 装备名 / 技能名 / VOICE_LINE 键 / 源码里的 speak('...') 字面量 /
        三元表达式里的两条回合播报（正则抓不到，显式补）。 */
function collectLines(html) {
  const scripts = splitScripts(html);
  if (scripts.length < 2) throw new Error('game.html 里找不到引擎或 UI 脚本');
  const SG = loadEngine(scripts[0]);
  const VL = loadVoiceLine(scripts[1]);
  const texts = [];
  Object.values(SG.CARDS).forEach(t => texts.push(t));
  Object.values(SG.EQUIPS).forEach(e => texts.push(e.name));
  SG.HEROES.forEach(h => (h.skills || []).forEach(s => texts.push(s.name)));
  Object.keys(VL).forEach(t => texts.push(t));
  const re = /\bspeak\(\s*'([^']+)'\s*\)/g;
  let m;
  while ((m = re.exec(scripts[1]))) texts.push(m[1]);
  ['轮到你出牌了', '对方回合', '语音已开启', '求桃'].forEach(t => texts.push(t));
  const lines = [...new Set(texts.map(t => VL[t] || t))].filter(Boolean).sort();
  return { lines, voiceLine: VL, SG };
}

async function synth(tts, text) {
  let lastErr;
  for (let k = 0; k < 3; k++) {
    try {
      const { audioStream } = await tts.toStream(text, { rate: RATE, pitch: PITCH });
      const bufs = [];
      await new Promise((res, rej) => {
        audioStream.on('data', b => bufs.push(b));
        audioStream.on('end', res);
        audioStream.on('error', rej);
      });
      const buf = Buffer.concat(bufs);
      if (buf.length < 1024) throw new Error('音频异常（' + buf.length + ' 字节）');
      return buf;
    } catch (e) {
      lastErr = e;
      if (k < 2) await new Promise(r => setTimeout(r, 900));
    }
  }
  throw lastErr;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const vi = args.indexOf('--voice');
  const voice = vi >= 0 && args[vi + 1] ? args[vi + 1] : DEFAULT_VOICE;

  const { lines } = collectLines(fs.readFileSync(HTML, 'utf8'));
  fs.mkdirSync(OUT, { recursive: true });

  let edge;
  try { edge = require('msedge-tts'); }
  catch (e) {
    console.error('缺少依赖：请先在项目 tools/ 目录执行 npm install');
    process.exit(2);
  }
  const { MsEdgeTTS, OUTPUT_FORMAT } = edge;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT[FORMAT]);
  console.log('音色 ' + voice + ' · 台词 ' + lines.length + ' 条 · 输出 ' + path.relative(ROOT, OUT));

  const map = {};
  let made = 0, skipped = 0;
  const failed = [];
  for (const line of lines) {
    const name = fileFor(line);
    map[line] = name;
    const dest = path.join(OUT, name);
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 1024) { skipped++; continue; }
    try {
      fs.writeFileSync(dest, await synth(tts, line));
      made++;
      process.stdout.write('.');
    } catch (e) {
      failed.push(line + ' → ' + (e && e.message ? e.message : e));
    }
  }
  process.stdout.write('\n');
  await tts.close();

  fs.writeFileSync(path.join(OUT, 'lines.json'),
    JSON.stringify({ voice, rate: RATE, pitch: PITCH, format: FORMAT, files: map }, null, 2) + '\n');
  console.log('新生成 ' + made + ' 条 · 跳过 ' + skipped + ' 条 · 失败 ' + failed.length + ' 条');
  if (failed.length) { failed.forEach(f => console.error('  ! ' + f)); process.exitCode = 1; }
  console.log('对照表：' + path.relative(ROOT, path.join(OUT, 'lines.json')));
}

module.exports = { voiceKey, fileFor, collectLines, splitScripts, loadEngine, loadVoiceLine };
if (require.main === module) main().catch(e => { console.error('生成失败：', e); process.exit(1); });
