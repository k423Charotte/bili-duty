# bili-duty：装完插件后的必要一步 —— 重启 DSH
#
# 用法（Windows PowerShell 5.1；必须带 -ExecutionPolicy Bypass）：
#   powershell -ExecutionPolicy Bypass -File tools\restart-dsh.ps1
# 自动探测不到 DSH 安装位置时，手动指定：
#   powershell -ExecutionPolicy Bypass -File tools\restart-dsh.ps1 -ExePath "C:\你的路径\DeepSeek Harness.exe"
#
# 为什么必须重启（是硬性要求，不是保险起见）：
#   1. 新 bundle 的行在重启时才进入组合；
#   2. 替换已装包必须重启才能加载新一代 JS 模块 —— 光改代码文件，运行中的进程还在用旧模块；
#   3. 客户端模块的加载问题只在重启时才暴露或消失。
#
# ⚠️ 这会结束你当前的 DSH 会话（包括正在跟你说话的那个 AI）。这是有意为之。
#
# ⛔ 如果重启后弹「应用无法启动」，**不要**点那个
#    「禁用第三方插件、备份 profile patch 并重启」按钮 ——
#    它会用一份安全模式 patch **整份替换** profile 的 cordis.patch.yml，冲掉你手工调好的
#    模型显示名 / 本地模型 / 默认模型 / ui-chat 偏好，还会把设置面板本身关掉。
#    要摘除本插件，只删 profile 里 cordis.patch.yml 末尾那段 `insert`（本插件那几行）再重启即可。

param([string]$ExePath)

$ErrorActionPreference = 'Stop'
$procName = 'DeepSeek Harness'

$running = Get-Process -Name $procName -ErrorAction SilentlyContinue
if (-not $ExePath -and $running) {
  $ExePath = ($running | Where-Object { $_.Path } | Select-Object -First 1).Path
}
if (-not $ExePath -or -not (Test-Path -LiteralPath $ExePath)) {
  throw @"
没能自动找到 DSH 可执行文件（进程不在运行，或读不到它的路径）。
请手动指定，例如：
  powershell -ExecutionPolicy Bypass -File tools\restart-dsh.ps1 -ExePath 'C:\你的路径\DeepSeek Harness.exe'
"@
}
$work = Split-Path -Parent $ExePath

Write-Host "DSH 位置：$ExePath"
Write-Host '正在结束 DSH 进程…'
Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host ("  kill pid {0}" -f $_.Id)
  try { $_.Kill() } catch { Write-Warning $_.Exception.Message }
}
Start-Sleep -Seconds 3

Write-Host '重新启动 DSH…'
Start-Process -FilePath $ExePath -WorkingDirectory $work

Write-Host ''
Write-Host '重启后请做三件事：'
Write-Host '  1) 在 DSH 页面按一次 F5（客户端模块是页面侧的东西，重启宿主不等于刷新页面）'
Write-Host '  2) 打开 设置 → 刷B站值班表，确认页面能出来'
Write-Host '  3) 在「目标会话」里选中你要被唤醒的那个会话（默认是空的，不选就不会有人被叫醒）'
Write-Host ''
Write-Host '如果设置里没有这一栏，先看这两处（把结果贴到 issue 里）：'
Write-Host '  · 设置页/浏览器控制台是否报错（F12）'
Write-Host '  · 插件家目录的 apply-probe.json 与 apply-error.log：'
Write-Host '      Get-Content "$env:USERPROFILE\.dsh\bili-duty\apply-probe.json" -Raw'
Write-Host '      Get-Content "$env:USERPROFILE\.dsh\bili-duty\apply-error.log" -Raw -ErrorAction SilentlyContinue'
