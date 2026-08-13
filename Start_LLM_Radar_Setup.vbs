Option Explicit
Dim fso, shell, root, tools, ps, setup, launcher, cmd, logDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
tools = fso.BuildPath(root, "tools")
launcher = fso.BuildPath(tools, "Launch_LLM_Radar_Setup.ps1")
setup = fso.BuildPath(tools, "LLMRadarWindowsSetup.ps1")
logDir = fso.BuildPath(tools, "logs")
If Not fso.FolderExists(logDir) Then On Error Resume Next: fso.CreateFolder(logDir): On Error GoTo 0

If Not fso.FileExists(setup) Then
  MsgBox "LLM Radar cannot start setup because a required setup file is missing:" & vbCrLf & vbCrLf & setup & vbCrLf & vbCrLf & "Extract the full LLM Radar package to a normal folder, then run Start_Here again.", vbCritical, "LLM Radar setup cannot continue"
  WScript.Quit 2
End If
If Not fso.FileExists(launcher) Then
  MsgBox "LLM Radar cannot start setup because the setup launcher is missing:" & vbCrLf & vbCrLf & launcher & vbCrLf & vbCrLf & "Extract the full LLM Radar package to a normal folder, then run Start_Here again.", vbCritical, "LLM Radar setup cannot continue"
  WScript.Quit 2
End If

ps = ""
Call TryPs(shell.ExpandEnvironmentStrings("%SystemRoot%") & "\Sysnative\WindowsPowerShell\v1.0\powershell.exe")
Call TryPs(shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe")
Call TryPs(shell.ExpandEnvironmentStrings("%WINDIR%") & "\Sysnative\WindowsPowerShell\v1.0\powershell.exe")
Call TryPs(shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe")
Call TryPs(shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\PowerShell\7\pwsh.exe")

If ps = "" Then
  MsgBox "LLM Radar cannot complete Windows setup on this computer because Windows PowerShell is not available or is blocked by policy." & vbCrLf & vbCrLf & "No firewall or network changes were made." & vbCrLf & vbCrLf & "Ask an administrator to enable Windows PowerShell or use an IT-managed setup path.", vbCritical, "LLM Radar setup cannot continue"
  WScript.Quit 3
End If

cmd = Quote(ps) & " -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(launcher) & " -SetupPath " & Quote(setup)
On Error Resume Next
shell.Run cmd, 0, False
If Err.Number <> 0 Then
  MsgBox "LLM Radar could not open the Windows Setup app." & vbCrLf & vbCrLf & "No firewall or network changes were made." & vbCrLf & vbCrLf & "Try running tools\Run_Command_Setup_Advanced.bat, or ask an administrator to review the setup package.", vbCritical, "LLM Radar setup could not start"
  WScript.Quit 4
End If
On Error GoTo 0
WScript.Quit 0

Sub TryPs(path)
  If ps = "" Then
    If fso.FileExists(path) Then ps = path
  End If
End Sub

Function Quote(s)
  Quote = Chr(34) & s & Chr(34)
End Function
