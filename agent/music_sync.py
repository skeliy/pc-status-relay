# -*- coding: utf-8 -*-
"""
「一緒に聴く」機能のエージェント側。Apple Music・Spotify・YouTube Music・YouTube のブラウザ版で、
サービスが違っても同じ曲を同時に流す。

仕組み:
  - 中継サーバーに、このPCの「部屋」を開いておく(config の listen_room。中にいる人は全員が曲を変えられる)。
    部屋のホストは同時に1人だけ。部屋が閉じている時はこのPCがホストになり、パスワードを知っている
    ほかの人がすでにホストとして開いていれば、その部屋に参加する
  - 実際の同期(今の曲を読む・同じ曲を探して流す)は、ブラウザ拡張機能(extension/)が部屋の中で行う。
    このファイルは、拡張機能に「どの部屋に入るか(部屋の鍵)」を教える係
  - ショートカットキー(初期値 Ctrl+Alt+M)で友達にリクエストを送り、相手が許可すると、
    相手はこちらの部屋に入る
  - config の listen_password を設定すると、Discord のリンク(/listen/<部屋>)から来た人も
    パスワードで部屋に入れる
  - 誰かが入ってきた・出ていったら、画面右下のポップアップと通知音で知らせる

拡張機能とは http://127.0.0.1:8788 で話す(このPCの中だけ。外からは繋がらない)。
"""

import json
import os
import queue
import re
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import requests
except ImportError:  # agent.py 側で必須チェック済み
    requests = None

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.join(SCRIPT_DIR, "extension")
EXTENSION_MANIFEST = os.path.join(EXTENSION_DIR, "manifest.json")

MUSIC_PORT = 8788  # 拡張機能側にも同じ番号が書いてあるので、変えるなら両方変えること
SERVICE_URLS = {
    "apple": "https://music.apple.com/",
    "spotify": "https://open.spotify.com/",
    "ytm": "https://music.youtube.com/",
    "youtube": "https://www.youtube.com/",
}
SERVICE_NAMES = {"apple": "Apple Music", "spotify": "Spotify", "ytm": "YouTube Music", "youtube": "YouTube", "none": "?"}

REQUEST_TIMEOUT_SEC = 60  # リクエストに応答が無ければ諦めるまでの秒数
ROOM_HEARTBEAT_SEC = 30
MEMBERS_CHECK_SEC = 4
ROOM_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "listen_together.log")


def _log(msg):
    line = f"[一緒に聴く] {msg}"
    print(line, flush=True)
    # 調べる時のために、ファイルにも残す(大きくなったら古いほうを消す)
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 512 * 1024:
            os.replace(LOG_PATH, LOG_PATH + ".old")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + line + "\n")
    except Exception:
        pass


def relay_base_url(server_url):
    """config の server_url(.../api/status)から中継サーバーの根元のURLを作る。"""
    url = (server_url or "").rstrip("/")
    if url.endswith("/api/status"):
        url = url[: -len("/api/status")]
    return url


def room_id_from_config(config):
    raw = str(config.get("listen_room") or config.get("pc_id") or "room").strip().lower()
    cleaned = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")[:32] or "room"
    return cleaned if ROOM_ID_RE.match(cleaned) else "room"


def read_extension_version():
    try:
        with open(EXTENSION_MANIFEST, "r", encoding="utf-8") as f:
            return json.load(f).get("version")
    except (OSError, ValueError):
        return None


class ConsoleNotifier:
    """ポップアップを出せない環境用(ログに出すだけ)。リクエストは音楽サービスの画面からも許可できる。"""

    def ask(self, key, title, message, buttons, timeout_sec, on_timeout=None):
        _log(f"{title}: {message}(音楽サービスの画面の「許可」ボタンでも応答できます)")

    def close(self, key):
        pass

    def toast(self, message, seconds=4):
        _log(message)


class MusicSync:
    def __init__(self, config, notifier=None, open_url=None, clock=None, start_threads=True):
        self.config = config
        self.pc_id = config["pc_id"]
        self.pc_label = config.get("pc_label") or self.pc_id
        self.base_url = relay_base_url(config.get("server_url"))
        self.headers = {"Authorization": f"Bearer {config.get('write_token', '')}"}
        self.room_id = room_id_from_config(config)
        self.password = str(config.get("listen_password") or "")
        self.hotkey_label = config.get("music_hotkey_label", "Ctrl+Alt+M")
        self.notifier = notifier or ConsoleNotifier()
        self.open_url = open_url or webbrowser.open
        self.clock = clock or time.monotonic

        self.lock = threading.RLock()
        self.own_token = None  # 自分の部屋の鍵(持ち主として)
        self.own_you = None  # 自分の部屋での、自分の参加者番号
        self.own_members = []
        self.own_host = True  # 自分の部屋のホストが自分か(ほかの人が先に開いていれば False)
        self.own_owner = self.pc_label  # 自分の部屋のホストの名前
        self._invited_clients = []
        self.agent_card = None  # 拡張機能に渡す「仲間カード」(PC Status の仲間どうしは、最初から一緒に聴ける友達)
        self.joined = None  # 友達の部屋に入っている時 {"id", "token", "owner", "session"}
        self.joined_members = []
        self.pending_out = None  # {"id", "expires"}
        self.pending_in = {}  # sessionId -> {"from", "label", "room", "expires"}
        self.last_ext_tick = 0.0
        # 使っている音楽サービス(拡張機能が教えてくれる。config の music_service で最初から決めておける)
        self.ext_service = config.get("music_service") if config.get("music_service") in SERVICE_URLS else None
        self.waiting_ext_since = None
        self.ever_tick = False

        self.send_queue = queue.Queue()
        self.http = requests.Session() if requests else None
        self._ext_version_cache = (None, None)

        if start_threads:
            self.start()

    # ------------------------------------------------------------------ 起動
    def start(self):
        threading.Thread(target=self._send_worker, name="music-send", daemon=True).start()
        threading.Thread(target=self._poll_loop, name="music-poll", daemon=True).start()
        threading.Thread(target=self._room_loop, name="music-room", daemon=True).start()
        threading.Thread(target=self._housekeeping_loop, name="music-house", daemon=True).start()
        threading.Thread(target=self._serve_extension, name="music-ext", daemon=True).start()

    # ------------------------------------------------------------------ 状態
    def _current_members_locked(self):
        return self.joined_members if self.joined else self.own_members

    def _other_members_locked(self):
        members = self._current_members_locked()
        mine = self.joined["you"] if self.joined else self.own_you
        return [m for m in members if m.get("id") != mine]

    def sharing(self):
        with self.lock:
            return bool(self.joined) or len(self._other_members_locked()) > 0

    def is_busy(self):
        """自動アップデートの再起動を後回しにすべきか。"""
        with self.lock:
            return self.sharing() or self.pending_out is not None

    def status_text(self):
        with self.lock:
            if self.joined:
                return f"{self.joined['owner']} の部屋から退出する"
            others = self._other_members_locked()
            if others:
                return "一緒に聴くのを終了する(" + "、".join(m["label"] for m in others) + ")"
            if self.pending_out:
                return "一緒に聴くリクエストを取り消す"
            return "友達に「一緒に聴く」をリクエストする"

    # ------------------------------------------------------------------ 操作(ショートカット・トレイ・画面のボタン)
    def toggle(self):
        with self.lock:
            if self.joined or self._other_members_locked():
                action = "stop"
            elif self.pending_out:
                action = "cancel"
            else:
                action = "request"
        getattr(self, {"stop": "stop", "cancel": "cancel_request", "request": "request"}[action])()

    def request(self):
        with self.lock:
            if self.pending_out:
                return
            sid = uuid.uuid4().hex[:12]
            self.pending_out = {"id": sid, "expires": self.clock() + REQUEST_TIMEOUT_SEC}

        def on_result(result):
            delivered = (result or {}).get("delivered", 0)
            with self.lock:
                if delivered == 0 and self.pending_out and self.pending_out["id"] == sid:
                    self.pending_out = None
            if result is None:
                self.notifier.toast("中継サーバーに繋がらなかったため、リクエストを送れませんでした")
            elif delivered == 0:
                time.sleep(1.5)  # 拡張機能だけの人への招待の結果を待つ
                if not self._invited_clients:
                    self.notifier.toast("リクエストを送れる相手が見つかりませんでした(友達の PC が起動していないか、ブラウザを開いていない可能性があります)")
            else:
                names = "、".join(r.get("label") or r.get("id") for r in result.get("recipients", []))
                self.notifier.toast(f"{names} に「一緒に聴く」をリクエストしました。許可を待っています…")

        _log(f"リクエストを送信 (session={sid}, 部屋={self.room_id})")
        self._send("*", "request", sid, {"timeoutSec": REQUEST_TIMEOUT_SEC, "room": self.room_id}, on_result=on_result)
        # 前に部屋に入ったことがある「拡張機能だけの人」にも招待を送る(拡張機能に通知と音が届く)
        threading.Thread(target=self._invite_known_clients, daemon=True).start()

    def _invite_known_clients(self):
        self._invited_clients = []
        with self.lock:
            token = self.own_token
        if not token:
            return
        r = self._room_post("invite", {"room": self.room_id, "token": token, "target": "clients"})
        self._invited_clients = [x for x in (r or {}).get("invited", []) if x.get("label")]
        names = "、".join(x.get("label", "") for x in self._invited_clients)
        if names:
            self.notifier.toast(f"前に参加した {names} にも招待を送りました")

    def cancel_request(self):
        with self.lock:
            if not self.pending_out:
                return
            sid = self.pending_out["id"]
            self.pending_out = None
        self._send("*", "stop", sid, {"reason": "cancel"})
        self.notifier.toast("リクエストを取り消しました")

    def stop(self, notify=True):
        """友達の部屋にいれば退出、自分の部屋に人がいれば全員に終了してもらう。"""
        with self.lock:
            joined = self.joined
            own_token = self.own_token
            has_others = bool(self._other_members_locked())
            self.joined = None
            self.joined_members = []
        if joined:
            self._room_post("leave", {"room": joined["id"], "token": joined["token"]})
            if notify:
                self.notifier.toast(f"{joined['owner']} の部屋から退出しました")
            return
        if own_token:
            # 部屋の人の一覧(4秒ごとに取り直している)が古くても終了できるよう、人がいるかどうかに関係なく終了を送る
            r = self._room_post("end", {"room": self.room_id, "token": own_token})
            _log(f"終了ボタン: {'終了しました' if r and r.get('ok') else '終了できませんでした ' + str(r)} (一覧上の人: {has_others})")
            if not (r and r.get("ok")):
                # 中継サーバーが再起動していた → 部屋を開き直してから、もう一度送る
                self.open_room()
                with self.lock:
                    own_token = self.own_token
                if own_token:
                    r = self._room_post("end", {"room": self.room_id, "token": own_token})
            with self.lock:
                self.own_members = [m for m in self.own_members if m.get("kind") == "owner"]
            if notify:
                self.notifier.toast("一緒に聴くのを終了しました(全員が部屋から出ました)")

    def accept(self, sid):
        with self.lock:
            info = self.pending_in.pop(sid, None)
        if not info:
            return
        self.notifier.close(sid)
        room = info.get("room")
        if not room:
            self.notifier.toast(f"{info['label']} のPCのプログラムが古いため、参加できませんでした")
            return
        result = self._room_post(
            "member-token", {"room": room, "pc": self.pc_id, "label": self.pc_label, "service": self.ext_service}, auth=True
        )
        if not result or not result.get("token"):
            self.notifier.toast(f"{info['label']} の部屋に入れませんでした(部屋が閉じている可能性があります)")
            return
        old = None
        with self.lock:
            old = self.joined
            self.joined = {"id": room, "token": result["token"], "you": result.get("you"), "owner": info["label"], "session": sid}
            self.joined_members = []
            self.pending_out = None
            tab_alive = self.clock() - self.last_ext_tick < 5
            if not tab_alive:
                self.waiting_ext_since = self.clock()
        if old and old["id"] != room:
            self._room_post("leave", {"room": old["id"], "token": old["token"]})
        self._send(info["from"], "accept", sid, {})
        self.notifier.toast(f"{info['label']} の部屋に入りました。誰かが曲を選ぶと、同じ曲が流れます")
        _log(f"許可しました (部屋={room}, 相手={info['label']})")
        if not tab_alive:
            if self.ext_service:
                self.open_url(SERVICE_URLS[self.ext_service])  # 前に使っていた音楽サービスのページを開く
            else:
                self.notifier.toast("音楽サービス(Apple Music / Spotify / YouTube Music)のページをブラウザで開いてください", seconds=8)

    def decline(self, sid):
        with self.lock:
            info = self.pending_in.pop(sid, None)
        if not info:
            return
        self.notifier.close(sid)
        self._send(info["from"], "decline", sid, {})

    # ------------------------------------------------------------------ 中継サーバー: リクエストのやり取り
    def _send(self, to, msg_type, sid, data, on_result=None):
        body = {"from": self.pc_id, "fromLabel": self.pc_label, "to": to, "type": msg_type, "sessionId": sid, "data": data}
        self.send_queue.put((body, on_result))

    def _send_worker(self):
        while True:
            body, on_result = self.send_queue.get()
            result = None
            for attempt in range(3):
                try:
                    r = self.http.post(self.base_url + "/api/music/send", json=body, headers=self.headers, timeout=8)
                    if r.status_code == 200:
                        result = r.json()
                        break
                    _log(f"送信エラー: {r.status_code} {r.text[:120]}")
                    if r.status_code in (400, 401, 404):
                        break
                except Exception as e:
                    _log(f"送信に失敗しました: {e}")
                time.sleep(1 + attempt)
            if on_result:
                try:
                    on_result(result)
                except Exception as e:
                    _log(f"内部エラー: {e}")

    def _poll_loop(self):
        since = -1
        wait = 2
        while True:
            try:
                r = self.http.get(
                    self.base_url + "/api/music/poll",
                    params={"pc": self.pc_id, "label": self.pc_label, "since": since},
                    headers=self.headers,
                    timeout=40,
                )
                if r.status_code == 404:
                    time.sleep(60)
                    continue
                if r.status_code != 200:
                    _log(f"受信エラー: {r.status_code}")
                    time.sleep(min(wait, 60))
                    wait = min(wait * 2, 60)
                    continue
                wait = 2
                data = r.json()
                server_now = float(data.get("serverNow", 0))
                for m in data.get("messages", []):
                    try:
                        self.handle_message(m, server_now)
                    except Exception as e:
                        _log(f"メッセージの処理でエラー: {e}")
                since = int(data.get("seq", 0))
            except Exception as e:
                _log(f"受信に失敗しました(再接続します): {e}")
                time.sleep(min(wait, 60))
                wait = min(wait * 2, 60)

    def handle_message(self, m, server_now):
        msg_type = m.get("type")
        sid = m.get("sessionId") or ""
        sender = m.get("from")
        label = m.get("fromLabel") or sender
        data = m.get("data") or {}
        age = max(0.0, (server_now - float(m.get("at", server_now))) / 1000.0)

        if msg_type == "request":
            with self.lock:
                timeout = float(data.get("timeoutSec", REQUEST_TIMEOUT_SEC))
                self.pending_in[sid] = {"from": sender, "label": label, "room": data.get("room"), "expires": self.clock() + timeout - age}
            _log(f"{label} からリクエストが来ました (部屋={data.get('room')})")
            self.play_notify_sound()
            self.notifier.ask(
                sid,
                "一緒に聴くリクエスト",
                f"{label} が「一緒に聴く」をリクエストしています",
                [("許可", lambda: self.accept(sid), True), ("拒否", lambda: self.decline(sid), False)],
                timeout_sec=REQUEST_TIMEOUT_SEC,
                on_timeout=lambda: self._expire_incoming(sid),
            )
            return

        if msg_type == "accept":
            with self.lock:
                mine = self.pending_out and self.pending_out["id"] == sid
                if mine:
                    self.pending_out = None
            if mine:
                _log(f"{label} が許可しました")
            # 参加したことは、部屋の参加者の確認(_room_loop)でも通知される
            return

        if msg_type in ("decline", "busy"):
            with self.lock:
                mine = self.pending_out and self.pending_out["id"] == sid
                if mine:
                    self.pending_out = None
            if mine:
                self.notifier.toast(f"{label} は今は参加できないようです" if msg_type == "busy" else f"{label} がリクエストを断りました")
            return

        if msg_type == "stop":
            with self.lock:
                was_incoming = self.pending_in.pop(sid, None) is not None
            if was_incoming:
                self.notifier.close(sid)
            return

    def _expire_incoming(self, sid):
        with self.lock:
            self.pending_in.pop(sid, None)

    # ------------------------------------------------------------------ 中継サーバー: 部屋
    def _room_post(self, action, body, auth=False):
        try:
            r = self.http.post(
                self.base_url + "/api/room/" + action, json=body, headers=self.headers if auth else {}, timeout=8
            )
            if r.status_code == 200:
                return r.json()
            return {"__status": r.status_code, "error": (r.json() if r.headers.get("content-type", "").startswith("application/json") else {}).get("error")}
        except Exception as e:
            _log(f"部屋の操作({action})に失敗しました: {e}")
            return None

    def open_room(self):
        result = self._room_post(
            "open",
            {"room": self.room_id, "pc": self.pc_id, "label": self.pc_label, "password": self.password, "service": self.ext_service},
            auth=True,
        )
        if result and result.get("token"):
            host = result.get("host", True)
            owner = result.get("owner") or self.pc_label
            with self.lock:
                if self.own_token and self.own_token != result["token"]:
                    self.own_members = []  # 中継サーバーが再起動して入り直した(前の自分を「出ました」と知らせないように)
                if self.own_token != result["token"] or self.own_host != host:
                    if host:
                        _log(f"部屋「{self.room_id}」を開きました" + ("(パスワードで参加できます)" if self.password else ""))
                    else:
                        _log(f"部屋「{self.room_id}」は {owner} がホストをしているので、参加しました")
                self.own_host = host
                self.own_owner = owner
                self.own_token = result["token"]
                self.own_you = result.get("you")
                self._update_members_locked(own=True, members=result.get("members") or [])
        elif result and result.get("__status") == 409:
            _log(f"部屋「{self.room_id}」はほかのPCが使っています。config.json の listen_room を変えてください")
        elif result and result.get("__status") == 404:
            pass  # 中継サーバーがまだ古い

    def _update_members_locked(self, own, members):
        old = self.own_members if own else self.joined_members
        mine = self.own_you if own else (self.joined or {}).get("you")
        old_ids = {m["id"] for m in old}
        new_ids = {m["id"] for m in members}
        if own:
            self.own_members = members
        else:
            self.joined_members = members
        if not old:
            return  # 最初の1回(部屋を開いた・入った直後)は、もともといた人のことは通知しない
        for m in members:
            if m["id"] not in old_ids and m["id"] != mine:
                service = SERVICE_NAMES.get(m.get("service"))
                where = f"({service})" if service and service != "?" else ""
                threading.Thread(target=self.play_notify_sound, daemon=True).start()
                self.notifier.toast(f"🎧 {m['label']}{where}が部屋に入りました")
        for m in old:
            if m["id"] not in new_ids and m["id"] != mine:
                self.notifier.toast(f"{m['label']} が部屋から出ました")

    def _room_loop(self):
        last_open = 0.0
        while True:
            try:
                now = self.clock()
                if not self.own_token or now - last_open > ROOM_HEARTBEAT_SEC:
                    self.open_room()
                    last_open = now
                    if not self.agent_card:
                        r = self._room_post("agent-card", {"pc": self.pc_id}, auth=True)
                        if r and r.get("card"):
                            self.agent_card = r["card"]
                with self.lock:
                    joined = self.joined
                    own_token = self.own_token
                if joined:
                    r = self._room_post("members", {"room": joined["id"], "token": joined["token"], "service": self.ext_service})
                    if r and r.get("members") is not None:
                        with self.lock:
                            if self.joined is joined:
                                self._update_members_locked(own=False, members=r["members"])
                    elif r and r.get("__status") in (403, 404):
                        with self.lock:
                            if self.joined is joined:
                                self.joined = None
                                self.joined_members = []
                        self.notifier.toast(f"{joined['owner']} の部屋が終了しました")
                if own_token:
                    r = self._room_post("members", {"room": self.room_id, "token": own_token, "service": self.ext_service})
                    if r and r.get("members") is not None:
                        with self.lock:
                            self._update_members_locked(own=True, members=r["members"])
                            if r.get("owner"):
                                self.own_owner = r["owner"]  # ホストが替わった時のため
                            if any("host" in m for m in r["members"]):
                                self.own_host = any(m.get("host") and m.get("id") == self.own_you for m in r["members"])
                    elif r and r.get("__status") in (403, 404):
                        with self.lock:
                            self.own_token = None  # 中継サーバーが再起動した → 開き直す
                            self.own_members = []  # 前の自分を「出ました」と知らせないように
            except Exception as e:
                _log(f"部屋の確認でエラー: {e}")
            time.sleep(MEMBERS_CHECK_SEC)

    # ------------------------------------------------------------------ 通知音
    def play_notify_sound(self):
        """リクエストが来た・誰かが入ってきた時の通知音(config の music_sound。空なら鳴らさない)。"""
        name = (self.config.get("music_sound") or "").strip()
        if not name:
            return
        path = name if os.path.isabs(name) else os.path.join(SCRIPT_DIR, name)
        if not os.path.exists(path):
            _log(f"通知音のファイルが見つかりません: {path}")
            return
        try:
            import winsound  # Windows の標準機能(追加のインストール不要)

            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
        except Exception as e:
            _log(f"通知音を鳴らせませんでした: {e}")

    # ------------------------------------------------------------------ 拡張機能とのやり取り
    def handle_ext_tick(self, data):
        with self.lock:
            self.last_ext_tick = self.clock()
            self.ever_tick = True
            self.waiting_ext_since = None
            service = (data or {}).get("service")
            if service in SERVICE_URLS:
                self.ext_service = service
            if self.joined:
                room = {"id": self.joined["id"], "token": self.joined["token"], "role": "friend", "owner": self.joined["owner"]}
            elif self.own_token:
                room = {"id": self.room_id, "token": self.own_token, "role": "owner", "owner": self.own_owner or self.pc_label}
            else:
                room = None
            return {"room": room, "ui": self._ui_locked(), "extVersion": self.extension_version(), "agentCard": self.agent_card}

    def handle_ext_action(self, action, sid=None):
        if action == "request":
            self.request()
        elif action == "cancel":
            self.cancel_request()
        elif action == "stop":
            self.stop()
        elif action == "accept" and sid:
            self.accept(sid)
        elif action == "decline" and sid:
            self.decline(sid)
        elif action == "tab-closed":
            # 曲のタブを全部閉じた → 友達の部屋にいれば出る(また入るには、もう一度招待を受け取る)
            with self.lock:
                joined = self.joined
            if joined:
                self.stop(notify=False)
                self.notifier.toast(f"音楽のタブを閉じたので、{joined['owner']} の部屋から出ました")
        with self.lock:
            return {"ui": self._ui_locked()}

    def _ui_locked(self):
        now = self.clock()
        return {
            "pending": self.pending_out is not None,
            "incoming": [{"sessionId": s, "label": v["label"]} for s, v in self.pending_in.items() if v["expires"] > now],
            "hotkey": self.hotkey_label,
        }

    def extension_version(self):
        try:
            mtime = os.path.getmtime(EXTENSION_MANIFEST)
        except OSError:
            return None
        cached_mtime, _ = self._ext_version_cache
        if cached_mtime != mtime:
            self._ext_version_cache = (mtime, read_extension_version())
        return self._ext_version_cache[1]

    def _housekeeping_loop(self):
        while True:
            time.sleep(1)
            try:
                self.housekeeping()
            except Exception as e:
                _log(f"内部エラー: {e}")

    def housekeeping(self):
        now = self.clock()
        expired_out = None
        missing_ext = False
        with self.lock:
            if self.pending_out and now > self.pending_out["expires"]:
                expired_out = self.pending_out["id"]
                self.pending_out = None
            for sid in [s for s, v in self.pending_in.items() if now > v["expires"]]:
                del self.pending_in[sid]
            if self.joined and self.waiting_ext_since and now - self.waiting_ext_since > 20:
                self.waiting_ext_since = None
                missing_ext = not self.ever_tick
        if expired_out:
            self._send("*", "stop", expired_out, {"reason": "timeout"})
            self.notifier.toast("リクエストに応答がありませんでした")
        if missing_ext:
            self.notifier.toast(
                "ブラウザの拡張機能から連絡がありません。拡張機能を入れていない場合は、"
                "開いたフォルダをブラウザの拡張機能ページで読み込んでください",
                seconds=12,
            )
            try:
                os.startfile(EXTENSION_DIR)  # type: ignore[attr-defined]  (Windows専用)
            except Exception:
                pass

    def _serve_extension(self):
        sync = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                pass

            def _json(self, status, obj):
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/ext/ping":
                    self._json(200, {"ok": True, "extVersion": sync.extension_version()})
                else:
                    self._json(404, {"error": "not found"})

            def do_POST(self):
                # ふつうのWebページから勝手に操作されないよう、拡張機能だけが付けるヘッダーを必須にする
                if self.headers.get("X-PCS-Ext") != "1":
                    self._json(403, {"error": "forbidden"})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                try:
                    data = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    self._json(400, {"error": "invalid json"})
                    return
                if self.path == "/ext/tick":
                    resp = sync.handle_ext_tick(data)
                elif self.path == "/ext/action":
                    resp = sync.handle_ext_action(data.get("action"), data.get("sessionId"))
                else:
                    self._json(404, {"error": "not found"})
                    return
                self._json(200, resp)

        class Server(ThreadingHTTPServer):
            # Windows ではこれを True にすると、同じポートを2つのプログラムが同時に使えてしまう(2重起動の時に困る)。
            # Linux/Mac では True にしないと、再起動の直後に閉じたばかりの接続が残っていて、しばらく開けない。
            allow_reuse_address = os.name != "nt"
            daemon_threads = True

        for attempt in range(120):  # 再起動の直後は開けないことがあるので、最大1分ほど粘る
            try:
                httpd = Server(("127.0.0.1", MUSIC_PORT), Handler)
                break
            except OSError as e:
                if attempt == 119:
                    _log(f"拡張機能用のポート {MUSIC_PORT} を開けませんでした(ほかのプログラムが使用中?): {e}")
                    return
                time.sleep(0.5)
        _log(f"拡張機能からの連絡を http://127.0.0.1:{MUSIC_PORT} で待っています")
        httpd.serve_forever()
