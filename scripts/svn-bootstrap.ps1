#requires -Version 7
<#
.SYNOPSIS
  一次性把本项目初始化为 SVN 工作副本并暂存所有应版本化的文件，最后由你执行 `svn commit`。

.DESCRIPTION
  做的事：
    1. svn checkout <Url> 到当前项目目录（Url 应指向 SVN 服务器上一个空目标路径）。
    2. 在根目录设置 svn:ignore（排除 node_modules / dist / data / .env / .git 等）。
    3. `svn add --force .` 暂存全部源码与配置（自动跳过被忽略项）。
    4. 按 scripts/svn/versioned-data-paths.txt 显式 add 需要随仓库分发的 data/ 子集
       （原始资料 blob、OKF 发布物、被引用 run 的轻量构建产物）。
    5. 设置 data/ 与各 run 的 svn:ignore，隐藏可再生的大体积产物。
  脚本不会自动 commit —— 跑完用 `svn status` 复核后，再 `svn commit -m "init"`。

.PARAMETER Url
  SVN 目标 URL，例如 svn://host/knowledge-hub/trunk 或 https://host/svn/knowledge-hub/trunk。

.EXAMPLE
  pwsh scripts/svn-bootstrap.ps1 -Url svn://192.168.1.10/knowledge-hub/trunk
#>
param(
  [Parameter(Mandatory = $true)] [string] $Url
)
$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

function Invoke-Svn { param([Parameter(ValueFromRemainingArguments)] [string[]] $Args)
  & svn @Args
  if ($LASTEXITCODE -ne 0) { throw "svn $($Args -join ' ') 失败（exit $LASTEXITCODE）" }
}

if (Test-Path (Join-Path $repoRoot ".svn")) {
  throw "当前目录已是 SVN 工作副本（存在 .svn）。如需重做请先手动清理。"
}
if (-not (Test-Path (Join-Path $repoRoot "seed/db/knowledge_hub.dump"))) {
  throw "缺少 seed/db/knowledge_hub.dump，请先生成数据库 dump 再初始化。"
}

Write-Host "→ [1/5] checkout $Url 到当前目录..." -ForegroundColor Cyan
Invoke-Svn checkout $Url .

Write-Host "→ [2/5] 设置根目录 svn:ignore..." -ForegroundColor Cyan
Invoke-Svn propset svn:ignore -F scripts/svn/root.svnignore .

Write-Host "→ [3/5] 暂存全部源码与配置（svn add --force .）..." -ForegroundColor Cyan
Invoke-Svn add --force . --depth infinity

Write-Host "→ [4/5] 显式 add 需随仓库分发的 data/ 子集..." -ForegroundColor Cyan
Get-Content scripts/svn/versioned-data-paths.txt |
  Where-Object { $_ -and -not $_.StartsWith("#") } |
  ForEach-Object {
    $p = $_.Trim()
    if (Test-Path $p) {
      Invoke-Svn add --parents --no-ignore --force $p
    } else {
      Write-Warning "跳过不存在的路径：$p"
    }
  }

Write-Host "→ [5/5] 设置 data/ 与 run 的 svn:ignore，隐藏可再生产物..." -ForegroundColor Cyan
Invoke-Svn propset svn:ignore -F scripts/svn/data.svnignore data
if (Test-Path "data/kb-build-runs") {
  # 隐藏未被引用的其它 run（已版本化的 run 不受 ignore 影响）
  Invoke-Svn propset svn:ignore "run_*" data/kb-build-runs
  # 仅对“已版本化”的 run/data 设置忽略（从 manifest 推导，避免对未版本化 run propset 报 E155010）。
  # 忽略与 blob 重复的 gamedata/gamedocs，以及构建缓存 .kh-cache。
  $runIgnore = "gamedata`ngamedocs`n.kh-cache"
  Get-Content scripts/svn/versioned-data-paths.txt |
    Where-Object { $_ -and -not $_.StartsWith("#") -and $_ -match "kb-build-runs" } |
    ForEach-Object { (($_ -replace "\\", "/").Trim()) -replace "(data/kb-build-runs/[^/]+/data)/.*", '$1' } |
    Select-Object -Unique |
    ForEach-Object {
      if (Test-Path $_) { Invoke-Svn propset svn:ignore $runIgnore $_ }
      else { Write-Warning "跳过未版本化的 run 路径：$_" }
    }
}

Write-Host ""
Write-Host "✓ 暂存完成。请执行以下命令复核并提交：" -ForegroundColor Green
Write-Host "    svn status | Select-String '^[^?]'   # 复核将提交的内容" -ForegroundColor Yellow
Write-Host "    svn commit -m \"chore: SVN 初始化（含种子数据与原始资料）\"" -ForegroundColor Yellow
Write-Host "（首次 commit 约数百 MB，耗时取决于网络/服务器。）" -ForegroundColor DarkGray
