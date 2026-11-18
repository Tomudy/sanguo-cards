#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""局域网 P1 回归测试（Python 服务端）:

    python tests/lan_p1_test.py

覆盖：房主转移（座位不重排、补电脑到 0 号位）、掉线超时转移、
可选进房口令、服务端签发 token、二维码矩阵正确性、/api/qr 缓存与防滥用、
启动横幅 flush、bat 的 Node 自检、注入客户端 JS 的语法。

零第三方依赖：二维码的期望矩阵是用成熟的 qrcode 库生成后固化成位串真值，
测试本身不需要装任何东西（只依赖项目自带的 Python 标准库 + Node.js）。
"""
import hashlib
import http.client
import io
import json
import os
import queue
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
import lan_server as L  # noqa: E402

PY = sys.executable


def _read(path):
    with io.open(path, encoding="utf-8", newline="") as f:
        return f.read().replace("\r\n", "\n")


def _start(port, extra=(), host="127.0.0.1"):
    p = subprocess.Popen(
        [PY, "lan_server.py", "--host", host, "--port", str(port)] + list(extra),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace")
    for _ in range(80):
        try:
            s = socket.create_connection(("127.0.0.1", port), 0.2)
            s.close()
            return p
        except OSError:
            if p.poll() is not None:
                raise AssertionError("服务器提前退出：" + (p.stdout.read() or "")[:600])
            time.sleep(0.1)
    p.terminate()
    raise AssertionError("服务器未就绪")


def _req(port, method, path, body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    if body is None:
        c.request(method, path, headers=headers or {})
    else:
        h = {"Content-Type": "application/json"}
        h.update(headers or {})
        c.request(method, path, json.dumps(body), h)
    r = c.getresponse()
    status, hs = r.status, dict(r.getheaders())
    if path.startswith("/api/events"):
        c.close()
        return status, hs, None
    data = r.read()
    c.close()
    try:
        return status, hs, json.loads(data.decode("utf-8"))
    except ValueError:
        return status, hs, data.decode("utf-8", "replace")


# ── 二维码期望矩阵（qrcode 8.2 / byte 模式 / L / mask 0 逐格生成后固化） ──
QR_TRUTH = [
    ("http://127.0.0.1:8765/?room=AAAA", 2,
     "1111111000100101101111111/1000001001011101001000001/1011101010001011101011101/"
     "1011101001110000101011101/1011101000100001101011101/1000001001011011101000001/"
     "1111111010101010101111111/0000000011111111000000000/1110111110010110011000100/"
     "0000010111000110001100001/0000001100100100111000111/1101010011111100101100010/"
     "0001101010111111101101011/0001000001001110011101001/1001001010100000110110111/"
     "0100000010001111011101010/1001111101111110111111000/0000000010001000100011111/"
     "1111111010100101101010011/1000001011001111100011010/1011101010011110111110001/"
     "1011101000001011110010111/1011101011001101010011001/1000001010000111110011010/"
     "1111111010100100101100011"),
    ("http://192.168.1.23:8765/?room=AB3D&pw=abc123", 3,
     "11111110001000010001101111111/10000010010001010011101000001/"
     "10111010100100110011001011101/10111010010010110001101011101/"
     "10111010010010011001101011101/10000010001110110111001000001/"
     "11111110101010101010101111111/00000000100101111111000000000/"
     "11101111100011101111011000100/00011001110110111000001101001/"
     "01111011001110000100111110111/10011101111011100110011101010/"
     "00101010001101000111001101011/11011001011101000010001101101/"
     "00001010000000101100000000011/01001101101101100110010011010/"
     "01010110100011001100001000011/01011001110111011110011100101/"
     "10101110100111100110110001011/01110101101011010100011101010/"
     "10111110001111001100111110000/00000000101101011000100010111/"
     "11111110110001100101101011011/10000010111001111111100011000/"
     "10111010101001110100111111010/10111010001001100001110011011/"
     "10111010101010100101010011101/10000010101001111111110001010/"
     "11111110101001111100111001011"),
    ("http://192.168.1.23:8765/?room=AB3D&pw=" + "x" * 40, 5,
     "1111111000100010010101010010001111111/1000001001000100010101010001101000001/"
     "1011101010010001001010101010101011101/1011101001001100101010101001001011101/"
     "1011101001001100110101010000001011101/1000001000111011110101010001101000001/"
     "1111111010101010101010101010101111111/0000000010010001010101010111100000000/"
     "1110111110001000110101010001011000100/0111100110011101101010101100001100111/"
     "1001011100011011101010101000001001001/0001100011001110110101010101101101011/"
     "1100111011010011010101010111101100000/0110010000010011001010101100101100101/"
     "1100111011100100001010101100000001001/0001000101010001010101010100111011010/"
     "0100101011001000110101010101101001001/0011100110011101101010101110101101001/"
     "1010111110111011101010101010000111111/1001010100001110110101010100110101010/"
     "1111001100110011010101010101101101011/0110010100010011001010101110101101101/"
     "0111011100000100001010101100111001111/1001100011010001010101010110001011010/"
     "1000011100101000110101010110001001011/0001000101011101101010101010101101001/"
     "1000101111011011101010101000011010011/0110100100101110110101010110111111010/"
     "1000001100110011110101010101111110000/0000000010110011001010101010100010111/"
     "1111111010100100101010101011101010011/1000001011110001010101010101100011001/"
     "1011101011101001010101010100111111010/1011101000011100101010101010110011010/"
     "1011101011011010101010101011010011111/1000001011101111010101010101100111010/"
     "1111111010010011010101010100111111011"),
]


def _matrix_bits(m):
    return "/".join("".join("1" if c else "0" for c in row) for row in m)


class TestQR(unittest.TestCase):
    def test_matrix_matches_reference(self):
        for text, ver, expected in QR_TRUTH:
            m = L.qr_matrix(text)
            self.assertIsNotNone(m, text)
            size = 17 + 4 * ver
            self.assertEqual((len(m), len(m[0])), (size, size))
            self.assertEqual(_matrix_bits(m), expected, "二维码矩阵不一致：" + text)

    def test_capacity_and_svg(self):
        self.assertIsNotNone(L.qr_matrix("x" * 106))
        self.assertIsNone(L.qr_matrix("x" * 107))
        svg = L.qr_svg(QR_TRUTH[1][0])
        self.assertTrue(svg.startswith("<svg") and svg.endswith("</svg>"))
        self.assertIn("<path", svg)
        self.assertLess(len(svg), 12000, "SVG 应该压缩成单个 path（约 6KB）")
        self.assertGreater(svg.count("M"), 200)


class TestHostHandover(unittest.TestCase):
    """房主转移：座位绝不重排（视角脱敏绑定座位号），只换房主标记。"""

    @classmethod
    def setUpClass(cls):
        L.ENGINE_JS = L.extract_engine_js("game.html")
        probe = L.EngineBridge(L.ENGINE_JS)
        try:
            L.HERO_IDS = [h["id"] for h in probe.call("heroes")["heroes"]]
        finally:
            probe.close()

    def setUp(self):
        self.conns = {}
        self.A, self.B = "p1_test_A", "p1_test_B"

    def online(self, t):
        q = queue.Queue()
        self.conns[t] = q
        with L.CONNS_LOCK:
            L.CONNS.setdefault(t, set()).add(q)

    def offline(self, t):
        with L.CONNS_LOCK:
            L.CONNS.pop(t, None)

    def tearDown(self):
        for t in list(self.conns):
            self.offline(t)
        with L.ROOMS_LOCK:
            for code, room in list(L.ROOMS.items()):
                with room.lock:
                    room.status = "closed"
                    room.close_bridge()
                L.ROOMS.pop(code, None)

    def test_full_chain(self):
        A, B = self.A, self.B
        self.online(A)
        self.online(B)
        room = L.act_create(A, {"name": "爸爸"})
        self.assertEqual(room.host_token, A)
        L.act_join(B, {"code": room.code, "name": "孩子"})
        self.assertTrue(room.is_host(A))
        self.assertFalse(room.is_host(B))
        self.assertFalse(room.sync_payload(1, B)["host"])
        self.assertTrue(room.sync_payload(0, A)["players"][0]["host"])

        L.act_pick(A, {"hero": "boy"})
        L.act_pick(B, {"hero": "lvbu"})
        L.act_ready(A, {"ready": True})
        L.act_ready(B, {"ready": True})
        L.act_start(A, {})
        self.assertEqual(room.status, "playing")

        # 宽限期内掉线不转移（防抖动）
        self.offline(A)
        L.on_disconnect(A, self.conns[A])
        self.assertEqual(room.host_token, A)
        self.assertIsNotNone(room.seats[0])
        self.online(A)
        L.on_connect(A, self.conns[A])

        # 明确离开 → 转移房主、房间不解散
        L.act_leave(A, {})
        self.assertIsNone(room.seats[0])
        self.assertIsNotNone(room.seats[1])
        self.assertEqual(room.host_token, B)
        self.assertIs(L.find_room_by_token(B), room)
        self.assertEqual(room.status, "closed")
        self.assertTrue(room.sync_payload(1, B)["host"])
        self.assertIn("房主", room.message)

        # 新房主补电脑到空出的 0 号位并能重开
        L.act_rematch(B, {})
        self.assertEqual(room.status, "select")
        L.act_add_ai(B, {})
        self.assertTrue(room.seats[0].ai)
        self.assertEqual(room.seats[1].token, B)
        L.act_ready(B, {"ready": True})
        L.act_start(B, {})
        self.assertEqual(room.status, "playing")
        seat = L.active_seat(room.state)
        self.assertIn(seat, (0, 1))
        L.kick_ai(room)  # 电脑在 0 号位也不能误判
        with room.lock:
            room.status = "closed"
            room.close_bridge()

    def test_disconnect_timeout_hands_over(self):
        A, B = self.A, self.B
        self.online(A)
        self.online(B)
        room = L.act_create(A, {"name": "爸爸"})
        L.act_join(B, {"code": room.code, "name": "孩子"})
        old_timeout = L.DISCONNECT_TIMEOUT
        L.DISCONNECT_TIMEOUT = 1
        try:
            self.offline(A)
            L.on_disconnect(A, self.conns[A])
            deadline = time.time() + 6
            while time.time() < deadline and room.host_token != B:
                time.sleep(0.2)
            self.assertEqual(room.host_token, B)
            self.assertEqual(room.status, "closed")
            self.assertIn("房主", room.message)
        finally:
            L.DISCONNECT_TIMEOUT = old_timeout


class TestHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p_free = _start(8911, host="0.0.0.0")
        cls.p_pw = _start(8912, ("--password", "abc123"))

    @classmethod
    def tearDownClass(cls):
        for p in (cls.p_free, cls.p_pw):
            p.terminate()
            p.wait(timeout=8)
            p.stdout.close()

    def test_no_password_is_fully_compatible(self):
        st, _, page = _req(8911, "GET", "/")
        self.assertEqual(st, 200)
        self.assertIn("window.MP_PW_REQUIRED=false", page)
        self.assertIn("qrline", page)
        st, _, d = _req(8911, "POST", "/api/action", {"type": "create", "name": "测试"})
        self.assertTrue(d.get("ok"))
        self.assertEqual(len(d["token"]), 32)
        st, _, _ = _req(8911, "GET", "/api/events?token=" + d["token"])
        self.assertEqual(st, 200)

    def test_password_guard(self):
        st, _, page = _req(8912, "GET", "/")
        self.assertIn("window.MP_PW_REQUIRED=true", page)
        st, _, d = _req(8912, "POST", "/api/action", {"type": "create", "name": "测试"})
        self.assertFalse(d.get("ok"))
        self.assertTrue(d.get("need_pw"))
        st, _, d = _req(8912, "POST", "/api/action",
                        {"type": "create", "name": "测试", "pw": "wrong"})
        self.assertTrue(d.get("need_pw"))
        st, _, d = _req(8912, "POST", "/api/action",
                        {"type": "create", "name": "测试", "pw": "abc123"})
        self.assertTrue(d.get("ok"))
        t = d["token"]
        st, _, _ = _req(8912, "GET", "/api/events?token=" + t)
        self.assertEqual(st, 403, "SSE 也必须挡住绕过口令")
        st, _, _ = _req(8912, "GET", "/api/events?token=" + t + "&pw=abc123")
        self.assertEqual(st, 200)

    def test_server_signed_token(self):
        st, _, d = _req(8912, "POST", "/api/action",
                        {"type": "create", "name": "伪造", "pw": "abc123",
                         "token": "fake_token_xxx"})
        nt = d.get("token")
        self.assertNotEqual(nt, "fake_token_xxx")
        self.assertEqual(len(nt or ""), 32)
        # 同一个签发的 token 再请求，身份保持不变
        st, _, d2 = _req(8912, "POST", "/api/action",
                         {"type": "ready", "token": nt, "pw": "abc123", "ready": True})
        self.assertEqual(d2.get("token"), nt)

    def test_qr_endpoint(self):
        url = "http://192.168.1.23:8765/?room=AB3D&pw=abc123"
        st, h, b = _req(8911, "GET", "/api/qr?text=" + quote(url, safe=""))
        self.assertEqual(st, 200)
        self.assertTrue(h.get("Content-Type", "").startswith("image/svg+xml"))
        self.assertTrue(b.startswith("<svg"))
        et = h.get("ETag")
        self.assertTrue(et)
        self.assertIn("max-age", h.get("Cache-Control") or "")
        st2, _, b2 = _req(8911, "GET", "/api/qr?text=" + quote(url, safe=""),
                          headers={"If-None-Match": et})
        self.assertEqual(st2, 304)
        self.assertFalse(b2, "304 不应带 body")
        st3, _, _ = _req(8911, "GET", "/api/qr?text=" + quote("javascript:alert(1)", safe=""))
        self.assertEqual(st3, 400)
        st4, _, _ = _req(8911, "GET",
                         "/api/qr?text=" + quote("http://x.y/" + "z" * 200, safe=""))
        self.assertEqual(st4, 400)

    def test_launch_banner(self):
        # 启动横幅必须 flush：双击 bat / 强制结束进程也不该丢掉访问地址
        for host, extra, port in (("0.0.0.0", (), 8913),
                                  ("127.0.0.1", ("--password", "abc123"), 8914)):
            p = _start(port, extra, host=host)
            try:
                p.terminate()
                p.wait(timeout=8)
                out = p.stdout.read()
                p.stdout.close()
            except Exception:
                p.kill()
                raise
            self.assertIn("进房口令", out)
            if host == "0.0.0.0":
                self.assertIn("监听范围", out)
                self.assertIn("所有网卡", out)
                self.assertIn("--host <家庭 Wi-Fi 的 IP>", out)
            else:
                self.assertIn("进房口令：    abc123", out)
                self.assertIn("/?pw=abc123", out)


class TestStatic(unittest.TestCase):
    def test_server_source(self):
        src = _read("lan_server.py")
        for needle in ("host_token", "handover_host", "resolve_token",
                       "--password", "MP_PW_REQUIRED", "qr_matrix",
                       "sys.stdout.flush()", "inviteUrl()", "qrline",
                       "if not room.bridge:"):
            self.assertIn(needle, src, "缺少：" + needle)

    def test_bat_checks_node(self):
        bat = _read("启动局域网.bat")
        self.assertIn("where python", bat)
        self.assertIn("where node", bat)
        self.assertIn("Node.js not found", bat)

    def test_client_js_syntax(self):
        src = _read("lan_server.py")
        m = re.search(r'CLIENT_JS = r"""([\s\S]*?)\n"""', src)
        self.assertIsNotNone(m)
        fd, path = tempfile.mkstemp(suffix=".js")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(m.group(1))
            r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
        finally:
            os.remove(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
