param(
  [switch]$AdminRepair,
  [int]$HelperPort = 49321,
  [int]$AiPort = 0,
  [string]$NodePath = '',
  [switch]$DebugConsole
)

$ErrorActionPreference = 'Continue'
$script:Root = Split-Path -Parent $PSScriptRoot
$script:LogDir = Join-Path $PSScriptRoot 'logs'
$script:StateFile = Join-Path $script:LogDir 'setup_state.json'
$script:RepairLog = Join-Path $script:LogDir 'setup_repair.log'
if (-not (Test-Path $script:LogDir)) { New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null }

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-Host "LLM Radar Windows Setup requires Windows PowerShell with Windows Forms support."
  Write-Host $_.Exception.Message
  exit 2
}

function New-LLMPoint([int]$X, [int]$Y) {
  return (New-Object -TypeName System.Drawing.Point -ArgumentList @($X, $Y))
}

function New-LLMSize([int]$Width, [int]$Height) {
  return (New-Object -TypeName System.Drawing.Size -ArgumentList @($Width, $Height))
}

function New-LLMFont([string]$Name, [float]$Size) {
  return (New-Object -TypeName System.Drawing.Font -ArgumentList @($Name, $Size))
}

function Write-SetupLog([string]$Message) {
  try {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path (Join-Path $script:LogDir 'setup.log') -Value $line -Encoding UTF8
  } catch {}
}

function Show-Info([string]$Title, [string]$Message) {
  [System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}

function Show-Warn([string]$Title, [string]$Message) {
  [System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
}

function Ask-Recommended([string]$Title, [string]$Message) {
  $result = [System.Windows.Forms.MessageBox]::Show($Message, $Title, [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button1)
  return ($result -eq [System.Windows.Forms.DialogResult]::Yes)
}

function Test-IsAdmin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

function Get-PowerShellExe {
  $candidates = @(
    "$env:SystemRoot\Sysnative\WindowsPowerShell\v1.0\powershell.exe",
    "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe",
    "$env:WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe",
    "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe",
    "$env:ProgramFiles\PowerShell\7\pwsh.exe"
  )
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
  $cmd = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Get-NodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $common = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )
  foreach ($p in $common) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

function Get-PrivateScore([string]$Address, [string]$Name) {
  $n = ([string]$Name).ToLowerInvariant()
  $score = 0
  if ($n -match 'wi-?fi|wireless|wlan') { $score += 60 }
  if ($n -match 'ethernet|lan') { $score += 45 }
  if ($n -match 'virtual|vmware|virtualbox|docker|hyper-v|vethernet|loopback|local area connection\*') { $score -= 120 }
  if ($Address.StartsWith('192.168.')) { $score += 40 }
  if ($Address.StartsWith('10.')) { $score += 25 }
  if ($Address -match '^172\.(1[6-9]|2\d|3[01])\.') { $score += 20 }
  if ($Address.StartsWith('192.168.137.')) { $score -= 90 }
  if ($Address.StartsWith('169.254.')) { $score -= 100 }
  return $score
}

function Get-LanIps {
  $items = @()
  try {
    foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
      $props = $nic.GetIPProperties()
      foreach ($ua in $props.UnicastAddresses) {
        if ($ua.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
        $addr = $ua.Address.ToString()
        if (-not $addr -or $addr -eq '127.0.0.1') { continue }
        $items += [PSCustomObject]@{ Address=$addr; Adapter=$nic.Name; Score=(Get-PrivateScore $addr $nic.Name) }
      }
    }
  } catch {}
  return @($items | Sort-Object Score -Descending)
}

function Test-PortAvailable([int]$Port) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
    $listener.Start()
    return $true
  } catch { return $false }
  finally { if ($listener) { $listener.Stop() } }
}

function Select-HelperPort {
  foreach ($p in 49321..49329) { if (Test-PortAvailable $p) { return $p } }
  return 49321
}

function Invoke-QuickGet([string]$Url, [int]$TimeoutMs = 400) {
  try {
    # Use a small .NET request instead of Invoke-WebRequest. It is faster on older
    # Windows PowerShell, avoids extra browser/proxy behavior, and gives setup a
    # predictable timeout so the UI does not feel frozen.
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    $req.Timeout = $TimeoutMs
    $req.ReadWriteTimeout = $TimeoutMs
    $req.Proxy = $null
    $req.Accept = 'application/json,text/html,*/*'
    $resp = $req.GetResponse()
    try { $status = [int]$resp.StatusCode } catch { $status = 200 }
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $text = $reader.ReadToEnd()
    $reader.Close()
    $resp.Close()
    return [PSCustomObject]@{ Ok=$true; Status=$status; Text=[string]$text; Error='' }
  } catch {
    return [PSCustomObject]@{ Ok=$false; Status=0; Text=''; Error=$_.Exception.Message }
  }
}

function Test-AiBase([string]$BaseUrl, [int]$Port) {
  $checks = @(
    [PSCustomObject]@{ Path='/v1/models'; Provider='llama-server / LocalAI / OpenAI-compatible'; Kind='openai-compatible'; Match='"data"\s*:|"object"\s*:\s*"list"' },
    [PSCustomObject]@{ Path='/api/tags'; Provider='Ollama'; Kind='ollama'; Match='"models"\s*:' },
    [PSCustomObject]@{ Path='/'; Provider='Local web/API service'; Kind='unknown'; Match='open webui|llama|localai|ollama|lm studio' }
  )
  foreach ($check in $checks) {
    $url = "$BaseUrl$($check.Path)"
    $res = Invoke-QuickGet $url 400
    if ($res.Ok -and (($res.Text -match $check.Match) -or ($res.Status -ge 200 -and $res.Status -lt 400 -and $check.Path -eq '/'))) {
      return [PSCustomObject]@{ Found=$true; BaseUrl=$BaseUrl; Port=$Port; Path=$check.Path; Provider=$check.Provider; Kind=$check.Kind; Status=$res.Status; Error='' }
    }
  }
  return $null
}

function Find-LocalAi([array]$LanIps) {
  $known = 0
  if ($env:LLMRADAR_AI_PORT) { [void][int]::TryParse($env:LLMRADAR_AI_PORT, [ref]$known) }
  $basePorts = @(8080,11434,1234,3000,8000,5000)
  $portList = New-Object System.Collections.Generic.List[int]
  if ($known -gt 0) { [void]$portList.Add([int]$known) }
  foreach ($p in $basePorts) { if ($p -ne $known) { [void]$portList.Add([int]$p) } }
  $ports = @($portList.ToArray())
  $bestIp = if ($LanIps.Count -gt 0) { $LanIps[0].Address } else { $null }

  # Fast path: the most common llama-server setup is --host 0.0.0.0 --port 8080.
  # Check it first using the actual computer LAN address, then localhost, before
  # trying broader fallback ports.
  $fastPortList = New-Object System.Collections.Generic.List[int]
  foreach ($p in @(8080, $known, 11434, 1234)) {
    if ($p -gt 0 -and -not $fastPortList.Contains([int]$p)) { [void]$fastPortList.Add([int]$p) }
  }
  $fastPorts = @($fastPortList.ToArray())

  if ($bestIp) {
    foreach ($port in $fastPorts) {
      $hit = Test-AiBase "http://$bestIp`:$port" $port
      if ($hit) { return $hit }
    }
  }

  foreach ($port in $fastPorts) {
    $hit = Test-AiBase "http://127.0.0.1`:$port" $port
    if ($hit) {
      $hit | Add-Member -NotePropertyName LocalhostOnly -NotePropertyValue $true -Force
      return $hit
    }
  }

  # Broader fallback stays available, but only after the likely ports fail.
  foreach ($ip in $LanIps) {
    foreach ($port in $ports) {
      if ($fastPorts -contains $port) { continue }
      $hit = Test-AiBase "http://$($ip.Address)`:$port" $port
      if ($hit) { return $hit }
    }
  }
  foreach ($port in $ports) {
    if ($fastPorts -contains $port) { continue }
    $hit = Test-AiBase "http://127.0.0.1`:$port" $port
    if ($hit) {
      $hit | Add-Member -NotePropertyName LocalhostOnly -NotePropertyValue $true -Force
      return $hit
    }
  }
  return $null
}

function Test-FirewallPortRule([int]$Port, [string]$NamePrefix) {
  try {
    $rules = @(Get-NetFirewallRule -DisplayName "$NamePrefix*" -ErrorAction SilentlyContinue)
    foreach ($rule in $rules) {
      if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Allow') { continue }
      $pf = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
      if ($pf -and [string]$pf.Protocol -eq 'TCP' -and (([string]$pf.LocalPort -eq [string]$Port) -or ([string]$pf.LocalPort -eq 'Any'))) { return $true }
    }
  } catch {}
  return $false
}

function Test-FirewallProgramPortRule([int]$Port, [string]$ProgramPath) {
  if (-not $ProgramPath) { return $false }
  try {
    $rules = @(Get-NetFirewallRule -DisplayName "LLM Radar Phone Access Program*" -ErrorAction SilentlyContinue) + @(Get-NetFirewallRule -DisplayName "LLM Radar Helper Program*" -ErrorAction SilentlyContinue)
    foreach ($rule in $rules) {
      if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Allow') { continue }
      $af = $rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
      if (-not $af -or ([string]$af.Program -ine [string]$ProgramPath)) { continue }
      $pf = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
      if ($pf -and [string]$pf.Protocol -eq 'TCP' -and (([string]$pf.LocalPort -eq [string]$Port) -or ([string]$pf.LocalPort -eq 'Any'))) { return $true }
    }
  } catch {}
  return $false
}

function Get-FirewallStatus([int]$HelperPort, [int]$AiPort, [string]$NodePath = '') {
  $status = [ordered]@{ ReadOk=$false; Enabled=$null; AllowInboundRules=$null; AllowLocalFirewallRules=$null; HelperRule=$false; PhoneAccessProgramRule=$false; AiRule=$false; UploadRoutePrepared=$false; NeedsRepair=$true; Error='' }
  try {
    $fw = Get-NetFirewallProfile -Profile Private -ErrorAction Stop
    $status.ReadOk = $true
    $status.Enabled = [string]$fw.Enabled
    $status.AllowInboundRules = [string]$fw.AllowInboundRules
    $status.AllowLocalFirewallRules = [string]$fw.AllowLocalFirewallRules
    $status.HelperRule = (Test-FirewallPortRule $HelperPort 'LLM Radar Phone Access') -or (Test-FirewallPortRule $HelperPort 'LLM Radar Helper')
    if ($NodePath) { $status.PhoneAccessProgramRule = Test-FirewallProgramPortRule $HelperPort $NodePath } else { $status.PhoneAccessProgramRule = $false }
    $status.UploadRoutePrepared = $status.HelperRule -and ((-not $NodePath) -or $status.PhoneAccessProgramRule)
    if ($AiPort -gt 0) { $status.AiRule = Test-FirewallPortRule $AiPort 'LLM Radar AI' } else { $status.AiRule = $false }
    $status.NeedsRepair = -not (($status.Enabled -eq 'True') -and ($status.AllowInboundRules -eq 'True') -and ($status.AllowLocalFirewallRules -eq 'True') -and $status.UploadRoutePrepared -and (($AiPort -le 0) -or $status.AiRule))
  } catch {
    $status.Error = $_.Exception.Message
  }
  return [PSCustomObject]$status
}

function Ensure-PortRule([string]$DisplayName, [int]$Port) {
  try {
    $existing = @(Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) { $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
    New-NetFirewallRule -DisplayName $DisplayName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    return $true
  } catch {
    Write-SetupLog (("Firewall rule error for {0}/{1}: {2}" -f $DisplayName, $Port, $_.Exception.Message))
    return $false
  }
}

function Ensure-ProgramPortRule([string]$ProgramPath, [int]$Port) {
  try {
    if (-not $ProgramPath -or -not (Test-Path $ProgramPath)) { return $false }
    $name = "LLM Radar Phone Access Program $Port"
    $existing = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) { $existing | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Program $ProgramPath -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    return $true
  } catch {
    Write-SetupLog "Program firewall rule error: $($_.Exception.Message)"
    return $false
  }
}

function Invoke-AdminRepair {
  if (-not (Test-IsAdmin)) {
    Show-Warn 'Administrator permission required' 'LLM Radar cannot complete Windows setup changes without Administrator permission. No firewall or network changes were made.'
    exit 10
  }
  try { Add-Content -Path $script:RepairLog -Value "`n=== Repair started $(Get-Date) ===" -Encoding UTF8 } catch {}

  $profiles = @()
  try { $profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -or $_.IPv6Connectivity -ne 'Disconnected' }) } catch {}
  foreach ($profile in $profiles) {
    if ($profile.NetworkCategory -eq 'Public') {
      $msg = "LLM Radar needs this trusted Wi-Fi network to be marked Private so your phone can reach this computer.`n`nCurrent network: $($profile.Name)`nCurrent profile: Public`n`nRecommended: choose Yes if this is your trusted home/work Wi-Fi. Choosing No stops setup before this network is changed."
      if (Ask-Recommended 'Set trusted Wi-Fi to Private?' $msg) {
        Set-NetConnectionProfile -InterfaceIndex $profile.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
      } else { Show-Warn 'Setup stopped' 'LLM Radar cannot reliably connect the phone while this network is Public. No further repair was made.'; exit 21 }
    }
  }

  $fw = Get-NetFirewallProfile -Profile Private -ErrorAction Stop
  if ([string]$fw.Enabled -ne 'True') {
    $msg = "Windows Firewall is currently OFF for the Private network.`n`nLLM Radar does not need the firewall turned off. The safer setup is to turn Firewall back ON and add narrow allow rules only for LLM Radar and the local AI port.`n`nRecommended: choose Yes to turn Firewall ON and continue. Choosing No stops setup."
    if (Ask-Recommended 'Turn Windows Firewall back on?' $msg) { Set-NetFirewallProfile -Profile Private -Enabled True -ErrorAction Stop } else { exit 22 }
  }

  $fw = Get-NetFirewallProfile -Profile Private -ErrorAction Stop
  if (([string]$fw.AllowInboundRules -ne 'True') -or ([string]$fw.AllowLocalFirewallRules -ne 'True')) {
    $msg = "Windows is not currently honoring the narrow inbound/local firewall rules LLM Radar creates.`n`nThat means the port rules may exist but your phone can still be blocked.`n`nRecommended: choose Yes so Windows honors LLM Radar's narrow Private-network allow rules. Choosing No stops setup."
    if (Ask-Recommended 'Allow LLM Radar firewall rules to work?' $msg) { Set-NetFirewallProfile -Profile Private -AllowInboundRules True -AllowLocalFirewallRules True -ErrorAction Stop } else { exit 23 }
  }

  $hp = [Math]::Max(49321, $HelperPort)
  $msg = "LLM Radar needs phone-access port $hp so the phone app can pair, chat/check status, and upload a small PDF/TXT to this computer.`n`nThis creates one narrow inbound TCP allow rule on Private Wi-Fi only. It does not turn off Windows Firewall.`n`nRecommended: choose Yes to continue setup. Choosing No stops setup."
  if (Ask-Recommended 'Allow LLM Radar phone-access port?' $msg) { [void](Ensure-PortRule "LLM Radar Phone Access $hp" $hp) } else { exit 24 }

  if ($AiPort -gt 0) {
    $msg = "LLM Radar found a local AI server on port $AiPort.`n`nFor phone chat, benchmark, and reports to work, Windows must allow the phone to reach this local AI server over trusted Private Wi-Fi.`n`nRecommended: choose Yes. Choosing No continues setup, but phone chat may fail."
    if (Ask-Recommended 'Allow local AI server port?' $msg) { [void](Ensure-PortRule "LLM Radar AI $AiPort" $AiPort) }
  }

  if ($NodePath) {
    $msg = "Recommended phone-access repair: allow the LLM Radar Phone Access program.`n`nMost systems work with the port rule alone. Some Windows systems still block the Phone Access program that serves QR pairing, chat/status, and file upload.`n`nProgram: $NodePath`nPort: $hp`n`nThis adds one narrow allow rule for this program and port on Private Wi-Fi only. It does not turn off Windows Firewall.`n`nRecommended: choose Yes for the least troubleshooting. Choose No only if you intentionally want to skip this repair. If file upload fails later, run Start_Here.bat again and allow this step."
    if (Ask-Recommended 'Allow LLM Radar phone access program?' $msg) { [void](Ensure-ProgramPortRule $NodePath $hp) } else { exit 25 }
  }

  Show-Info 'LLM Radar setup complete' 'Required Windows setup changes are complete. Phone access is prepared for QR pairing, chat/status checks, and file upload. Return to LLM Radar Windows Setup and click Check This Computer.'
  exit 0
}

if ($AdminRepair) { Invoke-AdminRepair }

$script:Current = $null
$script:HelperProcess = $null
$script:PairUrl = ''
$script:HelperUrl = ''

function Read-HelperPid {
  try {
    if (Test-Path $script:StateFile) {
      $data = Get-Content $script:StateFile -Raw | ConvertFrom-Json
      if ($data.helperPid) { return [int]$data.helperPid }
    }
  } catch {}
  return 0
}

function Stop-ProcessTreeSafe([int]$ProcessIdToStop, [string]$Reason) {
  if ($ProcessIdToStop -le 0 -or $ProcessIdToStop -eq $PID) { return }
  try {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessIdToStop" -ErrorAction SilentlyContinue)
    foreach ($child in $children) { Stop-ProcessTreeSafe ([int]$child.ProcessId) $Reason }
  } catch {}
  try {
    $p = Get-Process -Id $ProcessIdToStop -ErrorAction SilentlyContinue
    if ($p) {
      Write-SetupLog "Stopping LLM Radar process PID=$ProcessIdToStop. Reason=$Reason"
      Stop-Process -Id $ProcessIdToStop -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Get-LlmRadarProcessItems {
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ProcessId -and ([int]$_.ProcessId) -ne $PID -and $_.CommandLine -and ($_.CommandLine -like "*$($script:Root)*" -or $_.CommandLine -like '*LLM Radar*' -or $_.CommandLine -like '*LLMRadar*')
    })
  } catch { return @() }
}

function Stop-LlmRadarHelperProcesses {
  $oldHelperPid = Read-HelperPid
  if ($oldHelperPid -gt 0) { Stop-ProcessTreeSafe $oldHelperPid 'state-file Phone Access cleanup' }

  if ($script:HelperProcess -and -not $script:HelperProcess.HasExited) {
    Stop-ProcessTreeSafe ([int]$script:HelperProcess.Id) 'active Phone Access cleanup'
    $script:HelperProcess = $null
  }

  foreach ($item in Get-LlmRadarProcessItems) {
    try {
      $name = ([string]$item.Name).ToLowerInvariant()
      $cmd = [string]$item.CommandLine
      if ($name -eq 'node.exe' -and $cmd -like '*llmradar-ez-pair.js*') {
        Stop-ProcessTreeSafe ([int]$item.ProcessId) 'orphaned Phone Access node cleanup'
      }
    } catch {}
  }
}

function Stop-LlmRadarWaitingConsoles {
  foreach ($item in Get-LlmRadarProcessItems) {
    try {
      $name = ([string]$item.Name).ToLowerInvariant()
      $cmd = [string]$item.CommandLine
      if ($name -in @('cmd.exe','powershell.exe','pwsh.exe') -and (
        $cmd -like '*Start_Here.bat*' -or
        $cmd -like '*Run_Command_Setup_Advanced.bat*' -or
        $cmd -like '*Launch_LLM_Radar_Setup.ps1*' -or
        $cmd -like '*LLMRadarWindowsSetup.ps1*'
      )) {
        Stop-ProcessTreeSafe ([int]$item.ProcessId) 'related console cleanup after GUI close'
      }
    } catch {}
  }
}

function Stop-OldHelper {
  Stop-LlmRadarHelperProcesses
}

function Invoke-GuiCloseCleanup {
  try {
    Stop-LlmRadarHelperProcesses
    Stop-LlmRadarWaitingConsoles
    if (Test-Path $script:StateFile) { Remove-Item $script:StateFile -Force -ErrorAction SilentlyContinue }
    $script:HelperUrl = ''
    $script:PairUrl = ''
  } catch { Write-SetupLog "Close cleanup failed: $($_.Exception.Message)" }
}

function Get-StatusText([object]$State) {
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('LLM Radar Windows Setup')
  $lines.Add('')
  if ($State.NodePath) { $lines.Add("PASS: Node.js found: $($State.NodePath)") } else { $lines.Add('CANNOT COMPLETE: Node.js LTS was not found. LLM Radar needs Node.js to run the computer Phone Access service. Install Node.js LTS, then click Check This Computer.') }
  if ($State.BestIp) { $lines.Add("PASS: Computer LAN address: $($State.BestIp.Address) ($($State.BestIp.Adapter))") } else { $lines.Add('CANNOT COMPLETE: No usable computer LAN address was found. Connect this computer to trusted home/work Wi-Fi, then click Check This Computer.') }
  if ($State.Ai) {
    if ($State.Ai.LocalhostOnly) { $lines.Add("WARN: Local AI found only on this computer: $($State.Ai.BaseUrl). Restart it for LAN access, for example llama-server --host 0.0.0.0 --port $($State.Ai.Port).") }
    else { $lines.Add("PASS: Local AI server is LAN-ready: $($State.Ai.BaseUrl) via $($State.Ai.Path)") }
  } else { $lines.Add('WAITING: No LAN-ready local AI server was found yet. Start llama-server/Ollama/LM Studio, then click Check This Computer.') }
  if ($State.Firewall.ReadOk) {
    if (-not $State.Firewall.NeedsRepair) { $lines.Add('PASS: Windows Firewall readiness looks good for LLM Radar phone access, including file upload.') }
    else {
      $lines.Add('ACTION NEEDED: LLM Radar needs Windows setup permission before average phone pairing will be reliable.')
      $lines.Add("  Private Firewall Enabled: $($State.Firewall.Enabled)")
      $lines.Add("  AllowInboundRules: $($State.Firewall.AllowInboundRules)")
      $lines.Add("  AllowLocalFirewallRules: $($State.Firewall.AllowLocalFirewallRules)")
      $lines.Add("  Phone access port rule: $($State.Firewall.HelperRule)")
      $lines.Add("  Phone access program rule: $($State.Firewall.PhoneAccessProgramRule)")
      if ($State.AiPort -gt 0) { $lines.Add("  AI port rule: $($State.Firewall.AiRule)") }
    }
  } else { $lines.Add("WARN: Could not read Windows Firewall status: $($State.Firewall.Error)") }
  $lines.Add('')
  if ($State.Ready) { $lines.Add('READY: Click Start Phone Access, then connect from the phone app.') }
  elseif (-not $State.NodePath) { $lines.Add('CANNOT COMPLETE: Node.js is required for the computer Phone Access service.') }
  elseif ($State.Firewall.NeedsRepair) { $lines.Add('NEXT STEP: Click Allow Required Windows Setup. Administrator permission may be required.') }
  elseif (-not $State.Ai) { $lines.Add('NEXT STEP: Start your local AI server, then click Check This Computer.') }
  else { $lines.Add('NEXT STEP: Click Check This Computer again, or fix the item shown above.') }
  return ($lines -join "`r`n")
}

function Get-SetupState {
  $node = Get-NodeExe
  $helperPort = Select-HelperPort
  $ips = @(Get-LanIps)
  $bestIp = if ($ips.Count -gt 0) { $ips[0] } else { $null }
  $ai = Find-LocalAi $ips
  $aiPort = if ($ai) { [int]$ai.Port } else { 0 }
  $fw = Get-FirewallStatus $helperPort $aiPort $node
  $ready = ($node -and $bestIp -and $ai -and -not $ai.LocalhostOnly -and -not $fw.NeedsRepair)
  return [PSCustomObject]@{ NodePath=$node; HelperPort=$helperPort; LanIps=$ips; BestIp=$bestIp; Ai=$ai; AiPort=$aiPort; Firewall=$fw; Ready=$ready }
}



function New-AiCandidateList([array]$LanIps) {
  $known = 0
  if ($env:LLMRADAR_AI_PORT) { [void][int]::TryParse($env:LLMRADAR_AI_PORT, [ref]$known) }
  $portList = New-Object System.Collections.Generic.List[int]
  foreach ($p in @(8080, $known, 11434, 1234, 3000, 8000, 5000)) {
    if ($p -gt 0 -and -not $portList.Contains([int]$p)) { [void]$portList.Add([int]$p) }
  }
  $items = New-Object System.Collections.Generic.List[object]
  $bestIp = if ($LanIps -and $LanIps.Count -gt 0) { $LanIps[0].Address } else { $null }
  if ($bestIp) {
    foreach ($port in $portList.ToArray()) {
      [void]$items.Add([PSCustomObject]@{ BaseUrl="http://$bestIp`:$port"; Port=[int]$port; Localhost=$false })
    }
  }
  foreach ($port in $portList.ToArray()) {
    [void]$items.Add([PSCustomObject]@{ BaseUrl="http://127.0.0.1`:$port"; Port=[int]$port; Localhost=$true })
  }
  return @($items.ToArray())
}

function Move-ToFirewallCheck {
  Set-MainMessage 'Checking phone-access firewall readiness...'
  Set-ChecklistRow 'Firewall' 'CHECKING' 'Wait' 'Checking phone-access firewall readiness...'
  $script:ScanStep = 4
}

function Finish-Scan {
  try {
    if ($script:ScanTimer) { $script:ScanTimer.Stop() }
    $btnCheck.Text = 'Check This Computer'
    $btnCheck.Enabled = $true
    $btnCheck.Focus() | Out-Null

    $node = $script:ScanData.NodePath
    $bestIp = $script:ScanData.BestIp
    $ai = $script:ScanData.Ai
    $fw = $script:ScanData.Firewall
    $ready = ($node -and $bestIp -and $ai -and -not $ai.LocalhostOnly -and $fw -and -not $fw.NeedsRepair)
    $script:Current = [PSCustomObject]@{
      NodePath=$node
      HelperPort=$script:ScanData.HelperPort
      LanIps=$script:ScanData.LanIps
      BestIp=$bestIp
      Ai=$ai
      AiPort=$script:ScanData.AiPort
      Firewall=$fw
      Ready=$ready
    }

    if ($ready) {
      Set-Verdict 'Ready' 'Pass'
      Set-MainMessage 'Ready. Click Start Phone Access.'
      Show-OnlyPrimary 'Start'
    } elseif (-not $node) {
      Set-Verdict 'Cannot continue: Node.js required' 'Block'
      Set-MainMessage 'Install Node.js LTS, then click Check This Computer.'
      Show-OnlyPrimary 'Check'
    } elseif (-not $bestIp) {
      Set-Verdict 'Cannot continue: trusted Wi-Fi/LAN needed' 'Block'
      Set-MainMessage 'Connect this computer and phone to the same trusted Wi-Fi, then recheck.'
      Show-OnlyPrimary 'Check'
    } elseif ($fw -and $fw.NeedsRepair) {
      Set-Verdict 'Permission needed: allow required setup' 'Warn'
      Set-MainMessage 'Click Allow Phone Access. Windows may ask for Administrator permission.'
      Show-OnlyPrimary 'Repair'
    } elseif (-not $ai -or $ai.LocalhostOnly) {
      Set-Verdict 'Waiting for local AI' 'Warn'
      Set-MainMessage 'Start or restart Local AI for LAN access, then recheck.'
      Show-OnlyPrimary 'Check'
    } else {
      Set-Verdict 'Action needed' 'Warn'
      Set-MainMessage 'Fix the item marked ACTION NEEDED, then recheck.'
      Show-OnlyPrimary 'Check'
    }
  } catch {
    Write-SetupLog "Finish scan failed: $($_.Exception.Message)"
    Set-Verdict 'Check needs attention' 'Warn'
    Set-MainMessage 'Check did not finish. Open Troubleshooting for logs.'
    $btnCheck.Text = 'Check This Computer'
    $btnCheck.Enabled = $true
    Show-OnlyPrimary 'Check'
  }
}

function Continue-ScanStep {
  if (-not $script:ScanData) { return }
  try {
    if ($script:ScanStep -eq 0) {
      Set-MainMessage 'Checking Node.js...'
      Set-ChecklistRow 'Node' 'CHECKING' 'Wait' 'Checking Node.js...'
      $script:ScanStep = 1
      return
    }

    if ($script:ScanStep -eq 1) {
      $node = Get-NodeExe
      $script:ScanData.NodePath = $node
      if ($node) { Set-ChecklistRow 'Node' 'PASS' 'Pass' 'Node.js found.' }
      else { Set-ChecklistRow 'Node' 'CANNOT CONTINUE' 'Block' 'Install Node.js LTS, then recheck.' }
      Set-MainMessage 'Checking Wi-Fi/LAN...'
      Set-ChecklistRow 'LAN' 'CHECKING' 'Wait' 'Checking Wi-Fi/LAN...'
      $script:ScanStep = 2
      return
    }

    if ($script:ScanStep -eq 2) {
      $helperPort = Select-HelperPort
      $ips = @(Get-LanIps)
      $bestIp = if ($ips.Count -gt 0) { $ips[0] } else { $null }
      $script:ScanData.HelperPort = $helperPort
      $script:ScanData.LanIps = $ips
      $script:ScanData.BestIp = $bestIp
      if ($bestIp) { Set-ChecklistRow 'LAN' 'PASS' 'Pass' "LAN address: $($bestIp.Address)" }
      else { Set-ChecklistRow 'LAN' 'CANNOT CONTINUE' 'Block' 'Connect computer and phone to the same trusted Wi-Fi.' }
      Set-MainMessage 'Checking Local AI...'
      Set-ChecklistRow 'AI' 'CHECKING' 'Wait' 'Checking Local AI...'
      $script:ScanStep = 3
      return
    }

    if ($script:ScanStep -eq 3) {
      $script:ScanData.AiCandidates = @(New-AiCandidateList $script:ScanData.LanIps)
      $script:ScanData.AiIndex = 0
      $count = if ($script:ScanData.AiCandidates) { $script:ScanData.AiCandidates.Count } else { 0 }
      Set-MainMessage "Checking Local AI ($count checks)."
      Set-ChecklistRow 'AI' 'CHECKING' 'Wait' 'Checking Local AI ports...'
      $script:ScanStep = 30
      return
    }

    if ($script:ScanStep -eq 30) {
      $candidates = @($script:ScanData.AiCandidates)
      $idx = [int]$script:ScanData.AiIndex
      if ($idx -ge $candidates.Count) {
        Set-ChecklistRow 'AI' 'ACTION NEEDED' 'Warn' 'Start Local AI with LAN access, then recheck.'
        Move-ToFirewallCheck
        return
      }
      $candidate = $candidates[$idx]
      $num = $idx + 1
      Set-MainMessage "Checking local AI endpoint $num of $($candidates.Count): $($candidate.BaseUrl)"
      Set-ChecklistRow 'AI' 'CHECKING' 'Wait' "Checking $($candidate.BaseUrl)..."
      $hit = $null
      try { $hit = Test-AiBase $candidate.BaseUrl $candidate.Port } catch { Write-SetupLog "Local AI candidate check error for $($candidate.BaseUrl): $($_.Exception.Message)" }
      if ($hit) {
        if ($candidate.Localhost) { $hit | Add-Member -NotePropertyName LocalhostOnly -NotePropertyValue $true -Force }
        $script:ScanData.Ai = $hit
        $script:ScanData.AiPort = [int]$hit.Port
        if ($hit.LocalhostOnly) { Set-ChecklistRow 'AI' 'ACTION NEEDED' 'Warn' 'Local AI is localhost-only. Restart with LAN access, then recheck.' }
        else { Set-ChecklistRow 'AI' 'PASS' 'Pass' "Local AI ready: $($hit.BaseUrl)" }
        Move-ToFirewallCheck
        return
      }
      $script:ScanData.AiIndex = $idx + 1
      return
    }

    if ($script:ScanStep -eq 4) {
      $fw = $null
      try { $fw = Get-FirewallStatus $script:ScanData.HelperPort $script:ScanData.AiPort $script:ScanData.NodePath } catch { Write-SetupLog "Firewall check error: $($_.Exception.Message)" }
      if (-not $fw) { $fw = [PSCustomObject]@{ ReadOk=$false; Enabled=$null; AllowInboundRules=$null; AllowLocalFirewallRules=$null; HelperRule=$false; PhoneAccessProgramRule=$false; AiRule=$false; UploadRoutePrepared=$false; NeedsRepair=$true; Error='Firewall check could not complete.' } }
      $script:ScanData.Firewall = $fw
      if ($fw.ReadOk) {
        if (-not $fw.NeedsRepair) { Set-ChecklistRow 'Firewall' 'PASS' 'Pass' 'Phone Access ready.' }
        else { Set-ChecklistRow 'Firewall' 'ACTION NEEDED' 'Warn' 'Click Allow Phone Access.' }
      } else {
        Set-ChecklistRow 'Firewall' 'ACTION NEEDED' 'Warn' 'Click Allow Phone Access, or open Troubleshooting.'
      }
      Set-MainMessage 'Summarizing readiness...'
      Set-ChecklistRow 'Ready' 'CHECKING' 'Wait' 'Summarizing phone readiness...'
      $script:ScanStep = 5
      return
    }

    if ($script:ScanStep -eq 5) {
      $node = $script:ScanData.NodePath
      $bestIp = $script:ScanData.BestIp
      $ai = $script:ScanData.Ai
      $fw = $script:ScanData.Firewall
      $ready = ($node -and $bestIp -and $ai -and -not $ai.LocalhostOnly -and $fw -and -not $fw.NeedsRepair)
      if ($ready) { Set-ChecklistRow 'Ready' 'PASS' 'Pass' 'This computer is ready. Click Start Phone Access, then continue on the phone.' }
      elseif (-not $node -or -not $bestIp) { Set-ChecklistRow 'Ready' 'CANNOT CONTINUE' 'Block' 'Fix the blocked item above, then click Check This Computer.' }
      elseif ($fw -and $fw.NeedsRepair) { Set-ChecklistRow 'Ready' 'ACTION NEEDED' 'Warn' 'Next step: allow Windows setup so the phone can reach this computer.' }
      elseif (-not $ai -or $ai.LocalhostOnly) { Set-ChecklistRow 'Ready' 'ACTION NEEDED' 'Warn' 'Next step: start/restart Local AI for LAN access, then click Check This Computer.' }
      else { Set-ChecklistRow 'Ready' 'ACTION NEEDED' 'Warn' 'Review the item above, then click Check This Computer again.' }
      $script:ScanStep = 6
      Finish-Scan
      return
    }
  } catch {
    Write-SetupLog "Scan step $($script:ScanStep) failed: $($_.Exception.Message)"
    Set-ChecklistRow 'Ready' 'ACTION NEEDED' 'Warn' 'Setup check hit an issue. No Windows settings were changed. Open Troubleshooting, then recheck.'
    Set-Verdict 'Check needs attention' 'Warn'
    Set-MainMessage 'The setup check hit an issue. No Windows settings were changed. Open Troubleshooting for logs.'
    if ($script:ScanTimer) { $script:ScanTimer.Stop() }
    $btnCheck.Text = 'Check This Computer'
    $btnCheck.Enabled = $true
    Show-OnlyPrimary 'Check'
  }
}

function Start-Scan {
  if ($script:ScanTimer -and $script:ScanTimer.Enabled) { return }
  $script:Current = $null
  $script:ScanData = [PSCustomObject]@{ NodePath=$null; HelperPort=49321; LanIps=@(); BestIp=$null; Ai=$null; AiPort=0; Firewall=$null; AiCandidates=@(); AiIndex=0 }
  $script:ScanStep = 0
  Reset-Checklist
  Set-Verdict 'Checking this computer...' 'Info'
  Set-MainMessage 'Checking this computer...'
  Show-OnlyPrimary 'Check'
  $btnCheck.Text = 'Checking...'
  $btnCheck.Enabled = $false
  $actionHint.Text = 'Checking Node.js, Wi-Fi/LAN, Local AI, and Phone Access.'
  if (-not $script:ScanTimer) {
    $script:ScanTimer = New-Object System.Windows.Forms.Timer
    $script:ScanTimer.Interval = 350
    $script:ScanTimer.Add_Tick({ Continue-ScanStep })
  }
  $script:ScanTimer.Start()
}

function Refresh-Ui { Start-Scan }

function Start-Helper {
  if (-not $script:Current) { Show-Warn 'Check required first' 'Click Check This Computer first. LLM Radar will enable Start Phone Access only when the computer is ready.'; return }
  if (-not $script:Current.NodePath) { Show-Warn 'Cannot complete setup' 'Node.js LTS was not found. LLM Radar needs Node.js to run the computer Phone Access service. Install Node.js LTS, then click Check This Computer.'; return }
  if (-not $script:Current.BestIp) { Show-Warn 'Cannot complete setup' 'No usable LAN address was found. Connect this computer to trusted home/work Wi-Fi, then click Check This Computer.'; return }
  if ($script:Current.Firewall.NeedsRepair) { Show-Warn 'Permission needed before pairing' 'LLM Radar needs the required phone-access setup before pairing or file upload is reliable. Click Allow Phone Access, approve Administrator permission, then click Start Phone Access.'; return }
  if (-not $script:Current.Ai -or $script:Current.Ai.LocalhostOnly) { Show-Warn 'Local AI not ready for pairing' 'LLM Radar did not find a LAN-ready local AI server yet. Start llama-server/Ollama/LM Studio with LAN access, then click Check This Computer.'; return }
  Stop-OldHelper
  $helperScript = Join-Path $PSScriptRoot 'llmradar-ez-pair.js'
  if (-not (Test-Path $helperScript)) { Show-Warn 'Missing Phone Access file' "Missing Phone Access file script: $helperScript"; return }
  try {
    Set-Verdict 'Starting Phone Access service...' 'Info'
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:Current.NodePath
    $psi.Arguments = ('"{0}"' -f $helperScript)
    $psi.WorkingDirectory = $script:Root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $psi.EnvironmentVariables['LLMRADAR_HELPER_PORT'] = [string]$script:Current.HelperPort
    $psi.EnvironmentVariables['LLMRADAR_HELPER_PORT_MAX'] = [string]$script:Current.HelperPort
    $psi.EnvironmentVariables['LLMRADAR_QUIET_HELPER'] = '1'
    if ($script:Current.AiPort -gt 0) { $psi.EnvironmentVariables['LLMRADAR_AI_PORT'] = [string]$script:Current.AiPort }
    $p = [System.Diagnostics.Process]::Start($psi)
    $script:HelperProcess = $p
    $script:HelperUrl = "http://$($script:Current.BestIp.Address):$($script:Current.HelperPort)"
    $script:PairUrl = "$($script:HelperUrl)/pair"
    $state = [PSCustomObject]@{ helperPid=$p.Id; helperUrl=$script:HelperUrl; pairUrl=$script:PairUrl; startedAt=(Get-Date).ToString('o') }
    $state | ConvertTo-Json | Set-Content -Path $script:StateFile -Encoding UTF8
    $helperReady = $false
    for ($i = 0; $i -lt 20; $i++) {
      if ($p.HasExited) { break }
      try {
        $probe = Invoke-WebRequest -UseBasicParsing -Uri "$($script:HelperUrl)/reachability" -TimeoutSec 1 -ErrorAction Stop
        if ($probe.StatusCode -ge 200 -and $probe.StatusCode -lt 500) { $helperReady = $true; break }
      } catch {}
      Start-Sleep -Milliseconds 100
    }
    if (-not $helperReady) { Write-SetupLog 'Phone Access service did not answer before browser launch; opening page anyway.' }
    $uploadRouteReady = $false
    if ($helperReady) {
      try {
        $uploadProbe = Invoke-WebRequest -UseBasicParsing -Uri "$($script:HelperUrl)/rag/upload-test" -TimeoutSec 2 -ErrorAction Stop
        if ($uploadProbe.StatusCode -ge 200 -and $uploadProbe.StatusCode -lt 500) { $uploadRouteReady = $true }
      } catch { Write-SetupLog "file upload route self-check failed: $($_.Exception.Message)" }
    }
    Start-Process $script:HelperUrl | Out-Null
    if ($uploadRouteReady) {
      Set-Verdict 'CONNECTED / PHONE ACCESS RUNNING' 'Pass'
      $btnStart.Text = 'Phone Access Running'
      $btnStart.Enabled = $false
      Set-MainMessage "CONNECTED / PHONE ACCESS RUNNING.`r`n`r`nKeep this window open. Continue on the phone."
      $actionHint.Text = 'Phone Access service and file upload route are running. Continue on the phone; keep this setup window open.'
    } else {
      Set-Verdict 'PHONE ACCESS RUNNING / PDF REVIEW' 'Warn'
      $btnStart.Text = 'Phone Access Running'
      $btnStart.Enabled = $false
      Set-MainMessage "PHONE ACCESS RUNNING.`r`n`r`nPDF route needs review. Continue on the phone; if file upload fails, return here and Refresh Status."
      $actionHint.Text = 'Phone Access service is running. file upload route self-check needs review.'
    }
  } catch {
    Write-SetupLog "Helper start failed: $($_.Exception.Message)"
    Set-Verdict 'Could not start Phone Access' 'Block'
    Set-MainMessage 'LLM Radar could not start the computer Phone Access service. No firewall or network changes were made. Open Troubleshooting for logs or to stop any old Phone Access.'
    Show-Warn 'Could not start Phone Access' 'LLM Radar could not start the computer Phone Access service. No firewall or network changes were made. Open Troubleshooting for logs, stop any old Phone Access, then try Start Phone Access again.'
  }
}

function Repair-Firewall {
  if (-not $script:Current) { Show-Warn 'Check required first' 'Click Check This Computer first. LLM Radar will show Allow Required Setup only when repair is needed.'; return }
  $ps = Get-PowerShellExe
  if (-not $ps) { Show-Warn 'PowerShell required' 'Windows PowerShell was not found, so LLM Radar cannot perform firewall repair.'; return }
  $args = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"", '-AdminRepair', '-HelperPort', [string]$script:Current.HelperPort)
  if ($script:Current.AiPort -gt 0) { $args += @('-AiPort', [string]$script:Current.AiPort) }
  if ($script:Current.NodePath) { $args += @('-NodePath', "`"$($script:Current.NodePath)`"") }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ps
    $psi.Arguments = ($args -join ' ')
    $psi.WorkingDirectory = $script:Root
    $psi.Verb = 'runas'
    $psi.UseShellExecute = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    Set-Verdict 'Waiting for required setup...' 'Warn'
    Set-MainMessage 'Approve the Windows Administrator prompt. Keep recommended Yes choices.'
    Show-OnlyPrimary 'None'
    if ($proc) {
      $script:RepairProcess = $proc
      $script:RepairTimer.Start()
    }
  } catch {
    Show-Warn 'Administrator permission not granted' 'LLM Radar could not open the repair step with Administrator permission. No firewall changes were made. Open Troubleshooting for IT/Admin instructions.'
    Show-OnlyPrimary 'Repair'
  }
}

function Copy-AdminInstructions {
  $helper = if ($script:Current -and $script:Current.HelperPort) { $script:Current.HelperPort } else { 49321 }
  $aiPortText = if ($script:Current -and $script:Current.AiPort -gt 0) { [string]$script:Current.AiPort } else { '<local AI port, often 8080 for llama-server>' }
  $text = @"
LLM Radar admin repair request

Please run LLM Radar Start_Here.bat and choose Allow Required Setup, or apply these changes on a trusted Private Wi-Fi network:

1. Mark the trusted Wi-Fi network as Private if it is currently Public.
2. Keep Windows Firewall ON.
3. Set Private profile AllowInboundRules=True and AllowLocalFirewallRules=True.
4. Allow inbound TCP LLM Radar phone-access port $helper on Private networks only. This covers QR pairing, chat/status, and small PDF/TXT upload.
5. Allow inbound TCP local AI port $aiPortText on Private networks only.
6. If pairing or file upload still fails, allow the LLM Radar Phone Access program for phone-access port $helper.

Do not turn off Windows Firewall as the normal fix.
"@
  try { Set-Clipboard -Value $text; Show-Info 'Admin instructions copied' 'Instructions were copied to the clipboard.' } catch { Show-Warn 'Copy failed' 'Could not copy to clipboard. Open WINDOWS_SETUP.md instead.' }
}

function Set-Verdict([string]$Text, [string]$Kind) {
  $lblVerdict.Text = $Text
  switch ($Kind) {
    'Pass' { $lblVerdict.ForeColor = $script:ColorPass }
    'Warn' { $lblVerdict.ForeColor = $script:ColorWarn }
    'Block' { $lblVerdict.ForeColor = $script:ColorBlock }
    default { $lblVerdict.ForeColor = $script:ColorInfo }
  }
}

function Set-MainMessage([string]$Text) {
  $txtMain.Text = $Text
}

function Reset-Checklist {
  Set-ChecklistRow 'Node' 'NOT CHECKED' 'Idle' 'Node.js has not been checked yet.'
  Set-ChecklistRow 'LAN' 'NOT CHECKED' 'Idle' 'Computer Wi-Fi/LAN address has not been checked yet.'
  Set-ChecklistRow 'AI' 'NOT CHECKED' 'Idle' 'Local AI server has not been checked yet.'
  Set-ChecklistRow 'Firewall' 'NOT CHECKED' 'Idle' 'Phone-access firewall readiness has not been checked yet.'
  Set-ChecklistRow 'Ready' 'NOT CHECKED' 'Idle' 'Phone readiness has not been checked yet.'
}

function Set-ChecklistRow([string]$Key, [string]$Status, [string]$Kind, [string]$Message) {
  if (-not $script:Rows.ContainsKey($Key)) { return }
  $row = $script:Rows[$Key]
  $row.Badge.Text = $Status
  $row.Detail.Text = $Message
  switch ($Kind) {
    'Pass' { $row.Badge.ForeColor = $script:ColorPass }
    'Warn' { $row.Badge.ForeColor = $script:ColorWarn }
    'Block' { $row.Badge.ForeColor = $script:ColorBlock }
    'Wait' { $row.Badge.ForeColor = $script:ColorInfo }
    default { $row.Badge.ForeColor = $script:ColorIdle }
  }
}

function Show-OnlyPrimary([string]$Name) {
  $btnCheck.Visible = $false
  $btnRepair.Visible = $false
  $btnStart.Visible = $false
  if ($Name -eq 'Check') { $btnCheck.Visible = $true; $form.AcceptButton = $btnCheck; $btnCheck.Focus() | Out-Null }
  elseif ($Name -eq 'Repair') { $btnRepair.Visible = $true; $form.AcceptButton = $btnRepair; $btnRepair.Focus() | Out-Null }
  elseif ($Name -eq 'Start') { $btnStart.Visible = $true; $form.AcceptButton = $btnStart; $btnStart.Focus() | Out-Null }
  else { $form.AcceptButton = $null }
}

function Show-TroubleshootingDialog {
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = 'LLM Radar Troubleshooting'
  $dlg.Size = New-LLMSize 560 360
  $dlg.StartPosition = 'CenterParent'
  $dlg.BackColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
  $dlg.ForeColor = [System.Drawing.Color]::White
  $dlg.Font = New-LLMFont 'Segoe UI' 10
  $intro = New-Object System.Windows.Forms.Label
  $intro.Text = 'Troubleshooting is for refresh, logs, IT/admin help, and manual connection details.'
  $intro.Location = New-LLMPoint 18 18
  $intro.Size = New-LLMSize 500 48
  $intro.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
  $dlg.Controls.Add($intro)

  $btnOpenPair = New-Object System.Windows.Forms.Button
  $btnOpenPair.Text = 'Open Phone Access Page'
  $btnOpenPair.Location = New-LLMPoint 22 82
  $btnOpenPair.Size = New-LLMSize 230 36
  $btnOpenPair.Enabled = [bool]$script:HelperUrl
  $dlg.Controls.Add($btnOpenPair)

  $btnCopyPair = New-Object System.Windows.Forms.Button
  $btnCopyPair.Text = 'Copy Phone URL'
  $btnCopyPair.Location = New-LLMPoint 274 82
  $btnCopyPair.Size = New-LLMSize 230 36
  $btnCopyPair.Enabled = [bool]$script:PairUrl
  $dlg.Controls.Add($btnCopyPair)

  $btnRefresh2 = New-Object System.Windows.Forms.Button
  $btnRefresh2.Text = 'Refresh Status'
  $btnRefresh2.Location = New-LLMPoint 22 132
  $btnRefresh2.Size = New-LLMSize 230 36
  $dlg.Controls.Add($btnRefresh2)

  $btnAdmin2 = New-Object System.Windows.Forms.Button
  $btnAdmin2.Text = 'Copy IT/Admin Instructions'
  $btnAdmin2.Location = New-LLMPoint 274 132
  $btnAdmin2.Size = New-LLMSize 230 36
  $dlg.Controls.Add($btnAdmin2)

  $btnLogs2 = New-Object System.Windows.Forms.Button
  $btnLogs2.Text = 'Open Logs Folder'
  $btnLogs2.Location = New-LLMPoint 22 182
  $btnLogs2.Size = New-LLMSize 230 36
  $dlg.Controls.Add($btnLogs2)

  $btnStop2 = New-Object System.Windows.Forms.Button
  $btnStop2.Text = 'Stop Phone Access'
  $btnStop2.Location = New-LLMPoint 274 182
  $btnStop2.Size = New-LLMSize 230 36
  $dlg.Controls.Add($btnStop2)

  $btnAdvanced2 = New-Object System.Windows.Forms.Button
  $btnAdvanced2.Text = 'Advanced Command Setup'
  $btnAdvanced2.Location = New-LLMPoint 22 232
  $btnAdvanced2.Size = New-LLMSize 230 36
  $dlg.Controls.Add($btnAdvanced2)

  $btnClose2 = New-Object System.Windows.Forms.Button
  $btnClose2.Text = 'Close'
  $btnClose2.Location = New-LLMPoint 388 270
  $btnClose2.Size = New-LLMSize 116 36
  $dlg.Controls.Add($btnClose2)

  $btnOpenPair.Add_Click({ if ($script:HelperUrl) { Start-Process $script:HelperUrl | Out-Null } })
  $btnRefresh2.Add_Click({ $dlg.Close(); Start-Scan })
  $btnCopyPair.Add_Click({ if ($script:PairUrl) { try { Set-Clipboard -Value $script:PairUrl; Show-Info 'Copied' 'Phone URL copied.' } catch {} } })
  $btnAdmin2.Add_Click({ Copy-AdminInstructions })
  $btnLogs2.Add_Click({ Start-Process $script:LogDir | Out-Null })
  $btnStop2.Add_Click({ Stop-OldHelper; $script:HelperProcess = $null; $script:HelperUrl=''; $script:PairUrl=''; Show-Info 'Phone Access stopped' 'Phone Access was stopped if it was running.'; $dlg.Close() })
  $btnAdvanced2.Add_Click({ $advanced = Join-Path $PSScriptRoot 'Run_Command_Setup_Advanced.bat'; if (Test-Path $advanced) { Start-Process $advanced | Out-Null } else { Show-Warn 'Missing advanced setup' 'Advanced command setup file was not found.' } })
  $btnClose2.Add_Click({ $dlg.Close() })
  [void]$dlg.ShowDialog($form)
}

function Resize-WizardLayout {
  $w = $form.ClientSize.Width
  $h = $form.ClientSize.Height
  $pad = 22
  $right = [Math]::Max(360, $w - ($pad * 2))
  $subtitle.Size = New-LLMSize $right 44
  $actionPanel.Size = New-LLMSize $right 52
  $checkPanel.Size = New-LLMSize $right 260
  $txtMain.Location = New-LLMPoint $pad 468
  $txtMain.Size = New-LLMSize $right ([int]([Math]::Max(92, ($h - 540))))
  $btnTrouble.Location = New-LLMPoint $pad ([int]([Math]::Max(500, ($h - 52))))
  $btnClose.Location = New-LLMPoint ([int]([Math]::Max($pad, ($w - 142)))) ([int]([Math]::Max(500, ($h - 52))))
  $footer.Location = New-LLMPoint ([int]($pad + 142)) ([int]([Math]::Max(500, ($h - 44))))
  $footer.Size = New-LLMSize ([int]([Math]::Max(200, ($w - 310)))) 36
  foreach ($row in $script:Rows.Values) {
    $row.Detail.Size = New-LLMSize ([int]([Math]::Max(280, ($right - 330)))) 44
  }
}


function Set-PrimaryButtonStyle([System.Windows.Forms.Button]$Button, [string]$Kind) {
  $Button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $Button.UseVisualStyleBackColor = $false
  $Button.ForeColor = [System.Drawing.Color]::White
  $Button.Font = New-LLMFont 'Segoe UI Semibold' 10.5
  $Button.FlatAppearance.BorderSize = 2
  $Button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(226, 232, 240)
  switch ($Kind) {
    'Repair' { $Button.BackColor = [System.Drawing.Color]::FromArgb(217, 119, 6) }
    'Start' { $Button.BackColor = [System.Drawing.Color]::FromArgb(5, 150, 105) }
    default { $Button.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235) }
  }
}

# UI
$script:ColorPass = [System.Drawing.Color]::FromArgb(52, 211, 153)
$script:ColorWarn = [System.Drawing.Color]::FromArgb(251, 191, 36)
$script:ColorBlock = [System.Drawing.Color]::FromArgb(248, 113, 113)
$script:ColorIdle = [System.Drawing.Color]::FromArgb(148, 163, 184)
$script:ColorInfo = [System.Drawing.Color]::FromArgb(96, 165, 250)
$script:Rows = @{}
$script:ScanWorker = $null
$script:ScanTimer = $null
$script:ScanData = $null
$script:ScanStep = 0
$script:RepairProcess = $null

$form = New-Object System.Windows.Forms.Form
$form.Text = 'LLM Radar Windows Setup'
$form.Size = New-LLMSize 860 750
$form.MinimumSize = New-LLMSize 760 650
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(15, 23, 42)
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-LLMFont 'Segoe UI' 10
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Font

$title = New-Object System.Windows.Forms.Label
$title.Text = 'LLM Radar Windows Setup'
$title.Font = New-LLMFont 'Segoe UI Semibold' 18
$title.AutoSize = $true
$title.Location = New-LLMPoint 20 16
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Check this computer, then start Phone Access for the phone.'
$subtitle.Location = New-LLMPoint 22 54
$subtitle.Size = New-LLMSize 780 44
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
$form.Controls.Add($subtitle)

$lblVerdict = New-Object System.Windows.Forms.Label
$lblVerdict.Text = 'Ready to check this computer'
$lblVerdict.Font = New-LLMFont 'Segoe UI Semibold' 13
$lblVerdict.AutoSize = $true
$lblVerdict.Location = New-LLMPoint 22 96
$lblVerdict.ForeColor = $script:ColorInfo
$form.Controls.Add($lblVerdict)

$actionPanel = New-Object System.Windows.Forms.Panel
$actionPanel.Location = New-LLMPoint 22 126
$actionPanel.Size = New-LLMSize 780 52
$form.Controls.Add($actionPanel)

$btnCheck = New-Object System.Windows.Forms.Button
$btnCheck.Text = 'Check This Computer'
$btnCheck.Location = New-LLMPoint 0 6
$btnCheck.Size = New-LLMSize 210 42
$btnCheck.TabIndex = 0
Set-PrimaryButtonStyle $btnCheck 'Check'
$actionPanel.Controls.Add($btnCheck)

$btnRepair = New-Object System.Windows.Forms.Button
$btnRepair.Text = 'Allow Phone Access'
$btnRepair.Location = New-LLMPoint 0 6
$btnRepair.Size = New-LLMSize 220 42
$btnRepair.TabIndex = 0
Set-PrimaryButtonStyle $btnRepair 'Repair'
$btnRepair.Visible = $false
$actionPanel.Controls.Add($btnRepair)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = 'Start Phone Access'
$btnStart.Location = New-LLMPoint 0 6
$btnStart.Size = New-LLMSize 210 42
$btnStart.TabIndex = 0
Set-PrimaryButtonStyle $btnStart 'Start'
$btnStart.Visible = $false
$actionPanel.Controls.Add($btnStart)

$actionHint = New-Object System.Windows.Forms.Label
$actionHint.Text = 'Only the next action appears here.'
$actionHint.Location = New-LLMPoint 250 16
$actionHint.Size = New-LLMSize 520 24
$actionHint.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$actionPanel.Controls.Add($actionHint)

$checkPanel = New-Object System.Windows.Forms.Panel
$checkPanel.Location = New-LLMPoint 22 188
$checkPanel.Size = New-LLMSize 780 260
$checkPanel.BackColor = [System.Drawing.Color]::FromArgb(11, 18, 32)
$checkPanel.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$form.Controls.Add($checkPanel)

$rowDefs = @(
  @('Node','Node.js'),
  @('LAN','Computer Wi-Fi / LAN'),
  @('AI','Local AI server'),
  @('Firewall','Phone access firewall'),
  @('Ready','Phone readiness')
)
$y = 8
foreach ($def in $rowDefs) {
  $key = $def[0]
  $name = $def[1]
  $nameLabel = New-Object System.Windows.Forms.Label
  $nameLabel.Text = $name
  $nameLabel.Font = New-LLMFont 'Segoe UI Semibold' 10
  $nameLabel.Location = New-LLMPoint 12 ([int]$y)
  $nameLabel.Size = New-LLMSize 150 38
  $nameLabel.ForeColor = [System.Drawing.Color]::White
  $checkPanel.Controls.Add($nameLabel)

  $badge = New-Object System.Windows.Forms.Label
  $badge.Text = 'NOT CHECKED'
  $badge.Font = New-LLMFont 'Segoe UI Semibold' 9
  $badge.Location = New-LLMPoint 170 ([int]$y)
  $badge.Size = New-LLMSize 130 38
  $badge.ForeColor = $script:ColorIdle
  $checkPanel.Controls.Add($badge)

  $detail = New-Object System.Windows.Forms.Label
  $detail.Text = 'Not checked yet.'
  $detail.Location = New-LLMPoint 305 ([int]$y)
  $detail.Size = New-LLMSize 450 44
  $detail.ForeColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
  $checkPanel.Controls.Add($detail)

  $script:Rows[$key] = [PSCustomObject]@{ Badge=$badge; Detail=$detail }
  $y += 49
}

$txtMain = New-Object System.Windows.Forms.TextBox
$txtMain.Multiline = $true
$txtMain.ReadOnly = $true
$txtMain.TabStop = $false
$txtMain.ScrollBars = 'Vertical'
$txtMain.BackColor = [System.Drawing.Color]::FromArgb(11, 18, 32)
$txtMain.ForeColor = [System.Drawing.Color]::FromArgb(226, 232, 240)
$txtMain.BorderStyle = 'FixedSingle'
$txtMain.Font = New-LLMFont 'Segoe UI' 10
$txtMain.Location = New-LLMPoint 22 468
$txtMain.Size = New-LLMSize 780 135
$form.Controls.Add($txtMain)

$btnTrouble = New-Object System.Windows.Forms.Button
$btnTrouble.Text = 'Troubleshooting...'
$btnTrouble.Location = New-LLMPoint 22 584
$btnTrouble.Size = New-LLMSize 130 34
$form.Controls.Add($btnTrouble)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = 'Path: Check -> Allow -> Start Phone Access.'
$footer.Location = New-LLMPoint 166 590
$footer.Size = New-LLMSize 500 28
$footer.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$form.Controls.Add($footer)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = 'Close'
$btnClose.Location = New-LLMPoint 686 584
$btnClose.Size = New-LLMSize 116 34
$form.Controls.Add($btnClose)

$script:RepairTimer = New-Object System.Windows.Forms.Timer
$script:RepairTimer.Interval = 1000
$script:RepairTimer.Add_Tick({
  if ($script:RepairProcess -and $script:RepairProcess.HasExited) {
    $script:RepairTimer.Stop()
    $script:RepairProcess = $null
    Set-MainMessage 'Required setup finished or was closed. Rechecking this computer now...'
    Start-Scan
  }
})

$btnCheck.Add_Click({ try { Start-Scan } catch { Write-SetupLog "Check button failed: $($_.Exception.Message)"; Show-Warn 'Setup check could not start' 'LLM Radar could not start the setup check. No Windows settings were changed. Open Troubleshooting for logs.' } })
$btnRepair.Add_Click({ try { Repair-Firewall } catch { Write-SetupLog "Repair button failed: $($_.Exception.Message)"; Show-Warn 'Required setup could not start' 'LLM Radar could not start the required setup step. No Windows settings were changed. Open Troubleshooting for IT/Admin instructions.' } })
$btnStart.Add_Click({ try { Start-Helper } catch { Write-SetupLog "Start Phone Access failed: $($_.Exception.Message)"; Show-Warn 'Phone Access could not start' 'LLM Radar could not start the Phone Access service. No Windows settings were changed. Open Troubleshooting for logs.' } })
$btnTrouble.Add_Click({ try { Show-TroubleshootingDialog } catch { Write-SetupLog "Troubleshooting dialog failed: $($_.Exception.Message)"; Show-Warn 'Troubleshooting could not open' 'LLM Radar could not open Troubleshooting. Check tools\logs in the package folder.' } })
$btnClose.Add_Click({ $form.Close() })
$form.Add_Resize({ try { Resize-WizardLayout } catch { Write-SetupLog "Resize failed: $($_.Exception.Message)" } })
$form.Add_Shown({
  try {
    Reset-Checklist
    Set-Verdict 'Ready to check this computer' 'Info'
    Set-MainMessage "Click Check This Computer to begin."
    Show-OnlyPrimary 'Check'
    Resize-WizardLayout
    $btnCheck.Focus() | Out-Null
    $btnCheck.Select()
  } catch {
    Write-SetupLog "Initial UI setup failed: $($_.Exception.Message)"
    Show-Warn 'Setup window issue' 'LLM Radar opened but the setup window hit a UI issue. No Windows settings were changed. Close this window and share tools\logs\setup.log.'
  }
})
$form.Add_FormClosing({
  param($sender, $e)
  try {
    if ($script:HelperProcess -and -not $script:HelperProcess.HasExited) {
      $choice = [System.Windows.Forms.MessageBox]::Show('Phone Access is still running. Closing this setup window will stop it. Choose No to keep it open while you use the phone.', 'Close setup and stop Phone Access?', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
      if ($choice -eq [System.Windows.Forms.DialogResult]::No) { $e.Cancel = $true; return }
    }
    Invoke-GuiCloseCleanup
  } catch { Write-SetupLog "Form closing handler failed: $($_.Exception.Message)" }
})
$form.Add_FormClosed({
  try { Invoke-GuiCloseCleanup } catch { Write-SetupLog "Form closed cleanup failed: $($_.Exception.Message)" }
})

[void]$form.ShowDialog()
try { Invoke-GuiCloseCleanup } catch {}
