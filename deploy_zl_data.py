# -*- coding: utf-8 -*-
"""
部署 resource/zl-merged/ 目录到 Cloudflare Pages（books-data 项目）

使用 wrangler pages deploy 命令将数据目录部署为独立的 Cloudflare Pages 站点，
提供稳定的在线数据访问 URL。

依赖环境变量：
  - CLOUDFLARE_API_TOKEN: Cloudflare API Token
  - CLOUDFLARE_ACCOUNT_ID: Cloudflare Account ID

用法：
  python deploy_zl_data.py                       # 默认部署
  python deploy_zl_data.py --dry-run             # 预览模式（不实际部署）
  python deploy_zl_data.py --project my-data     # 指定项目名
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def check_wrangler():
    """检查 wrangler 是否已安装，返回可执行命令列表"""
    # 优先使用本地 npx，其次全局 wrangler
    try:
        subprocess.run(
            ['npx', 'wrangler', '--version'],
            capture_output=True, check=True, shell=True
        )
        return ['npx', 'wrangler']
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    try:
        subprocess.run(
            ['wrangler', '--version'],
            capture_output=True, check=True, shell=True
        )
        return ['wrangler']
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def deploy(deploy_dir, project_name, dry_run=False):
    """使用 wrangler pages deploy 部署目录

    返回 (success: bool, url: str)
    """
    wrangler_cmd = check_wrangler()
    if not wrangler_cmd:
        print("错误：未找到 wrangler，请先安装：npm install -g wrangler")
        return False, ''

    # 检查必需的环境变量
    api_token = os.environ.get('CLOUDFLARE_API_TOKEN')
    account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
    if not api_token or not account_id:
        print("错误：请设置环境变量 CLOUDFLARE_API_TOKEN 和 CLOUDFLARE_ACCOUNT_ID")
        return False, ''

    # 构建部署命令
    cmd = wrangler_cmd + [
        'pages', 'deploy',
        str(deploy_dir),
        '--project-name', project_name,
    ]

    if dry_run:
        print(f"[Dry Run] 将执行命令：{' '.join(cmd)}")
        print(f"[Dry Run] 部署目录：{deploy_dir}")
        print(f"[Dry Run] 项目名：{project_name}")
        return True, f'https://{project_name}.pages.dev'

    print(f"部署目录：{deploy_dir}")
    print(f"项目名：{project_name}")
    print(f"命令：{' '.join(cmd)}")
    print()

    env = os.environ.copy()
    env['CLOUDFLARE_API_TOKEN'] = api_token
    env['CLOUDFLARE_ACCOUNT_ID'] = account_id

    try:
        result = subprocess.run(
            cmd, env=env, capture_output=True, text=True, shell=True
        )
        print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)

        if result.returncode == 0:
            url = f'https://{project_name}.pages.dev'
            # 尝试从输出中提取实际部署 URL
            for line in result.stdout.splitlines():
                line_lower = line.lower()
                if 'https://' in line_lower and 'pages.dev' in line_lower:
                    # 提取 URL
                    import re
                    url_match = re.search(r'https://[^\s]+\.pages\.dev[^\s]*', line)
                    if url_match:
                        url = url_match.group(0)
                        break
            return True, url
        else:
            print(f"部署失败，退出码：{result.returncode}")
            return False, ''
    except Exception as e:
        print(f"部署异常：{e}")
        return False, ''


def main():
    parser = argparse.ArgumentParser(
        description='将 resource/zl-merged/ 目录部署到 Cloudflare Pages（books-data 项目）'
    )
    parser.add_argument(
        '--project', default='books-data',
        help='Cloudflare Pages 项目名（默认：books-data）'
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='预览模式，不实际部署'
    )
    parser.add_argument(
        '--dir', default=None,
        help='指定部署目录（默认：resource/zl-merged）'
    )
    args = parser.parse_args()

    # 确定源目录：相对于脚本所在路径，兼容 Windows
    script_dir = Path(__file__).parent.resolve()
    if args.dir:
        source_dir = Path(args.dir).resolve()
    else:
        source_dir = script_dir / 'resource' / 'zl-merged'

    if not source_dir.exists():
        print(f"错误：源目录不存在：{source_dir}")
        print("请先运行 python merge_zl_data.py 生成合并数据")
        return 1

    # 检查 _headers 文件
    headers_file = source_dir / '_headers'
    if not headers_file.exists():
        print(f"警告：{headers_file} 不存在，CORS headers 将不会生效")

    # 创建 zl-data/ 子目录结构的部署目录（与前端 DataManager CDN 路径一致）
    staging_dir = script_dir / 'deploy-staging'
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    zl_data_dir = staging_dir / 'zl-data'
    zl_data_dir.mkdir(parents=True)
    # 复制源目录内容到 zl-data/
    for item in source_dir.iterdir():
        dst = zl_data_dir / item.name
        if item.is_dir():
            shutil.copytree(item, dst)
        else:
            shutil.copy2(item, dst)
    # _headers 放在根目录（/* 通配符覆盖所有路径）
    if headers_file.exists():
        shutil.copy2(headers_file, staging_dir / '_headers')

    print("=" * 50)
    print(" Cloudflare Pages 数据部署工具")
    print("=" * 50)
    print(f"源目录：{source_dir}")
    print(f"部署目录：{staging_dir}（含 zl-data/ 子目录）")
    print()

    success, url = deploy(str(staging_dir), args.project, args.dry_run)

    if success:
        print()
        print(f"✓ 部署成功！")
        print(f"  访问 URL: {url}")
        return 0
    else:
        print()
        print("✗ 部署失败")
        return 1


if __name__ == '__main__':
    sys.exit(main())
