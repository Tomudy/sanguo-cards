#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键启动局域网对战。

用法：
    python start_lan.py                 # 默认端口 8765，启动后自动打开浏览器
    python start_lan.py --port 8766     # 换端口
    python start_lan.py --no-browser    # 不自动开浏览器（比如在无桌面环境）

双击同目录的「启动局域网.bat」效果相同。
其余参数与 lan_server.py 完全一致，原样透传。
"""
import sys
import threading
import webbrowser

import lan_server


def _detect_port(argv):
    """从命令行里找 --port / --port=xxx，其余情况用默认值。"""
    port = lan_server.PORT
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--port" and i + 1 < len(argv):
            port = argv[i + 1]
            break
        if a.startswith("--port="):
            port = a.split("=", 1)[1]
            break
        i += 1
    try:
        return int(port)
    except (TypeError, ValueError):
        return lan_server.PORT


def _open_browser(url):
    try:
        webbrowser.open(url)
    except Exception:
        pass  # 打不开浏览器不影响服务器运行


def main():
    argv = [a for a in sys.argv[1:] if a != "--no-browser"]
    if "--no-browser" not in sys.argv[1:]:
        url = "http://127.0.0.1:%d" % _detect_port(argv)
        # 延迟 1.5 秒再打开，避免服务器还没监听就显示"无法访问"
        threading.Timer(1.5, _open_browser, args=(url,)).start()
    lan_server.main(argv)


if __name__ == "__main__":
    main()
