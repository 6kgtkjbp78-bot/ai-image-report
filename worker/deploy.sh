#!/bin/sh
# 一键部署 Worker（密钥从环境变量读取，不写入文件）
# 用法：DASHSCOPE_API_KEY=sk-xxx ./deploy.sh
set -e
cd "$(dirname "$0")"

if [ -z "$DASHSCOPE_API_KEY" ]; then
  echo "错误：请先设置环境变量 DASHSCOPE_API_KEY" >&2
  exit 1
fi

echo "-> 写入百炼 API Key 到 Worker Secrets"
printf '%s' "$DASHSCOPE_API_KEY" | ./node_modules/.bin/wrangler secret put DASHSCOPE_API_KEY

if [ -n "$LEAD_WEBHOOK" ]; then
  echo "-> 写入企业微信机器人 Webhook"
  printf '%s' "$LEAD_WEBHOOK" | ./node_modules/.bin/wrangler secret put LEAD_WEBHOOK
fi

echo "-> 部署 Worker"
./node_modules/.bin/wrangler deploy

echo "-> 健康检查"
./node_modules/.bin/wrangler deploy --dry-run >/dev/null 2>&1 || true
echo "完成。把输出的 https://xxx.workers.dev 填进 assets/js/config.js 的 API_BASE 后重新 push。"
