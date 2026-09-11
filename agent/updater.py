# -*- coding: utf-8 -*-
"""
agent.py 起動時に、コードの最新版をネット上から自動で取得して適用するための仕組み。

これがあることで、あなたがコードを直すたびに友達へファイルを送り直してもらう
必要が無くなります。友達のPCのagent.pyは、起動するたびに「もっと新しいバージョンが
公開されていないか」を確認し、あれば自動でダウンロード・適用してから自分自身を
再起動します(config.jsonの設定値は変更しません)。

必要な準備(あなた側):
  1. agent/ フォルダ一式(agent.py, status_logic.py, local_status_server.py, VERSION)を
     GitHubなどにアップロードしておく(コードには秘密の値=WRITE_TOKENなどは
     一切含まれていないので、公開リポジトリで問題ありません)
  2. コードを直したら VERSION ファイルの中身を書き換えて(例: "1.0.0" -> "1.1.0")、
     アップロードし直す

友達側は何もしなくてOKです。config.json の update_base_url をあなたのGitHubの
raw URLに設定しておけば、あとは自動で追従します。

安全のための工夫:
  - ダウンロードしたコードは書き込む前に構文チェック(compile)し、壊れていたら適用しない
  - update_base_url が未設定(初期値のまま)なら何もしない
  - ネットワークエラー時は静かに諦めて通常通り起動する(アップデートは必須ではないため)
"""

import os
import sys

try:
    import requests
except ImportError:
    requests = None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VERSION_FILE = os.path.join(SCRIPT_DIR, "VERSION")
UPDATED_FILES = ["agent.py", "status_logic.py", "local_status_server.py"]

PLACEHOLDER_MARKER = "USERNAME/REPO"


def _local_version():
    if os.path.exists(VERSION_FILE):
        with open(VERSION_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    return "0.0.0"


def _fetch_text(url, timeout=5):
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.text


def check_and_apply_update(config):
    """必要ならアップデートを適用して、プロセスを再起動する(戻ってこない)。
    アップデートが無い/できない場合は普通に return する。
    """
    if not config.get("auto_update_enabled", True):
        return
    if requests is None:
        return

    base_url = (config.get("update_base_url") or "").rstrip("/")
    if not base_url or PLACEHOLDER_MARKER in base_url:
        return  # 未設定ならアップデート機能自体を使わない

    try:
        remote_version = _fetch_text(base_url + "/VERSION").strip()
    except Exception as e:
        print(f"[アップデート確認] 確認できませんでした(オフライン等の可能性、通常起動を続けます): {e}")
        return

    if not remote_version:
        return

    local_version = _local_version()
    if remote_version == local_version:
        print(f"[アップデート確認] 最新版です (version {local_version})")
        return

    print(f"[アップデート] 新しいバージョンを検出しました: {local_version} -> {remote_version}")

    downloaded = {}
    try:
        for filename in UPDATED_FILES:
            code = _fetch_text(base_url + "/" + filename)
            if not code.strip():
                raise ValueError(f"{filename} が空でした")
            compile(code, filename, "exec")  # 構文が壊れているコードを適用しないための安全策
            downloaded[filename] = code
    except Exception as e:
        print(f"[アップデート] ダウンロードまたは検証に失敗したため、今回は適用せず続行します: {e}")
        return

    try:
        for filename, code in downloaded.items():
            path = os.path.join(SCRIPT_DIR, filename)
            with open(path, "w", encoding="utf-8") as f:
                f.write(code)
        with open(VERSION_FILE, "w", encoding="utf-8") as f:
            f.write(remote_version)
    except OSError as e:
        print(f"[アップデート] ファイルの書き込みに失敗しました: {e}")
        return

    print("[アップデート] 適用しました。新しいバージョンで再起動します...")
    os.execv(sys.executable, [sys.executable] + sys.argv)
