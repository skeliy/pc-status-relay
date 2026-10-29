# -*- coding: utf-8 -*-
"""
画面の右下に出す小さなポップアップと、ショートカットキー(Windows専用)。

ポップアップは「作業の邪魔をしない」ように作ってある:
  - クリックしてもフォーカスを奪わない(ゲームや入力中のウィンドウが裏に回らない)
  - タスクバーにも出ない
  - 一定時間で自動的に消える

使うのは pywin32(agent.py が元から使っているもの)と、Windows標準の機能だけ。
"""

import ctypes
import queue
import threading
import time
from ctypes import wintypes

try:
    import win32api
    import win32con
    import win32gui

    WIN32_AVAILABLE = True
except ImportError:
    WIN32_AVAILABLE = False

WS_EX_NOACTIVATE = 0x08000000
WM_MOUSEACTIVATE = 0x0021
MA_NOACTIVATE = 3
WM_HOTKEY = 0x0312

COLOR_BG = (32, 34, 44)
COLOR_BORDER = (72, 76, 94)
COLOR_TITLE = (255, 255, 255)
COLOR_TEXT = (205, 208, 220)
COLOR_PRIMARY = (250, 45, 72)  # Apple Music の赤
COLOR_SECONDARY = (64, 67, 84)
FONT_FACE = "Yu Gothic UI"


def _rgb(c):
    return win32api.RGB(*c)


class _Popup:
    def __init__(self, key, title, message, buttons, timeout_sec, on_timeout):
        self.key = key
        self.title = title
        self.message = message
        self.buttons = buttons  # [(label, callback, is_primary)]
        self.expires = time.monotonic() + timeout_sec
        self.on_timeout = on_timeout
        self.hwnd = None
        self.width = 0
        self.height = 0
        self.button_rects = []  # [(rect, callback)]
        self.title_rect = None
        self.message_rect = None


class WinNotifier:
    """ポップアップ係。ウィンドウは全部この専用スレッドの中で作る(Windowsの決まりのため)。"""

    CLASS_NAME = "PcStatusMusicPopup"

    def __init__(self):
        self.requests = queue.Queue()
        self.popups = {}  # hwnd -> _Popup
        self.ready = threading.Event()
        self.failed = False
        threading.Thread(target=self._run, name="popup-ui", daemon=True).start()
        self.ready.wait(5)

    # --- 他のスレッドから呼ぶもの ------------------------------------------
    def ask(self, key, title, message, buttons, timeout_sec, on_timeout=None):
        self.requests.put(("show", _Popup(key, title, message, buttons, timeout_sec, on_timeout)))

    def toast(self, message, seconds=4):
        self.requests.put(("show", _Popup(None, None, message, [], seconds, None)))

    def close(self, key):
        self.requests.put(("close", key))

    # --- UIスレッド ---------------------------------------------------------
    def _run(self):
        try:
            try:
                # このスレッドだけ高DPI対応にする(文字がぼやけないように)。古いWindowsでは無視
                ctypes.windll.user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
            except Exception:
                pass
            self.hinst = win32api.GetModuleHandle(None)
            wc = win32gui.WNDCLASS()
            wc.lpszClassName = self.CLASS_NAME
            wc.hInstance = self.hinst
            wc.lpfnWndProc = self._wndproc
            wc.hCursor = win32gui.LoadCursor(0, win32con.IDC_ARROW)
            try:
                win32gui.RegisterClass(wc)
            except win32gui.error:
                pass  # 再起動などで既に登録済み
            self.scale = self._dpi() / 96.0
            self.font_title = self._font(10.5, 700)
            self.font_text = self._font(10, 400)
            self.font_button = self._font(10, 600)
            self.hand_cursor = win32gui.LoadCursor(0, win32con.IDC_HAND)
        except Exception as e:
            print(f"[ポップアップ] 初期化できませんでした: {e}")
            self.failed = True
            self.ready.set()
            return
        self.ready.set()

        while True:
            try:
                self._process_requests()
                win32gui.PumpWaitingMessages()
                self._check_timeouts()
            except Exception as e:
                print(f"[ポップアップ] エラー: {e}")
            time.sleep(0.03)

    def _dpi(self):
        try:
            return ctypes.windll.user32.GetDpiForSystem()
        except Exception:
            hdc = win32gui.GetDC(0)
            try:
                return ctypes.windll.gdi32.GetDeviceCaps(hdc, 90)  # LOGPIXELSY
            finally:
                win32gui.ReleaseDC(0, hdc)

    def _font(self, points, weight):
        lf = win32gui.LOGFONT()
        lf.lfFaceName = FONT_FACE
        lf.lfHeight = -int(round(points * self._dpi() / 72.0))
        lf.lfWeight = weight
        lf.lfQuality = 5  # CLEARTYPE_QUALITY
        lf.lfCharSet = 1  # DEFAULT_CHARSET
        return win32gui.CreateFontIndirect(lf)

    def _s(self, v):
        return int(round(v * self.scale))

    def _measure(self, text, font, width):
        hdc = win32gui.GetDC(0)
        try:
            old = win32gui.SelectObject(hdc, font)
            result = win32gui.DrawText(
                hdc, text, -1, (0, 0, width, 0), win32con.DT_CALCRECT | win32con.DT_WORDBREAK | win32con.DT_NOPREFIX
            )
            win32gui.SelectObject(hdc, old)
            # pywin32 のバージョンによって (高さ, 枠) か 高さだけ が返ってくる
            return result[0] if isinstance(result, tuple) else result
        finally:
            win32gui.ReleaseDC(0, hdc)

    def _process_requests(self):
        while True:
            try:
                kind, arg = self.requests.get_nowait()
            except queue.Empty:
                return
            if kind == "show":
                self._create(arg)
            elif kind == "close":
                for hwnd, p in list(self.popups.items()):
                    if p.key is not None and p.key == arg:
                        win32gui.DestroyWindow(hwnd)
                self._layout()

    def _create(self, p):
        pad = self._s(14)
        width = self._s(340)
        inner = width - pad * 2
        y = pad
        if p.title:
            th = self._measure(p.title, self.font_title, inner)
            p.title_rect = (pad, y, pad + inner, y + th)
            y += th + self._s(4)
        mh = self._measure(p.message, self.font_text, inner)
        p.message_rect = (pad, y, pad + inner, y + mh)
        y += mh
        if p.buttons:
            y += self._s(12)
            bh, bw, gap = self._s(30), self._s(88), self._s(8)
            x = width - pad
            rects = []
            for label, cb, primary in reversed(p.buttons):
                rects.append(((x - bw, y, x, y + bh), label, cb, primary))
                x -= bw + gap
            p.button_rects = list(reversed(rects))
            y += bh
        y += pad
        p.width, p.height = width, y

        ex_style = win32con.WS_EX_TOPMOST | win32con.WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
        hwnd = win32gui.CreateWindowEx(
            ex_style, self.CLASS_NAME, "PC Status", win32con.WS_POPUP, 0, 0, p.width, p.height, 0, 0, self.hinst, None
        )
        p.hwnd = hwnd
        self.popups[hwnd] = p
        radius = self._s(12)
        rgn = win32gui.CreateRoundRectRgn(0, 0, p.width + 1, p.height + 1, radius, radius)
        win32gui.SetWindowRgn(hwnd, rgn, True)
        self._layout()
        win32gui.ShowWindow(hwnd, win32con.SW_SHOWNOACTIVATE)
        win32gui.UpdateWindow(hwnd)

    def _layout(self):
        """ポップアップを画面右下(タスクバーの上)に、新しいものが下になるよう積み上げる。"""
        try:
            monitor = win32api.MonitorFromPoint((0, 0), 1)  # MONITOR_DEFAULTTOPRIMARY
            left, top, right, bottom = win32api.GetMonitorInfo(monitor)["Work"]
        except Exception:
            right, bottom = win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1) - 48
        margin = self._s(16)
        y = bottom - margin
        ordered = list(self.popups.values())  # 作った順
        for p in reversed(ordered):
            y -= p.height
            win32gui.SetWindowPos(
                p.hwnd,
                win32con.HWND_TOPMOST,
                right - margin - p.width,
                y,
                p.width,
                p.height,
                win32con.SWP_NOACTIVATE | win32con.SWP_NOSIZE,
            )
            y -= self._s(8)

    def _check_timeouts(self):
        now = time.monotonic()
        changed = False
        for hwnd, p in list(self.popups.items()):
            if now > p.expires:
                cb = p.on_timeout
                win32gui.DestroyWindow(hwnd)
                changed = True
                if cb:
                    threading.Thread(target=cb, daemon=True).start()
        if changed:
            self._layout()

    def _paint(self, hwnd, p):
        hdc, ps = win32gui.BeginPaint(hwnd)
        try:
            bg = win32gui.CreateSolidBrush(_rgb(COLOR_BG))
            pen = win32gui.CreatePen(win32con.PS_SOLID, 1, _rgb(COLOR_BORDER))
            old_brush = win32gui.SelectObject(hdc, bg)
            old_pen = win32gui.SelectObject(hdc, pen)
            r = self._s(12)
            win32gui.RoundRect(hdc, 0, 0, p.width, p.height, r, r)
            win32gui.SetBkMode(hdc, win32con.TRANSPARENT)
            flags = win32con.DT_WORDBREAK | win32con.DT_NOPREFIX
            if p.title:
                win32gui.SelectObject(hdc, self.font_title)
                win32gui.SetTextColor(hdc, _rgb(COLOR_TITLE))
                win32gui.DrawText(hdc, p.title, -1, p.title_rect, flags)
            win32gui.SelectObject(hdc, self.font_text)
            win32gui.SetTextColor(hdc, _rgb(COLOR_TEXT if p.title else COLOR_TITLE))
            win32gui.DrawText(hdc, p.message, -1, p.message_rect, flags)
            win32gui.SelectObject(hdc, self.font_button)
            for rect, label, _cb, primary in p.button_rects:
                brush = win32gui.CreateSolidBrush(_rgb(COLOR_PRIMARY if primary else COLOR_SECONDARY))
                bpen = win32gui.CreatePen(win32con.PS_SOLID, 1, _rgb(COLOR_PRIMARY if primary else COLOR_SECONDARY))
                win32gui.SelectObject(hdc, brush)
                win32gui.SelectObject(hdc, bpen)
                br = self._s(8)
                win32gui.RoundRect(hdc, rect[0], rect[1], rect[2], rect[3], br, br)
                win32gui.SetTextColor(hdc, _rgb(COLOR_TITLE))
                win32gui.DrawText(
                    hdc, label, -1, rect, win32con.DT_CENTER | win32con.DT_VCENTER | win32con.DT_SINGLELINE
                )
                win32gui.SelectObject(hdc, pen)
                win32gui.SelectObject(hdc, bg)
                win32gui.DeleteObject(brush)
                win32gui.DeleteObject(bpen)
            win32gui.SelectObject(hdc, old_brush)
            win32gui.SelectObject(hdc, old_pen)
            win32gui.DeleteObject(bg)
            win32gui.DeleteObject(pen)
        finally:
            win32gui.EndPaint(hwnd, ps)

    def _button_at(self, p, x, y):
        for rect, _label, cb, _primary in p.button_rects:
            if rect[0] <= x < rect[2] and rect[1] <= y < rect[3]:
                return cb
        return None

    def _wndproc(self, hwnd, msg, wparam, lparam):
        p = self.popups.get(hwnd)
        if msg == WM_MOUSEACTIVATE:
            return MA_NOACTIVATE  # クリックされてもフォーカスを奪わない
        if p is not None:
            if msg == win32con.WM_PAINT:
                self._paint(hwnd, p)
                return 0
            if msg == win32con.WM_SETCURSOR:
                x, y = win32gui.ScreenToClient(hwnd, win32gui.GetCursorPos())
                if not p.buttons or self._button_at(p, x, y):
                    win32api.SetCursor(self.hand_cursor)
                    return 1
            if msg == win32con.WM_LBUTTONUP:
                x = ctypes.c_short(lparam & 0xFFFF).value
                y = ctypes.c_short((lparam >> 16) & 0xFFFF).value
                cb = self._button_at(p, x, y)
                if cb or not p.buttons:  # ボタン、またはお知らせ(ボタン無し)ならクリックで閉じる
                    win32gui.DestroyWindow(hwnd)
                    self._layout()
                    if cb:
                        threading.Thread(target=cb, daemon=True).start()
                return 0
            if msg == win32con.WM_DESTROY:
                self.popups.pop(hwnd, None)
                return 0
        return win32gui.DefWindowProc(hwnd, msg, wparam, lparam)


def make_notifier():
    """Windowsならポップアップ係を、ダメならログに出すだけの係を返す。"""
    from music_sync import ConsoleNotifier

    if not WIN32_AVAILABLE:
        return ConsoleNotifier()
    n = WinNotifier()
    if n.failed:
        return ConsoleNotifier()
    return n


# ---------------------------------------------------------------------- ショートカットキー
_MODIFIERS = {"ctrl": 0x0002, "control": 0x0002, "alt": 0x0001, "shift": 0x0004, "win": 0x0008}
MOD_NOREPEAT = 0x4000


def parse_hotkey(spec):
    """"ctrl+alt+m" → (modifiers, 仮想キーコード, 表示用の文字)。読めなければ None。"""
    parts = [x.strip().lower() for x in (spec or "").split("+") if x.strip()]
    if not parts:
        return None
    mods = 0
    for m in parts[:-1]:
        if m not in _MODIFIERS:
            return None
        mods |= _MODIFIERS[m]
    key = parts[-1]
    if len(key) == 1 and key.isalnum():
        vk = ord(key.upper())
    elif key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        vk = 0x70 + int(key[1:]) - 1
    else:
        return None
    label = "+".join([m.capitalize() for m in parts[:-1]] + [key.upper()])
    return mods, vk, label


def start_hotkey(spec, callback):
    """どの画面にいても効くショートカットキーを登録する。登録できたら表示用の文字を返す。"""
    parsed = parse_hotkey(spec)
    if not parsed:
        print(f"[ショートカット] 「{spec}」は読めない形式です(例: ctrl+alt+m)")
        return None
    mods, vk, label = parsed
    result = {"ok": None}
    done = threading.Event()

    def run():
        user32 = ctypes.windll.user32
        ok = False
        for _ in range(20):  # 再起動直後は古いプロセスがまだ登録しているかもしれないので少し粘る
            if user32.RegisterHotKey(None, 1, mods | MOD_NOREPEAT, vk):
                ok = True
                break
            time.sleep(0.5)
        result["ok"] = ok
        done.set()
        if not ok:
            return
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message == WM_HOTKEY:
                threading.Thread(target=callback, daemon=True).start()

    threading.Thread(target=run, name="hotkey", daemon=True).start()
    done.wait(12)
    if result["ok"]:
        print(f"[ショートカット] {label} で曲の共有をリクエスト/終了できます")
        return label
    print(f"[ショートカット] {label} はほかのアプリが使っているため登録できませんでした(config.json の music_hotkey で変えられます)")
    return None
