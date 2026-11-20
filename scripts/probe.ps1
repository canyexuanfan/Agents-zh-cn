# Claude Desktop 探针脚本 - 只读，不修改任何文件
# 用法：powershell -ExecutionPolicy Bypass -File .\probe.ps1
# 安装发现统一走 lib\discover.js（唯一实现入口），本脚本不再持有路径表。

$ErrorActionPreference = 'SilentlyContinue'

# 设置 UTF-8 输出（仅在非受限语言模式下尝试）
try {
    if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $OutputEncoding = [System.Text.Encoding]::UTF8
    }
} catch {}

Write-Host "=================================================="
Write-Host " Claude Desktop 环境探针"
Write-Host "=================================================="

# --- Node.js（installer/发现模块的前置）---
Write-Host "`n--- Node.js 版本（installer 需要 >= 16）---"
$node = (node --version) 2>$null
if ($node) { Write-Host "node: $node" -ForegroundColor Green }
else {
    Write-Host "未检测到 node，installer 与统一发现模块无法运行" -ForegroundColor Yellow
    Write-Host "可右键 Claude 桌面快捷方式 -> 打开文件位置，把路径贴给开发者。"
    Write-Host "`n探针结束。"
    exit
}

# --- 统一发现模块（唯一实现入口）---
Write-Host "`n--- Claude 安装发现（lib/discover.js 动态发现链）---"
$discoverJs = Join-Path (Split-Path -Parent $PSScriptRoot) 'lib\discover.js'
if (-not (Test-Path $discoverJs)) {
    Write-Host "[ERROR] 未找到发现模块: $discoverJs" -ForegroundColor Red
    exit
}
$raw = (& node $discoverJs --json 2>$null) -join "`n"
if (-not $raw) {
    Write-Host "[NOT FOUND] 发现模块无结果。" -ForegroundColor Yellow
    Write-Host "探针结束。"
    exit
}
try { $d = $raw | ConvertFrom-Json } catch {
    Write-Host "[ERROR] 发现模块输出解析失败: $raw" -ForegroundColor Red
    exit
}

if ($d.squirrel) {
    Write-Host "[FOUND] Squirrel 直装版 $($d.squirrel.version) — 可注入" -ForegroundColor Green
    Write-Host "  asar: $($d.squirrel.asarPath)" -ForegroundColor Cyan
} else {
    Write-Host "[--] Squirrel 直装版: 未发现（旧版残留空壳不会误报）" -ForegroundColor DarkGray
}
if ($d.msix) {
    $desc = "MSIX 包 $($d.msix.packageVersion)"
    if ($d.msix.version -and $d.msix.version -ne $d.msix.packageVersion) {
        $desc += "（内部 $($d.msix.version)）"
    }
    Write-Host "[FOUND] $desc — 不支持文件级注入" -ForegroundColor Yellow
    Write-Host "  asar: $($d.msix.asarPath)" -ForegroundColor Cyan
    Write-Host "  原因: WindowsApps 只读 + ASAR 完整性 fuse + MSIX 包身份管理" -ForegroundColor DarkGray
}

# --- 当前正在运行的 Claude 进程（路径校验）---
Write-Host "`n--- 当前正在运行的 Claude 进程（路径校验）---"
Get-Process -Name 'Claude*' -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, Path |
    Format-Table -AutoSize

# --- 安装状态（state.json）---
Write-Host "`n--- 安装状态（state.json）---"
$stateFile = Join-Path $env:APPDATA 'claude-cn\state.json'
if (Test-Path $stateFile) {
    Write-Host "state: $stateFile" -ForegroundColor Green
    Get-Content $stateFile | Write-Host
} else {
    Write-Host "无 state.json（尚未安装汉化包）"
}

Write-Host "`n探针结束。"
