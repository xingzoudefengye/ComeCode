# ComeCode 一键安装脚本 (Windows PowerShell)

$ErrorActionPreference = "Stop"

$REPO = "xingzoudefengye/ComeCode"
$INSTALL_DIR = "$env:LOCALAPPDATA\ComeCode"

Write-Host "🚀 正在安装 ComeCode..." -ForegroundColor Green

# 检测架构
$ARCH = $env:PROCESSOR_ARCHITECTURE
if ($ARCH -eq "AMD64") {
    $PLATFORM = "windows-x64"
} elseif ($ARCH -eq "ARM64") {
    $PLATFORM = "windows-arm64"
} else {
    Write-Host "❌ 不支持的架构: $ARCH" -ForegroundColor Red
    exit 1
}

# 获取最新版本
Write-Host "📦 获取最新版本..." -ForegroundColor Cyan
try {
    $response = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest"
    $LATEST_VERSION = $response.tag_name
} catch {
    Write-Host "❌ 无法获取最新版本" -ForegroundColor Red
    exit 1
}

Write-Host "✅ 最新版本: $LATEST_VERSION" -ForegroundColor Green

# 下载地址
$VERSION_NUM = $LATEST_VERSION -replace '^v', ''
$DOWNLOAD_URL = "https://github.com/$REPO/releases/download/$LATEST_VERSION/comecode-$VERSION_NUM-$PLATFORM.zip"

# 创建安装目录
if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR | Out-Null
}

# 下载并解压
$TEMP_FILE = Join-Path $env:TEMP "comecode.zip"

Write-Host "⬇️  下载 ComeCode..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $TEMP_FILE

Write-Host "📦 解压文件..." -ForegroundColor Cyan
Expand-Archive -Path $TEMP_FILE -DestinationPath $INSTALL_DIR -Force

# 清理
Remove-Item $TEMP_FILE

# 添加到 PATH
$USER_PATH = [Environment]::GetEnvironmentVariable("Path", "User")
if ($USER_PATH -notlike "*$INSTALL_DIR*") {
    Write-Host "📥 添加到 PATH..." -ForegroundColor Cyan
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$USER_PATH;$INSTALL_DIR",
        "User"
    )
    $env:Path = "$env:Path;$INSTALL_DIR"
}

# 验证安装
Write-Host ""
Write-Host "✅ ComeCode 安装成功！" -ForegroundColor Green
Write-Host ""
Write-Host "运行以下命令开始使用："
Write-Host "  comecode --version" -ForegroundColor Yellow
Write-Host "  comecode config setup" -ForegroundColor Yellow
Write-Host "  comecode" -ForegroundColor Yellow
Write-Host ""
Write-Host "注意: 如果找不到 comecode 命令，请重新打开 PowerShell 窗口" -ForegroundColor Cyan
