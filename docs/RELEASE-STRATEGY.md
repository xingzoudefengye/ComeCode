# ComeCode 发布方案

## 📦 发布方式

### 方式 1: npm 包发布（推荐）

用户可以通过 npm 全局安装：

```bash
npm install -g comecode
# 或
pnpm add -g comecode
```

### 方式 2: GitHub Release 下载

用户可以从 GitHub Release 下载预编译的二进制文件：

```bash
# Linux/macOS
curl -fsSL https://github.com/xingzoudefengye/ComeCode/releases/latest/download/comecode-linux-x64.tar.gz | tar xz
sudo mv comecode /usr/local/bin/

# Windows
# 从 Release 页面下载 comecode-windows-x64.zip
```

---

## 🔧 实施步骤

### 第一步：准备 npm 包

#### 1. 创建独立的 npm 包配置

在 `engine/apps/zcode-cli` 创建发布用的 `package.json`:

```json
{
  "name": "comecode",
  "version": "0.1.0",
  "description": "ComeCode - 不绑定厂商的开源 Coding Agent",
  "bin": {
    "comecode": "./dist/zcode.cjs"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "keywords": ["ai", "coding", "agent", "cli", "assistant"],
  "repository": {
    "type": "git",
    "url": "https://github.com/xingzoudefengye/ComeCode.git"
  },
  "license": "Apache-2.0",
  "author": "ComeCode Contributors",
  "files": [
    "dist/",
    "packages/cli/dist/",
    "LICENSE",
    "README.md"
  ]
}
```

#### 2. 修改构建脚本

需要将 `zcode.cjs` 重命名为 `comecode.cjs`，并调整所有引用。

---

### 第二步：GitHub Actions 自动发布

#### 1. 创建 Release 工作流

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*.*.*'

permissions:
  contents: write

jobs:
  build:
    name: Build for ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-24.04, windows-2022, macos-14]
        include:
          - os: ubuntu-24.04
            target: linux-x64
          - os: windows-2022
            target: windows-x64
          - os: macos-14
            target: darwin-arm64
    runs-on: ${{ matrix.os }}
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v4
        with:
          version: 10.33.2
          
      - uses: actions/setup-node@v4
        with:
          node-version: 24.14.0
          
      - name: Install dependencies
        working-directory: engine
        run: pnpm install --frozen-lockfile
        
      - name: Build CLI
        working-directory: engine
        run: pnpm build:sea
        
      - name: Package
        run: node scripts/package-comecode-cli.mjs
        
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: comecode-${{ matrix.target }}
          path: artifacts/comecode/*
          
  release:
    name: Create Release
    needs: build
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts
          
      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          files: artifacts/**/*
          draft: false
          prerelease: false
          generate_release_notes: true
```

#### 2. 创建 npm 发布工作流

`.github/workflows/npm-publish.yml`:

```yaml
name: Publish to npm

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v4
        with:
          version: 10.33.2
          
      - uses: actions/setup-node@v4
        with:
          node-version: 24.14.0
          registry-url: 'https://registry.npmjs.org'
          
      - name: Install dependencies
        working-directory: engine
        run: pnpm install --frozen-lockfile
        
      - name: Build
        working-directory: engine
        run: pnpm --filter @zcode/cli build
        
      - name: Publish to npm
        working-directory: engine/apps/zcode-cli
        run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

### 第三步：发布流程

#### 1. 创建 Release

```bash
# 1. 确保在 main 分支
git checkout main
git pull origin main

# 2. 更新版本号
cd engine/apps/zcode-cli
npm version 0.1.0

# 3. 提交并打标签
git add .
git commit -m "chore: release v0.1.0"
git tag v0.1.0
git push origin main --tags
```

#### 2. GitHub Actions 自动执行

- ✅ 在 Linux/Windows/macOS 上构建
- ✅ 创建 GitHub Release
- ✅ 上传预编译二进制文件
- ✅ 发布到 npm

#### 3. 用户安装

```bash
# 方式 1: npm 安装（推荐）
npm install -g comecode

# 方式 2: 下载二进制
# 从 https://github.com/xingzoudefengye/ComeCode/releases
```

---

## 📋 TODO 清单

### 必须完成

- [ ] 修改 CLI 包名从 `zcode-cli` 到 `comecode`
- [ ] 修改二进制名从 `zcode.cjs` 到 `comecode.cjs`
- [ ] 创建 `.github/workflows/release.yml`
- [ ] 创建 `.github/workflows/npm-publish.yml`
- [ ] 在 npmjs.com 注册 `comecode` 包名
- [ ] 配置 GitHub Secrets: `NPM_TOKEN`

### 建议完成

- [ ] 添加安装脚本 `install.sh` / `install.ps1`
- [ ] 创建 Homebrew formula（macOS）
- [ ] 创建 Scoop manifest（Windows）
- [ ] 添加自动更新检查功能

---

## 🎯 最终用户体验

### npm 安装（最简单）

```bash
npm install -g comecode
comecode --version
comecode
```

### 二进制下载

```bash
# Linux
wget https://github.com/xingzoudefengye/ComeCode/releases/latest/download/comecode-linux-x64.tar.gz
tar xzf comecode-linux-x64.tar.gz
sudo mv comecode /usr/local/bin/

# macOS
curl -fsSL https://github.com/xingzoudefengye/ComeCode/releases/latest/download/comecode-darwin-arm64.tar.gz | tar xz
sudo mv comecode /usr/local/bin/

# Windows
# 下载 comecode-windows-x64.zip
# 解压并添加到 PATH
```

### 一键安装脚本

```bash
# Linux/macOS
curl -fsSL https://raw.githubusercontent.com/xingzoudefengye/ComeCode/main/install.sh | bash

# Windows
iwr https://raw.githubusercontent.com/xingzoudefengye/ComeCode/main/install.ps1 | iex
```

---

## 📊 对比

| 方式 | 优点 | 缺点 |
|------|------|------|
| npm 全局安装 | 简单、支持更新、跨平台 | 需要 Node.js |
| GitHub Release | 独立二进制、无需 Node.js | 手动更新、文件大 |
| 安装脚本 | 自动化、用户体验好 | 需维护脚本 |

**推荐**: npm 发布为主，GitHub Release 为辅

---

## ⚠️ 注意事项

1. **包名冲突**: 先在 npm 检查 `comecode` 是否可用
2. **版本号**: 遵循 Semantic Versioning（0.1.0 开始）
3. **License**: 确保 npm 包包含 LICENSE 文件
4. **README**: npm 页面会显示 README.md
5. **测试**: 发布前在本地 `npm pack` 测试

---

**下一步**: 完成 TODO 清单后即可发布
