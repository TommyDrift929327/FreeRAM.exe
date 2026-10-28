#requires -Version 5.1
<#
.SYNOPSIS
  Crée un raccourci FreeRAM sur le Bureau.

.DESCRIPTION
  Cherche par défaut l'application packagée :
    1. -TargetPath fourni explicitement ;
    2. release\win-unpacked\FreeRAM.exe (build local) ;
    3. %LOCALAPPDATA%\Programs\FreeRAM\FreeRAM.exe (installation NSIS) ;
    4. FreeRAM.exe à la racine du projet.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 -TargetPath "C:\Program Files\FreeRAM\FreeRAM.exe"
#>
param(
  [string]$TargetPath = '',
  [string]$Name = 'FreeRAM'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

if (-not $TargetPath) {
  $candidates = @(
    (Join-Path $projectRoot 'release\win-unpacked\FreeRAM.exe'),
    (Join-Path $projectRoot 'FreeRAM.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\FreeRAM\FreeRAM.exe'),
    (Join-Path $env:ProgramFiles 'FreeRAM\FreeRAM.exe')
  )
  $TargetPath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

if (-not $TargetPath -or -not (Test-Path -LiteralPath $TargetPath)) {
  throw "FreeRAM.exe introuvable. Lancez d'abord « npm run dist » ou passez -TargetPath."
}

$target = (Resolve-Path -LiteralPath $TargetPath).Path
$workingDirectory = Split-Path -Parent $target
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $workingDirectory
$shortcut.IconLocation = "$target,0"
$shortcut.Description = 'FreeRAM — surveiller et libérer la mémoire vive'
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "Raccourci créé : $shortcutPath"
Write-Host "Cible : $target"
