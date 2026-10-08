# ComeCode 一键安装脚本 (Windows PowerShell)
# 产物结构: comecode-<version>-windows-x64/ 内含 comecode.cjs 与运行资源，需要已安装 Node.js 24+。

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$REPO = "xingzoudefengye/ComeCode"
$INSTALL_ROOT = if ($env:COMECODE_HOME) { $env:COMECODE_HOME } else { "$env:LOCALAPPDATA\ComeCode" }
$NODE_MIN_MAJOR = 24

Write-Host "🚀 正在安装 ComeCode..." -ForegroundColor Green

$ARCH = $env:PROCESSOR_ARCHITECTURE
switch ($ARCH) {
    "AMD64" { $TARGET = "windows-x64" }
    "ARM64" {
        Write-Host "❌ 暂不提供 Windows ARM64 安装包。" -ForegroundColor Red
        Write-Host "   可尝试: npm install -g comecode，或从源码构建。" -ForegroundColor Yellow
        exit 1
    }
    default {
        Write-Host "❌ 不支持的架构: $ARCH" -ForegroundColor Red
        exit 1
    }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "❌ 未找到 Node.js。ComeCode 需要 Node.js $NODE_MIN_MAJOR 或更高版本。" -ForegroundColor Red
    Write-Host "   请先安装 Node.js: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}
$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt $NODE_MIN_MAJOR) {
    Write-Host "❌ 当前 Node.js 版本为 $(node -v)，ComeCode 需要 Node.js $NODE_MIN_MAJOR.14.0 或更高版本。" -ForegroundColor Red
    exit 1
}

Write-Host "📦 获取最新版本..." -ForegroundColor Cyan
try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest"
} catch {
    Write-Host "❌ 无法访问 GitHub Releases API，请检查网络后重试。" -ForegroundColor Red
    exit 1
}

$LATEST_VERSION = $release.tag_name
if (-not $LATEST_VERSION) {
    Write-Host "❌ 仓库还没有可用的 Release，暂时无法自动安装。" -ForegroundColor Red
    Write-Host "   可改用 npm 安装（发布后）: npm install -g comecode" -ForegroundColor Yellow
    exit 1
}

$VERSION_NUM = $LATEST_VERSION -replace '^v', ''
$ASSET_NAME = "comecode-$VERSION_NUM-$TARGET.tar.gz"
$asset = $release.assets | Where-Object { $_.name -eq $ASSET_NAME }
if (-not $asset) {
    Write-Host "❌ 该版本没有为 $TARGET 提供安装包。" -ForegroundColor Red
    Write-Host "   可尝试: npm install -g comecode，或从源码构建。" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ 最新版本: $LATEST_VERSION ($TARGET)" -ForegroundColor Green

$TEMP_DIR = Join-Path $env:TEMP ("comecode-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TEMP_DIR -Force | Out-Null

try {
    $ARCHIVE = Join-Path $TEMP_DIR $ASSET_NAME
    Write-Host "⬇️  下载 ComeCode $VERSION_NUM..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $ARCHIVE

    $checksumAsset = $release.assets | Where-Object { $_.name -eq "$ASSET_NAME.sha256" }
    if ($checksumAsset) {
        $checksumFile = Join-Path $TEMP_DIR "$ASSET_NAME.sha256"
        Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $checksumFile
        $expected = ((Get-Content $checksumFile -Raw) -split '\s+')[0].ToLower()
        $actual = (Get-FileHash -Path $ARCHIVE -Algorithm SHA256).Hash.ToLower()
        if ($expected -ne $actual) {
            Write-Host "❌ 校验失败，下载文件可能已损坏。" -ForegroundColor Red
            exit 1
        }
        Write-Host "🔒 校验通过" -ForegroundColor Green
    }

    Write-Host "📦 解压文件..." -ForegroundColor Cyan
    tar -xzf $ARCHIVE -C $TEMP_DIR
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 解压失败，需要系统自带 tar 命令（Windows 10 1803 及以上）。" -ForegroundColor Red
        exit 1
    }

    $PACKAGE_DIR = Join-Path $TEMP_DIR "comecode-$VERSION_NUM-$TARGET"
    if (-not (Test-Path (Join-Path $PACKAGE_DIR "comecode.cjs"))) {
        Write-Host "❌ 安装包结构异常，未找到 comecode.cjs。" -ForegroundColor Red
        exit 1
    }

    $TARGET_DIR = Join-Path $INSTALL_ROOT "cli\$VERSION_NUM"
    if (Test-Path $TARGET_DIR) { Remove-Item $TARGET_DIR -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $TARGET_DIR -Parent) -Force | Out-Null
    Move-Item $PACKAGE_DIR $TARGET_DIR

    $BIN_DIR = Join-Path $INSTALL_ROOT "bin"
    New-Item -ItemType Directory -Path $BIN_DIR -Force | Out-Null
    $launcher = Join-Path $BIN_DIR "comecode.cmd"
    $launcherBody = "@echo off`r`nnode `"$TARGET_DIR\comecode.cjs`" %*`r`n"
    Set-Content -Path $launcher -Value $launcherBody -Encoding ASCII -NoNewline

    $USER_PATH = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($USER_PATH -notlike "*$BIN_DIR*") {
        Write-Host "📥 添加到 PATH..." -ForegroundColor Cyan
        [Environment]::SetEnvironmentVariable("Path", "$USER_PATH;$BIN_DIR", "User")
        $env:Path = "$env:Path;$BIN_DIR"
    }
} finally {
    Remove-Item $TEMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "✅ ComeCode $VERSION_NUM 安装成功！" -ForegroundColor Green
Write-Host ""
Write-Host "运行以下命令开始使用："
Write-Host "  comecode --version" -ForegroundColor Yellow
Write-Host "  comecode config setup" -ForegroundColor Yellow
Write-Host "  comecode" -ForegroundColor Yellow
Write-Host ""
Write-Host "注意: 如果找不到 comecode 命令，请重新打开 PowerShell 窗口" -ForegroundColor Cyan
