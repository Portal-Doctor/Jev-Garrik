# Starts the Next.js dashboard detached on port 3000 (see package.json "ui:start").
$web = Join-Path $PSScriptRoot '..\web'
Start-Process -FilePath bun -ArgumentList 'run','dev','-p','3000' -WorkingDirectory $web -WindowStyle Hidden
Write-Host 'UI starting -> http://localhost:3000/paper'
