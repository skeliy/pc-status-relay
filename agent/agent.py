# -*- coding: utf-8 -*-
"""
PC status agent (Windows専用)

このスクリプトをステータスを共有したいPC(友達のPCや自分のPC)で常駐実行します。
定期的に「今フォアグラウンドで開いているウィンドウ」と「最後に入力があってからの秒数」を調べ、
中継サーバー(relay-server)へ送信します。

また、このPC上で http://127.0.0.1:<local_ui_port>/ を開くと、
「お風呂中」「準備中」のようなカスタムステータスを分数指定で設定できます
(設定した時間が経過すると自動的に元の自動検出表示に戻ります)。

さらに、Apple Music(ブラウザ版)の曲を友達と同時に再生する「曲の共有」機能があります
(music_sync.py / popup.py / extension フォルダ。使い方は README.md)。

必要なライブラリのインストール:
    pip install -r requirements.txt
    (必須: pywin32 psutil requests / トレイアイコンを使う場合だけ: pystray Pillow)

初回起動時、同じフォルダに config.json が無ければテンプレートを自動生成して終了します。
config.json を開いて設定値を書き換えてから、もう一度実行してください。

設定値(SERVER_URLやWRITE_TOKENなど)を config.json に外出ししているのは、
agent.py 自体をアップデートしたときに設定をやり直さずに済むようにするためです。
新しい agent.py / status_logic.py / local_status_server.py に差し替えても、
config.json はそのまま使い続けられます。
"""

import json
import os
import subprocess
import sys
import threading
import time

try:
    import requests
    import win32gui
    import win32process
    import win32api
    import psutil
except ImportError as e:
    print("必要なライブラリが不足しています。次のコマンドを実行してください:")
    print("    pip install -r requirements.txt")
    print(f"詳細: {e}")
    sys.exit(1)

from status_logic import StatusOverride, StatusTracker, compute_status_fields, tracking_key_for
from local_status_server import start_local_ui_server

# tray_icon / music_sync / popup は、自動アップデートで後から届くファイルなので、
# ここではまだ読み込まない(無くても起動できるように、main_loop の中で読み込む)。


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")

DEFAULT_CONFIG = {
    "server_url": "https://your-relay-server.example.com/api/status",
    "write_token": "CHANGE_ME_TO_A_LONG_RANDOM_SECRET",
    "pc_id": "pc1",
    "pc_label": "Toroのパソコン",
    "post_interval_sec": 8,
    "afk_threshold_sec": 60,
    "request_timeout_sec": 5,
    "local_ui_port": 8787,
    "auto_update_enabled": True,
    "update_base_url": "https://raw.githubusercontent.com/USERNAME/REPO/main/agent",
    "show_tray_icon": False,
    "dashboard_url": "",
    "music_enabled": True,
    "music_hotkey": "ctrl+alt+m",
    "update_check_interval_min": 30,
}


def load_or_create_config():
    if not os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        print(f"config.json が無かったので雛形を作成しました: {CONFIG_PATH}")
        print("中身を編集してから、もう一度 python agent.py を実行してください。")
        sys.exit(0)

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

    # 将来config.jsonに新しい項目が増えても、無ければデフォルト値で補う
    merged = dict(DEFAULT_CONFIG)
    merged.update(config)
    return merged


# ---------------------------------------------------------------------------
# 自動アップデート
# ---------------------------------------------------------------------------
# update_base_url(GitHubの agent フォルダ)にある VERSION が手元と違うか、FILES に書かれた
# ファイルが手元に無ければ、FILES のファイルを全部ダウンロードして入れ替え、再起動する。
#
# 以前の updater.py は決まった3つのファイルしか取りに行かなかったので、新しいファイルを
# 増やしても友達のPCに届かなかった。この agent.py はその3つに含まれるので、古いバージョンから
# でも「まず agent.py が新しくなる → 新しい agent.py が残りのファイルを全部取ってくる」という
# 2段階で、最新の状態までたどり着ける。config.json には一切触らない。
VERSION_PATH = os.path.join(SCRIPT_DIR, "VERSION")
PLACEHOLDER_MARKER = "USERNAME/REPO"


def _read_local_version():
    try:
        with open(VERSION_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "0.0.0"


def _safe_relative_path(name):
    """FILES に書かれたパスが、agent フォルダの中を指しているか確かめる(変な場所に書き込まないため)。"""
    norm = os.path.normpath(name.replace("/", os.sep))
    if os.path.isabs(norm) or norm.startswith("..") or os.path.basename(norm).lower() == "config.json":
        return None
    return norm


def restart_self():
    """このプログラムをもう一度起動し直して、今のプロセスは終わる。"""
    args = [sys.executable, os.path.abspath(__file__)] + sys.argv[1:]
    subprocess.Popen(args, cwd=SCRIPT_DIR)
    os._exit(0)


def self_update(config):
    if not config.get("auto_update_enabled", True):
        return
    base = (config.get("update_base_url") or "").rstrip("/")
    if not base or PLACEHOLDER_MARKER in base:
        return
    try:
        resp = requests.get(base + "/VERSION", timeout=8)
        resp.raise_for_status()
        remote_version = resp.text.strip()
        resp = requests.get(base + "/FILES", timeout=8)
        resp.raise_for_status()
        names = [ln.strip() for ln in resp.text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    except Exception as e:
        print(f"[アップデート確認] 確認できませんでした(通常どおり起動します): {e}")
        return
    if not remote_version or not names:
        return

    paths = []
    for name in names:
        rel = _safe_relative_path(name)
        if rel is None:
            print(f"[アップデート] 不正なファイル名を無視しました: {name}")
            continue
        paths.append((name, rel))

    local_version = _read_local_version()
    missing = [rel for _, rel in paths if not os.path.exists(os.path.join(SCRIPT_DIR, rel))]
    if remote_version == local_version and not missing:
        print(f"[アップデート確認] 最新版です (version {local_version})")
        return

    print(f"[アップデート] {local_version} -> {remote_version} に更新します(足りないファイル {len(missing)} 個)")
    downloaded = []
    try:
        for name, rel in paths:
            resp = requests.get(base + "/" + name, timeout=15)
            resp.raise_for_status()
            content = resp.content
            if not content.strip():
                raise ValueError(f"{name} が空でした")
            if rel.endswith(".py"):
                compile(content.decode("utf-8"), rel, "exec")  # 壊れたコードは適用しない
            downloaded.append((rel, content))
    except Exception as e:
        print(f"[アップデート] ダウンロードか確認に失敗したので、今回は更新しません: {e}")
        return

    try:
        for rel, content in downloaded:
            path = os.path.join(SCRIPT_DIR, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(content)
        with open(VERSION_PATH, "w", encoding="utf-8") as f:
            f.write(remote_version)
    except OSError as e:
        print(f"[アップデート] ファイルを書き込めませんでした: {e}")
        return

    print("[アップデート] 更新しました。新しいバージョンで起動し直します...")
    restart_self()


def start_periodic_update(config, override, music):
    """起動中も30分ごとに新しいバージョンを確認する(以前は起動した時しか確認しなかったので、
    PCを付けっぱなしの友達には、再起動するまで更新が届かなかった)。
    カスタムステータスや曲の共有の最中は、再起動で消えてしまうので更新を後回しにする。"""
    interval = float(config.get("update_check_interval_min", 30)) * 60
    if interval <= 0:
        return

    def busy():
        if override.snapshot()[0]:
            return True
        return music is not None and (music.session is not None or music.pending_out is not None)

    def loop():
        while True:
            time.sleep(interval)
            if busy():
                continue
            try:
                self_update(config)  # 新しければここで再起動するので戻ってこない
            except Exception as e:
                print(f"[アップデート確認] エラー: {e}")

    threading.Thread(target=loop, name="update-check", daemon=True).start()


def get_idle_seconds() -> float:
    """最後にマウス/キーボード入力があってからの経過秒数を返す(Windows API)。"""
    last_input_info = win32api.GetLastInputInfo()
    tick_count = win32api.GetTickCount()
    idle_millis = tick_count - last_input_info
    if idle_millis < 0:
        idle_millis = 0
    return idle_millis / 1000.0


def get_foreground_info():
    """現在フォアグラウンドのウィンドウのタイトルと実行ファイル名を返す。"""
    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return None, None

    title = win32gui.GetWindowText(hwnd) or None

    exe_name = None
    try:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        if pid:
            proc = psutil.Process(pid)
            exe_name = proc.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied, Exception):
        exe_name = None

    return title, exe_name


def build_payload(config, override: StatusOverride, tracker: StatusTracker):
    idle_sec = get_idle_seconds()
    title, exe_name = get_foreground_info()
    fields = compute_status_fields(
        idle_seconds=idle_sec,
        window_title=title,
        exe_name=exe_name,
        override_snapshot=override.snapshot(),
        afk_threshold_sec=config["afk_threshold_sec"],
    )
    # 「今の状態」がどれくらい続いているか(同じアプリ/AFK/カスタムが続いている時間)
    duration_sec = tracker.update(tracking_key_for(fields, exe_name))

    payload = {
        "id": config["pc_id"],
        "label": config["pc_label"],
        "processName": exe_name,
        "idleSeconds": round(idle_sec, 1),
        "durationSeconds": round(duration_sec, 1),
    }
    payload.update(fields)
    return payload


def start_music(config):
    """曲の共有機能を起動する。必要なファイルが無い・使えない環境では何もしない。"""
    if not config.get("music_enabled", True):
        return None
    try:
        from music_sync import MusicSync
        from popup import make_notifier, start_hotkey
    except Exception as e:
        print(f"[曲の共有] 起動できませんでした(ファイル不足?): {e}")
        return None
    try:
        music = MusicSync(config, notifier=make_notifier())
    except Exception as e:
        print(f"[曲の共有] 起動できませんでした: {e}")
        return None
    try:
        label = start_hotkey(config.get("music_hotkey", "ctrl+alt+m"), music.toggle)
        if label:
            music.hotkey_label = label
    except Exception as e:
        print(f"[ショートカット] 登録できませんでした(トレイアイコンや Apple Music の画面からは使えます): {e}")
    return music


def main_loop(config):
    override = StatusOverride()
    tracker = StatusTracker()

    for attempt in range(20):  # 再起動直後は古いプロセスがまだポートを使っていることがあるので少し粘る
        try:
            start_local_ui_server(override, config["local_ui_port"])
            print(
                f"[カスタムステータス設定] http://127.0.0.1:{config['local_ui_port']}/ "
                "をこのPCのブラウザで開くと設定できます"
            )
            break
        except OSError as e:
            if attempt == 19:
                print(f"[警告] ローカル設定用サーバーを起動できませんでした(ポート使用中?): {e}")
            else:
                time.sleep(0.5)

    music = start_music(config)
    start_periodic_update(config, override, music)

    if config.get("show_tray_icon", False):
        try:
            from tray_icon import start_tray_icon

            if start_tray_icon(config, music=music):
                print("[トレイアイコン] タスクバー右下(通知領域)にアイコンを表示しました")
        except Exception as e:
            print(f"[トレイアイコン] 表示できませんでした: {e}")

    print(f"[起動] pc_id={config['pc_id']} pc_label={config['pc_label']} -> {config['server_url']}")
    headers = {"Authorization": f"Bearer {config['write_token']}", "Content-Type": "application/json"}

    while True:
        try:
            payload = build_payload(config, override, tracker)
            resp = requests.post(
                config["server_url"], json=payload, headers=headers, timeout=config["request_timeout_sec"]
            )
            if resp.status_code != 200:
                print(f"[警告] サーバーからエラー応答: {resp.status_code} {resp.text[:200]}")
            else:
                tag = "カスタム" if payload["isCustom"] else ("AFK" if payload["isAfk"] else "自動")
                mins = int(payload["durationSeconds"] // 60)
                print(f"[送信:{tag}] status={payload['status']!r} 継続={mins}分")
        except requests.exceptions.RequestException as e:
            print(f"[警告] サーバーへの送信に失敗しました: {e}")
        except Exception as e:
            print(f"[エラー] 予期しないエラー: {e}")

        time.sleep(config["post_interval_sec"])


if __name__ == "__main__":
    cfg = load_or_create_config()
    self_update(cfg)  # 新しいバージョンがあれば適用して自動的に再起動する(無ければ何もしない)
    if "CHANGE_ME" in cfg["write_token"] or "your-relay-server.example.com" in cfg["server_url"]:
        print(f"先に {CONFIG_PATH} を編集してから実行してください(server_url / write_token)。")
        sys.exit(1)
    try:
        main_loop(cfg)
    except KeyboardInterrupt:
        print("\n終了しました。")
