#!/bin/bash
# remote-computer-control / start.sh
# 初始化运行环境：确保 Go 依赖就绪

set -euo pipefail

# Go 环境路径（按优先级查找）
GO_PATHS=(
  "/home/caifeng.nice/.gvm/gos/go1.19/bin"
  "/usr/local/go/bin"
  "$HOME/go/bin"
)

for gp in "${GO_PATHS[@]}"; do
  if [ -d "$gp" ]; then
    export PATH="$gp:$PATH"
    break
  fi
done

# 验证 Go 可用
if ! command -v go &>/dev/null; then
  echo "❌ Go 未找到，请确认 Go 环境已安装"
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "$0")"; pwd)
echo "📁 SCRIPT_DIR: $SCRIPT_DIR"
echo "🔧 Go version: $(go version)"

cd "$SCRIPT_DIR"

echo "📦 安装 Go 依赖..."
go mod tidy

echo "✅ 环境初始化完成"
