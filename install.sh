#!/bin/bash
# ComeCode 一键安装脚本 (Linux / macOS)
# 产物结构: comecode-<version>-<target>/ 内含 comecode.cjs 与运行资源，需要已安装 Node.js 24+。

set -e

REPO="xingzoudefengye/ComeCode"
INSTALL_ROOT="${COMECODE_HOME:-$HOME/.comecode}"
NODE_MIN_MAJOR=24

echo "🚀 正在安装 ComeCode..."

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)
    case "$ARCH" in
      x86_64) TARGET="linux-x64" ;;
      aarch64|arm64) TARGET="linux-arm64" ;;
      *) echo "❌ 不支持的架构: $ARCH"; exit 1 ;;
    esac
    ;;
  Darwin*)
    case "$ARCH" in
      arm64) TARGET="darwin-arm64" ;;
      x86_64) TARGET="darwin-x64" ;;
      *) echo "❌ 不支持的架构: $ARCH"; exit 1 ;;
    esac
    ;;
  *)
    echo "❌ 不支持的操作系统: $OS（Windows 请使用 install.ps1）"
    exit 1
    ;;
esac

if ! command -v node > /dev/null 2>&1; then
  echo "❌ 未找到 Node.js。ComeCode 需要 Node.js ${NODE_MIN_MAJOR} 或更高版本。"
  echo "   请先安装 Node.js，例如: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
  echo "❌ 当前 Node.js 版本为 $(node -v)，ComeCode 需要 Node.js ${NODE_MIN_MAJOR}.14.0 或更高版本。"
  exit 1
fi

echo "📦 获取最新版本..."
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" || {
  echo "❌ 无法访问 GitHub Releases API，请检查网络后重试。"
  exit 1
}

LATEST_VERSION="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$LATEST_VERSION" ]; then
  echo "❌ 仓库还没有可用的 Release，暂时无法自动安装。"
  echo "   可改用 npm 安装（发布后）: npm install -g comecode"
  exit 1
fi

VERSION_NUM="${LATEST_VERSION#v}"
ASSET_NAME="comecode-${VERSION_NUM}-${TARGET}.tar.gz"
echo "✅ 最新版本: $LATEST_VERSION (${TARGET})"

if ! printf '%s' "$RELEASE_JSON" | grep -q "\"$ASSET_NAME\""; then
  echo "❌ 该版本没有为 $TARGET 提供安装包。"
  if [ "$TARGET" = "darwin-x64" ]; then
    echo "   当前仅发布 macOS Apple Silicon (darwin-arm64) 构建，Intel Mac 暂不支持。"
  fi
  echo "   可尝试: npm install -g comecode，或从源码构建。"
  exit 1
fi

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_VERSION/$ASSET_NAME"
CHECKSUM_URL="${DOWNLOAD_URL}.sha256"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "⬇️  下载 ComeCode $VERSION_NUM..."
curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_DIR/$ASSET_NAME"

if curl -fsSL "$CHECKSUM_URL" -o "$TEMP_DIR/$ASSET_NAME.sha256" 2>/dev/null; then
  EXPECTED="$(awk '{print $1}' "$TEMP_DIR/$ASSET_NAME.sha256" | head -n 1)"
  if command -v sha256sum > /dev/null 2>&1; then
    ACTUAL="$(sha256sum "$TEMP_DIR/$ASSET_NAME" | awk '{print $1}')"
  else
    ACTUAL="$(shasum -a 256 "$TEMP_DIR/$ASSET_NAME" | awk '{print $1}')"
  fi
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "❌ 校验失败，下载文件可能已损坏。"
    exit 1
  fi
  echo "🔒 校验通过"
fi

echo "📦 解压文件..."
tar xzf "$TEMP_DIR/$ASSET_NAME" -C "$TEMP_DIR"

PACKAGE_DIR="$TEMP_DIR/comecode-${VERSION_NUM}-${TARGET}"
if [ ! -f "$PACKAGE_DIR/comecode.cjs" ]; then
  echo "❌ 安装包结构异常，未找到 comecode.cjs。"
  exit 1
fi

TARGET_DIR="$INSTALL_ROOT/cli/$VERSION_NUM"
rm -rf "$TARGET_DIR"
mkdir -p "$(dirname "$TARGET_DIR")"
mv "$PACKAGE_DIR" "$TARGET_DIR"

if [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"

LAUNCHER="$BIN_DIR/comecode"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec node "$TARGET_DIR/comecode.cjs" "\$@"
EOF
chmod +x "$LAUNCHER"

echo ""
echo "✅ ComeCode $VERSION_NUM 安装成功！"
echo ""
echo "运行以下命令开始使用："
echo "  comecode --version"
echo "  comecode config setup"
echo "  comecode"
echo ""

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "⚠️  $BIN_DIR 不在 PATH 中，请把下面一行加入 shell 配置（如 ~/.zshrc）后重开终端："
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
