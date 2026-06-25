# -*- coding: utf-8 -*-
"""
静态站点生成器

将解析后的 Book 对象序列化为 JSON，并生成全局索引、搜索索引和静态资源。
"""
import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import List

from .models import Book


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
    # JSON 生成
    # ------------------------------------------------------------------

    def generate_book_json(self, book: Book):
        """生成单本书的 book.json。

        保存到 output/{book.id}/book.json
        """
        book_dir = os.path.join(self.output_dir, book.id)
        os.makedirs(book_dir, exist_ok=True)

        data = book.to_dict()
        data['version'] = datetime.now().strftime('%Y%m%d%H%M%S')

        json_path = os.path.join(book_dir, 'book.json')
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        print(f"  ✓ {book.id}/book.json 已生成 ({len(book.chapters)} 章)")

    def generate_books_json(self, books: List[Book]):
        """生成全局索引 books.json。

        包含所有书的摘要信息，保存到 output/books.json
        """
        entries = [book.summary_dict() for book in books]
        # 按 date_added 倒序（新加的在前）
        entries.sort(key=lambda b: b.get('date_added', ''), reverse=True)

        data = {
            'version': datetime.now().strftime('%Y%m%d%H%M%S'),
            'count': len(entries),
            'books': entries,
        }

        json_path = os.path.join(self.output_dir, 'books.json')
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        print(f"✓ books.json 已生成 ({len(entries)} 本书)")

    def generate_search_index(self, books: List[Book]):
        """生成搜索索引 search-index.json。

        遍历所有书的章节内容，创建可搜索条目。
        保存到 output/data/search-index.json
        """
        entries = []
        for book in books:
            for chapter in book.chapters:
                pi = 0  # paragraph index
                for content in chapter.content:
                    if content.type == 'paragraph' and content.text and len(content.text) >= 6:
                        entries.append({
                            'url': f"{book.id}/{chapter.number}",
                            'book_id': book.id,
                            'book_title': book.title,
                            'chapter': chapter.number,
                            'chapter_title': chapter.title,
                            'pi': pi,
                            'text': content.text[:300],
                        })
                        pi += 1
                    elif content.type == 'heading' and content.text:
                        entries.append({
                            'url': f"{book.id}/{chapter.number}",
                            'book_id': book.id,
                            'book_title': book.title,
                            'chapter': chapter.number,
                            'chapter_title': chapter.title,
                            'pi': pi,
                            'text': content.text[:200],
                        })
                        pi += 1
                    elif content.type == 'quote' and content.text and len(content.text) >= 6:
                        entries.append({
                            'url': f"{book.id}/{chapter.number}",
                            'book_id': book.id,
                            'book_title': book.title,
                            'chapter': chapter.number,
                            'chapter_title': chapter.title,
                            'pi': pi,
                            'text': content.text[:300],
                        })
                        pi += 1

        data = {
            'version': datetime.now().strftime('%Y%m%d%H%M%S'),
            'count': len(entries),
            'entries': entries,
        }

        data_dir = os.path.join(self.output_dir, 'data')
        os.makedirs(data_dir, exist_ok=True)
        json_path = os.path.join(data_dir, 'search-index.json')
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

        print(f"✓ search-index.json 已生成 ({len(entries)} 条索引)")

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

        # sw.js
        sw_src = os.path.join(template_dir, 'main_sw.js')
        if os.path.exists(sw_src):
            shutil.copy2(sw_src, os.path.join(self.output_dir, 'sw.js'))
            print("✓ sw.js 已生成")

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
    # 完整生成流程
    # ------------------------------------------------------------------

    def generate_all(self, books: List[Book], app_config: dict = None):
        """完整生成流程：逐本书生成 JSON → 全局索引 → 搜索索引 → 静态资源"""

        # 1. 逐本书生成 book.json
        for book in books:
            self.generate_book_json(book)

        # 2. 全局索引
        self.generate_books_json(books)

        # 3. 静态资源（先复制，避免后续生成的 search-index.json 被覆盖）
        self.copy_static_assets()

        # 4. 搜索索引
        self.generate_search_index(books)

        # 5. PWA manifest 和 Service Worker
        self.generate_manifest_and_sw()

        # 6. version.json
        if app_config:
            self.generate_version_json(app_config)

        # 7. .nojekyll（GitHub Pages 兼容）
        nojekyll_path = os.path.join(self.output_dir, '.nojekyll')
        with open(nojekyll_path, 'w') as f:
            f.write('')
