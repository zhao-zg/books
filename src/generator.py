# -*- coding: utf-8 -*-
"""
静态站点生成器

生成全局索引、静态资源、PWA 文件等。
"""
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path


class BooksGenerator:
    """电子书静态站点生成器"""

    def __init__(self, output_dir: str, config: dict):
        """
        Args:
            output_dir: 输出目录路径
            config: 配置字典（来自 config.yaml）
        """
        self.output_dir = output_dir
        self.config = config
        os.makedirs(output_dir, exist_ok=True)

    # ------------------------------------------------------------------
    # 静态资源
    # ------------------------------------------------------------------

    def copy_static_assets(self):
        """复制静态资源到 output/"""
        static_dir = os.path.join(os.path.dirname(__file__), 'static')
        if not os.path.isdir(static_dir):
            print("⚠ src/static/ 目录不存在，跳过静态资源复制")
            return

        # 复制整个 static 目录下的子目录和文件
        for item in os.listdir(static_dir):
            src_path = os.path.join(static_dir, item)
            dst_path = os.path.join(self.output_dir, item)

            if os.path.isdir(src_path):
                # 复制目录（js/, css/, icons/, data/, vendor/ 等）
                if os.path.exists(dst_path):
                    shutil.rmtree(dst_path)
                shutil.copytree(src_path, dst_path)
            else:
                # 复制文件（index.html 等）
                shutil.copy2(src_path, dst_path)

        print("✓ 静态资源已复制到 output/")

    def generate_manifest_and_sw(self):
        """生成 PWA manifest.json 和 sw.js（从 templates 目录复制）"""
        template_dir = os.path.join(os.path.dirname(__file__), 'templates')
        if not os.path.isdir(template_dir):
            return

        # manifest.json
        manifest_src = os.path.join(template_dir, 'main_manifest.json')
        if os.path.exists(manifest_src):
            shutil.copy2(manifest_src, os.path.join(self.output_dir, 'manifest.json'))
            print("✓ manifest.json 已生成")

        # sw.js - 注入构建版本号，使 CACHE_NAME 每次都变化，确保 SW 能正确更新缓存
        sw_src = os.path.join(template_dir, 'main_sw.js')
        if os.path.exists(sw_src):
            with open(sw_src, 'r', encoding='utf-8') as f:
                sw_content = f.read()
            build_version = datetime.now().strftime('%Y%m%d%H%M%S')
            sw_content = sw_content.replace('__BUILD_VERSION__', build_version)
            sw_dst = os.path.join(self.output_dir, 'sw.js')
            with open(sw_dst, 'w', encoding='utf-8') as f:
                f.write(sw_content)
            print(f"✓ sw.js 已生成 (版本: {build_version})")

        # _redirects（Cloudflare Pages）
        redirects_src = os.path.join(template_dir, '_redirects')
        if os.path.exists(redirects_src):
            shutil.copy2(redirects_src, os.path.join(self.output_dir, '_redirects'))
            print("✓ _redirects 已复制")

        # _headers
        headers_src = os.path.join(template_dir, '_headers')
        if os.path.exists(headers_src):
            shutil.copy2(headers_src, os.path.join(self.output_dir, '_headers'))

    def generate_version_json(self, app_config: dict):
        """生成 version.json（从 app_config.json 读取版本信息）"""
        version_data = {
            'version': app_config.get('version', '1.0.0'),
            'build_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'app_name': app_config.get('name', '书报'),
        }

        # 合并其他版本相关字段
        for key in ('min_android_version', 'update_url', 'changelog'):
            if key in app_config:
                version_data[key] = app_config[key]

        json_path = os.path.join(self.output_dir, 'version.json')
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(version_data, f, ensure_ascii=False, indent=2)

        print(f"✓ version.json 已生成 (v{version_data['version']})")

    # ------------------------------------------------------------------
    # CSS 样式
    # ------------------------------------------------------------------

    def generate_css(self):
        """从独立 CSS 文件生成 style.css"""
        css_src = os.path.join(os.path.dirname(__file__), 'static', 'css', 'style.css')
        css_dir = os.path.join(self.output_dir, 'css')
        os.makedirs(css_dir, exist_ok=True)
        css_path = os.path.join(css_dir, 'style.css')
        with open(css_src, 'r', encoding='utf-8') as f:
            css_content = f.read()
        with open(css_path, 'w', encoding='utf-8') as f:
            f.write(css_content)
        print(f"  style.css ({len(css_content)} bytes)")

    # ------------------------------------------------------------------
    # 搜索索引
    # ------------------------------------------------------------------

    def generate_search_index(self):
        """生成搜索索引文件 output/books/search-index.json

        遍历 resource/zl-merged/ 下所有系列和书籍，提取书名、章节标题和内容摘要，
        生成精简的搜索索引供前端使用。
        """
        # resource 目录相对于 src/generator.py 的位置
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        resource_dir = os.path.join(project_root, 'resource', 'zl-merged')

        if not os.path.isdir(resource_dir):
            print(f"⚠ resource 目录不存在: {resource_dir}，跳过搜索索引生成")
            return

        # 读取全局索引获取系列列表
        global_index_path = os.path.join(resource_dir, 'books-index.json')
        if not os.path.isfile(global_index_path):
            print("⚠ books-index.json 不存在，跳过搜索索引生成")
            return

        with open(global_index_path, 'r', encoding='utf-8') as f:
            global_index = json.load(f)

        series_list = global_index.get('series', [])

        # 构建 series id → title 映射
        series_title_map = {}
        for s in series_list:
            series_title_map[s['id']] = s.get('title', s['id'])

        books_output = []
        html_tag_re = re.compile(r'<[^>]+>')
        book_count = 0
        chapter_count = 0

        for series_info in series_list:
            series_id = series_info['id']
            series_dir = os.path.join(resource_dir, series_id)

            if not os.path.isdir(series_dir):
                continue

            # 读取系列索引
            series_index_path = os.path.join(series_dir, 'index.json')
            if not os.path.isfile(series_index_path):
                continue

            with open(series_index_path, 'r', encoding='utf-8') as f:
                series_books = json.load(f)

            if not isinstance(series_books, list):
                continue

            for book_info in series_books:
                book_id = book_info.get('id', '')
                book_title = book_info.get('title', '')

                # 读取书籍 JSON
                book_path = os.path.join(series_dir, book_id + '.json')
                if not os.path.isfile(book_path):
                    continue

                try:
                    with open(book_path, 'r', encoding='utf-8') as f:
                        book_data = json.load(f)
                except (json.JSONDecodeError, IOError):
                    print(f"  ⚠ 无法解析书籍文件: {book_path}")
                    continue

                chapters = book_data.get('chapters', [])
                chapters_output = []

                for ch in chapters:
                    ch_number = ch.get('number', 0)
                    ch_title = ch.get('title', '')
                    content = ch.get('content', '')

                    # 处理 content：可以是字符串或数组
                    if isinstance(content, list):
                        # 数组格式：[{type: "paragraph", text: "..."}]
                        text_parts = []
                        for item in content:
                            if isinstance(item, dict):
                                text_parts.append(item.get('text', ''))
                            elif isinstance(item, str):
                                text_parts.append(item)
                        content_text = ' '.join(text_parts)
                    else:
                        content_text = str(content) if content else ''

                    # 去除 HTML 标签
                    content_text = html_tag_re.sub('', content_text)

                    # 提取前 150 个字符作为摘要
                    summary = content_text[:150].strip()
                    if len(content_text) > 150:
                        summary = summary + '…'

                    chapters_output.append({
                        'n': ch_number,
                        't': ch_title,
                        's': summary,
                    })

                books_output.append({
                    'id': book_id,
                    'title': book_title,
                    'series': series_id,
                    'chapters': chapters_output,
                })

                book_count += 1
                chapter_count += len(chapters_output)

        # 输出到 output/books/search-index.json
        books_dir = os.path.join(self.output_dir, 'books')
        os.makedirs(books_dir, exist_ok=True)

        search_index = {
            'version': 1,
            'generated_at': datetime.now().isoformat(),
            'books': books_output,
        }

        output_path = os.path.join(books_dir, 'search-index.json')
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(search_index, f, ensure_ascii=False, separators=(',', ':'))

        file_size = os.path.getsize(output_path)
        print(f"✓ search-index.json 已生成 ({book_count} 本书, {chapter_count} 个章节, {file_size // 1024} KB)")

    # ------------------------------------------------------------------
    # 完整生成流程
    # ------------------------------------------------------------------

    def generate_all(self, app_config: dict = None):
        """完整生成流程：静态资源 → 搜索索引 → PWA → version"""

        # 1. 静态资源（先复制，避免后续生成的文件被覆盖）
        self.copy_static_assets()

        # 2. 搜索索引（在静态资源复制之后生成，避免被覆盖）
        self.generate_search_index()

        # 3. 生成完整 CSS
        self.generate_css()

        # 4. PWA manifest 和 Service Worker
        self.generate_manifest_and_sw()

        # 5. version.json
        if app_config:
            self.generate_version_json(app_config)

        # 6. 复制 app_config.json 到 output/（供前端 loadConfig 回退路径使用）
        app_config_src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'app_config.json')
        if os.path.exists(app_config_src):
            shutil.copy2(app_config_src, os.path.join(self.output_dir, 'app_config.json'))
            print("✓ app_config.json 已复制到 output/")
        else:
            print("⚠ app_config.json 未找到，跳过复制")

        # 7. .nojekyll（GitHub Pages 兼容）
        nojekyll_path = os.path.join(self.output_dir, '.nojekyll')
        with open(nojekyll_path, 'w') as f:
            f.write('')
