#!/bin/bash
# Listen Together - updater for Mac (一緒に聴く 拡張機能の更新係・Mac 用)
#
# GitHub (skeliy/pc-status-relay の agent/extension) に新しい版があれば、
# ~/Library/Application Support/ListenTogether の中身を新しくする。
# 拡張機能は中身が新しくなったことに自分で気付いて、読み込み直す。
#
# launchd(Mac の自動実行)から2時間ごとに
#   curl -fsSL https://raw.githubusercontent.com/skeliy/pc-status-relay/main/public/listen-update.sh | bash
# の形で実行される(このファイル自体も GitHub から毎回取ってくるので、更新係の直しも自動で届く)。
# Mac に最初から入っているコマンド(curl・sed など)だけで書いている。

lt_update() {
  local base="${LT_UPDATE_BASE:-https://raw.githubusercontent.com/skeliy/pc-status-relay/main/agent}"
  local root="${LT_ROOT:-$HOME/Library/Application Support/ListenTogether}"
  local tmp="${root}-download"
  local log="$root/update.log"

  lt_log() {
    local line
    line="$(date '+%Y-%m-%d %H:%M:%S')  $1"
    echo "$line"
    if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 200000 ]; then rm -f "$log"; fi
    echo "$line" >> "$log" 2>/dev/null
  }

  lt_version() { # manifest.json から "version" を取り出す
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
  }

  lt_fail() {
    lt_log "update failed: $1"
    rm -rf "$tmp"
    return 1
  }

  mkdir -p "$root" || return 1
  rm -rf "$tmp"
  mkdir -p "$tmp" || return 1

  curl -fsSL "$base/extension/manifest.json" -o "$tmp/manifest.json" || { lt_fail 'could not read the latest version'; return 1; }
  local remote local_v=''
  remote="$(lt_version "$tmp/manifest.json")"
  [ -n "$remote" ] || { lt_fail 'could not read the latest version'; return 1; }
  [ -f "$root/manifest.json" ] && local_v="$(lt_version "$root/manifest.json")"
  if [ "$remote" = "$local_v" ] && [ -z "$LT_FORCE" ]; then
    rm -rf "$tmp"
    lt_log "up to date ($local_v)"
    return 0
  fi

  # FILES に書かれた extension/ のファイルを全部、いったん別の場所にダウンロードする
  curl -fsSL "$base/FILES" -o "$tmp/.files" || { lt_fail 'could not read the file list'; return 1; }
  local list
  list="$(tr -d '\r' < "$tmp/.files" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep '^extension/' | grep -v '\.\.')"
  [ -n "$list" ] || { lt_fail 'could not read the file list'; return 1; }

  local f rel
  while IFS= read -r f; do
    rel="${f#extension/}"
    [ "$rel" = 'manifest.json' ] && continue
    mkdir -p "$tmp/$(dirname "$rel")"
    curl -fsSL "$base/$f" -o "$tmp/$rel" || { lt_fail "could not download $f"; return 1; }
  done <<< "$list"

  # 全部そろってから入れ替える。manifest.json は最後(拡張機能はこれを見て読み込み直すため)
  while IFS= read -r f; do
    rel="${f#extension/}"
    [ "$rel" = 'manifest.json' ] && continue
    mkdir -p "$root/$(dirname "$rel")"
    cp -f "$tmp/$rel" "$root/$rel" || { lt_fail "could not copy $rel"; return 1; }
  done <<< "$list"
  cp -f "$tmp/manifest.json" "$root/manifest.json" || { lt_fail 'could not copy manifest.json'; return 1; }
  rm -rf "$tmp"

  if [ -n "$local_v" ]; then lt_log "updated $local_v -> $remote"; else lt_log "installed $remote"; fi
  return 0
}

lt_update
