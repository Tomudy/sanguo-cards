/* 静态资源与联机稳定性：WebP 立绘完整性、ART 映射与浏览器兜底、
   静态缓存/304 与动态 no-store、引擎超时修复的结构对账 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'game.html'), 'utf8');
const srv = fs.readFileSync(path.join(ROOT, 'lan_server.py'), 'utf8');
const ART_DIR = path.join(ROOT, 'art');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}

/* ===== 1. 引擎武将 id 与 ART 映射一一对应 ===== */
const eng = html.match(/<script id="engine">([\s\S]*?)<\/script>/)[1];
const esb = { module: { exports: {} }, console };
vm.createContext(esb); vm.runInContext(eng, esb);
const HERO_IDS = esb.module.exports.HEROES.map(h => h.id);

const artStart = html.indexOf('var ART = {');
const artEnd = html.indexOf('})();', artStart) + '})();'.length;
const artSnippet = html.slice(artStart, artEnd);
ok(artStart > 0 && artEnd > artStart, 'game.html 里能定位到 ART 映射与能力检测段');

function artWith(docStub) {
  const sb = { document: docStub, Object, console };
  vm.createContext(sb); vm.runInContext(artSnippet, sb);
  return sb.ART;
}
const ART = artWith({});                    // 无 canvas 的环境（Node 测试桩）
ok(Object.keys(ART).length === 15, 'ART 共 15 项（实际 ' + Object.keys(ART).length + '）');
ok(HERO_IDS.every(id => ART[id]), '每位武将都有立绘映射');
ok(Object.values(ART).every(v => /^art\/[\w-]+\.webp$/.test(v)),
   '默认全部走 WebP（15 项）');

/* ===== 2. WebP 文件真实存在、格式有效、体积显著下降 ===== */
const webps = Object.values(ART).map(v => path.join(ROOT, v));
ok(webps.every(f => fs.existsSync(f)), '15 个 .webp 文件全部存在');
let totalWebp = 0, totalPng = 0;
for (const f of webps) {
  const buf = fs.readFileSync(f);
  totalWebp += buf.length;
  ok(buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP',
     path.basename(f) + ' 是有效 WebP（RIFF/WEBP 头）');
  const png = f.replace(/\.webp$/, '.png');
  ok(fs.existsSync(png), path.basename(png) + ' 原图保留作打印/老浏览器兜底');
  if (fs.existsSync(png)) totalPng += fs.statSync(png).size;
}
ok(totalWebp < 6 * 1024 * 1024, 'WebP 总量 < 6MB（实际 ' + (totalWebp / 1048576).toFixed(2) + 'MB）');
ok(totalWebp < totalPng * 0.2, 'WebP 总量不到 PNG 的 20%（' +
   (totalPng / 1048576).toFixed(1) + 'MB → ' + (totalWebp / 1048576).toFixed(2) + 'MB）');

/* ===== 3. 浏览器能力检测：支持则 WebP，不支持则回退 PNG ===== */
const supported = artWith({
  createElement: () => ({ getContext: () => ({}), toDataURL: () => 'data:image/webp;base64,AAAA' })
});
ok(Object.values(supported).every(v => v.endsWith('.webp')), '支持 WebP → 保持 .webp');
const legacy = artWith({
  createElement: () => ({ getContext: () => ({}), toDataURL: () => 'data:image/png;base64,AAAA' })
});
ok(Object.values(legacy).every(v => v.endsWith('.png')),
   '老 Safari（toDataURL 回 png）→ 自动回退 .png');
ok(Object.keys(legacy).length === 15, '回退后 15 项映射都还在');
const noCanvas = artWith({ createElement: () => null });
ok(Object.values(noCanvas).every(v => v.endsWith('.webp')),
   '无 canvas 环境（测试桩）→ 不误回退，保持 .webp');

/* ===== 4. 服务端：静态缓存 / 304 / 动态 no-store ===== */
ok(/["']\.webp["']\s*:\s*["']image\/webp["']/.test(srv), 'MIME 表补上 image/webp');
ok(/STATIC_CACHE\s*=\s*["']public, max-age=/.test(srv), '静态资源有 Cache-Control 常量');
ok(/If-None-Match/.test(srv) && /send_response\(304\)/.test(srv), '支持 ETag 条件请求并返回 304');
ok(/def _send\(self, code, body, ctype, cache=None, etag=None\)/.test(srv),
   '_send 支持 cache / etag 参数');
ok(/cache or ["']no-store["']/.test(srv), '动态响应仍默认 no-store');
ok(/cache=STATIC_CACHE, etag=etag/.test(srv), '_static 用长缓存 + ETag 下发静态文件');
ok(/send_header\(["']ETag["'], etag\)/.test(srv), '200 响应带 ETag 头');
ok(/not full\.startswith\(root\)/.test(srv), '路径穿越防护仍在');

/* ===== 5. 引擎超时修复：超时必须真的生效 ===== */
ok(/def _drain_stdout\(self\)/.test(srv), '独立 stdout 读线程存在');
ok(/self\.replies = queue\.Queue\(\)/.test(srv), '响应走队列（不再直接阻塞 call）');
ok(/self\.replies\.get\(timeout=remain\)/.test(srv), 'call() 用带超时的 Queue.get 等待');
ok(/def _kill_locked\(self\)/.test(srv) && /self\.proc\.kill\(\)/.test(srv),
   '超时会强制杀掉卡死的 Node 进程');
ok(/self\.broken/.test(srv), '损坏状态被记录，后续 call 立即失败');
ok(!/while time\.time\(\) < deadline:\s*\n\s*line = self\.proc\.stdout\.readline\(\)/.test(srv),
   '旧的「阻塞 readline + deadline 轮询」已移除');

console.log('\n静态资源与联机稳定性测试：' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
