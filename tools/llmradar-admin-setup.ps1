$ErrorActionPreference = 'Continue'

$script:TranscriptStarted = $false
try {
  $logDir = Join-Path $PSScriptRoot 'logs'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $logPath = Join-Path $logDir 'last_setup.log'
  Start-Transcript -Path $logPath -Force | Out-Null
  $script:TranscriptStarted = $true
} catch {
  Write-Host "WARNING: Could not start setup log: $($_.Exception.Message)" -ForegroundColor Yellow
}

function Write-Section([string]$Title) {
  Write-Host ''
  Write-Host ('=' * 62) -ForegroundColor DarkGray
  Write-Host " $Title" -ForegroundColor Cyan
  Write-Host ('=' * 62) -ForegroundColor DarkGray
}

function Ask-YesNo([string]$Question, [string]$Default = 'Y') {
  $suffix = if ($Default -eq 'Y') { '[Y recommended / Enter = Y / n]' } else { '[y / Enter = N]' }
  while ($true) {
    $answer = Read-Host "$Question $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return ($Default -eq 'Y') }
    switch -Regex ($answer.Trim()) {
      '^(y|yes)$' { return $true }
      '^(n|no)$' { return $false }
      default { Write-Host 'Please answer Y or N.' -ForegroundColor Yellow }
    }
  }
}


function Stop-Setup([string]$Message, [int]$Code = 20) {
  Write-Host ''
  Write-Host 'SETUP STOPPED' -ForegroundColor Yellow
  Write-Host $Message -ForegroundColor Yellow
  Write-Host 'Run Start_Here.bat again when you are ready to continue LLM Radar setup.'
  exit $Code
}

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-PortAvailable([int]$Port) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

function Select-HelperPort {
  foreach ($port in 49321..49329) {
    if (Test-PortAvailable $port) { return $port }
  }
  throw 'No Phone Access port was available in 49321-49329. Close old LLM Radar windows and try again.'
}

function Test-PortRuleValid([object]$Rule, [int]$Port) {
  if (-not $Rule) { return $false }
  if ([string]$Rule.Enabled -ne 'True') { return $false }
  if ([string]$Rule.Direction -ne 'Inbound') { return $false }
  if ([string]$Rule.Action -ne 'Allow') { return $false }
  $profile = [string]$Rule.Profile
  if ($profile -notmatch 'Any|Private') { return $false }
  $pf = $Rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
  if (-not $pf) { return $false }
  if ([string]$pf.Protocol -ne 'TCP') { return $false }
  $lp = [string]$pf.LocalPort
  return ($lp -eq [string]$Port -or $lp -eq 'Any')
}

function Ensure-PortRule([string]$DisplayName, [int]$Port, [string]$Rationale) {
  $existing = @(Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue)
  $valid = $false
  foreach ($rule in $existing) {
    if (Test-PortRuleValid -Rule $rule -Port $Port) { $valid = $true }
  }
  if ($valid) {
    Write-Host "PASS: Valid firewall rule exists: $DisplayName" -ForegroundColor Green
    return $true
  }

  Write-Host ''
  if ($existing.Count -gt 0) {
    Write-Host "NEEDS ACTION: Existing LLM Radar rule is stale or incorrect: $DisplayName" -ForegroundColor Yellow
    Write-Host 'LLM Radar will repair only this LLM Radar-named rule.'
    $question = 'Repair this firewall rule?'
  } else {
    Write-Host "NEEDS ACTION: $DisplayName" -ForegroundColor Yellow
    $question = 'Create this firewall rule?'
  }
  Write-Host $Rationale
  Write-Host "Change: allow inbound TCP port $Port on Private networks only. This does not turn off Windows Firewall."
  if ($DisplayName -like 'LLM Radar Helper*' -or $DisplayName -like 'LLM Radar Phone Access*') {
    $question = "Allow LLM Radar phone access on port $Port for QR, chat, status, and file upload? Required: Y. Choosing N cancels setup."
  } elseif ($DisplayName -like 'LLM Radar AI*') {
    $question = "Allow AI server port $Port for phone chat? Recommended: Y. Choosing N continues Phone Access setup only."
  }
  if (Ask-YesNo $question 'Y') {
    if ($existing.Count -gt 0) { $existing | Remove-NetFirewallRule }
    New-NetFirewallRule -DisplayName $DisplayName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    Write-Host "PASS: Rule created/repaired: $DisplayName" -ForegroundColor Green
    return $true
  }
  Write-Host "SKIPPED: $DisplayName" -ForegroundColor Yellow
  return $false
}

function Test-ProgramPortRuleValid([object]$Rule, [string]$ProgramPath, [int]$Port) {
  if (-not $Rule) { return $false }
  if ([string]$Rule.Enabled -ne 'True') { return $false }
  if ([string]$Rule.Direction -ne 'Inbound') { return $false }
  if ([string]$Rule.Action -ne 'Allow') { return $false }
  $profile = [string]$Rule.Profile
  if ($profile -notmatch 'Any|Private') { return $false }
  $af = $Rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
  if (-not $af -or ([string]$af.Program -ine [string]$ProgramPath)) { return $false }
  $pf = $Rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
  if (-not $pf) { return $false }
  if ([string]$pf.Protocol -ne 'TCP') { return $false }
  $lp = [string]$pf.LocalPort
  return ($lp -eq [string]$Port -or $lp -eq 'Any')
}

function Ensure-PhoneAccessProgramPortRule([string]$DisplayName, [string]$ProgramPath, [int]$Port) {
  $existing = @(Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue)
  $valid = $false
  foreach ($rule in $existing) {
    if (Test-ProgramPortRuleValid -Rule $rule -ProgramPath $ProgramPath -Port $Port) { $valid = $true }
  }
  if ($valid) {
    Write-Host "PASS: Phone-access program+port rule already matches this setup." -ForegroundColor Green
    return
  }
  Write-Host ''
  Write-Host 'PHONE ACCESS REPAIR: allow the LLM Radar computer program' -ForegroundColor Yellow
  Write-Host 'LLM Radar has already opened the phone-access port. On some Windows systems, the phone can still be blocked unless Windows also allows the Phone Access program.'
  Write-Host "Detected phone-access program: $ProgramPath"
  Write-Host "Selected phone-access port: $Port"
  Write-Host 'This adds one narrow allow rule for this program and port on Private Wi-Fi only. It does not turn off Windows Firewall.'
  Write-Host 'Required for this setup pass: choose Y so Android pairing, status checks, and phone file upload are prepared during Start_Here.bat.'
  Write-Host 'Choosing N stops this required setup pass. Run Start_Here.bat again and choose Y when you are ready to allow phone access.'
  $question = if ($existing.Count -gt 0) { 'Repair the LLM Radar phone-access program rule and continue setup?' } else { 'Allow the LLM Radar phone-access program and continue setup?' }
  if (Ask-YesNo $question 'Y') {
    if ($existing.Count -gt 0) { $existing | Remove-NetFirewallRule }
    New-NetFirewallRule -DisplayName $DisplayName -Direction Inbound -Program $ProgramPath -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    Write-Host 'PASS: LLM Radar phone-access program is allowed on the selected port.' -ForegroundColor Green
  } else {
    Stop-Setup 'LLM Radar setup stopped because phone-access program permission was not approved. Run Start_Here.bat again and approve the recommended phone-access prompt.' 25
  }
}

function Get-LanIpv4Candidates {
  $virtualPattern = 'virtual|vmware|virtualbox|docker|hyper-v|vethernet|loopback|local area connection\*'
  $rows = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -and $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
    Where-Object { $_.InterfaceAlias -notmatch $virtualPattern } |
    ForEach-Object {
      $score = 0
      if ($_.InterfaceAlias -match 'wi-?fi|wireless|wlan') { $score += 60 }
      if ($_.InterfaceAlias -match 'ethernet|lan') { $score += 45 }
      if ($_.IPAddress -like '192.168.*') { $score += 40 }
      if ($_.IPAddress -like '10.*') { $score += 25 }
      if ($_.IPAddress -match '^172\.(1[6-9]|2\d|3[01])\.') { $score += 20 }
      if ($_.IPAddress -like '192.168.137.*') { $score -= 90 }
      [PSCustomObject]@{ IPAddress=$_.IPAddress; InterfaceAlias=$_.InterfaceAlias; Score=$score }
    }
  return @($rows | Sort-Object Score -Descending)
}

function Invoke-QuickHttp([string]$Url) {
  Write-Host -NoNewline '.'
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Uri $Url -Method GET -TimeoutSec 1 -ErrorAction Stop
    return [PSCustomObject]@{ Ok=$true; Status=[int]$res.StatusCode; Text=[string]$res.Content; Url=$Url }
  } catch {
    return [PSCustomObject]@{ Ok=$false; Status=0; Text=''; Url=$Url; Error=$_.Exception.Message }
  }
}

function Test-AiAtBase([string]$BaseUrl, [int]$Port) {
  $openAi = @{ Path='/v1/models'; Provider= if ($Port -eq 1234) { 'LM Studio / OpenAI-compatible' } elseif ($Port -eq 8080) { 'llama-server / LocalAI / OpenAI-compatible' } else { 'OpenAI-compatible' }; Kind='openai-compatible'; Pattern='"data"\s*:|"object"\s*:\s*"list"' }
  $ollama = @{ Path='/api/tags'; Provider='Ollama'; Kind='ollama'; Pattern='"models"\s*:' }
  $root = @{ Path='/'; Provider= if ($Port -eq 3000) { 'Open WebUI / web UI' } else { 'Local web/API service' }; Kind='web'; Pattern='open webui|llama|localai|ollama|lm studio' }
  if ($Port -eq 8080 -or $Port -eq 1234 -or $Port -eq 8000 -or $Port -eq 5000) { $checks = @($openAi, $ollama, $root) }
  elseif ($Port -eq 11434) { $checks = @($ollama, $openAi, $root) }
  elseif ($Port -eq 3000) { $checks = @($root, $openAi, $ollama) }
  else { $checks = @($openAi, $ollama, $root) }
  foreach ($check in $checks) {
    $url = "$BaseUrl$($check.Path)"
    $res = Invoke-QuickHttp $url
    if ($res.Ok -and ($res.Text -match $check.Pattern)) {
      return [PSCustomObject]@{ BaseUrl=$BaseUrl; Port=$Port; Provider=$check.Provider; Kind=$check.Kind; Path=$check.Path; Url=$url; Status=$res.Status }
    }
  }
  return $null
}

function Find-LocalAiServices {
  Write-Host 'Checking Local AI endpoints. Dots mean LLM Radar is still working; keep this window open.' -ForegroundColor Cyan
  $knownPort = 0
  if ($env:LLMRADAR_AI_PORT -and [int]::TryParse($env:LLMRADAR_AI_PORT, [ref]$knownPort)) { } else { $knownPort = 0 }
  $basePorts = @(8080, 11434, 1234, 3000, 8000, 5000)
  $ports = if ($knownPort -gt 0) { @($knownPort) + @($basePorts | Where-Object { $_ -ne $knownPort }) } else { $basePorts }
  $lanIps = @(Get-LanIpv4Candidates)
  $lanReady = @()
  $localhostOnly = @()

  # Fast path: most LLM Radar testing uses llama-server/OpenAI-compatible on the best LAN IP, port 8080.
  foreach ($port in @($ports | Select-Object -First 3)) {
    foreach ($ip in @($lanIps | Select-Object -First 1)) {
      $fastHit = Test-AiAtBase -BaseUrl "http://$($ip.IPAddress):$port" -Port $port
      if ($fastHit) {
        $lanReady += $fastHit
        Write-Host ''
        return [PSCustomObject]@{ LanReady=@($lanReady); LocalhostOnly=@($localhostOnly); LanIps=@($lanIps); FastPath=$true }
      }
    }
  }

  foreach ($port in $ports) {
    $localHit = Test-AiAtBase -BaseUrl "http://127.0.0.1:$port" -Port $port
    $lanHit = $null
    foreach ($ip in $lanIps) {
      $maybe = Test-AiAtBase -BaseUrl "http://$($ip.IPAddress):$port" -Port $port
      if ($maybe) {
        $lanHit = $maybe
        $lanReady += $maybe
        break
      }
    }
    if ($localHit -and -not $lanHit) { $localhostOnly += $localHit }
  }

  Write-Host ''
  return [PSCustomObject]@{ LanReady=@($lanReady); LocalhostOnly=@($localhostOnly); LanIps=@($lanIps); FastPath=$false }
}

try {
  Write-Section 'LLM Radar Windows Setup Tool v0.2.7'
  Write-Host 'This tool sets up computer-to-phone access on trusted private Wi-Fi for QR pairing, chat/status, and small PDF/TXT upload.'
  Write-Host 'It avoids ipconfig instructions and avoids sending you into Defender Firewall screens.'
  Write-Host 'It asks before each firewall/network change.'
  Write-Host 'It does not turn Windows Firewall off.'

  if (-not (Test-IsAdmin)) {
    Write-Host 'ERROR: This script must run elevated as Administrator.' -ForegroundColor Red
    Write-Host 'Use Start_Here.bat so Windows can show the UAC prompt.'
    exit 1
  }

  $root = Split-Path -Parent $PSScriptRoot
  Set-Location $root

  Write-Section 'Node.js check'
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Host 'Node.js was not found.' -ForegroundColor Red
    Write-Host 'Install Node.js LTS from nodejs.org, then run Start_Here.bat again.'
    exit 1
  }
  Write-Host "PASS: Node.js found: $($node.Source)" -ForegroundColor Green

  Write-Section 'Network profile check'
  $profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' -or $_.IPv6Connectivity -ne 'Disconnected' })
  if ($profiles.Count -eq 0) {
    Write-Host 'WARNING: Could not find an active network profile.' -ForegroundColor Yellow
  } else {
    foreach ($profile in $profiles) {
      Write-Host "Network: $($profile.Name) | Interface: $($profile.InterfaceAlias) | Category: $($profile.NetworkCategory)"
      if ($profile.NetworkCategory -eq 'Public') {
        Write-Host 'NEEDS ACTION: This network is Public.' -ForegroundColor Yellow
        Write-Host 'LLM Radar needs this Wi-Fi network to be marked Private so your phone can reach this computer.'
        Write-Host 'Only choose Yes if this is your trusted home/work Wi-Fi.'
        Write-Host "Current network: $($profile.Name)"
        Write-Host "Current profile: $($profile.NetworkCategory)"
        if (Ask-YesNo 'Set this network to Private and continue LLM Radar setup? Recommended: Y. Choosing N cancels setup.' 'Y') {
          Set-NetConnectionProfile -InterfaceIndex $profile.InterfaceIndex -NetworkCategory Private
          Write-Host 'PASS: Network set to Private.' -ForegroundColor Green
        } else {
          Stop-Setup 'LLM Radar cannot reliably connect your phone to this computer while this network is Public. Use a trusted private Wi-Fi network, then run Start_Here.bat again.' 21
        }
      } elseif ($profile.NetworkCategory -eq 'Private') {
        Write-Host 'PASS: Network is Private.' -ForegroundColor Green
      } else {
        Write-Host "INFO: Network category is $($profile.NetworkCategory). LLM Radar will not change Domain networks automatically." -ForegroundColor Yellow
      }
    }
  }

  Write-Section 'Windows Firewall profile check'
  $fw = Get-NetFirewallProfile -Profile Private
  Write-Host "Private firewall enabled: $($fw.Enabled)"
  Write-Host "AllowInboundRules: $($fw.AllowInboundRules)"
  Write-Host "AllowLocalFirewallRules: $($fw.AllowLocalFirewallRules)"

  if (-not $fw.Enabled) {
    Write-Host ''
    Write-Host 'NEEDS ACTION: Windows Firewall is currently OFF for this Private network.' -ForegroundColor Yellow
    Write-Host 'LLM Radar does not need the firewall turned off. Safer setup keeps Firewall ON and allows only the Phone Access and AI ports.'
    if (Ask-YesNo 'Turn Windows Firewall back ON and continue setup? Recommended: Y. Choosing N stops setup.' 'Y') {
      Set-NetFirewallProfile -Profile Private -Enabled True
      Write-Host 'PASS: Private firewall enabled.' -ForegroundColor Green
    } else {
      Stop-Setup 'LLM Radar setup stopped because the safer supported path keeps Windows Firewall on and uses narrow allow rules.' 22
    }
  }

  $fw = Get-NetFirewallProfile -Profile Private
  $needsInbound = ([string]$fw.AllowInboundRules -ne 'True') -or ([string]$fw.AllowLocalFirewallRules -ne 'True')
  if ($needsInbound) {
    Write-Host ''
    Write-Host 'NEEDS ACTION: Windows may be ignoring local inbound allow rules.' -ForegroundColor Yellow
    Write-Host 'LLM Radar needs Windows Firewall to honor inbound allow rules and local firewall rules.'
    Write-Host 'Right now, port rules may exist but your phone may still be blocked. This was the known blocker in the v0.2.x setup work.'
    Write-Host 'Change: set AllowInboundRules=True and AllowLocalFirewallRules=True for the Private profile.'
    if (Ask-YesNo 'Allow inbound/local firewall rules for the Private profile and continue setup? Required: Y. Choosing N cancels setup.' 'Y') {
      Set-NetFirewallProfile -Profile Private -AllowInboundRules True -AllowLocalFirewallRules True
      Write-Host 'PASS: Private profile now honors inbound/local firewall rules.' -ForegroundColor Green
    } else {
      Stop-Setup 'LLM Radar cannot continue because Windows would ignore the narrow firewall rules needed for phone-to-computer access.' 23
    }
  } else {
    Write-Host 'PASS: Private profile honors inbound/local firewall rules.' -ForegroundColor Green
  }

  Write-Section 'Phone access setup: QR, chat, and file upload'
  $helperPort = Select-HelperPort
  Write-Host "Selected LLM Radar Phone Access port: $helperPort"
  if ($helperPort -ne 49321) {
    Write-Host "Note: default port 49321 was busy, so the setup selected $helperPort." -ForegroundColor Yellow
  }
  $helperRuleOk = Ensure-PortRule -DisplayName "LLM Radar Phone Access $helperPort" -Port $helperPort -Rationale "LLM Radar needs phone access on port $helperPort so your phone can pair, chat, check status, and upload a small PDF/TXT to this computer. The rule allows only this LLM Radar port on your Private Wi-Fi."
  if (-not $helperRuleOk) { Stop-Setup "LLM Radar cannot continue without Phone Access port $helperPort because the phone will not be able to connect." 24 }

  Write-Section 'Local AI endpoint detection'
  Write-Host 'Checking likely local AI endpoints first. This can take a few seconds. Dots mean the setup is still working; do not close this window.'
  Write-Host 'If your local model starts later, start it and then use Recheck Local AI on the browser page.'
  $ai = Find-LocalAiServices
  if ($ai.LanReady.Count -gt 0) {
    foreach ($svc in $ai.LanReady) {
      Write-Host "PASS: Detected LAN-ready AI service: $($svc.Provider) at $($svc.BaseUrl) via $($svc.Path)" -ForegroundColor Green
      $aiRuleOk = Ensure-PortRule -DisplayName "LLM Radar AI $($svc.Port)" -Port ([int]$svc.Port) -Rationale "LLM Radar found a local AI server on port $($svc.Port). For chat and testing to work from your phone, Windows must allow your phone to reach this AI server over Private Wi-Fi."
      if (-not $aiRuleOk) { Write-Host "WARNING: Phone Access setup will continue, but phone chat/benchmarking may be blocked until AI server port $($svc.Port) is allowed." -ForegroundColor Yellow }
    }
  } else {
    Write-Host 'No LAN-ready local AI endpoint was detected from this computer yet.' -ForegroundColor Yellow
    if ($ai.LocalhostOnly.Count -gt 0) {
      Write-Host 'Localhost-only AI clues were found. Firewall rules alone will not fix localhost-only binding.' -ForegroundColor Yellow
      foreach ($svc in $ai.LocalhostOnly) {
        Write-Host "Localhost-only: $($svc.Provider) at $($svc.BaseUrl). For llama-server, restart with --host 0.0.0.0 --port $($svc.Port)."
      }
    }
    Write-Host 'The Phone Access page will keep checking and will show endpoint status.'
  }

  Write-Section 'Phone access program rule'
  Ensure-PhoneAccessProgramPortRule -DisplayName "LLM Radar Phone Access Program $helperPort" -ProgramPath $node.Source -Port $helperPort

  Write-Section 'Starting LLM Radar Phone Access'
  $helperScript = Join-Path $root 'tools\llmradar-ez-pair.js'
  if (-not (Test-Path $helperScript)) {
    Write-Host "ERROR: Missing Phone Access script: $helperScript" -ForegroundColor Red
    exit 2
  }

  $env:LLMRADAR_HELPER_PORT = [string]$helperPort
  $env:LLMRADAR_HELPER_PORT_MAX = [string]$helperPort
  if ($ai.LanReady.Count -gt 0) { $env:LLMRADAR_AI_PORT = [string]$ai.LanReady[0].Port }
  Write-Host "The LLM Radar computer page will open in your browser using phone-access port $helperPort. This same port is used for QR pairing, chat/status, and small PDF/TXT upload from the phone."
  Write-Host 'Keep this setup window open while using the phone. If a check pauses for a few seconds, wait for the next status line instead of closing the window.'
  Write-Host 'No ipconfig or Defender Firewall screen is required.'
  Write-Host ''
  & $node.Source $helperScript
  $exit = $LASTEXITCODE
} catch {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  $exit = 1
} finally {
  if ($script:TranscriptStarted) {
    try { Stop-Transcript | Out-Null } catch {}
  }
}
exit $exit
