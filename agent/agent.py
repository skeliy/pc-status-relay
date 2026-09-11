# -*- coding: utf-8 -*-
"""
PC status agent (Windows専用)

このスクリプトをステータスを共有したいPC(友達のPCや自分のPC)で常駐実行します。
定期的に「今フォアグラウンドで開いているウィンドウ」と「最後に入力があってからの秒数」を調べ、
中継サーバー(relay-server)へ送信します。

また、このPC上で http://127.0.0.1:<local_ui_port>/ を開くと、
「お風呂中」「準備中」のようなカスタムステータスを分数指定で設定できます
(設定した時間が経過すると自動的に元の自動検出表示に戻ります)。

必要なライブラリのインストール:
    pip install -r requirements.txt
    (中身: pywin32 psutil requests)

初回起動時、同じフォルダに config.json が無ければテンプレートを自動生成して終了します。
config.json を開いて設定値を書き換えてから、もう一度実行してください。

設定値(SERVER_URLやWRITE_TOKENなど)を config.json に外出ししているのは、
agent.py 自体をアップデートしたときに設定をやり直さずに済むようにするためです。
新しい agent.py / status_logic.py / local_status_server.py に差し替えても、
config.json はそのまま使い続けられます。
"""

import json
import os
import sys
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
from updater import check_and_apply_update


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


def main_loop(config):
    override = StatusOverride()
    tracker = StatusTracker()

    try:
        start_local_ui_server(override, config["local_ui_port"])
        print(
            f"[カスタムステータス設定] http://127.0.0.1:{config['local_ui_port']}/ "
            "をこのPCのブラウザで開くと設定できます"
        )
    except OSError as e:
        print(f"[警告] ローカル設定用サーバーを起動できませんでした(ポート使用中?): {e}")

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
    check_and_apply_update(cfg)  # 新しいバージョンがあれば適用して自動的に再起動する(無ければ何もしない)
    if "CHANGE_ME" in cfg["write_token"] or "your-relay-server.example.com" in cfg["server_url"]:
        print(f"先に {CONFIG_PATH} を編集してから実行してください(server_url / write_token)。")
        sys.exit(1)
    try:
        main_loop(cfg)
    except KeyboardInterrupt:
        print("\n終了しました。")
