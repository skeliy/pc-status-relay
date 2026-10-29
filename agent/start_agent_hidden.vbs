' agent.py をウィンドウを表示せずバックグラウンドで起動するためのスクリプト。
' スタートアップフォルダにこのファイルのショートカットを置くと、
' Windowsログイン時にコンソール画面を出さずに agent.py が自動起動します。

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set objShell = CreateObject("WScript.Shell")
objShell.Run "pythonw.exe """ & scriptDir & "\agent.py""", 0, False