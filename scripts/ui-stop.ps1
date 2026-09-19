# Stops whatever is listening on port 3000, i.e. the Next.js dashboard (see package.json "ui:stop").
$procs = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
if ($procs) {
  $procs | ForEach-Object { Stop-Process -Id $_ -Force }
  Write-Host 'UI stopped (port 3000)'
} else {
  Write-Host 'No UI running on port 3000'
}
