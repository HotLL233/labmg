$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path;$out=Join-Path $root 'dist'
if(Test-Path $out){Remove-Item $out -Recurse -Force};New-Item $out -ItemType Directory|Out-Null
Copy-Item (Join-Path $root 'server.js') $out;Copy-Item (Join-Path $root 'package.json') $out;Copy-Item (Join-Path $root 'docker-compose.yml') $out;Copy-Item (Join-Path $root 'public') $out -Recurse
"@echo off`r`ncd /d `"%~dp0`"`r`nnode server.js`r`n"|Set-Content (Join-Path $out '启动实验室系统.cmd') -Encoding utf8
Compress-Archive -Path (Join-Path $out '*') -DestinationPath (Join-Path $root 'labos-mvp.zip') -Force
Write-Host '已生成 labos-mvp.zip（可部署包；EXE 需在环境变量恢复后用 Electron/Node SEA继续打包）'
