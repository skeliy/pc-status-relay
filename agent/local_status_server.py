# -*- coding: utf-8 -*-
"""
友達がこのPC上で「カスタムステータス」を設定するための、ごく小さなローカルWebサーバー。

127.0.0.1 (localhost) だけにバインドするので、外部やインターネットからはアクセスできません。
agent.py 実行中に、このPCのブラウザで http://127.0.0.1:<port>/ を開くと操作画面が出ます。
"""

import html
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

PRESETS = [
    ("お風呂", 20),
    ("準備中", 15),
    ("ご飯", 30),
    ("離席", 30),
    ("会議中", 60),
]


def _page_html(override, message=None):
    active, text, remaining = override.snapshot()

    if active:
        mins = max(1, int(remaining // 60) + (1 if remaining % 60 else 0))
        current_html = (
            f'<div class="current active">現在のカスタムステータス: '
            f'<strong>{html.escape(text)}</strong>(残り約{mins}分)'
            f'<form method="POST" action="/clear" style="display:inline">'
            f'<button type="submit" class="clear-btn">今すぐ解除</button></form></div>'
        )
    else:
        current_html = '<div class="current">現在カスタムステータスは設定されていません(自動検出中)</div>'

    preset_buttons = "".join(
        f'''
        <form method="POST" action="/set" class="preset-form">
          <input type="hidden" name="text" value="{html.escape(label)}">
          <input type="hidden" name="minutes" value="{minutes}">
          <button type="submit">{html.escape(label)} ({minutes}分)</button>
        </form>
        '''
        for label, minutes in PRESETS
    )

    message_html = f'<div class="msg">{html.escape(message)}</div>' if message else ""

    return f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>カスタムステータス設定</title>
<style>
  :root {{
    color-scheme: light dark;
    --bg: #ffffff;
    --text: #1c1e21;
    --text-dim: #6b7280;
    --text-dimmer: #9ca3af;
    --border: #e5e7eb;
    --input-bg: #ffffff;
    --current-bg: #f4f5f7;
    --current-active-bg: #ede9fe;
    --current-active-text: #4c1d95;
    --preset-bg: #ffffff;
    --preset-hover-bg: #f4f5f7;
    --msg-bg: #dcfce7;
    --msg-text: #166534;
    --accent: #4f7cff;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #16181c;
      --text: #f2f3f5;
      --text-dim: #9aa0a8;
      --text-dimmer: #6b7280;
      --border: #33363c;
      --input-bg: #212429;
      --current-bg: #212429;
      --current-active-bg: #3b2f63;
      --current-active-text: #e9d5ff;
      --preset-bg: #212429;
      --preset-hover-bg: #2a2d33;
      --msg-bg: #14332155;
      --msg-text: #86efac;
    }}
  }}
  body {{ font-family: -apple-system, "Segoe UI", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
         max-width: 480px; margin: 32px auto; padding: 0 16px; color: var(--text); background: var(--bg); }}
  h1 {{ font-size: 1.2rem; }}
  .current {{ background: var(--current-bg); border-radius: 10px; padding: 12px 14px; margin-bottom: 20px; font-size: 0.9rem; }}
  .current.active {{ background: var(--current-active-bg); color: var(--current-active-text); }}
  .msg {{ background: var(--msg-bg); color: var(--msg-text); border-radius: 10px; padding: 8px 12px; margin-bottom: 16px; font-size: 0.85rem; }}
  .presets {{ display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }}
  .preset-form button {{
    padding: 8px 12px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--preset-bg); color: var(--text); cursor: pointer; font-size: 0.85rem;
  }}
  .preset-form button:hover {{ background: var(--preset-hover-bg); }}
  .clear-btn {{ margin-left: 10px; font-size: 0.8rem; border: none; background: none;
                color: var(--text-dim); text-decoration: underline; cursor: pointer; }}
  fieldset {{ border: 1px solid var(--border); border-radius: 10px; }}
  legend {{ color: var(--text-dim); }}
  label {{ display: block; font-size: 0.85rem; margin-bottom: 4px; color: var(--text-dim); }}
  input[type=text], input[type=number] {{
    width: 100%; padding: 8px; border-radius: 8px; border: 1px solid var(--border);
    margin-bottom: 12px; box-sizing: border-box; background: var(--input-bg); color: var(--text);
  }}
  button[type=submit].main {{
    padding: 10px 16px; border-radius: 8px; border: none; background: var(--accent); color: #fff; cursor: pointer;
  }}
  p {{ color: var(--text-dimmer); }}
</style>
</head>
<body>
  <h1>カスタムステータス設定</h1>
  {current_html}
  {message_html}

  <div class="presets">
    {preset_buttons}
  </div>

  <fieldset>
    <legend>自由に設定</legend>
    <form method="POST" action="/set">
      <label for="text">表示するテキスト</label>
      <input type="text" id="text" name="text" placeholder="例: 買い物中" required maxlength="40">
      <label for="minutes">何分間</label>
      <input type="number" id="minutes" name="minutes" value="30" min="1" max="600" required>
      <button type="submit" class="main">設定する</button>
    </form>
  </fieldset>

  <p style="color:#9ca3af; font-size:0.8rem; margin-top:24px;">
    設定した時間が経過すると、自動的に元の自動検出(開いているアプリ名 / AFK)表示に戻ります。
  </p>
</body>
</html>"""


def make_handler(override):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass  # コンソールを静かに保つ

        def _write_html(self, body: str, status=200):
            encoded = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def _redirect_home(self):
            self.send_response(303)
            self.send_header("Location", "/")
            self.end_headers()

        def do_GET(self):
            if self.path.rstrip("/") in ("", ""):
                self._write_html(_page_html(override))
            else:
                self._write_html("<p>not found</p>", status=404)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length else b""
            fields = parse_qs(raw.decode("utf-8"))

            if self.path.rstrip("/") == "/set":
                text = (fields.get("text", [""])[0]).strip()
                try:
                    minutes = float(fields.get("minutes", ["0"])[0])
                except ValueError:
                    minutes = 0
                if text and minutes > 0:
                    override.set(text, minutes)
                self._redirect_home()
                return

            if self.path.rstrip("/") == "/clear":
                override.clear()
                self._redirect_home()
                return

            self._write_html("<p>not found</p>", status=404)

    return Handler


def start_local_ui_server(override, port: int, host: str = "127.0.0.1"):
    """バックグラウンドスレッドでローカルUIサーバーを起動して返す(ThreadingHTTPServerインスタンス)。"""
    handler_cls = make_handler(override)
    httpd = ThreadingHTTPServer((host, port), handler_cls)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd
