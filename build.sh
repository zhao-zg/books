#!/bin/bash
# Cloudflare Pages 构建脚本

set -e  # 遇到错误立即退出

echo "🚀 开始构建..."

# 注意：Cloudflare Pages 构建环境没有 sudo 权限
# 无法安装 LibreOffice，请确保所有文档都是 .docx 格式

# 1. 安装 Python 依赖
echo "📦 安装 Python 依赖..."
pip install -r requirements.txt

# 2. 生成静态文件
echo "🔨 生成静态文件..."
python main.py

echo "✅ 构建完成！"
