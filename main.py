# -*- coding: utf-8 -*-
"""
书报 - 电子书阅读应用构建工具

从 resource/ysz/ 转换书籍数据，生成静态站点和配置文件。
"""
import os
import sys
import json
import shutil
import base64
import subprocess
import yaml
from pathlib import Path

from src.generator import BooksGenerator


def load_config(config_path='config.yaml'):
    """加载配置文件"""
    with open(config_path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def load_app_config(config_path='app_config.json'):
    """加载应用配置"""
    if not os.path.exists(config_path):
        return {
            'name': '书报',
            'version': '1.0.0',
        }
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def copy_zl_merged_data(resource_dir: str, output_dir: str):
    """将 resource/zl-merged/ 中的索引文件复制到 output/zl-data/，供 APK/PWA 本地使用。

    仅复制 books-index.json 和 manifest.json（轻量索引），
    不复制单本书籍 JSON（体积大，通过 CDN 在线加载）。
    """
    merged_dir = os.path.join(resource_dir, 'zl-merged')
    if not os.path.isdir(merged_dir):
        print("⚠ resource/zl-merged/ 不存在，跳过索引数据复制")
        return

    dst_dir = os.path.join(output_dir, 'zl-data')
    os.makedirs(dst_dir, exist_ok=True)

    # 只复制索引文件（体积小，打包进 APK/PWA）
    # 单本书籍 JSON 不复制，通过 CDN 在线加载
    copied = []
    for fname in ['books-index.json', 'manifest.json']:
        src = os.path.join(merged_dir, fname)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(dst_dir, fname))
            copied.append(fname)

    # 统计
    index_path = os.path.join(dst_dir, 'books-index.json')
    book_count = 0
    series_count = 0
    if os.path.exists(index_path):
        try:
            with open(index_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            book_count = len(data.get('books', []))
            series_count = len(data.get('series', []))
        except Exception:
            pass

    print(f"✓ zl-merged 索引已复制到 output/zl-data/（{series_count} 个系列，{book_count} 本书）")
    print(f"  已复制文件: {', '.join(copied)}")


def generate_remote_config(config: dict, output_dir: str = 'output'):
    """根据 config.yaml 中的 remote_servers 生成 remote-config.js。

    将所有 URL 进行 base64 编码，运行时由前端 atob() 解码还原，
    配合 CI 中的 javascript-obfuscator 进行二次混淆。
    """
    remote_servers = config.get('remote_servers')
    if not remote_servers:
        print("⚠ config.yaml 中未找到 remote_servers 配置，跳过 remote-config.js 生成")
        return

    # 收集所有需要编码的 URL
    encoded = {}
    for key, value in remote_servers.items():
        if isinstance(value, list):
            encoded[key] = [base64.b64encode(url.encode('utf-8')).decode('utf-8') for url in value]
        elif isinstance(value, str):
            encoded[key] = base64.b64encode(value.encode('utf-8')).decode('utf-8')


    # 生成 JS 内容
    js_content = f"""\
/**
 * 远程服务器配置（自动生成，请勿手动修改）
 * 由 main.py generate_remote_config() 生成
 * URL 已 base64 编码，运行时通过 atob() 解码还原
 */
(function() {{
  var _c = {json.dumps(encoded, ensure_ascii=False)};

  function _d(v) {{
    return typeof v === 'string' ? atob(v) : v;
  }}

  var config = {{}};
  for (var k in _c) {{
    if (Array.isArray(_c[k])) {{
      config[k] = _c[k].map(_d);
    }} else {{
      config[k] = _d(_c[k]);
    }}
  }}

  window.REMOTE_CONFIG = config;
  window.BK_SERVERS = window.REMOTE_CONFIG;
}})();
"""

    js_dir = os.path.join(output_dir, 'js')
    os.makedirs(js_dir, exist_ok=True)
    js_path = os.path.join(js_dir, 'remote-config.js')
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)

    print("✓ js/remote-config.js 已生成（URL 已 base64 编码）")


def main():
    """主函数"""
    # 确保 stdout 使用 UTF-8
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    print("=" * 60)
    print(" 书报 - 电子书阅读应用构建工具")
    print("=" * 60)
    print()

    # 加载配置
    try:
        config = load_config()
        print("✓ 配置文件加载成功")
    except FileNotFoundError:
        print("⚠ config.yaml 未找到，使用默认配置")
        config = {
            'resource_dir': 'resource',
            'output_dir': 'output',
        }
    except Exception as e:
        print(f"✗ 配置文件加载失败: {e}")
        return 1

    try:
        app_config = load_app_config()
    except Exception as e:
        print(f"⚠ 应用配置加载失败: {e}")
        app_config = {'name': '书报', 'version': '1.0.0'}

    resource_dir = config.get('resource_dir', 'resource')
    output_dir = config.get('output_dir', 'output')

    # 清理并创建输出目录
    if os.path.exists(output_dir):
        import time as _time
        for _retry in range(3):
            try:
                shutil.rmtree(output_dir)
                break
            except PermissionError:
                if _retry < 2:
                    _time.sleep(0.5)
                else:
                    # 最后一次尝试：仅清空内容而不删除目录本身
                    for item in os.listdir(output_dir):
                        p = os.path.join(output_dir, item)
                        if os.path.isdir(p):
                            shutil.rmtree(p, ignore_errors=True)
                        else:
                            try: os.remove(p)
                            except: pass
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # ── 数据准备：ysz → zl-ysz → zl-merged ──────────────────────
    print("── 数据准备 ──")

    # 增量检查：如果 zl-merged 已是最新则跳过数据准备
    _merged_manifest = os.path.join(resource_dir, 'zl-merged', 'manifest.json')
    _ysz_dir = os.path.join(resource_dir, 'ysz')
    _need_data_prep = True
    if os.path.exists(_merged_manifest):
        try:
            _manifest_mtime = os.path.getmtime(_merged_manifest)
            # 检查 ysz 目录中是否有比 manifest 更新的文件
            _ysz_latest = 0
            if os.path.isdir(_ysz_dir):
                for _f in os.listdir(_ysz_dir):
                    _fp = os.path.join(_ysz_dir, _f)
                    if os.path.isfile(_fp):
                        _mt = os.path.getmtime(_fp)
                        if _mt > _ysz_latest:
                            _ysz_latest = _mt
            if _ysz_latest <= _manifest_mtime:
                _need_data_prep = False
                print("✓ zl-merged 数据已是最新，跳过数据准备")
        except Exception:
            pass  # 检查失败则正常执行数据准备

    if _need_data_prep:
        # Step 0a: 执行 process_ysz_books.py（ysz → zl-ysz）
        try:
            print("▶ 处理 YSZ 数据 (ysz → zl-ysz) ...")
            result = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'process_ysz_books.py')],
                capture_output=True, text=True, timeout=600
            )
            if result.returncode == 0:
                print("✓ YSZ 数据处理完成")
                if result.stdout:
                    lines = result.stdout.strip().splitlines()
                    for line in lines[-5:]:
                        print(f"  {line}")
            else:
                print(f"⚠ YSZ 数据处理警告 (exit={result.returncode})")
                if result.stderr:
                    print(f"  {result.stderr[:200]}")
        except Exception as e:
            print(f"⚠ YSZ 数据处理异常: {e}")

        # Step 0b: 执行 merge_zl_data.py（zl-ysz → zl-merged）
        try:
            print("▶ 合并数据 (zl-ysz → zl-merged) ...")
            result = subprocess.run(
                [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'merge_zl_data.py'), '--force'],
                capture_output=True, text=True, timeout=300
            )
            if result.returncode == 0:
                print("✓ 数据合并完成")
            else:
                print(f"⚠ 数据合并警告 (exit={result.returncode})")
                if result.stderr:
                    print(f"  {result.stderr[:200]}")
        except Exception as e:
            print(f"⚠ 数据合并异常: {e}")

    print()

    # 生成静态站点
    generator = BooksGenerator(output_dir, config)
    generator.generate_all(app_config)

    # 生成 remote-config.js（base64 编码 URL）
    generate_remote_config(config, output_dir)

    # 复制 changelog.json 到 output/（供前端 fetchChangelog 使用）
    changelog_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'changelog.json')
    if os.path.exists(changelog_src):
        shutil.copy2(changelog_src, os.path.join(output_dir, 'changelog.json'))
        print("✓ changelog.json 已复制到 output/")
    else:
        print("⚠ changelog.json 未找到，跳过复制")

    # 复制 zl-merged 合并数据到 output/zl-data/（供本地测试使用）
    copy_zl_merged_data(resource_dir, output_dir)

    print(f"\n{'=' * 60}")
    print(f" 构建完成!")
    print(f" 输出目录: {output_dir}/")
    print(f"{'=' * 60}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
