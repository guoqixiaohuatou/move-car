#!/usr/bin/env bash
# ============================================================
#  挪车小程序 — 云函数一键部署脚本（微信开发者工具 CLI）
# ============================================================
# 前置条件（一次性）：
#   1. 安装并打开过「微信开发者工具」，且本项目已用 appid wxYOUR_APPID_0000 打开过
#   2. 开发者工具 → 设置 → 安全设置 → 开启「服务端口」
#   3. 已在本小程序「开发 → 云开发」里新建好环境，拿到 envId
#
# 用法：
#   ./deploy.sh <envId>
#   例：./deploy.sh cloud1-xxxxxxxx
#
# 说明：
#   本脚本只负责「上传云函数 + 云端安装依赖」。以下 3 步仍需在控制台手动做
#   （微信要求扫码登录，无法脚本化）：
#     - 设云函数环境变量（云开发控制台 → 云函数 car → 配置 → 环境变量）
#         新增 MP_APPID=wxYOUR_APPID_0000 与 MP_APPSECRET（公众平台→开发→开发设置 获取）
#         本项目已弃用 cloud.openapi，改用 AppID+AppSecret 直连微信 HTTP 接口，
#         因此这两个变量是「微信通知/小程序码」能工作的前提。
#     - 选订阅消息模板（公众平台 → 功能 → 订阅消息 → 公共模板库）
#   触发器已写入 cloudfunctions/car/config.json 的 triggers 字段，部署时自动创建；
#   若控制台没自动出现 timer: 0 0 3 * * * *，请手动加一条。
# ============================================================
set -e

PROJECT="${PROJECT:-C:/Users/Administrator/WorkBuddy/2026-09-02-16-41-14/move-car}"
ENV_ID="${1:?用法: ./deploy.sh <envId>}"

# 优先用环境变量指定的 CLI，否则自动探测常见安装路径
if [ -n "$DEVTOOLS_CLI" ]; then
  CLI="$DEVTOOLS_CLI"
else
  for p in \
    "/c/Program Files (x86)/Tencent/微信web开发者工具/cli.bat" \
    "/c/Program Files/Tencent/微信web开发者工具/cli.bat" \
    "/d/Program Files (x86)/Tencent/微信web开发者工具/cli.bat" \
    "/e/Program Files (x86)/Tencent/微信web开发者工具/cli.bat" ; do
    if [ -f "$p" ]; then CLI="$p"; break; fi
  done
fi

if [ -z "$CLI" ]; then
  echo "❌ 找不到微信开发者工具 cli.bat"
  echo "   请设置环境变量 DEVTOOLS_CLI 指向 cli.bat，例如："
  echo '   export DEVTOOLS_CLI="/c/Program Files (x86)/Tencent/微信web开发者工具/cli.bat"'
  exit 1
fi

echo "▶ 使用 CLI: $CLI"
echo "▶ 项目目录: $PROJECT"
echo "▶ 目标环境: $ENV_ID"

# CLI 访问令牌（新版开发者工具开启「服务端口」后生成，在 设置→安全设置 复制）
# 用法：WECHAT_DEVTOOLS_CLI_TOKEN="粘贴的token" ./deploy.sh <envId>
TOKEN="${WECHAT_DEVTOOLS_CLI_TOKEN:-}"
CLI_ARGS=(cloud functions deploy --env "$ENV_ID" -r --names car --project "$PROJECT")
if [ -n "$TOKEN" ]; then
  CLI_ARGS+=(--token "$TOKEN")
  echo "▶ 已携带 CLI 访问令牌"
else
  echo "⚠ 未提供 CLI 访问令牌。若开发者工具开启了令牌校验，会报 access token validation 错误。"
fi

echo "▶ 部署云函数 car（云端安装依赖）..."
# 注意：cli.bat 即使失败也常返回 0 退出码，因此改为「捕获输出 + 关键词判断」
OUT=$("$CLI" "${CLI_ARGS[@]}" 2>&1)
echo "$OUT"
if echo "$OUT" | grep -qiE 'error|×|失败|fail|invalid'; then
  echo ""
  echo "❌ 部署失败（CLI 输出含错误信息）。常见原因："
  echo "   1) CLI 访问令牌不正确/不完整 → 在 设置→安全设置 点「复制」拿完整令牌"
  echo "   2) 微信开发者工具未打开 / 项目未加载 / 服务端口未开启"
  echo "   3) 目标环境 ID 不正确"
  exit 1
fi
echo ""
echo "✅ 部署完成。"
echo "   下一步（手动，控制台操作）："
echo "   1) 云函数 car → 配置 → 环境变量，设 MP_APPID=wxYOUR_APPID_0000 与 MP_APPSECRET"
echo "      （AppSecret 在 公众平台 → 开发 → 开发管理 → 开发设置 获取，需管理员扫码）"
echo "   2) 微信公众平台 → 功能 → 订阅消息 → 公共模板库，选一个「挪车」模板"
echo "   3) 云函数 car → 触发器，确认有 timer: 0 0 3 * * * *（没有就手动加）"
echo "   4) 云端测试跑 {} 做健康自检，期望 allPass: true（订阅消息模板项应变绿）"
