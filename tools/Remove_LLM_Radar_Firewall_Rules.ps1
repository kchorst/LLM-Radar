function Ask-YesNo([string]$Question) {
  $answer = Read-Host "$Question [y/N]"
  return $answer -match '^(y|yes)$'
}
Write-Host ''
Write-Host 'Remove LLM Radar firewall rules' -ForegroundColor Cyan
Write-Host 'This removes only rules with LLM Radar names. It does not change unrelated firewall rules.'
if (-not (Ask-YesNo 'Remove LLM Radar firewall rules now?')) {
  Write-Host 'Canceled.' -ForegroundColor Yellow
  exit 0
}
Get-NetFirewallRule -DisplayName 'LLM Radar Helper *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'LLM Radar AI *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName 'LLM Radar Helper Program *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Done. LLM Radar firewall rules were removed if present.' -ForegroundColor Green
