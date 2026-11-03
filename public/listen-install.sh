#!/bin/bash
# Listen Together - install for Mac (一緒に聴く 拡張機能を入れる・Mac 用)
#
# 使い方(ターミナルに貼り付けて Enter):
#   curl -fsSL https://pc-status-relay.onrender.com/listen-install.sh | bash
#
# 1. GitHub から拡張機能を ~/Library/Application Support/ListenTogether にダウンロードする
# 2. 2時間ごとに新しい版を確かめるよう、launchd(Mac の自動実行)に登録する(管理者の権限はいらない)
# 3. フォルダの場所をクリップボードにコピーする(拡張機能ページの「読み込む」で貼り付ける)
#
# やめる時:
#   curl -fsSL https://pc-status-relay.onrender.com/listen-uninstall.sh | bash

LT_UPDATE_URL="${LT_UPDATE_SCRIPT:-https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/listen-update.sh}"
LT_ROOT="${LT_ROOT:-$HOME/Library/Application Support/ListenTogether}"
LT_LABEL='com.skeliy.listentogether.updater'
LT_PLIST="${LT_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$LT_LABEL.plist"

echo ''
printf '\033[36mListen Together: downloading the extension... / 拡張機能をダウンロードしています…\033[0m\n'
LT_SETUP="$(mktemp -d)"
if ! curl -fsSL "$LT_UPDATE_URL" -o "$LT_SETUP/listen-update.sh"; then
  echo 'Download failed. Check your internet connection and try again. / ダウンロードできませんでした。'
  rm -rf "$LT_SETUP"
  exit 1
fi
if ! LT_ROOT="$LT_ROOT" bash "$LT_SETUP/listen-update.sh"; then
  echo 'Install failed. Please try again. / 入れられませんでした。もう一度試してください。'
  rm -rf "$LT_SETUP"
  exit 1
fi
rm -rf "$LT_SETUP"

# 自動更新(launchd)。ログインしている間、2時間ごとに更新係を動かす
LT_AUTO=0
if command -v launchctl >/dev/null 2>&1; then
  mkdir -p "$(dirname "$LT_PLIST")"
  cat > "$LT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>/usr/bin/curl -fsSL $LT_UPDATE_URL | /bin/bash</string>
  </array>
  <key>StartInterval</key><integer>7200</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LT_LABEL" >/dev/null 2>&1
  if launchctl bootstrap "gui/$(id -u)" "$LT_PLIST" >/dev/null 2>&1 || launchctl load -w "$LT_PLIST" >/dev/null 2>&1; then
    LT_AUTO=1
  else
    echo 'Could not set up automatic updates. / 自動更新を設定できませんでした。'
  fi
fi

LT_COPIED=0
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$LT_ROOT" | pbcopy && LT_COPIED=1
fi

echo ''
printf '\033[32mDone! / 完了しました\033[0m\n'
echo ''
echo "Extension folder / 拡張機能のフォルダ:  $LT_ROOT"
[ "$LT_COPIED" = 1 ] && echo '(copied to the clipboard / クリップボードにコピーしました)'
echo ''
echo 'Next: open chrome://extensions, turn on Developer mode, click "Load unpacked", press Cmd+Shift+G, press Cmd+V and Enter, then click "Select".'
echo '次に: chrome://extensions を開いてデベロッパーモードをオンにし、「パッケージ化されていない拡張機能を読み込む」を押します。Cmd+Shift+G を押し、Cmd+V と Enter を押してから「選択」を押します。'
echo ''
if [ "$LT_AUTO" = 1 ]; then
  printf '\033[32mUpdates install automatically every 2 hours. / 2時間ごとに自動で新しい版になります。\033[0m\n'
else
  echo 'To update later, run this command again. / 新しい版にする時は、このコマンドをもう一度実行してください。'
fi
echo ''
