#!/bin/bash
# ComeCode 一键安装脚本 (Linux/macOS)

set -e

REPO="xingzoudefengye/ComeCode"
INSTALL_DIR="/usr/local/bin"

echo "🚀 正在安装 ComeCode..."

# 检测操作系统和架构
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)
    if [ "$ARCH" = "x86_64" ]; then
      PLATFORM="linux-x64"
    elif [ "$ARCH" = "aarch64" ]; then
      PLATFORM="linux-arm64"
    else
      echo "❌ 不支持的架构: $ARCH"
      exit 1
    fi
    ;;
  Darwin*)
    if [ "$ARCH" = "arm64" ]; then
      PLATFORM="darwin-arm64"
    elif [ "$ARCH" = "x86_64" ]; then
      PLATFORM="darwin-x64"
    else
      echo "❌ 不支持的架构: $ARCH"
      exit 1
    fi
    ;;
  *)
    echo "❌ 不支持的操作系统: $OS"
    exit 1
    ;;
esac

# 获取最新版本
echo "📦 获取最新版本..."
LATEST_VERSION=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST_VERSION" ]; then
  echo "❌ 无法获取最新版本"
  exit 1
fi

echo "✅ 最新版本: $LATEST_VERSION"

# 下载地址
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_VERSION/comecode-${LATEST_VERSION#v}-${PLATFORM}.tar.gz"

# 下载并解压
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

echo "⬇️  下载 ComeCode..."
curl -fsSL "$DOWNLOAD_URL" -o comecode.tar.gz

echo "📦 解压文件..."
tar xzf comecode.tar.gz

# 安装
echo "📥 安装到 $INSTALL_DIR..."
if [ -w "$INSTALL_DIR" ]; then
  mv comecode "$INSTALL_DIR/comecode"
  chmod +x "$INSTALL_DIR/comecode"
else
  sudo mv comecode "$INSTALL_DIR/comecode"
  sudo chmod +x "$INSTALL_DIR/comecode"
fi

# 清理
cd - > /dev/null
rm -rf "$TEMP_DIR"

# 验证安装
if command -v comecode &> /dev/null; then
  echo "✅ ComeCode 安装成功！"
  echo ""
  echo "运行以下命令开始使用："
  echo "  comecode --version"
  echo "  comecode config setup"
  echo "  comecode"
else
  echo "⚠️  安装完成，但未找到 comecode 命令"
  echo "请确保 $INSTALL_DIR 在您的 PATH 中"
fi
