#!/usr/bin/env bash
# ------------------------------------------------------------
# 推送本项目到 GitHub（首次推送需要 Personal Access Token）
#
# 用法（在项目根目录或任意位置执行均可）：
#   bash scripts/push-github.sh
#
# Token 获取：https://github.com/settings/tokens
#   → Generate new token (classic) → 勾选 repo → 生成后复制
#
# 说明：
#   - Token 只在本次进程内使用，不会写入 .git/config 明文
#   - 已处理 Windows 下 schannel 证书吊销检查失败的问题
# ------------------------------------------------------------
set -euo pipefail

REPO_OWNER="guoqixiaohuatou"
REPO_NAME="move-car"
BRANCH="main"

# 定位到项目根目录（脚本位于 scripts/ 下）
cd "$(dirname "$0")/.."

# Windows / 内网常见的 schannel 证书吊销检查失败，这里绕过
export GIT_SSL_NO_VERIFY=1
export GIT_TERMINAL_PROMPT=0

echo "=============================================="
echo " 推送 $REPO_OWNER/$REPO_NAME (分支 $BRANCH)"
echo "=============================================="
echo ""

# 确保 origin 指向正确地址（不含 token）
CLEAN_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$CLEAN_URL"
else
  git remote add origin "$CLEAN_URL"
fi

# 检查是否有待提交内容
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  工作区有未提交的改动："
  git status --short
  echo ""
  read -r -p "是否先提交这些改动？(y/N) " DO_COMMIT
  if [ "$DO_COMMIT" = "y" ] || [ "$DO_COMMIT" = "Y" ]; then
    read -r -p "提交说明: " MSG
    git add -A
    git commit -m "${MSG:-update}"
    echo "✓ 已提交"
  else
    echo "跳过提交，直接推送已有 commit"
  fi
fi

echo ""
echo "请输入 GitHub Personal Access Token（输入内容不显示）"
echo "没有的话到 https://github.com/settings/tokens 生成，勾选 repo 权限"
read -r -s -p "Token: " TOKEN
echo ""

if [ -z "$TOKEN" ]; then
  echo "✗ 未输入 token，已取消"
  exit 1
fi

echo ""
echo "正在推送..."

# 用带 token 的地址推送，避免交互式弹窗
if git push -u "https://${REPO_OWNER}:${TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git" "$BRANCH"; then
  echo ""
  echo "✓ 推送成功！"
  echo "  仓库地址: https://github.com/${REPO_OWNER}/${REPO_NAME}"
else
  echo ""
  echo "✗ 推送失败，常见原因："
  echo "  1. Token 无效或过期       → 重新生成，注意勾选 repo 权限"
  echo "  2. Token 输错/多了空格     → 复制时留意首尾"
  echo "  3. GitHub 上仓库不是空的   → 若初始化了 README，先执行："
  echo "       git pull origin $BRANCH --allow-unrelated-histories"
  echo "  4. 网络不通               → 检查代理 / 重试"
  exit 1
fi
