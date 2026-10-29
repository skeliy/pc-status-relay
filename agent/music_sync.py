# -*- coding: utf-8 -*-
"""
Apple Music(ブラウザ版)の曲を、友達のPCと同時に再生する「曲の共有」機能。

全体の流れ:
  1. どちらかが ショートカットキー(初期値 Ctrl+Alt+M)/トレイアイコン/Apple Music の画面の
     ボタン で「共有をリクエスト」する
  2. 相手のPCの右下に、作業の邪魔にならない小さなポップアップが出る(フォーカスは奪わない)
  3. 相手が「許可」を押すと共有が始まり、どちらかが「終了」するまで続く
  4. 共有中は、どちらかが曲を選ぶ・再生・一時停止・シークすると、もう片方も同じ状態になる

役割分担:
  - ブラウザ拡張機能(extension/)… Apple Music のページで、今の曲・再生状態を0.5秒ごとに
    このエージェントへ知らせ、エージェントから来た指示(この曲を再生して、など)を実行するだけ
  - このファイル … 共有の状態管理、相手とのやり取り(中継サーバー経由)、同期の判断
  - popup.py … ポップアップとショートカットキー(Windows専用)

拡張機能とは http://127.0.0.1:8788 で話す(このPCの中だけ。外からは繋がらない)。
"""

import json
import os
import queue
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
APPLE_MUSIC_URL = "https://music.apple.com/"

REQUEST_TIMEOUT_SEC = 60  # リクエストに応答が無ければ諦めるまでの秒数
TAB_ALIVE_SEC = 3.0  # この秒数ティックが来ないタブは閉じられたとみなす
LATENCY_COMP_SEC = 0.3  # 相手に届くまでの通信時間の見積もり(再生位置をこの分だけ先に進める)

# MusicKit の playbackState の番号
PS_NONE, PS_LOADING, PS_PLAYING, PS_PAUSED, PS_STOPPED, PS_ENDED = 0, 1, 2, 3, 4, 5
PS_SEEKING, PS_WAITING, PS_STALLED, PS_COMPLETED = 6, 8, 9, 10
TRANSIENT_STATES = {PS_NONE, PS_LOADING, PS_STOPPED, PS_ENDED, PS_SEEKING, PS_WAITING, PS_STALLED, PS_COMPLETED}
SUPPORTED_KINDS = {"song", "musicVideo"}


def _log(msg):
    print(f"[曲の共有] {msg}", flush=True)


def relay_base_url(server_url):
    """config の server_url(.../api/status)から中継サーバーの根元のURLを作る。"""
    url = (server_url or "").rstrip("/")
    if url.endswith("/api/status"):
        url = url[: -len("/api/status")]
    return url


def read_extension_version():
    try:
        with open(EXTENSION_MANIFEST, "r", encoding="utf-8") as f:
            return json.load(f).get("version")
    except (OSError, ValueError):
        return None


class ConsoleNotifier:
    """ポップアップを出せない環境用(ログに出すだけ)。リクエストは Apple Music の画面からも許可できる。"""

    def ask(self, key, title, message, buttons, timeout_sec, on_timeout=None):
        _log(f"{title}: {message}(Apple Music の画面の「許可」ボタンでも応答できます)")

    def close(self, key):
        pass

    def toast(self, message, seconds=4):
        _log(message)


class MusicSync:
    def __init__(self, config, notifier=None, open_url=None, clock=None, wall_clock=None, start_threads=True):
        self.config = config
        self.pc_id = config["pc_id"]
        self.pc_label = config.get("pc_label") or self.pc_id
        self.base_url = relay_base_url(config.get("server_url"))
        self.headers = {"Authorization": f"Bearer {config.get('write_token', '')}"}
        self.hotkey_label = config.get("music_hotkey_label", "Ctrl+Alt+M")
        self.notifier = notifier or ConsoleNotifier()
        self.open_url = open_url or webbrowser.open
        self.clock = clock or time.monotonic
        self.wall_clock = wall_clock or time.time

        self.lock = threading.RLock()
        self.session = None  # {"id", "members": {pcId: label}}
        self.pending_out = None  # {"id", "expires"}
        self.pending_in = {}  # sessionId -> {"from", "label", "expires"}
        self.shared = None  # 最後に「2人の共通の状態」になったもの
        self.target = None  # 相手から来た状態に、こちらのプレイヤーを合わせている最中ならその目標
        self.last_cmd = {}  # 指示の種類 -> 最後に出した時刻(同じ指示を連打しないため)
        self.needs_click = False  # ブラウザが自動再生を止めた(画面を1回クリックしてもらう必要がある)
        self.tabs = {}  # tabId -> {"at", "state", "last_playing"}
        self.ever_tick = False  # 起動してから一度でも拡張機能から連絡があったか
        self.waiting_ext_since = None  # 許可した後、拡張機能からの連絡を待ち始めた時刻
        self.cmd_seq = 0

        self.server_time_offset = 0.0
        self.send_queue = queue.Queue()
        self.http = requests.Session() if requests else None
        self._ext_version_cache = (None, None)

        if start_threads:
            self.start()

    # ------------------------------------------------------------------ 起動
    def start(self):
        threading.Thread(target=self._send_worker, name="music-send", daemon=True).start()
        threading.Thread(target=self._poll_loop, name="music-poll", daemon=True).start()
        threading.Thread(target=self._housekeeping_loop, name="music-house", daemon=True).start()
        threading.Thread(target=self._serve_extension, name="music-ext", daemon=True).start()

    # ------------------------------------------------------------------ 操作(ショートカット・トレイ・画面のボタン)
    def toggle(self):
        """ショートカットキー用: 状態に応じて「リクエスト」「取り消し」「終了」を切り替える。"""
        with self.lock:
            if self.session:
                action = "stop"
            elif self.pending_out:
                action = "cancel"
            else:
                action = "request"
        if action == "stop":
            self.stop()
        elif action == "cancel":
            self.cancel_request()
        else:
            self.request()

    def status_text(self):
        with self.lock:
            if self.session:
                return f"曲の共有を終了する({self._partner_names()}と共有中)"
            if self.pending_out:
                return "曲の共有リクエストを取り消す"
            return "曲の共有をリクエストする"

    def request(self):
        with self.lock:
            if self.session or self.pending_out:
                return
            sid = uuid.uuid4().hex[:12]
            self.pending_out = {"id": sid, "expires": self.clock() + REQUEST_TIMEOUT_SEC}

        def on_result(result):
            delivered = (result or {}).get("delivered", 0)
            with self.lock:
                still_pending = self.pending_out and self.pending_out["id"] == sid
                if delivered == 0 and still_pending:
                    self.pending_out = None
            if result is None:
                self.notifier.toast("中継サーバーに繋がらなかったため、リクエストを送れませんでした")
            elif delivered == 0:
                self.notifier.toast("共有できる相手が見つかりませんでした(相手のPCが新しいバージョンで動いていない可能性があります)")
            else:
                names = "、".join(r.get("label") or r.get("id") for r in result.get("recipients", []))
                self.notifier.toast(f"{names} に曲の共有をリクエストしました。許可を待っています…")

        _log(f"リクエストを送信 (session={sid})")
        self._send("*", "request", sid, {"timeoutSec": REQUEST_TIMEOUT_SEC}, on_result=on_result)

    def cancel_request(self):
        with self.lock:
            if not self.pending_out:
                return
            sid = self.pending_out["id"]
            self.pending_out = None
        self._send("*", "stop", sid, {"reason": "cancel"})
        self.notifier.toast("曲の共有リクエストを取り消しました")

    def stop(self, notify=True):
        with self.lock:
            if not self.session:
                return
            sid = self.session["id"]
            self._end_session_locked()
        self._send("*", "stop", sid, {"reason": "stop"})
        if notify:
            self.notifier.toast("曲の共有を終了しました")

    def accept(self, sid):
        with self.lock:
            info = self.pending_in.pop(sid, None)
            if not info:
                return
            if self.session:
                self._end_session_locked()
            self.pending_out = None
            self.session = {"id": sid, "members": {info["from"]: info["label"]}}
            self.shared = None
            self.target = None
            tab_alive = self._primary_tab_locked() is not None
            if not tab_alive:
                self.waiting_ext_since = self.clock()
        self.notifier.close(sid)
        self._send(info["from"], "accept", sid, {})
        self.notifier.toast(f"{info['label']} と曲の共有を始めました")
        _log(f"許可しました (session={sid}, 相手={info['label']})")
        if not tab_alive:
            # Apple Music が開かれていなければ開く(拡張機能が入っていれば、開いたページで同期が始まる)
            self.open_url(APPLE_MUSIC_URL)

    def decline(self, sid):
        with self.lock:
            info = self.pending_in.pop(sid, None)
        if not info:
            return
        self.notifier.close(sid)
        self._send(info["from"], "decline", sid, {})

    # ------------------------------------------------------------------ 中継サーバーとのやり取り
    def _send(self, to, msg_type, sid, data, on_result=None):
        body = {
            "from": self.pc_id,
            "fromLabel": self.pc_label,
            "to": to,
            "type": msg_type,
            "sessionId": sid,
            "data": data,
        }
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
                except Exception as e:  # ネットワークエラー
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
                    # 中継サーバーがまだ古い(曲の共有に対応していない)。しばらく待ってからまた試す
                    time.sleep(60)
                    continue
                if r.status_code != 200:
                    _log(f"受信エラー: {r.status_code}")
                    time.sleep(min(wait, 60))
                    wait = min(wait * 2, 60)
                    continue
                wait = 2
                data = r.json()
                seq = int(data.get("seq", 0))
                server_now = float(data.get("serverNow", 0))
                for m in data.get("messages", []):
                    try:
                        self.handle_message(m, server_now)
                    except Exception as e:
                        _log(f"メッセージの処理でエラー: {e}")
                since = seq  # サーバーが再起動して番号が戻った場合も、ここで合わせ直される
            except Exception as e:
                _log(f"受信に失敗しました(再接続します): {e}")
                time.sleep(min(wait, 60))
                wait = min(wait * 2, 60)

    def handle_message(self, m, server_now):
        msg_type = m.get("type")
        sid = m.get("sessionId") or ""
        sender = m.get("from")
        label = m.get("fromLabel") or sender
        age = max(0.0, (server_now - float(m.get("at", server_now))) / 1000.0)

        if msg_type == "request":
            with self.lock:
                busy = self.session is not None
                if not busy:
                    timeout = float((m.get("data") or {}).get("timeoutSec", REQUEST_TIMEOUT_SEC))
                    self.pending_in[sid] = {"from": sender, "label": label, "expires": self.clock() + timeout - age}
            if busy:
                self._send(sender, "busy", sid, {})
                return
            _log(f"{label} からリクエストが来ました (session={sid})")
            self.notifier.ask(
                sid,
                "曲の共有のリクエスト",
                f"{label} が Apple Music の曲の共有をリクエストしています",
                [("許可", lambda: self.accept(sid), True), ("拒否", lambda: self.decline(sid), False)],
                timeout_sec=REQUEST_TIMEOUT_SEC,
                on_timeout=lambda: self._expire_incoming(sid),
            )
            return

        if msg_type == "accept":
            with self.lock:
                if self.session and self.session["id"] == sid:
                    self.session["members"][sender] = label
                    started = False
                elif self.pending_out and self.pending_out["id"] == sid:
                    self.pending_out = None
                    self.session = {"id": sid, "members": {sender: label}}
                    self.shared = None
                    self.target = None
                    started = True
                else:
                    started = None
                tab = self._primary_tab_locked()
                current = tab["state"] if tab else None
            if started is None:
                # もう取り消したリクエストへの許可 → 相手に「終わったよ」と伝える
                self._send(sender, "stop", sid, {"reason": "expired"})
                return
            self.notifier.toast(f"{label} が許可しました。曲の共有を始めます")
            _log(f"{label} が許可しました (session={sid})")
            # 今こちらで曲が流れていれば、すぐに相手にも流す
            if current and current.get("songId") and current.get("isPlaying"):
                with self.lock:
                    self._broadcast_local_locked(current, self.clock())
            return

        if msg_type in ("decline", "busy"):
            with self.lock:
                mine = self.pending_out and self.pending_out["id"] == sid
                if mine:
                    self.pending_out = None
            if mine:
                if msg_type == "busy":
                    self.notifier.toast(f"{label} は今ほかの人と曲を共有中です")
                else:
                    self.notifier.toast(f"{label} が曲の共有を断りました")
            return

        if msg_type == "stop":
            with self.lock:
                was_incoming = self.pending_in.pop(sid, None) is not None
                in_session = self.session is not None and self.session["id"] == sid
                if in_session:
                    self._end_session_locked()
            if was_incoming:
                self.notifier.close(sid)
            if in_session:
                self.notifier.toast(f"{label} が曲の共有を終了しました")
                _log(f"{label} が終了しました (session={sid})")
            return

        if msg_type == "state":
            with self.lock:
                if not self.session or self.session["id"] != sid:
                    return
                self._apply_remote_locked(m.get("data") or {}, age)
            return

    # ------------------------------------------------------------------ 同期の中身
    def _partner_names(self):
        if not self.session:
            return ""
        return "、".join(self.session["members"].values())

    def _end_session_locked(self):
        self.session = None
        self.shared = None
        self.target = None
        self.needs_click = False
        self.waiting_ext_since = None

    def _expire_incoming(self, sid):
        with self.lock:
            self.pending_in.pop(sid, None)

    def _apply_remote_locked(self, data, age):
        song_id = data.get("songId")
        kind = data.get("kind") or "song"
        if not song_id or kind not in SUPPORTED_KINDS:
            return
        now = self.clock()
        playing = bool(data.get("isPlaying"))
        position = float(data.get("position") or 0)
        if playing:
            position += age + LATENCY_COMP_SEC
        snap = {
            "songId": str(song_id),
            "kind": kind,
            "title": data.get("title"),
            "artist": data.get("artist"),
            "playing": playing,
            "position": position,
            "at": now,
        }
        has_tab = self._primary_tab_locked() is not None
        self.target = dict(snap, deadline=now + (15 if has_tab else 45))
        self.shared = snap
        self.last_cmd = {}
        _log(f"相手の状態に合わせます: {snap['title']} / {snap['artist']} ({'再生' if playing else '一時停止'} {position:.1f}秒)")

    @staticmethod
    def _expected_position(snap, now):
        if snap["playing"]:
            return snap["position"] + (now - snap["at"])
        return snap["position"]

    def _new_cmd(self, action, **kw):
        self.cmd_seq += 1
        self.last_cmd[action] = self.clock()
        cmd = {"id": self.cmd_seq, "action": action, "issuedAt": int(self.wall_clock() * 1000)}
        cmd.update(kw)
        return cmd

    def _converge_locked(self, st, now):
        """相手から来た状態(target)に、こちらのプレイヤーを近づける指示を作る。"""
        t = self.target
        if now > t["deadline"]:
            _log("相手の状態に合わせきれないまま時間切れになりました")
            self.target = None
            return []
        expected = self._expected_position(t, now)
        since = lambda action: now - self.last_cmd.get(action, -1e9)

        if st.get("songId") != t["songId"]:
            if since("load") > 6:
                return [
                    self._new_cmd(
                        "load", songId=t["songId"], kind=t["kind"], position=expected, play=t["playing"]
                    )
                ]
            return []

        ps = st.get("playbackState")
        if ps in (PS_LOADING, PS_SEEKING, PS_WAITING, PS_STALLED):
            return []

        cmds = []
        position = float(st.get("position") or 0)
        pos_ok = abs(position - expected) <= 2.0
        play_ok = bool(st.get("isPlaying")) == t["playing"]
        if not pos_ok and since("seek") > 2.5 and since("load") > 2.5:
            cmds.append(self._new_cmd("seek", position=expected, play=t["playing"]))
        if not play_ok and since("play") > 2.5 and since("load") > 2.5:
            cmds.append(self._new_cmd("play" if t["playing"] else "pause"))
        if pos_ok and play_ok:
            self.target = None
            self.needs_click = False
            self.shared = {k: t[k] for k in ("songId", "kind", "title", "artist", "playing")}
            self.shared.update(position=expected, at=now)
        return cmds

    def _snapshot_from_local(self, st, now):
        return {
            "songId": st.get("songId"),
            "kind": st.get("kind") or "song",
            "title": st.get("title"),
            "artist": st.get("artist"),
            "playing": bool(st.get("isPlaying")),
            "position": float(st.get("position") or 0),
            "at": now,
        }

    def _broadcast_local_locked(self, st, now):
        snap = self._snapshot_from_local(st, now)
        self.shared = snap
        data = {k: snap[k] for k in ("songId", "kind", "title", "artist")}
        data.update(isPlaying=snap["playing"], position=round(snap["position"], 2))
        _log(f"こちらの操作を相手に送ります: {snap['title']} ({'再生' if snap['playing'] else '一時停止'} {snap['position']:.1f}秒)")
        self._send("*", "state", self.session["id"], data)

    def _detect_local_change_locked(self, st, now):
        """こちらで曲を選んだ・再生した・止めた・シークした、を見つけて相手に送る。"""
        if not st.get("songId") or (st.get("kind") or "song") not in SUPPORTED_KINDS:
            return
        ps = st.get("playbackState")
        playing = bool(st.get("isPlaying"))
        sh = self.shared

        if sh is None or st["songId"] != sh["songId"]:
            # 最初の再生 / 別の曲になった → 実際に流れ始めたら送る
            if playing and ps == PS_PLAYING:
                self._broadcast_local_locked(st, now)
            return

        if ps in TRANSIENT_STATES:
            return
        position = float(st.get("position") or 0)
        if playing != sh["playing"]:
            if not playing:
                if ps != PS_PAUSED:
                    return
                duration = float(st.get("duration") or 0)
                if duration and position >= duration - 2.5:
                    return  # 曲が最後まで終わっただけ(相手を止めない)
            self._broadcast_local_locked(st, now)
            return

        expected = self._expected_position(sh, now)
        if abs(position - expected) > 3.0:
            self._broadcast_local_locked(st, now)  # シークした

    # ------------------------------------------------------------------ 拡張機能とのやり取り
    def _primary_tab_locked(self):
        now = self.clock()
        for tab_id in [t for t, v in self.tabs.items() if now - v["at"] > TAB_ALIVE_SEC]:
            del self.tabs[tab_id]
        if not self.tabs:
            return None
        # いちばん最近まで曲が流れていたタブ。どれも流れていなければ、いちばん最近連絡があったタブ
        best = max(self.tabs.values(), key=lambda v: (v.get("last_playing") or 0, v["at"]))
        return best

    def handle_tick(self, tab_id, state, results):
        now = self.clock()
        state = state or {}
        with self.lock:
            prev = self.tabs.get(tab_id) or {}
            entry = {"at": now, "state": state, "last_playing": prev.get("last_playing"), "id": tab_id}
            if state.get("isPlaying"):
                entry["last_playing"] = now
                self.needs_click = False
            self.tabs[tab_id] = entry
            self.ever_tick = True
            self.waiting_ext_since = None
            for res in results or []:
                if not res.get("ok"):
                    _log(f"拡張機能で指示が失敗しました: {res.get('error')}")
                    if res.get("error") == "autoplay":
                        self.needs_click = True

            cmds = []
            primary = self._primary_tab_locked()
            if self.session and primary is entry and state.get("available"):
                if self.target:
                    cmds = self._converge_locked(state, now)
                else:
                    self._detect_local_change_locked(state, now)
            ui = self._ui_locked(is_primary=primary is entry)
        return {"commands": cmds, "ui": ui, "extVersion": self.extension_version()}

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
        with self.lock:
            return {"ui": self._ui_locked(is_primary=True)}

    def _ui_locked(self, is_primary):
        now = self.clock()
        return {
            "sharing": self.session is not None,
            "partners": self._partner_names(),
            "pending": self.pending_out is not None,
            "incoming": [
                {"sessionId": sid, "label": v["label"]} for sid, v in self.pending_in.items() if v["expires"] > now
            ],
            "needsClick": bool(self.needs_click and self.session and is_primary),
            "hotkey": self.hotkey_label,
        }

    def extension_version(self):
        try:
            mtime = os.path.getmtime(EXTENSION_MANIFEST)
        except OSError:
            return None
        cached_mtime, cached_version = self._ext_version_cache
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
            if self.session and self.waiting_ext_since and now - self.waiting_ext_since > 20:
                self.waiting_ext_since = None
                missing_ext = not self.ever_tick
        if expired_out:
            self._send("*", "stop", expired_out, {"reason": "timeout"})
            self.notifier.toast("曲の共有リクエストに応答がありませんでした")
        if missing_ext:
            self.notifier.toast(
                "Apple Music の拡張機能から連絡がありません。拡張機能を入れていない場合は、"
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
                # (このヘッダーが付くとブラウザは事前確認をするが、それには応じないので普通のページからは送れない)
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
                    resp = sync.handle_tick(data.get("tabId"), data.get("state"), data.get("results"))
                elif self.path == "/ext/action":
                    resp = sync.handle_ext_action(data.get("action"), data.get("sessionId"))
                else:
                    self._json(404, {"error": "not found"})
                    return
                self._json(200, resp)

        class Server(ThreadingHTTPServer):
            # Windows ではこれを True にすると、同じポートを2つのプログラムが同時に使えてしまう
            # (エージェントを2重に起動した時に、拡張機能の連絡がどちらに届くか分からなくなる)
            allow_reuse_address = False
            daemon_threads = True

        for attempt in range(20):
            try:
                httpd = Server(("127.0.0.1", MUSIC_PORT), Handler)
                break
            except OSError as e:
                if attempt == 19:
                    _log(f"拡張機能用のポート {MUSIC_PORT} を開けませんでした(ほかのプログラムが使用中?): {e}")
                    return
                time.sleep(0.5)
        _log(f"拡張機能からの連絡を http://127.0.0.1:{MUSIC_PORT} で待っています")
        httpd.serve_forever()
