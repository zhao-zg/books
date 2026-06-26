# -*- coding: utf-8 -*-
"""
书报 - 电子书阅读应用构建工具

扫描 resource/books/ 目录，解析 EPUB/Markdown/TXT 格式电子书，
生成 JSON 数据文件和静态站点。
"""
import os
import sys
import json
import shutil
import base64
import yaml
from pathlib import Path

from src.epub_parser import parse_epub
from src.md_parser import parse_markdown
from src.txt_parser import parse_txt
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


def scan_books(resource_dir: str) -> list:
    """扫描书籍目录，返回文件列表。

    支持的文件格式：.epub, .md, .txt
    """
    books_dir = Path(resource_dir) / 'books'
    if not books_dir.exists():
        # 也尝试直接扫描 resource_dir
        books_dir = Path(resource_dir)
        if not books_dir.exists():
            return []

    supported_extensions = {'.epub', '.md', '.txt'}
    book_files = []
    for f in sorted(books_dir.rglob('*')):
        if f.suffix.lower() in supported_extensions and f.is_file():
            book_files.append(f)
    return book_files


def parse_book(file_path, output_dir='output'):
    """根据文件扩展名选择解析器"""
    ext = file_path.suffix.lower()
    try:
        if ext == '.epub':
            return parse_epub(file_path, output_dir)
        elif ext == '.md':
            return parse_markdown(file_path, output_dir)
        elif ext == '.txt':
            return parse_txt(file_path, output_dir)
        else:
            print(f"  ⚠ 不支持的格式: {ext}")
            return None
    except Exception as e:
        print(f"  ✗ 解析失败: {file_path.name} — {e}")
        import traceback
        traceback.print_exc()
        return None


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

    # 从 app_config.json 注入 zl_html_data_url（覆盖 config.yaml 中的同名配置）
    try:
        app_cfg = load_app_config()
        zl_url = app_cfg.get('zl_html_data_url')
        if zl_url:
            encoded['zl_html_data'] = base64.b64encode(
                zl_url.encode('utf-8')
            ).decode('utf-8')
    except Exception:
        pass  # app_config.json 加载失败时，沿用 config.yaml 中的值

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

    # 扫描并解析书籍
    book_files = scan_books(resource_dir)
    print(f"✓ 发现 {len(book_files)} 本电子书")
    print()

    books = []
    for file_path in book_files:
        print(f"解析: {file_path.name}")
        book = parse_book(file_path, output_dir)
        if book:
            books.append(book)
            print(f"  → {book.title} ({len(book.chapters)} 章)")

    print()

    # 生成静态站点
    generator = BooksGenerator(output_dir, config)
    generator.generate_all(books, app_config)

    # 生成 remote-config.js（base64 编码 URL）
    generate_remote_config(config, output_dir)

    print(f"\n{'=' * 60}")
    print(f" 构建完成! 共 {len(books)} 本书")
    print(f" 输出目录: {output_dir}/")
    print(f"{'=' * 60}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
