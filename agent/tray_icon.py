# -*- coding: utf-8 -*-
"""
タスクバー右下(システムトレイ、時計の近く)に小さなアイコンを常駐させ、
クリックだけでダッシュボードやカスタムステータス設定画面をすぐ開けるようにするモジュール。

・左クリック(またはダブルクリック) → ダッシュボードを開く(config.jsonにdashboard_urlを
  設定していない場合は、中継サーバーから閲覧用の URL をもらって開く。中継サーバーに
  繋がらない時だけ、このPC自身のカスタムステータス設定画面を開く)
・右クリック → メニュー(ダッシュボードを開く/カスタムステータス設定を開く/
  曲の共有をリクエスト・終了/終了)

必要なライブラリ: pystray, Pillow (requirements.txtに含まれています)
これらが入っていない/使えない環境では、エラーにはせず単にトレイアイコンを出さないだけにします
(agent.py自体は今まで通り動きます)。

config.json の "show_tray_icon" を true にした場合だけ有効になります
(友達のPCまで一律で増やしたくない、という理由でデフォルトはfalseにしてあります)。
"""

import threading
import webbrowser

try:
    from PIL import Image, ImageDraw
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

try:
    import pystray
    PYSTRAY_AVAILABLE = True
except ImportError:
    PYSTRAY_AVAILABLE = False

TRAY_AVAILABLE = PIL_AVAILABLE and PYSTRAY_AVAILABLE


def dashboard_target_url(config):
    """トレイアイコンをクリックしたときに開くURLを決める(純粋関数、pystray不要でテスト可能)。

    dashboard_url が config.json に設定されていればそれを、無ければこのPC自身の
    カスタムステータス設定画面(ローカルURL)を返す。
    """
    url = (config.get("dashboard_url") or "").strip()
    if url:
        return url
    return f"http://127.0.0.1:{config.get('local_ui_port', 8787)}/"


def fetch_dashboard_url(config, timeout=8):
    """dashboard_url が設定されていない時、中継サーバーから閲覧用のダッシュボード URL をもらう。
    取れなかった時は None(呼び出し側でカスタムステータス画面に切り替える)。"""
    try:
        import requests
        from music_sync import relay_base_url

        base = relay_base_url(config.get("server_url"))
        if not base:
            return None
        r = requests.get(
            base + "/api/dashboard-link",
            headers={"Authorization": f"Bearer {config.get('write_token', '')}"},
            timeout=timeout,
        )
        if r.status_code != 200:
            return None
        path = (r.json() or {}).get("path") or ""
        if not path.startswith("/dashboard"):
            return None
        return base + path
    except Exception:
        return None


def local_ui_url(config):
    return f"http://127.0.0.1:{config.get('local_ui_port', 8787)}/"


def make_icon_image():
    """トレイに表示する小さな円のアイコン画像を作る(外部の画像ファイル不要)。"""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((4, 4, size - 4, size - 4), fill=(79, 124, 255, 255))
    draw.ellipse(
        (size // 2 - 11, size // 2 - 11, size // 2 + 11, size // 2 + 11),
        fill=(255, 255, 255, 255),
    )
    return img


def start_tray_icon(config, music=None):
    """トレイアイコンをバックグラウンドスレッドで起動する。
    pystray/Pillowが使えない環境では何もせず None を返す(agent.py本体は止めない)。
    """
    if not TRAY_AVAILABLE:
        print("[トレイアイコン] pystray/Pillowが無いため表示をスキップします(pip install -r requirements.txt で追加できます)")
        return None

    fetched = {"url": None}

    def open_dashboard(icon=None, item=None):
        if (config.get("dashboard_url") or "").strip():
            webbrowser.open(dashboard_target_url(config))
            return
        # dashboard_url を書いていない PC: 中継サーバーから URL をもらって開く(1回もらったら覚えておく)
        def run():
            url = fetched["url"] or fetch_dashboard_url(config)
            if url:
                fetched["url"] = url
                webbrowser.open(url)
            else:
                webbrowser.open(local_ui_url(config))  # 中継サーバーに繋がらない時だけ、今まで通り
        threading.Thread(target=run, daemon=True).start()

    def open_local_ui(icon=None, item=None):
        webbrowser.open(local_ui_url(config))

    def quit_app(icon, item=None):
        icon.stop()
        import os

        os._exit(0)

    items = [
        pystray.MenuItem("ダッシュボードを開く", open_dashboard, default=True),
        pystray.MenuItem("カスタムステータス設定を開く", open_local_ui),
    ]
    if music is not None:
        # 文字は開くたびに変わる(「リクエストする」/「取り消す」/「終了する」)
        items.append(pystray.MenuItem(lambda item: music.status_text(), lambda icon, item: music.toggle()))
    items += [pystray.Menu.SEPARATOR, pystray.MenuItem("終了", quit_app)]
    menu = pystray.Menu(*items)

    icon = pystray.Icon(
        "pc_status_agent",
        icon=make_icon_image(),
        title=config.get("pc_label", "PCステータス"),
        menu=menu,
    )

    thread = threading.Thread(target=icon.run, daemon=True)
    thread.start()
    return icon
