param(
  [Parameter(Mandatory = $true)]
  [string]$Name
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".git")) {
  Write-Error "Not a git repository. Run from Probable root."
}

git fetch origin 2>$null
git checkout main 2>$null
if ($LASTEXITCODE -ne 0) { git checkout -b main }
git pull origin main 2>$null

git checkout -b $Name
Write-Host "Created and switched to branch: $Name"
Write-Host "When ready: git push -u origin $Name"
