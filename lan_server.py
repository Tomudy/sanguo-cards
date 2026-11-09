#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三国武将卡 · 局域网多人对战服务器（单文件，可直接运行）

用法：
    python lan_server.py                     # 默认 0.0.0.0:8765
    python lan_server.py --port 9000         # 换端口
    python lan_server.py --host 127.0.0.1    # 只允许本机（调试用）
    python lan_server.py --help              # 全部参数

同一 Wi-Fi 下：一台电脑跑本脚本 → 其他人用手机 / iPad 浏览器打开终端打印的地址
（形如 http://192.168.1.23:8765）→ 一人创建房间，其他人用 4 位房间号或邀请链接加入。

依赖：Python 3.8+ 标准库；本机需装 Node.js（规则引擎用它加载，见"接入点 1"）。
不改变原游戏任何玩法：卡牌、技能、胜负判定全部仍由 game.html 里的引擎执行。

────────────────────────────────────────────────────────────────────
四个接入点（想改联机行为只看这四处）
────────────────────────────────────────────────────────────────────
接入点 1｜游戏规则引擎 —— extract_engine_js() / DRIVER_JS / EngineBridge
    从 game.html 抽出 <script id="engine"> 源码交给 Node 执行；每个房间一个引擎进程，
    Python 通过标准输入输出发命令（new / apply / ai），规则一行都没有重写。

接入点 2｜状态数据 —— Room.state / rotate_state()
    引擎返回的状态快照就是唯一权威状态，只存在于服务器；
    发给 1 号位玩家时原样发，发给 2 号位时把双方对调（rotate_state），
    于是每个客户端都看到"自己在下方"。要改状态结构只改 rotate_state。

接入点 3｜交互入口 —— CLIENT_JS 里的 5 个 monkey patch
    pick()       选将 → 上报英雄
    startGame()  开始对局 → 交给服务器判定权限并开局
    SG.apply()   所有出牌动作 → 改为发给服务器，本地不再自行结算
    again()      结算后"再来一局" → 请求重开
    backSetup()  返回选将 → 离开房间
    渲染（render / renderPicks / renderHand）一行未改，直接复用原界面。

接入点 4｜断线重连 —— 全局 CONNS 连接表 + 浏览器 token
    身份是 localStorage 里的 token；掉线重连自动回到原座位，
    超过 DISCONNECT_TIMEOUT 还没回来才判掉线结束对局。
"""

import argparse
import copy
import json
import os
import queue
import random
import re
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# ══════════════════════════════════════════════════════════════════
# 配置项（一般只改这里）
# ══════════════════════════════════════════════════════════════════
HOST = "0.0.0.0"                # 监听地址：0.0.0.0 = 局域网内所有设备都能连
PORT = 8765                     # 端口，被占用时换一个
GAME_FILE = "game.html"         # 原游戏页面（相对本脚本目录）
ART_DIR = "art"                 # 立绘目录（相对本脚本目录）
MAX_ROOMS = 20                  # 最多同时存在的房间数
DISCONNECT_TIMEOUT = 180        # 玩家掉线后保留座位 / 对局的秒数，超时结束
AI_STEP_DELAY = 0.55            # 电脑出牌间隔（秒），留出看清节奏的时间
ROOM_IDLE_TIMEOUT = 1800        # 无人在线的房间多久后回收（秒）
SSE_PING_INTERVAL = 5           # SSE 心跳间隔（秒）：对端彻底失联时的兜底探测

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
START_TIME = time.time()

# ══════════════════════════════════════════════════════════════════
# 接入点 1：规则引擎 —— 用 Node 加载 game.html 的引擎，零改动复用
# ══════════════════════════════════════════════════════════════════

# Node 侧驱动：读一行 JSON 命令，写一行 JSON 结果
DRIVER_JS = r"""
const fs = require('fs'), path = require('path'), vm = require('vm'), readline = require('readline');
const src = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
const sandbox = { module: { exports: {} }, console: console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const SG = sandbox.module.exports;

let st = null;
// 快照：JSON 序列化会自动丢掉 rnd 函数；客户端只拿它渲染，不参与结算
function snap() { return JSON.parse(JSON.stringify(st)); }
function takeEvents() { const e = st.events || []; st.events = []; return e; }
function reply(res) { process.stdout.write(JSON.stringify(res) + '\n'); }

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch (e) { return; }
  const res = { id: req.id };
  try {
    switch (req.cmd) {
      case 'ping':   res.ok = true; break;
      case 'heroes': res.heroes = SG.HEROES.map(h => ({ id: h.id, name: h.name })); res.ok = true; break;
      case 'new':
        st = SG.newGame({ seed: req.seed | 0, p0: req.p0, p1: req.p1 });
        res.state = snap(); res.events = takeEvents(); res.ok = true; break;
      case 'apply':
        SG.apply(st, req.move);
        res.state = snap(); res.events = takeEvents(); res.ok = true; break;
      case 'ai':
        res.move = SG.aiStep(st) || { t: 'end' }; res.ok = true; break;
      default:
        res.ok = false; res.error = '未知命令: ' + req.cmd;
    }
  } catch (err) {
    res.ok = false; res.error = String((err && err.message) || err);
  }
  reply(res);
});
"""


class EngineError(RuntimeError):
    """引擎进程异常（node 缺失、崩溃、超时）。"""


class Reject(Exception):
    """给玩家看的错误提示（会直接显示在页面上）。"""


def extract_engine_js(html_path):
    """接入点 1：从 game.html 抽出 <script id="engine"> 源码。"""
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    m = re.search(r'<script id="engine">([\s\S]*?)</script>', html)
    if not m:
        raise SystemExit(
            '错误：在 %s 里找不到 <script id="engine">。\n'
            '请确认这是原始游戏页面（引擎脚本必须带 id="engine"）。' % html_path
        )
    return m.group(1)


class EngineBridge:
    """一个房间一个 Node 引擎进程，行分隔 JSON 通信。"""

    NODE = shutil.which("node") or shutil.which("node.exe")

    def __init__(self, engine_js):
        if not EngineBridge.NODE:
            raise EngineError(
                "找不到 node 命令，规则引擎无法启动。\n"
                "原游戏的规则是 JavaScript 写的，服务器需要 Node.js 来运行它：\n"
                "  1) 安装 Node.js（https://nodejs.org ，选 LTS 版本）\n"
                "  2) 重新打开终端，确认 `node -v` 能输出版本号\n"
                "  3) 再运行本脚本"
            )
        self.dir = tempfile.mkdtemp(prefix="sanguo-engine-")
        with open(os.path.join(self.dir, "engine.js"), "w", encoding="utf-8") as f:
            f.write(engine_js)
        with open(os.path.join(self.dir, "driver.js"), "w", encoding="utf-8") as f:
            f.write(DRIVER_JS)
        self.proc = subprocess.Popen(
            [EngineBridge.NODE, "driver.js"], cwd=self.dir,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self.lock = threading.Lock()
        self.seq = 0
        self.stderr_tail = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stderr(self):
        try:
            for line in self.proc.stderr:
                self.stderr_tail.append(line.rstrip())
                del self.stderr_tail[:-20]
        except Exception:
            pass

    def call(self, cmd, timeout=10, **kw):
        with self.lock:
            if self.proc.poll() is not None:
                raise EngineError("引擎进程已退出：\n" + "\n".join(self.stderr_tail[-5:]))
            self.seq += 1
            req_id = self.seq
            try:
                self.proc.stdin.write(json.dumps(dict(cmd=cmd, id=req_id, **kw),
                                                 ensure_ascii=False) + "\n")
                self.proc.stdin.flush()
            except Exception as e:
                raise EngineError("向引擎进程写入失败：%s" % e)

            deadline = time.time() + timeout
            while time.time() < deadline:
                line = self.proc.stdout.readline()
                if not line:
                    raise EngineError("引擎进程无响应：\n" + "\n".join(self.stderr_tail[-5:]))
                try:
                    res = json.loads(line)
                except ValueError:
                    continue
                if res.get("id") != req_id:
                    continue                      # 跳过历史残留行
                if not res.get("ok"):
                    raise EngineError(res.get("error") or "引擎返回错误")
                return res
            raise EngineError("引擎响应超时（%ss）" % timeout)

    def close(self):
        try:
            if self.proc.poll() is None:
                self.proc.stdin.close()
                self.proc.terminate()
                self.proc.wait(timeout=2)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        shutil.rmtree(self.dir, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════
# 接入点 2：状态数据 —— 视角对调，让每个玩家都看到"自己在下方"
# ══════════════════════════════════════════════════════════════════
def rotate_state(st):
    """把 p0 / p1 视角互换（深拷贝，不动服务器里的权威状态）。"""
    s = copy.deepcopy(st)
    s["p"] = [s["p"][1], s["p"][0]]
    s["turn"] = 1 - s["turn"]
    a = s.get("awaiting")
    if isinstance(a, dict):
        for k in ("p", "from", "dying"):
            if isinstance(a.get(k), int):
                a[k] = 1 - a[k]
    for ev in s.get("events") or []:
        if isinstance(ev.get("p"), int):
            ev["p"] = 1 - ev["p"]
        if isinstance(ev.get("w"), int) and ev["w"] >= 0:
            ev["w"] = 1 - ev["w"]
    for lg in s.get("log") or []:
        if isinstance(lg.get("who"), int):
            lg["who"] = 1 - lg["who"]
    w = s.get("winner")
    if isinstance(w, int) and w >= 0:
        s["winner"] = 1 - w
    return s


def mask_state(st, seat):
    """接入点 2：按座位生成"这一方能看"的状态。
    对手手牌只保留张数（内容换成 ?），牌堆 / 弃牌堆不外发，防止开控制台偷看。"""
    s = rotate_state(st) if seat == 1 else copy.deepcopy(st)
    hide = (1,) if seat in (0, 1) else (0, 1)
    for i in hide:
        s["p"][i]["hand"] = ["?"] * len(s["p"][i]["hand"])
    s["deck"] = []
    s["discard"] = []
    return s


def active_seat(state):
    """当前该谁动：有等待响应就等响应方，否则是轮到的玩家；-1 = 无对局 / 已结束。"""
    if not state or state.get("over"):
        return -1
    a = state.get("awaiting")
    if isinstance(a, dict) and isinstance(a.get("p"), int):
        return a["p"]
    return state.get("turn", 0)


# 等待态只接受对应动作；出牌阶段只接受出牌类动作（防止乱发把状态搞乱）
AWAIT_ACTIONS = {
    "yusuan": {"yusuan"}, "keep": {"keep"}, "trim": {"trim"},
    "jinglan": {"jinglan"}, "dodge": {"dodge", "bagua"}, "qinglong": {"qinglong"},
    "dying": {"dying"}, "save": {"save"}, "discard": {"discard"}, "jinghong": {"jinghong"},
    "duel": {"duel"}, "guohe": {"guohe"}, "shunshou": {"shunshou"},
    "wuxie": {"wuxie"}, "nanman": {"nanman"}, "wanjian": {"wanjian"},
}
PLAY_ACTIONS = {"slash", "peach", "wzsy", "nu", "ruiqi", "qimou", "lijian", "yehuo", "zhijian",
                "jiu", "juedou", "guohe", "shunshou", "nanman", "wanjian", "equip", "end"}


def check_move(state, move):
    """None = 可以执行；否则返回给玩家看的中文原因。"""
    if not isinstance(move, dict) or not isinstance(move.get("t"), str):
        return "无效的操作"
    a = state.get("awaiting")
    if isinstance(a, dict) and a.get("type"):
        if move["t"] not in AWAIT_ACTIONS.get(a["type"], set()):
            return "现在需要响应【%s】，不能执行该操作" % a["type"]
    elif move["t"] not in PLAY_ACTIONS:
        return "现在是出牌阶段，不能执行该操作"
    return None


# ══════════════════════════════════════════════════════════════════
# 玩家 / 房间
# ══════════════════════════════════════════════════════════════════
ROOMS = {}
ROOMS_LOCK = threading.RLock()
CONNS = {}                       # token -> set(Queue)：全局连接表（接入点 4）
CONNS_LOCK = threading.RLock()
ENGINE_JS = ""
HERO_IDS = []


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def idle_payload(message=""):
    return {"type": "sync", "status": "idle", "seat": -1, "host": False, "code": "",
            "players": [], "spectators": 0, "game": None, "message": message}


def send_to(token, payload):
    with CONNS_LOCK:
        conns = list(CONNS.get(token) or ())
    for q in conns:
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass


def is_online(token):
    with CONNS_LOCK:
        return bool(CONNS.get(token))


def new_code():
    """4 位房间号，去掉易混淆的 0/O/1/I。"""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    with ROOMS_LOCK:
        while True:
            code = "".join(random.choice(alphabet) for _ in range(4))
            if code not in ROOMS:
                return code


class Seat:
    def __init__(self, name, token, ai=False):
        self.name = name
        self.token = token
        self.hero = None
        self.ready = False
        self.ai = ai
        self.online = True

    def public(self, idx):
        return {"seat": idx, "name": self.name, "hero": self.hero,
                "ready": self.ready, "online": self.online if not self.ai else True,
                "ai": self.ai}


class Room:
    def __init__(self, code):
        self.code = code
        self.lock = threading.RLock()
        self.seats = [None, None]        # 0 号位 = 房主，1 号位 = 挑战者 / 电脑
        self.specs = {}                  # token -> 昵称（观战）
        self.status = "select"           # select | playing | over | closed
        self.state = None                # 引擎权威状态（接入点 2）
        self.message = ""
        self.tick = 0                    # 状态版本号：客户端据此判断"新事件"
        self.bridge = None
        self.ai_thread = None
        self.last_seen = time.time()

    # ---- 身份 ----
    def seat_of(self, token):
        for i, s in enumerate(self.seats):
            if s and s.token == token:
                return i
        return -1

    def is_host(self, token):
        return self.seat_of(token) == 0

    def members(self):
        """房间里的所有 token（含观战）。"""
        out = [s.token for s in self.seats if s]
        out.extend(self.specs.keys())
        return out

    def online_members(self):
        return [t for t in self.members() if t.startswith("ai:") or is_online(t)]

    # ---- 引擎 ----
    def ensure_bridge(self):
        if self.bridge is None:
            self.bridge = EngineBridge(ENGINE_JS)
        return self.bridge

    def close_bridge(self):
        if self.bridge:
            self.bridge.close()
            self.bridge = None

    # ---- 广播（每个接收者一份，视角不同）----
    def sync_payload(self, seat):
        game = mask_state(self.state, seat) if self.state else None
        return {
            "type": "sync", "code": self.code, "status": self.status,
            "seat": seat, "host": (seat == 0),
            "players": [s.public(i) for i, s in enumerate(self.seats) if s],
            "spectators": len(self.specs), "game": game, "message": self.message,
        }

    def broadcast(self):
        with self.lock:
            tokens = self.members()
            for token in tokens:
                if token.startswith("ai:"):
                    continue
                payload = self.sync_payload(self.seat_of(token))
                send_to(token, payload)
            self.last_seen = time.time()

    def bump(self, state, events):
        """写入新状态并推进版本号（客户端靠 tick 判断是否播新音效）。"""
        self.tick += 1
        state["_t"] = self.tick
        state["events"] = events or []
        self.state = state


def find_room_by_token(token):
    with ROOMS_LOCK:
        rooms = list(ROOMS.values())
    for room in rooms:
        with room.lock:
            if room.seat_of(token) >= 0 or token in room.specs:
                return room
    return None


# ══════════════════════════════════════════════════════════════════
# 连接管理（接入点 4：断线 / 重连）
# ══════════════════════════════════════════════════════════════════
def on_connect(token, q):
    with CONNS_LOCK:
        CONNS.setdefault(token, set()).add(q)
    room = find_room_by_token(token)
    if not room:
        q.put_nowait(idle_payload())
        return
    with room.lock:
        seat = room.seat_of(token)
        if seat >= 0 and room.seats[seat] and not room.seats[seat].ai:
            room.seats[seat].online = True
            if room.message.endswith("等待重连…"):
                room.message = ""
        q.put_nowait(room.sync_payload(seat))
        log("房间 %s：%s 连接%s" % (room.code, seat_label(room, seat), "(重连)" if seat >= 0 else ""))
    room.broadcast()


def on_disconnect(token, q):
    with CONNS_LOCK:
        qs = CONNS.get(token)
        if qs:
            qs.discard(q)
            if not qs:
                CONNS.pop(token, None)
        still_here = bool(CONNS.get(token))
    if still_here:
        return                                   # 同一 token 还有别的标签页/连接
    room = find_room_by_token(token)
    if not room:
        return
    with room.lock:
        seat = room.seat_of(token)
        if seat >= 0 and room.seats[seat] and not room.seats[seat].ai:
            room.seats[seat].online = False
            room.message = "%s 掉线了，等待重连…" % room.seats[seat].name
            log("房间 %s：%s 掉线" % (room.code, room.seats[seat].name))
            if room.status in ("playing", "select"):
                threading.Thread(target=watch_disconnect, args=(room, seat), daemon=True).start()
    room.broadcast()


def watch_disconnect(room, seat):
    """掉线宽限：超时仍未回来就结束对局。"""
    deadline = time.time() + DISCONNECT_TIMEOUT
    while time.time() < deadline:
        time.sleep(2)
        with room.lock:
            if room.status not in ("playing", "select"):
                return
            s = room.seats[seat]
            if s is None or s.online:
                return
    with room.lock:
        if room.status in ("playing", "select"):
            room.status = "closed"
            room.message = "有玩家掉线超过 %d 秒，本局结束。" % DISCONNECT_TIMEOUT
            room.close_bridge()
            log("房间 %s：掉线超时关闭" % room.code)
    room.broadcast()


def seat_label(room, seat):
    if seat < 0:
        return "观战者"
    s = room.seats[seat]
    return ("%d 号位 %s" % (seat + 1, s.name)) if s else "空位"


def cleanup_loop():
    while True:
        time.sleep(20)
        now = time.time()
        with ROOMS_LOCK:
            rooms = list(ROOMS.items())
        for code, room in rooms:
            with room.lock:
                idle = (not room.online_members()) and now - room.last_seen > ROOM_IDLE_TIMEOUT
                done = room.status == "closed" and not room.online_members()
                if idle or done:
                    room.close_bridge()
                    with ROOMS_LOCK:
                        ROOMS.pop(code, None)
                    log("房间 %s 已回收" % code)


# ══════════════════════════════════════════════════════════════════
# 业务动作（全部抛 Reject 表示"给玩家看的错误"）
# ══════════════════════════════════════════════════════════════════
def clean_name(name):
    name = (name or "").strip()[:8]
    return name or "无名玩家"


def require_room(token):
    room = find_room_by_token(token)
    if not room:
        raise Reject("你还没有加入任何房间")
    return room


def act_create(token, msg):
    old = find_room_by_token(token)
    if old:
        raise Reject("你已经在房间 %s 里了，先「离开房间」再建新的" % old.code)
    with ROOMS_LOCK:
        if len(ROOMS) >= MAX_ROOMS:
            raise Reject("服务器房间已满（%d 个），请稍后再试" % MAX_ROOMS)
    name = clean_name(msg.get("name"))
    code = new_code()
    room = Room(code)
    with ROOMS_LOCK:
        ROOMS[code] = room
    with room.lock:
        room.seats[0] = Seat(name, token)
    log("创建房间 %s（房主：%s）" % (code, name))
    return room


def act_join(token, msg):
    code = (msg.get("code") or "").strip().upper()
    name = clean_name(msg.get("name"))
    with ROOMS_LOCK:
        room = ROOMS.get(code)
    if not room:
        raise Reject("房间号「%s」不存在，确认一下是不是打错了" % (code or "空"))
    with room.lock:
        if room.seat_of(token) >= 0 or token in room.specs:
            return room                                   # 已在房里（刷新 / 重连）
        free = [i for i in (0, 1) if room.seats[i] is None]
        if free:
            room.seats[free[0]] = Seat(name, token)
            log("房间 %s：%s 加入 %d 号位" % (code, name, free[0] + 1))
        elif room.status == "playing":
            room.specs[token] = name
            log("房间 %s：%s 以观战身份加入" % (code, name))
        else:
            raise Reject("房间 %s 已满（两位玩家都在），换个房间吧" % code)
    return room


def act_pick(token, msg):
    room = require_room(token)
    with room.lock:
        seat = room.seat_of(token)
        if seat < 0:
            raise Reject("观战模式不能选将")
        if room.status == "playing":
            raise Reject("对局已经开始，不能换将")
        hero = msg.get("hero")
        if hero not in HERO_IDS:
            raise Reject("没有这位武将：%s" % hero)
        room.seats[seat].hero = hero
        room.seats[seat].ready = False
    return room


def act_ready(token, msg):
    room = require_room(token)
    with room.lock:
        seat = room.seat_of(token)
        if seat < 0:
            raise Reject("观战模式不需要准备")
        s = room.seats[seat]
        if not s.hero:
            raise Reject("先选一位武将再准备")
        s.ready = bool(msg.get("ready"))
    return room


def act_add_ai(token, msg):
    room = require_room(token)
    with room.lock:
        if not room.is_host(token):
            raise Reject("只有房主能加电脑")
        if room.status == "playing":
            raise Reject("对局进行中，不能加电脑")
        if room.seats[1] is not None:
            raise Reject("1 号位已经有人了")
        ai = Seat("电脑", "ai:" + uuid.uuid4().hex, ai=True)
        pool = [h for h in HERO_IDS if h != (room.seats[0].hero if room.seats[0] else None)]
        ai.hero = random.choice(pool or HERO_IDS)
        ai.ready = True
        room.seats[1] = ai
        log("房间 %s：房主加入电脑对手（%s）" % (room.code, ai.hero))
    return room


def act_start(token, msg):
    room = require_room(token)
    with room.lock:
        if not room.is_host(token):
            raise Reject("只有房主能开始对局")
        if room.status == "playing":
            raise Reject("对局已经开始了")
        a, b = room.seats[0], room.seats[1]
        if not a or not b:
            raise Reject("还差一位玩家；也可以点「加一台电脑」先和电脑打")
        for s, idx in ((a, 1), (b, 2)):
            if not s.ai and not s.ready:
                raise Reject("%d 号位还没点「准备」" % idx)
        for s in (a, b):                                  # 没选将的自动补一个
            if not s.hero:
                s.hero = random.choice(HERO_IDS)
        room.message = ""
        res = room.ensure_bridge().call(
            "new", p0=a.hero, p1=b.hero, seed=random.randint(1, 2 ** 31 - 1))
        room.bump(res["state"], res.get("events"))
        room.status = "playing"
        log("房间 %s 开局：%s（%s） vs %s（%s）"
            % (room.code, a.name, a.hero, b.name, b.hero))
    return room


def act_move(token, msg):
    room = require_room(token)
    with room.lock:
        seat = room.seat_of(token)
        if seat < 0:
            raise Reject("观战模式不能出牌")
        if room.status != "playing" or not room.state:
            raise Reject("当前没有进行中的对局")
        if room.state.get("over"):
            raise Reject("对局已结束，可以点「再来一局」")
        if active_seat(room.state) != seat:
            raise Reject("现在不是你的回合，等对手行动")
        move = msg.get("move")
        bad = check_move(room.state, move)
        if bad:
            raise Reject(bad)
        try:
            res = room.bridge.call("apply", move=move)
        except EngineError as e:
            room.status = "closed"
            room.message = "规则引擎出错：%s" % e
            raise Reject(room.message)
        room.bump(res["state"], res.get("events"))
        if room.state.get("over"):
            room.status = "over"
            room.message = room.state.get("overReason") or "对局结束"
            log("房间 %s 对局结束" % room.code)
    kick_ai(room)
    return room


def act_rematch(token, msg):
    room = require_room(token)
    with room.lock:
        if room.seat_of(token) < 0:
            raise Reject("观战模式不能发起重开")
        if room.status not in ("over", "closed"):
            raise Reject("现在还不能重开")
        room.status = "select"
        room.state = None
        room.tick = 0
        room.message = ""
        for s in room.seats:
            if s and not s.ai:
                s.ready = False
        room.close_bridge()
        log("房间 %s：回到选将" % room.code)
    return room


def act_leave(token, msg):
    room = find_room_by_token(token)
    if not room:
        send_to(token, idle_payload())
        return None
    with room.lock:
        seat = room.seat_of(token)
        if seat >= 0:
            s = room.seats[seat]
            name = s.name
            room.seats[seat] = None
            if room.status in ("playing", "over"):
                room.status = "closed"
                room.message = "%s 离开了对局。" % name
            room.close_bridge()
            log("房间 %s：%s 离开" % (room.code, name))
        room.specs.pop(token, None)
        humans = [s for s in room.seats if s and not s.ai]      # 只剩电脑也要回收
        if not humans:
            with ROOMS_LOCK:
                ROOMS.pop(room.code, None)
            log("房间 %s 已解散" % room.code)
            send_to(token, idle_payload())
            return None
    send_to(token, idle_payload())
    room.broadcast()
    return None


def kick_ai(room):
    """轮到电脑就自动出牌（复用引擎自带的 aiStep）。"""
    with room.lock:
        if room.status != "playing" or not room.state:
            return
        if active_seat(room.state) != 1:
            return
        if not (room.seats[1] and room.seats[1].ai):
            return
        if room.ai_thread and room.ai_thread.is_alive():
            return
        room.ai_thread = threading.Thread(target=ai_loop, args=(room,), daemon=True)
        room.ai_thread.start()


def ai_loop(room):
    while True:
        time.sleep(AI_STEP_DELAY)
        with room.lock:
            if room.status != "playing" or not room.state:
                return
            if active_seat(room.state) != 1:
                return
            try:
                mv = room.bridge.call("ai").get("move") or {"t": "end"}
                res = room.bridge.call("apply", move=mv)
            except EngineError as e:
                room.status = "closed"
                room.message = "规则引擎出错：%s" % e
                room.broadcast()
                return
            room.bump(res["state"], res.get("events"))
            if room.state.get("over"):
                room.status = "over"
                room.message = room.state.get("overReason") or "对局结束"
            log("房间 %s：电脑出牌 %s" % (room.code, mv.get("t")))
        room.broadcast()
        if room.status != "playing":
            return


ACTIONS = {
    "create": act_create, "join": act_join, "pick": act_pick, "ready": act_ready,
    "add_ai": act_add_ai, "start": act_start, "move": act_move,
    "rematch": act_rematch, "leave": act_leave,
}


# ══════════════════════════════════════════════════════════════════
# HTTP / SSE
# ══════════════════════════════════════════════════════════════════
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8", ".png": "image/png",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
        ".ico": "image/x-icon", ".json": "application/json; charset=utf-8"}

_page_cache = {"html": None}


def served_page():
    """接入点 3 的载体：原页面 + 注入联机外壳（不修改磁盘上的 game.html）。"""
    if _page_cache["html"]:
        return _page_cache["html"]
    path = os.path.join(BASE_DIR, GAME_FILE)
    if not os.path.isfile(path):
        raise SystemExit("错误：找不到游戏页面 %s" % path)
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()
    if "</body>" not in html:
        raise SystemExit("错误：%s 结构不符合预期（缺少 </body>）" % path)
    html = html.replace("</head>", '<style id="mp-style">%s</style>\n</head>' % CLIENT_CSS, 1)
    html = html.replace("</body>", "<script>\n%s\n</script>\n</body>" % CLIENT_JS, 1)
    _page_cache["html"] = html.encode("utf-8")
    return _page_cache["html"]


class Handler(BaseHTTPRequestHandler):
    server_version = "SanguoLAN/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass                                    # 静音默认访问日志

    # ---- 基础 ----
    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False),
                   "application/json; charset=utf-8")

    def _error(self, msg, code=200):
        self._json({"ok": False, "error": msg}, code)

    # ---- GET ----
    def do_GET(self):
        u = urlparse(self.path)
        path = u.path
        if path in ("/", "/index.html", "/game.html"):
            try:
                self._send(200, served_page(), "text/html; charset=utf-8")
            except SystemExit as e:
                self._error(str(e), 500)
            return
        if path == "/api/health":
            self._json({"ok": True, "rooms": len(ROOMS),
                        "uptime": int(time.time() - START_TIME)})
            return
        if path == "/api/events":
            self._sse(parse_qs(u.query))
            return
        if path.startswith("/art/"):
            self._static(path[len("/art/"):])
            return
        self._error("没有这个地址：%s" % path, 404)

    def _static(self, rel):
        root = os.path.normpath(os.path.join(BASE_DIR, ART_DIR))
        full = os.path.normpath(os.path.join(root, rel.replace("\\", "/").lstrip("/")))
        if not full.startswith(root) or not os.path.isfile(full):
            self._error("文件不存在：%s" % rel, 404)
            return
        with open(full, "rb") as f:
            self._send(200, f.read(), MIME.get(os.path.splitext(full)[1].lower(),
                                               "application/octet-stream"))

    # ---- SSE 下行 ----
    def _sse(self, query):
        token = (query.get("token") or [""])[0].strip() or uuid.uuid4().hex
        q = queue.Queue(maxsize=256)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def write(event, data):
            self.wfile.write(("event: %s\ndata: %s\n\n"
                              % (event, json.dumps(data, ensure_ascii=False))).encode("utf-8"))
            self.wfile.flush()

        try:
            write("hello", {"token": token})
            on_connect(token, q)
            last_ping = time.time()
            while True:
                try:
                    payload = q.get(timeout=1)
                except queue.Empty:
                    # 每 1 秒探一次对端是否已关闭（手机锁屏 / 切后台会立刻断），
                    # 这样掉线能在 1 秒内被发现，而不是等一个心跳周期。
                    if self._peer_gone():
                        break
                    if time.time() - last_ping >= SSE_PING_INTERVAL:
                        last_ping = time.time()
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                    continue
                write(payload.get("type", "sync"), payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            on_disconnect(token, q)

    def _peer_gone(self):
        try:
            r, _, _ = select.select([self.connection], [], [], 0)
            if not r:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    # ---- POST 上行 ----
    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/action":
            self._error("没有这个接口：%s" % u.path, 404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            msg = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._error("请求格式错误（需要 JSON）", 400)
            return

        token = (msg.get("token") or "").strip() or uuid.uuid4().hex
        kind = msg.get("type")
        fn = ACTIONS.get(kind)
        if not fn:
            self._json({"ok": False, "error": "未知操作：%s" % kind, "token": token})
            return
        try:
            room = fn(token, msg)
            self._json({"ok": True, "token": token,
                        "room": room.code if isinstance(room, Room) else None})
            if isinstance(room, Room):
                room.broadcast()                 # 统一在一处广播，避免重复推送
        except Reject as e:
            self._json({"ok": False, "error": str(e), "token": token})
        except EngineError as e:
            log("引擎异常：%s" % e)
            self._json({"ok": False, "error": "规则引擎异常：%s" % e, "token": token})
        except Exception as e:                    # 兜底：单次请求出错不能让服务挂掉
            log("内部错误：%r" % e)
            self._json({"ok": False, "error": "服务器内部错误：%s" % e, "token": token})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        """客户端中途断开（刷新页面 / 手机锁屏 / Wi-Fi 抖动）是常态，
        这类连接类异常不该打印堆栈吓人，直接忽略；真正的程序错误照常打印。"""
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def lan_addresses():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))               # 不真的发包，只为拿到出口网卡 IP
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except Exception:
        pass
    return sorted(ips)

# ══════════════════════════════════════════════════════════════════
# 接入点 3：注入页面的联机外壳（大厅 UI + 5 个 monkey patch）
# ══════════════════════════════════════════════════════════════════
CLIENT_CSS = r"""
#mpgate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
  background:#EDEAE3;padding:16px;}
#mpgate .gbox{width:100%;max-width:360px;background:#FBF6EA;border:1px solid #D8D3C6;border-radius:14px;
  padding:18px 16px;box-shadow:0 6px 24px rgba(0,0,0,.08);}
#mpgate h3{font-size:17px;margin-bottom:6px;font-family:"KaiTi","STKaiti",serif;}
#mpgate .ghint{font-size:12px;color:#8a857a;line-height:1.7;margin-bottom:10px;}
#mpgate label{font-size:12px;color:#6b665c;display:block;margin:10px 0 4px;}
#mpgate input{width:100%;padding:10px;border:1px solid #c3beb0;border-radius:8px;font-size:14px;
  background:#fff;color:#3B332A;font-family:inherit;}
#mpgate .grow{display:flex;gap:8px;margin-top:8px;}
#mpgate .grow input{flex:1;min-width:0;text-transform:uppercase;}
#mpgate .grow button{flex:none;padding:10px 16px;}
#mpgate .gerr{color:#B03A2E;font-size:12px;margin-top:10px;min-height:16px;line-height:1.5;}
#mpbar{margin:0 0 12px;}
#mpbar .barcard{background:#FBF6EA;border:1px solid #D8D3C6;border-radius:12px;padding:10px 12px;}
#mpbar .brow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;}
#mpbar .code{font-family:"KaiTi","STKaiti",serif;font-weight:700;font-size:17px;letter-spacing:2px;
  color:#31597E;}
#mpbar .copy{color:#31597E;font-size:12px;cursor:pointer;text-decoration:underline;}
#mpbar .seatline{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;}
#mpbar .seat{font-size:12px;background:#fff;border:1px solid #D8D3C6;border-radius:8px;
  padding:6px 8px;line-height:1.5;}
#mpbar .seat.on{border-color:#31597E;box-shadow:0 0 0 2px rgba(49,89,126,.12);}
#mpbar .seat.off{opacity:.55;}
#mpbar .seat b{font-family:"KaiTi","STKaiti",serif;font-size:13px;}
#mpbar .wait{font-size:12px;color:#8a857a;}
#mppill{position:fixed;left:8px;top:8px;z-index:900;background:rgba(251,246,234,.96);
  border:1px solid #D8D3C6;border-radius:999px;padding:6px 12px;font-size:11.5px;color:#6b665c;
  display:none;align-items:center;gap:8px;box-shadow:0 2px 10px rgba(0,0,0,.06);}
#mppill .x{color:#B03A2E;cursor:pointer;font-weight:700;}
#mpnet{position:fixed;right:8px;top:44px;z-index:900;background:#FBEEE6;color:#8a4b2a;
  border:1px solid #e0c9b8;border-radius:999px;padding:6px 12px;font-size:11.5px;display:none;}
@media screen and (max-width:640px){
  #mpgate .gbox{padding:16px 14px;}
  #mpbar .brow{font-size:12px;}
}
"""

CLIENT_JS = r"""
(function () {
  'use strict';
  if (location.protocol === 'file:') return;   // 直接双击打开文件时完全保持原样

  var MP = window.MP = {
    token: localStorage.getItem('mp_token') || '',
    seat: -1, host: false, code: '', status: 'idle',
    players: [], spectators: 0, on: false, started: false, joined: false, lastTick: 0
  };
  var es = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function err(msg) {
    var el = $('mperr'); if (el) el.textContent = msg || '';
    // 对局中大厅是隐藏的，错误必须弹到棋盘上，否则玩家看不到
    var gate = $('mpgate');
    if (msg && gate && gate.style.display === 'none') toast(msg);
  }
  function toast(msg) {
    if (typeof window.flash === 'function') { try { window.flash(msg); return; } catch (e) {} }
    alert(msg);
  }

  // ── 传输：POST 上行 + SSE 下行（都在标准库里，不需要第三方库） ──
  function api(payload) {
    var body = JSON.stringify(Object.assign({ token: MP.token }, payload));
    return fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.token) { MP.token = d.token; localStorage.setItem('mp_token', d.token); }
      if (d && d.error) { err(d.error); window.busy = false; }   // 被拒绝时解锁界面
      return d;
    }).catch(function () {
      err('连不上服务器：确认手机和电脑在同一个 Wi-Fi，且服务器还在运行');
      window.busy = false;                                      // 断网也要能继续操作
      return null;
    });
  }

  function connect() {
    if (typeof EventSource === 'undefined') { err('该浏览器不支持实时联机，请用 Chrome / Safari'); return; }
    if (es) { try { es.close(); } catch (e) {} }
    es = new EventSource('/api/events?token=' + encodeURIComponent(MP.token));
    es.addEventListener('hello', function (e) {
      var d = JSON.parse(e.data);
      MP.token = d.token; localStorage.setItem('mp_token', d.token);
      net(false);
    });
    es.addEventListener('sync', function (e) { onSync(JSON.parse(e.data)); });
    es.onopen = function () { net(false); };
    es.onerror = function () { net(true); };     // EventSource 会自动重连，重连后服务器补发状态
  }
  function net(bad) {
    var el = $('mpnet');
    if (el) { el.style.display = bad ? 'block' : 'none'; el.textContent = '与服务器断开，正在重连…'; }
  }

  // ── 服务器状态 → 界面 ──────────────────────────────────────
  function onSync(d) {
    var wasIdle = MP.status === 'idle';
    MP.status = d.status; MP.seat = d.seat; MP.host = !!d.host;
    MP.code = d.code || ''; MP.players = d.players || [];
    MP.spectators = d.spectators || 0; MP.on = d.status !== 'idle';
    if (MP.on) MP.joined = true;
    if (d.status === 'idle' && MP.joined) {
      MP.joined = false;
      err('房间已关闭（服务器可能重启过），请重新创建或加入');
    }

    if (d.game) {
      var tk = d.game._t || 0;
      var fresh = tk !== MP.lastTick;          // 同一版本的重复推送不再重播音效
      MP.lastTick = tk;
      window.mode = 'pvp';                     // 复用原界面双人视图，不跑本地 AI
      window.G = d.game;
      window.G.events = fresh ? (d.game.events || []) : [];
      window.busy = false; window.sel = [];
      $('mpgate').style.display = 'none';
      $('setup').style.display = 'none';
      $('board').style.display = 'block';
      if (!MP.started) { MP.started = true; try { SFX.start(); } catch (e) {} }
      window.render();
      if (d.game.over || d.status === 'closed') showEnd(d);
    } else {
      MP.started = false; MP.lastTick = 0;
      window.G = null;
      $('board').style.display = 'none';
      $('setup').style.display = 'block';
      $('ov').className = 'ov';
      $('mpgate').style.display = (d.status === 'idle') ? 'flex' : 'none';
      if (d.status === 'closed') showEnd(d);
      syncHero();
      if (window.renderPicks) window.renderPicks();
    }
    renderBar(); renderPill();
    if (wasIdle && MP.on) err('');
  }

  function syncHero() {
    var me = playerByIdx(MP.seat);
    if (me && me.hero) window.myHero = me.hero;
  }

  function showEnd(d) {
    var g = d.game || {}, title, text;
    if (d.status === 'closed') { title = '对局结束'; text = d.message || '房间已关闭'; }
    else if (g.winner === 0) { title = '胜利！'; text = g.overReason || ''; }
    else if (g.winner < 0) { title = '平局'; text = g.overReason || ''; }
    else if (MP.seat >= 0) { title = '再接再厉'; text = g.overReason || ''; }
    else { title = '对局结束'; text = '观战结束'; }
    $('ovTitle').textContent = title;
    $('ovText').textContent = text;
    $('ov').className = 'ov on';
  }

  // ── 大厅 / 房间条 / 角标 ──────────────────────────────────
  function buildShell() {
    var gate = document.createElement('div');
    gate.id = 'mpgate';
    gate.innerHTML =
      '<div class="gbox">' +
        '<h3>局域网联机</h3>' +
        '<p class="ghint">同一个 Wi-Fi 下：一人创建房间，把房间号或邀请链接发给大家就能一起玩。</p>' +
        '<label>你的名字</label><input id="mpname" maxlength="8" placeholder="如：爸爸 / 小明">' +
        '<div class="grow"><button class="pri" id="mpcreate">创建房间</button></div>' +
        '<label>已有房间号</label>' +
        '<div class="grow"><input id="mpcode" maxlength="4" placeholder="4 位房间号">' +
          '<button id="mpjoin">加入</button></div>' +
        '<p class="gerr" id="mperr"></p>' +
      '</div>';
    document.body.appendChild(gate);

    var bar = document.createElement('div');
    bar.id = 'mpbar';
    var setup = $('setup');
    if (setup) setup.insertBefore(bar, setup.firstChild);

    var pill = document.createElement('div');
    pill.id = 'mppill';
    document.body.appendChild(pill);

    var n = document.createElement('div');
    n.id = 'mpnet';
    document.body.appendChild(n);

    $('mpname').value = localStorage.getItem('mp_name') || '';
    var q = new URLSearchParams(location.search).get('room');
    if (q) $('mpcode').value = q.toUpperCase();

    $('mpcreate').onclick = function () { joinFlow({ type: 'create' }); };
    $('mpjoin').onclick = function () {
      var code = ($('mpcode').value || '').trim().toUpperCase();
      if (code.length !== 4) { err('房间号是 4 位字母或数字'); return; }
      joinFlow({ type: 'join', code: code });
    };
    $('mpname').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('mpcreate').click();
    });
    $('mpcode').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('mpjoin').click();
    });
  }

  function joinFlow(payload) {
    var name = ($('mpname').value || '').trim();
    if (!name) { err('先给自己起个名字'); return; }
    localStorage.setItem('mp_name', name);
    payload.name = name;
    err('');
    api(payload);                                  // 结果通过 SSE 推回来
  }

  function playerByIdx(i) {
    return MP.players.filter(function (p) { return p.seat === i; })[0] || null;
  }
  function heroName(id) {
    var h = ((window.SG && SG.HEROES) || []).filter(function (x) { return x.id === id; })[0];
    return h ? h.name : '';
  }

  function renderBar() {
    var bar = $('mpbar');
    if (!bar) return;
    if (!MP.on) { bar.innerHTML = ''; return; }
    var rows = '', i, p;
    for (i = 0; i < 2; i++) {
      p = playerByIdx(i);
      var tag = i === 0 ? '①' : '②';
      if (!p) {
        rows += '<div class="seat off"><b>' + tag + '</b> 等待加入…</div>';
      } else {
        rows += '<div class="seat' + (p.seat === MP.seat ? ' on' : '') +
          (p.online ? '' : ' off') + '"><b>' + tag + ' ' + esc(p.name) + '</b>' +
          (p.hero ? ' · ' + esc(heroName(p.hero)) : ' · 未选将') +
          (p.ready ? ' · 已准备' : '') + (p.ai ? ' · 电脑' : (p.online ? '' : ' · 掉线')) +
          '</div>';
      }
    }
    var me = playerByIdx(MP.seat);
    var both = !!playerByIdx(0) && !!playerByIdx(1);
    var allReady = both && MP.players.every(function (x) { return x.ai || x.ready; });
    var btns = '';
    if (MP.seat >= 0) {
      btns += '<button id="mpready">' + (me && me.ready ? '取消准备' : '准备') + '</button>';
      if (MP.host && !playerByIdx(1)) btns += '<button id="mpai">加一台电脑</button>';
      if (MP.host) {
        btns += '<button class="pri" id="mpstart"' +
          (both && allReady ? '' : ' disabled') + '>开始对战</button>';
      } else {
        btns += '<span class="wait">等房主开始</span>';
      }
    } else {
      btns += '<span class="wait">观战中（' + MP.spectators + ' 人围观）</span>';
    }
    btns += '<span class="copy" id="mpleave">离开房间</span>';

    bar.innerHTML =
      '<div class="barcard">' +
        '<div class="brow"><span>房间号</span><span class="code">' + esc(MP.code) + '</span>' +
          '<span class="copy" id="mpcopy">复制邀请链接</span></div>' +
        '<div class="seatline">' + rows + '</div>' +
        '<div class="brow">' + btns + '</div>' +
      '</div>';

    var elReady = $('mpready');
    if (elReady) elReady.onclick = function () { api({ type: 'ready', ready: !(me && me.ready) }); };
    var elAi = $('mpai');
    if (elAi) elAi.onclick = function () { api({ type: 'add_ai' }); };
    var elStart = $('mpstart');
    if (elStart) elStart.onclick = function () { api({ type: 'start' }); };
    var elCopy = $('mpcopy');
    if (elCopy) elCopy.onclick = function () {
      var url = location.origin + '/?room=' + MP.code;
      var done = function () {
        elCopy.textContent = '已复制';
        setTimeout(function () { elCopy.textContent = '复制邀请链接'; }, 1500);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done);
      else prompt('把链接发给朋友：', url);
    };
    var elLeave = $('mpleave');
    if (elLeave) elLeave.onclick = leaveRoom;
  }

  function renderPill() {
    var pill = $('mppill');
    if (!pill) return;
    if (!MP.on || !window.G) { pill.style.display = 'none'; return; }
    var me = playerByIdx(MP.seat);
    pill.style.display = 'flex';
    pill.innerHTML = '<span>房间 ' + esc(MP.code) + '</span><span>' +
      (MP.seat < 0 ? '观战中' : ('你是 ' + (MP.seat === 0 ? '①' : '②') + ' ' +
        esc(me ? me.name : ''))) + '</span><span class="x" id="mpquit">离开</span>';
    var elQuit = $('mpquit');
    if (elQuit) elQuit.onclick = leaveRoom;
  }

  function leaveRoom() {
    if (!confirm('确定离开房间？对局中离开会结束本局。')) return;
    api({ type: 'leave' }).then(function () {
      MP.on = false; MP.status = 'idle'; MP.joined = false;
      window.G = null;
      $('board').style.display = 'none';
      $('setup').style.display = 'block';
      $('mpgate').style.display = 'flex';
      $('ov').className = 'ov';
      renderBar(); renderPill();
    });
  }

  // ── 接入点 3：把原界面的 5 个入口接到服务器 ─────────────────
  var _apply = SG.apply;
  SG.apply = function (st, mv) {
    if (!MP.on || st !== window.G) return _apply.apply(SG, arguments);
    if (MP.seat < 0) { toast('观战模式不能出牌'); return st; }
    window.busy = true;                     // 等服务器确认前禁止连点
    api({ type: 'move', move: mv });
    return st;                              // 本地不推进，以服务器快照为准
  };

  var _pick = window.pick;
  window.pick = function (id) {
    if (!MP.on) return _pick(id);
    if (MP.seat < 0) { toast('观战模式不能选将'); return; }
    if (MP.status === 'playing') { toast('对局中不能换将'); return; }
    window.myHero = id;
    try { SFX.click(); } catch (e) {}
    api({ type: 'pick', hero: id });
    window.renderPicks();
  };

  var _startGame = window.startGame;
  window.startGame = function () {
    if (!MP.on) return _startGame();        // 没进房间时保留原本的本地对战
    api({ type: 'start' });                 // 权限由服务器判定（只有房主能开）
  };

  var _again = window.again;
  window.again = function () {
    if (!MP.on) return _again();
    $('ov').className = 'ov';
    api({ type: 'rematch' });
  };

  var _backSetup = window.backSetup;
  window.backSetup = function () {
    if (!MP.on) return _backSetup();
    leaveRoom();
  };

  var _viewIdx = window.viewIdx;
  window.viewIdx = function () { return MP.on ? 0 : _viewIdx(); };

  var _renderActs = window.renderActs;
  window.renderActs = function () {
    if (!MP.on) return _renderActs();
    var box = $('acts');
    if (!box) return;
    if (MP.seat < 0) { box.innerHTML = '<span class="wait">观战中：正在看两位玩家对局</span>'; return; }
    if (!window.G || window.G.over) return _renderActs();
    if (SG.active(window.G) !== 0) {
      var foe = (window.G.p && window.G.p[1]) ? window.G.p[1].name : '对手';
      box.innerHTML = '<span class="wait">等待 ' + esc(foe) + ' 行动…</span>';
      return;
    }
    return _renderActs();
  };

  // ── 启动 ─────────────────────────────────────────────────
  buildShell();
  var rowbtn = document.querySelector('#setup .rowbtn');
  if (rowbtn) rowbtn.style.display = 'none';   // 隐藏"电脑 / 同机双人"那排，改用房间条
  connect();
})();
"""


# ══════════════════════════════════════════════════════════════════
# 启动 / 退出
# ══════════════════════════════════════════════════════════════════
def parse_args(argv):
    p = argparse.ArgumentParser(description="三国武将卡 · 局域网多人对战服务器")
    p.add_argument("--host", default=HOST, help="监听地址（默认 0.0.0.0 = 局域网可访问）")
    p.add_argument("--port", type=int, default=PORT, help="端口（默认 %d）" % PORT)
    p.add_argument("--game", default=GAME_FILE, help="游戏页面文件名（默认 game.html）")
    p.add_argument("--ai-delay", type=float, default=AI_STEP_DELAY, help="电脑出牌间隔秒数")
    p.add_argument("--timeout", type=int, default=DISCONNECT_TIMEOUT,
                   help="掉线等待重连的秒数（默认 %d）" % DISCONNECT_TIMEOUT)
    return p.parse_args(argv)


def main(argv=None):
    global HOST, PORT, GAME_FILE, ENGINE_JS, HERO_IDS, AI_STEP_DELAY, DISCONNECT_TIMEOUT
    args = parse_args(argv)
    HOST, PORT, GAME_FILE = args.host, args.port, args.game
    AI_STEP_DELAY, DISCONNECT_TIMEOUT = args.ai_delay, args.timeout

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    game_path = os.path.join(BASE_DIR, GAME_FILE)
    if not os.path.isfile(game_path):
        print("错误：找不到游戏页面 %s\n请把本脚本与 game.html 放同一目录，或用 --game 指定。"
              % game_path)
        return 2

    # 启动自检：引擎能加载、武将能取到，出问题现在就说清楚，别等开局才炸
    try:
        ENGINE_JS = extract_engine_js(game_path)                 # 接入点 1
        probe = EngineBridge(ENGINE_JS)
        try:
            HERO_IDS = [h["id"] for h in probe.call("heroes").get("heroes", [])]
        finally:
            probe.close()
    except (EngineError, SystemExit) as e:
        print("启动失败：%s" % e)
        return 2
    if not HERO_IDS:
        print("启动失败：引擎没有返回任何武将，请检查 game.html 是否完整。")
        return 2

    try:
        httpd = Server((HOST, PORT), Handler)
    except OSError as e:
        print("错误：无法监听 %s:%d —— %s\n换个端口试试：python lan_server.py --port 8766"
              % (HOST, PORT, e))
        return 2

    threading.Thread(target=cleanup_loop, daemon=True).start()

    print("=" * 64)
    print("三国武将卡 · 局域网对战已启动（%d 位武将可用；Ctrl+C 退出）" % len(HERO_IDS))
    print("-" * 64)
    if HOST in ("0.0.0.0", ""):
        for ip in lan_addresses():
            print("  局域网访问：  http://%s:%d" % (ip, PORT))
    else:
        print("  访问地址：    http://%s:%d" % (HOST, PORT))
    print("  本机自测：    http://127.0.0.1:%d" % PORT)
    print("-" * 64)
    print("玩法：一人进页面点「创建房间」；其他人输入 4 位房间号加入。")
    print("      两位玩家都「准备」后，房主点「开始对战」。")
    print("      掉线 %d 秒内重连可回到原座位。" % DISCONNECT_TIMEOUT)
    print("=" * 64)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭服务器…")
    finally:
        httpd.shutdown()
        httpd.server_close()
        with ROOMS_LOCK:
            rooms = list(ROOMS.values())
            ROOMS.clear()
        for room in rooms:
            with room.lock:
                room.status = "closed"
                room.message = "服务器已关闭。"
            room.broadcast()
            room.close_bridge()
        print("已关闭（本次运行 %d 秒）。" % int(time.time() - START_TIME))
    return 0


if __name__ == "__main__":
    sys.exit(main())
