# -*- coding: utf-8 -*-
"""
agent.py から使う、OS依存のない(=Windows専用ライブラリに依存しない)純粋なロジック部分。
ここを分離しておくことで、Windows以外の環境でもロジック単体のテストができます。
"""

import threading
import time


class StatusOverride:
    """友達が手動で設定する「カスタムステータス」(例: お風呂中 20分)を保持するクラス。

    スレッドセーフ。有効期限が切れたら snapshot() を呼んだタイミングで自動的にクリアされる。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._text = None
        self._expires_at = None  # time.time() が返す形式のepoch秒

    def set(self, text: str, minutes: float):
        text = (text or "").strip()
        if not text:
            raise ValueError("text is empty")
        if minutes <= 0:
            raise ValueError("minutes must be positive")
        with self._lock:
            self._text = text
            self._expires_at = time.time() + minutes * 60.0

    def clear(self):
        with self._lock:
            self._text = None
            self._expires_at = None

    def snapshot(self, now: float = None):
        """(active, text, remaining_seconds) を返す。期限切れなら自動でクリアしてから
        (False, None, None) を返す。
        """
        if now is None:
            now = time.time()
        with self._lock:
            if self._text is None or self._expires_at is None:
                return False, None, None
            remaining = self._expires_at - now
            if remaining <= 0:
                self._text = None
                self._expires_at = None
                return False, None, None
            return True, self._text, remaining


class StatusTracker:
    """「今の状態がどれくらい続いているか」を計測するためのクラス。

    main_loop側から毎回 update(key) を呼ぶだけで、
    key が前回と同じなら継続時間を積み上げ、変わったらリセットして0から数え直す。
    (agent.pyのメインループは単一スレッドからしか呼ばないので、ロックは不要)
    """

    def __init__(self):
        self._key = None
        self._started_at = None

    def update(self, key, now: float = None) -> float:
        if now is None:
            now = time.time()
        if key != self._key or self._started_at is None:
            self._key = key
            self._started_at = now
        return now - self._started_at


def tracking_key_for(fields, exe_name):
    """継続時間を計測する単位を決める。

    ウィンドウタイトルは同じアプリでも(ブラウザのタブ名など)頻繁に変わりうるので、
    自動検出中は実行ファイル名(exe_name)を基準にする。AFK中/カスタム中はそれぞれ
    専用のキーにする。
    """
    if fields["isCustom"]:
        return "custom:" + fields["status"]
    if fields["isAfk"]:
        return "afk"
    return "app:" + (exe_name or fields["status"] or "unknown")


def compute_status_fields(idle_seconds, window_title, exe_name, override_snapshot, afk_threshold_sec):
    """現在サーバーに送信すべき状態(status/isAfk/isCustom/customRemainingSeconds)を計算する。

    優先順位:
      1. カスタムステータスが有効な間は、それを最優先で表示する(AFK自動判定より優先)。
         => 「お風呂中」に設定したのに1分操作が無いからといって勝手にAFK表示に
            切り替わってしまうと本末転倒なため。
      2. カスタムステータスが無ければ、アイドル時間による自動AFK判定。
      3. どちらでもなければ、フォアグラウンドウィンドウの情報をそのまま表示。
    """
    active, text, remaining = override_snapshot
    if active:
        return {
            "status": text,
            "isAfk": False,
            "isCustom": True,
            "customRemainingSeconds": round(remaining, 1),
        }

    is_afk = idle_seconds >= afk_threshold_sec
    if is_afk:
        status_text = "AFK"
    else:
        status_text = window_title or exe_name or "不明"

    return {
        "status": status_text,
        "isAfk": is_afk,
        "isCustom": False,
        "customRemainingSeconds": None,
    }
