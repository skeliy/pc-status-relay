' agent.py をウィンドウを表示せずバックグラウンドで起動するためのスクリプト。
' スタートアップフォルダにこのファイルのショートカットを置くと、
' Windowsログイン時にコンソール画面を出さずに agent.py が自動起動します。
'
' 使い方は README.md の「エージェントの自動起動」を参照してください。
' 必要に応じて、下の pythonw と agent.py の絶対パスを環境に合わせて書き換えてください。

Set objShell = CreateObject("WScript.Shell")
strPath = objShell.CurrentDirectory
objShell.Run "pythonw.exe """ & strPath & "\agent.py""", 0, False
