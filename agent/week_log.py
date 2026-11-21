"""1週間分の「何にどれくらい時間を使ったか」を、このPCに記録する。

- 週の区切りは、このPCの時計で「日曜日の夜(月曜 0:00)」。月曜になったら新しい週を始め、
  前の週は「先週」として1つだけ残す
- AFK の時間は記録しない(画面の表示では AFK と出るが、履歴には入れない)
- カスタムステータス(「お風呂」など)の時間は記録する
- アプリごと(実行ファイル名ごと)の合計時間と、その中のウィンドウタイトルごとの内訳を持つ
- week_log.json に保存するので、PC や中継サーバーが再起動しても消えない
  (中継サーバーには1分ごとに最新の集計を送るだけ。サーバー側は覚えていなくてよい)
"""

import datetime as _dt
import json
import os
import threading
import time

MAX_GAP_SEC = 30          # これより間が空いた時(スリープ等)は、その間を数えない
MAX_TITLE_LEN = 120
TITLES_KEEP = 40          # 1つのアプリについて残すタイトルの数
TITLES_PRUNE_AT = 80
MAX_APPS = 150


def week_start_of(d: _dt.date) -> _dt.date:
    """その日を含む週の月曜日(週は月曜 0:00 〜 日曜の夜まで)。"""
    return d - _dt.timedelta(days=d.weekday())


def _empty_week(ws: _dt.date) -> dict:
    return {"weekStart": ws.isoformat(), "apps": {}, "customs": {}}


class WeekLog:
    def __init__(self, path, clock=time.monotonic, today=None):
        self.path = path
        self.clock = clock
        self.today = today or (lambda: _dt.datetime.now().date())
        self.lock = threading.Lock()
        self.last_tick = None
        self.last_save = 0.0
        self.dirty = False
        ws = week_start_of(self.today())
        self.data = {"version": 1, "current": _empty_week(ws), "previous": None}
        self._load()
        self._roll()

    # ---- 保存・読み込み ----
    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict) and isinstance(d.get("current"), dict):
                cur = d["current"]
                cur.setdefault("apps", {})
                cur.setdefault("customs", {})
                self.data = {"version": 1, "current": cur, "previous": d.get("previous")}
        except FileNotFoundError:
            pass
        except Exception as e:  # 壊れていたら作り直す(元のファイルは残す)
            print(f"[週の記録] week_log.json を読めなかったので新しく始めます: {e}")
            try:
                os.replace(self.path, self.path + ".broken")
            except Exception:
                pass

    def save(self, force=False):
        with self.lock:
            if not self.dirty and not force:
                return
            text = json.dumps(self.data, ensure_ascii=False, separators=(",", ":"))
            self.dirty = False
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, self.path)
        except Exception as e:
            print(f"[週の記録] 保存できませんでした: {e}")

    # ---- 週の切り替え ----
    def _roll(self):
        ws = week_start_of(self.today()).isoformat()
        cur = self.data["current"]
        if cur.get("weekStart") == ws:
            return
        prev_ws = (week_start_of(self.today()) - _dt.timedelta(days=7)).isoformat()
        # 先週の分だけ「先週」として残す(もっと前の週なら捨てる)
        self.data["previous"] = cur if cur.get("weekStart") == prev_ws else None
        self.data["current"] = _empty_week(week_start_of(self.today()))
        self.dirty = True

    # ---- 記録 ----
    def add(self, payload: dict):
        """送信のたびに呼ぶ。前回からの経過時間を、今の状態に足す。"""
        now = self.clock()
        with self.lock:
            last, self.last_tick = self.last_tick, now
            self._roll()
            if last is None:
                return
            dt = now - last
            if dt <= 0 or dt > MAX_GAP_SEC:
                return
            cur = self.data["current"]
            if payload.get("isCustom"):
                text = str(payload.get("status") or "カスタム")[:MAX_TITLE_LEN]
                cur["customs"][text] = round(cur["customs"].get(text, 0) + dt, 1)
            elif payload.get("isAfk"):
                return  # AFK は履歴に入れない
            else:
                exe = str(payload.get("processName") or "不明")[:80]
                apps = cur["apps"]
                if exe not in apps and len(apps) >= MAX_APPS:
                    exe = "その他"
                app = apps.setdefault(exe, {"sec": 0, "titles": {}})
                app["sec"] = round(app["sec"] + dt, 1)
                title = str(payload.get("status") or "").strip()[:MAX_TITLE_LEN]
                if title:
                    t = app["titles"]
                    t[title] = round(t.get(title, 0) + dt, 1)
                    if len(t) > TITLES_PRUNE_AT:
                        keep = sorted(t.items(), key=lambda kv: -kv[1])[:TITLES_KEEP]
                        app["titles"] = dict(keep)
            self.dirty = True

    def maybe_save(self, every_sec=60):
        if self.clock() - self.last_save >= every_sec:
            self.last_save = self.clock()
            self.save()

    # ---- 中継サーバーに送る形 ----
    @staticmethod
    def _week_out(w):
        if not w:
            return None
        apps = []
        for exe, a in w.get("apps", {}).items():
            titles = sorted(a.get("titles", {}).items(), key=lambda kv: -kv[1])[:25]
            apps.append({"exe": exe, "sec": round(a.get("sec", 0)), "titles": [[t, round(s)] for t, s in titles]})
        apps.sort(key=lambda x: -x["sec"])
        customs = sorted(([k, round(v)] for k, v in w.get("customs", {}).items()), key=lambda kv: -kv[1])
        return {"weekStart": w.get("weekStart"), "apps": apps, "customs": customs}

    def report(self) -> dict:
        with self.lock:
            self._roll()
            offset = _dt.datetime.now().astimezone().utcoffset()
            return {
                "current": self._week_out(self.data["current"]),
                "previous": self._week_out(self.data["previous"]),
                "utcOffsetMin": int(offset.total_seconds() // 60) if offset else 0,
                "today": self.today().isoformat(),
            }


def _relay_base(server_url):
    url = (server_url or "").rstrip("/")
    if url.endswith("/api/status"):
        url = url[: -len("/api/status")]
    return url


def start_week_reporter(config, weeklog, script_dir, post=None, sleep=time.sleep):
    """1分ごとに週の集計を中継サーバーへ送る。schedule.json があれば、5分ごとに予定表も送る
    (予定表は持ち主の PC にだけ置くファイル。GitHub には上げない)。"""
    if post is None:
        import requests

        post = requests.post
    base = _relay_base(config.get("server_url"))
    headers = {"Authorization": f"Bearer {config.get('write_token', '')}", "Content-Type": "application/json"}
    sched_path = os.path.join(script_dir, "schedule.json")

    def send_week():
        body = {"id": config.get("pc_id"), "label": config.get("pc_label")}
        body.update(weeklog.report())
        post(base + "/api/week/report", json=body, headers=headers, timeout=15)

    def send_schedule():
        if not os.path.exists(sched_path):
            return
        with open(sched_path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        post(base + "/api/schedule", json={"id": config.get("pc_id"), "schedule": data}, headers=headers, timeout=15)

    def loop():
        n = 0
        while True:
            try:
                weeklog.save()
                send_week()
            except Exception as e:
                print(f"[週の記録] 送れませんでした: {e}")
            if n % 5 == 0:
                try:
                    send_schedule()
                except Exception as e:
                    print(f"[予定表] 送れませんでした: {e}")
            n += 1
            sleep(60)

    t = threading.Thread(target=loop, name="week-reporter", daemon=True)
    t.start()
    return t
