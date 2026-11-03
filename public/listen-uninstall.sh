#!/bin/bash
# Listen Together - uninstall for Mac (一緒に聴く 拡張機能の更新係をやめる・Mac 用)
#
# 使い方(ターミナルに貼り付けて Enter):
#   curl -fsSL https://pc-status-relay.onrender.com/listen-uninstall.sh | bash
#
# 先にブラウザの拡張機能ページで Listen Together を「削除」してから実行してください。
# 自動更新(launchd)をやめ、~/Library/Application Support/ListenTogether フォルダを消す。

LT_ROOT="${LT_ROOT:-$HOME/Library/Application Support/ListenTogether}"
LT_LABEL='com.skeliy.listentogether.updater'
LT_PLIST="${LT_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$LT_LABEL.plist"

if [ -f "$LT_PLIST" ]; then
  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LT_LABEL" >/dev/null 2>&1 || launchctl unload -w "$LT_PLIST" >/dev/null 2>&1
  fi
  rm -f "$LT_PLIST"
  echo 'Automatic updates stopped. / 自動更新を止めました。'
fi
rm -rf "${LT_ROOT}-download"
if [ -d "$LT_ROOT" ]; then
  rm -rf "$LT_ROOT"
  echo "Removed / 消しました: $LT_ROOT"
fi
printf '\033[32mDone. Remove "Listen Together" on the extensions page if it is still there. / 完了しました。拡張機能ページに Listen Together が残っていたら「削除」してください。\033[0m\n'
