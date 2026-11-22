"""中継サーバー(Render)の記録を、この PC に預かっておく係。

中継サーバーは更新や再起動のたびに、覚えていたことを全部忘れる。
そこで「前に一緒に聴いたことのある人」や「Listen Together アプリを入れた人の一覧」を、
暗号化したまま1分ごとに受け取って relay_backup.json に保存しておき、
サーバーが起動し直した時に送り返して元に戻してもらう。

- relay_backup.json がある PC(持ち主の PC だけ)でしか動かない。ほかの人の PC では何もしない
- 中身はサーバー側の鍵(持ち主用のトークンから作る)で暗号化されていて、この PC では読めない
- relay_backup.json は人によって違うファイルなので、自動アップデートの対象にも GitHub にも入れない
"""

import json
import os
import threading
import time
from datetime import datetime

FILE_NAME = "relay_backup.json"


def _relay_base(url):
    url = (url or "").rstrip("/")
    for suffix in ("/api/status", "/api/update"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
    return url


def _load(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def sync_once(base, headers, path, get, post):
    """1回分。戻り値は何をしたか('saved' / 'restored' / 'unsupported' など。テスト用)。"""
    r = get(base + "/api/backup", headers=headers, timeout=20)
    if r.status_code == 404:
        return "unsupported"  # まだ古いサーバー、または持ち主用のトークンが無い
    r.raise_for_status()
    d = r.json()
    if not d.get("restored"):
        # サーバーが起動し直したばかり → 預かっていた分を送り返す(無ければ「無い」と伝える)
        blob = _load(path).get("blob")
        r2 = post(base + "/api/backup/restore", json={"blob": blob}, headers=headers, timeout=30)
        if r2.status_code == 400 and blob:
            # 鍵が変わったなどで読めなかった → 何も無かったことにして、これから新しく預かる
            post(base + "/api/backup/restore", json={"blob": None}, headers=headers, timeout=30)
            return "reset"
        r2.raise_for_status()
        return "restored" if blob else "empty"
    blob = d.get("blob")
    if isinstance(blob, str) and blob:
        _save(path, {"blob": blob, "savedAt": datetime.now().isoformat(timespec="seconds")})
        return "saved"
    return "nothing"


def start_relay_backup(config, script_dir, get=None, post=None, sleep=time.sleep):
    path = os.path.join(script_dir, FILE_NAME)
    if not os.path.exists(path):
        return None  # 持ち主の PC ではない
    if get is None or post is None:
        import requests

        get = get or requests.get
        post = post or requests.post
    base = _relay_base(config.get("server_url"))
    headers = {"Authorization": f"Bearer {config.get('write_token', '')}"}

    def loop():
        last = None
        while True:
            try:
                what = sync_once(base, headers, path, get, post)
                if what in ("restored", "empty", "reset"):
                    print(f"[中継サーバーの控え] サーバーに送り返しました({what})")
                last = None
            except Exception as e:
                msg = type(e).__name__
                if msg != last:
                    print(f"[中継サーバーの控え] 失敗しました: {msg}")  # 中身や合言葉は出さない
                last = msg
            sleep(60)

    t = threading.Thread(target=loop, name="relay-backup", daemon=True)
    t.start()
    return t
