#!/bin/zsh
cd -- "$(dirname -- "$0")"
NODE="$PWD/.local-runtime/node_modules/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"
[[ -n "$NODE" ]] || { echo "请先安装 Node.js 24 或更新版本"; read "?按回车退出"; exit 1; }
URL=$("$NODE" local-preview.cjs start) || { read "?启动失败，按回车退出"; exit 1; }
open "$URL"
echo "中文文档已打开：$URL"
