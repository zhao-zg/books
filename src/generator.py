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
        """生成完整 style.css，包含主题变量、布局和下载面板等样式。"""
        css_content = r"""/* 书报 - 完整样式表（由 generator.py 自动生成） */

/* ── 主题变量 ─────────────────────────────────────────────── */
:root, [data-theme="cool"] {
  --surface: #fafbff; --surface-alt: #f0f2f8; --nav-hover: #eef1fa;
  --text: #1a1a2e; --text-soft: #4b5563; --text-muted: #8888a0; --heading: #111128;
  --brand: #667eea; --brand-rgb: 102,126,234; --accent-color: #4a90d9;
  --border: #e0e3ef; --group-divider-bg: #ebedf5;
  --header-text: #333; --btn-primary-bg: #667eea;
  --btn-primary-text: #fff; --btn-primary-border: #667eea;
  --card-bg: #fff; --shadow-sm: 0 1px 3px rgba(0,0,0,.08);
  --success-text: #2e7d32; --danger-text: #c62828; --danger-border: #fed7d7; --danger-bg: #fff5f5;
  --warning-text: #e65100; --muted: #ccc;
  --menu-shadow: 0 4px 20px rgba(15,23,42,.22);
  --dialog-shadow: 0 8px 32px rgba(15,23,42,.2);
  --overlay-strong: rgba(15,23,42,.45);
  --interactive-soft-bg: rgba(102,126,234,.08);
  --interactive-soft-border: rgba(102,126,234,.16);
}
[data-theme="warm"] {
  --surface: #F7F2E8; --surface-alt: #EDE7D9; --nav-hover: #E8E0CE;
  --text: #3E2F1C; --text-soft: #6A4E40; --text-muted: #8C7A62; --heading: #2B1E0E;
  --brand: #A67C52; --brand-rgb: 166,124,82; --accent-color: #A67C52;
  --border: #D9CEBC; --group-divider-bg: #E0D5C3;
  --header-text: #3E2F1C; --btn-primary-bg: #A67C52;
  --btn-primary-text: #fff; --btn-primary-border: #A67C52;
  --card-bg: #FBF7EF; --shadow-sm: 0 1px 3px rgba(0,0,0,.06);
  --success-text: #558B2F; --danger-text: #BF360C; --danger-border: #EFCACA; --danger-bg: #FFF1EF;
  --warning-text: #E65100; --muted: #C4B9A8;
  --menu-shadow: 0 6px 20px rgba(90,65,30,.16);
  --dialog-shadow: 0 10px 32px rgba(90,65,30,.14);
  --overlay-strong: rgba(44,24,16,.40);
  --interactive-soft-bg: rgba(180,145,85,.12);
  --interactive-soft-border: rgba(160,125,75,.22);
}
[data-theme="dark"] {
  --surface: #181b21; --surface-alt: #1e2128; --nav-hover: #272b34;
  --text: #e0e0e0; --text-soft: #b8bfcc; --text-muted: #888; --heading: #f0f0f0;
  --brand: #8ea4f0; --brand-rgb: 142,164,240; --accent-color: #8ea4f0;
  --border: #2e323b; --group-divider-bg: #22252c;
  --header-text: #e0e0e0; --btn-primary-bg: #556bba;
  --btn-primary-text: #fff; --btn-primary-border: #556bba;
  --card-bg: #1e2128; --shadow-sm: 0 1px 3px rgba(0,0,0,.3);
  --success-text: #66bb6a; --danger-text: #ef5350; --danger-border: #7a3b3b; --danger-bg: #3a1f24;
  --warning-text: #ffa726; --muted: #444;
  --menu-shadow: 0 6px 20px rgba(0,0,0,.34);
  --dialog-shadow: 0 12px 36px rgba(0,0,0,.34);
  --overlay-strong: rgba(0,0,0,.56);
  --interactive-soft-bg: rgba(142,164,240,.14);
  --interactive-soft-border: rgba(142,164,240,.26);
}

/* ── 基础布局 ─────────────────────────────────────────────── */
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', sans-serif; background: var(--surface); color: var(--text); line-height: 1.6; -webkit-font-smoothing: antialiased; }
.container { max-width: 960px; margin: 0 auto; padding: 0; }
.header { padding: 24px 16px 12px; }
.header h1 { font-size: 24px; font-weight: 700; color: var(--brand); margin-bottom: 4px; }
.header .subtitle { font-size: 14px; color: var(--text-muted); }
.content { padding: 0; }

/* ── 首页头部操作栏 ─────────────────────────────────────── */
.home-header-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.home-action-btn { padding: 7px 18px; background: var(--surface-alt); color: var(--brand); border: 1.5px solid var(--border); border-radius: 20px; font: inherit; font-size: 14px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.home-action-btn:active { transform: scale(0.97); }

/* ── 系列标签栏 ─────────────────────────────────────────── */
.series-tabs { display: flex; flex-wrap: nowrap; gap: 8px; padding: 12px 16px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.series-tabs::-webkit-scrollbar { display: none; }
.series-tab { padding: 6px 16px; border-radius: 20px; border: 1px solid var(--border); background: transparent; color: var(--text); font-size: 14px; cursor: pointer; transition: all 0.2s; -webkit-tap-highlight-color: transparent; white-space: nowrap; flex-shrink: 0; }
[data-theme="dark"] .series-tab:not(.active) { color: rgba(255,255,255,0.82); }
.series-tab:active { transform: scale(0.96); }
.series-tab.active { background: var(--accent-color, #4a90d9); color: white; border-color: var(--accent-color, #4a90d9); box-shadow: 0 2px 8px rgba(var(--brand-rgb, 102,126,234), 0.3); font-weight: 500; }

/* ── 书籍卡片增强 ───────────────────────────────────────── */
.book-grid { display: grid; gap: 1px; padding: 0 16px 16px; background: transparent; }
@media (min-width: 768px) { .book-grid { grid-template-columns: repeat(2, 1fr); gap: 12px; } }
@media (min-width: 1024px) { .book-grid { grid-template-columns: repeat(3, 1fr); } }
.zl-book-card { background: var(--card-bg, var(--surface)); border-radius: 8px; overflow: hidden; transition: background-color .2s, transform 0.15s ease, box-shadow 0.15s ease; border: 1px solid var(--border); border-left: 3px solid var(--series-color, var(--accent-color, #667eea)); box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.zl-book-card:hover { background: var(--nav-hover); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
[data-theme="dark"] .zl-book-card { box-shadow: 0 1px 3px rgba(0,0,0,0.25); }
[data-theme="dark"] .zl-book-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
.zl-book-card .book-card-wrapper { display: flex; align-items: stretch; }
.zl-book-card .book-link { display: block; padding: 12px 14px; text-decoration: none; color: inherit; flex: 1; min-width: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; user-select: none; }
.zl-book-card .book-link:active { background: var(--nav-hover); }
.zl-book-card .book-info { position: relative; }
.zl-book-card .book-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
.zl-book-card .book-title-row { display: flex; align-items: center; gap: 6px; }
.zl-book-card .title { font-size: 1em; color: var(--text); line-height: 1.5; font-weight: 500; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; flex: 1; }
.zl-book-card .series-tag { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
.zl-book-card .chapter-count { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
.zl-book-card .download-icon { margin-left: auto; font-size: 16px; opacity: 0.7; flex-shrink: 0; }

/* ── 类型目录导航 ───────────────────────────────────────── */
.category-grid { display: grid; gap: 12px; padding: 0 16px 16px; }
@media (min-width: 768px) { .category-grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .category-grid { grid-template-columns: repeat(3, 1fr); } }
.category-card { background: var(--card-bg, var(--surface)); border-radius: 10px; padding: 16px; border: 1px solid var(--border); cursor: pointer; transition: background-color .2s, transform 0.15s ease, box-shadow 0.15s ease; -webkit-tap-highlight-color: transparent; user-select: none; position: relative; overflow: hidden; }
.category-card::before { content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: linear-gradient(180deg, var(--accent-color, #667eea), rgba(var(--brand-rgb, 102,126,234), 0.3)); border-radius: 4px 0 0 4px; }
.category-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
[data-theme="dark"] .category-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.category-card:active { background: var(--nav-hover); transform: scale(0.98); }
.category-card-title { font-size: 16px; font-weight: 600; color: var(--text); line-height: 1.4; padding-left: 8px; }
.category-card-count { font-size: 12px; color: var(--text-muted); margin-top: 6px; padding-left: 8px; display: inline-flex; align-items: center; gap: 4px; }
.category-card-count::before { content: ''; display: inline-block; min-width: 22px; height: 22px; line-height: 22px; text-align: center; background: rgba(var(--brand-rgb, 102,126,234), 0.12); border-radius: 11px; font-weight: 600; font-size: 11px; color: var(--accent-color, #667eea); padding: 0 6px; }
.category-back-bar { padding: 8px 16px; }
.category-back-btn { background: none; border: none; color: var(--brand, var(--accent-color, #4a90d9)); font-size: 14px; cursor: pointer; padding: 6px 0; -webkit-tap-highlight-color: transparent; }
.category-back-btn:active { opacity: 0.7; }

/* ── 批量下载面板 ───────────────────────────────────────── */
.download-panel { position: fixed; bottom: 0; left: 0; right: 0; background: var(--card-bg, var(--surface)); border-top: 1px solid var(--border); padding: 16px; transform: translateY(100%); transition: transform 0.3s ease; z-index: 200; max-height: 70vh; overflow-y: auto; border-radius: 16px 16px 0 0; box-shadow: 0 -4px 20px rgba(0,0,0,.15); }
.download-panel.open { transform: translateY(0); }
.download-panel-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 199; }
.download-panel-overlay.open { display: block; }
.download-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.download-panel-title { font-size: 16px; font-weight: 600; color: var(--text); }
.download-panel-close { background: none; border: none; font-size: 18px; color: var(--text-muted); cursor: pointer; padding: 4px 8px; min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center; }
.download-storage-info { font-size: 13px; color: var(--text-muted); margin-bottom: 10px; }
.download-progress { height: 4px; background: var(--border); border-radius: 2px; margin: 8px 0; overflow: hidden; }
.download-progress-bar { height: 100%; background: var(--accent-color, #4a90d9); border-radius: 2px; transition: width 0.3s; }
.download-progress-text { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
.download-controls { display: flex; gap: 8px; margin-bottom: 10px; }
.dl-ctrl-btn { padding: 6px 16px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-alt); color: var(--text); font-size: 13px; cursor: pointer; }
.dl-ctrl-btn:active { transform: scale(0.96); }
.download-series-list { margin: 8px 0; }
.download-series-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
.download-series-name { font-size: 14px; color: var(--text); }
.download-series-btn { padding: 4px 14px; border-radius: 14px; border: 1px solid var(--accent-color, #4a90d9); background: transparent; color: var(--accent-color, #4a90d9); font-size: 13px; cursor: pointer; }
.download-series-btn:active { transform: scale(0.96); }
.download-all-btn { display: block; width: 100%; padding: 10px; margin-top: 10px; border-radius: 8px; border: none; background: var(--accent-color, #4a90d9); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
.download-all-btn:active { transform: scale(0.98); opacity: 0.9; }

/* ── 返回书架按钮 ────────────────────────────────────────── */
.bk-reading-header { padding: 16px 16px 8px; }
.bk-reading-header-row { display: flex; align-items: flex-start; gap: 8px; }
.bk-reading-header-titles { flex: 1; min-width: 0; }
.bk-back-btn { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; border: none; background: var(--surface-alt); color: var(--brand); cursor: pointer; flex-shrink: 0; margin-top: 2px; font-size: 24px; line-height: 1; -webkit-tap-highlight-color: transparent; transition: background .15s; }
.bk-back-btn:active { background: var(--nav-hover); transform: scale(0.92); }
.bk-back-btn-icon { display: block; line-height: 1; }
.bk-reading-book-title { font-size: 13px; color: var(--text-muted); margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bk-reading-chapter-title { font-size: 20px; font-weight: 600; color: var(--heading); line-height: 1.4; }

/* ── 字号提示 Toast ──────────────────────────────────────── */
.bk-font-toast { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.85); background: rgba(40,40,40,.88); color: #fff; padding: 12px 24px; border-radius: 12px; font-size: 15px; font-weight: 500; z-index: 99999; opacity: 0; transition: opacity .2s, transform .2s; pointer-events: none; white-space: nowrap; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
.bk-font-toast.show { opacity: 1; transform: translate(-50%, -50%) scale(1); }

/* ── 书签空状态 ─────────────────────────────────────────── */
.bk-bm-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 16px; }
.bk-bm-empty-icon { font-size: 36px; margin-bottom: 10px; opacity: .6; }
.bk-bm-empty-text { font-size: 15px; color: var(--text-muted); margin-bottom: 6px; }
.bk-bm-empty-hint { font-size: 13px; color: var(--text-muted); opacity: .7; text-align: center; line-height: 1.5; }

/* ── 页面导航栏 ──────────────────────────────────────────── */
.page-navigation { display: flex; align-items: center; justify-content: center; gap: 0; padding: 16px 8px 32px; border-top: 1px solid var(--border); margin-top: 24px; }
.nav-link { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 10px 14px; text-decoration: none; color: var(--brand); font-size: 14px; border-radius: 8px; transition: background .15s; -webkit-tap-highlight-color: transparent; cursor: pointer; min-width: 44px; min-height: 44px; }
.nav-link:active { background: var(--nav-hover); transform: scale(0.95); opacity: 0.7; }
.nav-link.nav-disabled { color: var(--text-muted); opacity: .3; pointer-events: none; }
.nav-arrow { font-size: 20px; font-weight: 600; line-height: 1; }
.nav-icon { font-size: 18px; line-height: 1; }
.nav-label { font-size: 13px; max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-home { margin-right: auto; }
.nav-next { margin-left: auto; }

/* ── 加载 / 空状态 / 错误 ───────────────────────────────── */
.bk-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: var(--text-muted); }
.bk-spinner { width: 28px; height: 28px; border: 3px solid var(--border); border-top-color: var(--brand); border-radius: 50%; animation: bk-spin 0.8s linear infinite; margin-bottom: 12px; }
@keyframes bk-spin { to { transform: rotate(360deg); } }
.bk-empty, .bk-error { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; }
.bk-empty-icon, .bk-error-icon { font-size: 40px; margin-bottom: 12px; }
.bk-empty-text, .bk-error-text { font-size: 15px; color: var(--text-muted); }
.bk-error-text { color: var(--danger-text); }
.home-status { padding: 40px 20px; text-align: center; background: var(--surface); color: var(--text-muted); }
.home-status-icon { font-size: 24px; margin-bottom: 10px; }

/* ── 底部 ─────────────────────────────────────────────── */
.footer { text-align: center; padding: 16px; color: var(--text-muted); background: var(--surface-alt); border-top: 1px solid var(--border); font-size: 13px; }
.footer-meta { margin-top: 6px; font-size: 12px; }

/* ── 响应式微调 ─────────────────────────────────────────── */
@media (min-width: 768px) {
  .header { padding: 32px 24px 16px; }
  .series-tabs { padding: 12px 24px; }
  .book-grid { padding: 0 24px 24px; }
}

/* ── 目录侧边栏 Drawer ──────────────────────────────────── */
.bk-toc-drawer {
  position: fixed;
  top: 0;
  left: 0;
  width: 320px;
  max-width: 85vw;
  height: 100vh;
  background: var(--surface, #fff);
  z-index: 1000;
  transform: translateX(-100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow-y: auto;
  box-shadow: 2px 0 16px rgba(0,0,0,0.15);
  display: flex;
  flex-direction: column;
}
.bk-toc-drawer.open {
  transform: translateX(0);
}
.bk-toc-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 999;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.bk-toc-overlay.open {
  opacity: 1;
  pointer-events: auto;
}
.bk-toc-drawer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 14px 12px;
  border-bottom: 1px solid var(--border, #e0e3ef);
  flex-shrink: 0;
  gap: 8px;
}
.bk-toc-drawer-titles { flex: 1; min-width: 0; }
.bk-toc-drawer-book-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--heading, #111);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.bk-toc-drawer-author {
  font-size: 13px;
  color: var(--text-muted, #888);
  margin-top: 2px;
}
.bk-toc-drawer-close {
  min-width: 44px;
  min-height: 44px;
  border-radius: 50%;
  border: none;
  background: var(--surface-alt, #f0f2f8);
  color: var(--text-muted, #888);
  cursor: pointer;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.bk-toc-drawer-close:active { background: var(--nav-hover, #eef1fa); }
.bk-toc-search {
  flex-shrink: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #e0e3ef);
}
.bk-toc-search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid var(--border, #e0e3ef);
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  background: var(--surface-alt, #f0f2f8);
  color: var(--text, #1a1a2e);
  transition: border-color 0.15s;
}
.bk-toc-search-input:focus {
  border-color: var(--brand, #667eea);
}
.bk-toc-search-input::placeholder {
  color: var(--text-muted, #aaa);
}
.bk-toc-chapter-item.bk-toc-hidden { display: none; }
.bk-toc-no-results {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted, #888);
  font-size: 14px;
}
.bk-toc-drawer-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.bk-toc-chapter-list {
  display: flex;
  flex-direction: column;
}
.bk-toc-chapter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
  text-decoration: none;
  color: var(--text, #1a1a2e);
  font-size: 14px;
  border-bottom: 1px solid var(--border, #e0e3ef);
  transition: background 0.15s;
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
}
.bk-toc-chapter-item:active { background: var(--nav-hover, #eef1fa); }
.bk-toc-chapter-item.bk-toc-current {
  background: var(--nav-hover, #eef1fa);
  color: var(--brand, #667eea);
  font-weight: 500;
}
.bk-toc-chapter-num {
  font-size: 12px;
  color: var(--text-muted, #888);
  min-width: 28px;
  text-align: right;
  flex-shrink: 0;
}
.bk-toc-chapter-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bk-toc-chapter-badge {
  font-size: 11px;
  background: var(--brand, #667eea);
  color: #fff;
  border-radius: 10px;
  padding: 1px 7px;
  flex-shrink: 0;
}

/* ── 书籍下载状态过渡动画 ──────────────────────────────────── */
.download-icon {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
@keyframes bk-pulse {
  0%, 100% { opacity: 0.7; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.18); }
}
.zl-book-card[data-downloading="true"] .download-icon {
  animation: bk-pulse 1.2s ease-in-out infinite;
}

/* ── 设置按钮与面板 ────────────────────────────────────────── */
.theme-toggle-btn {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--surface-alt, #f0f2f8);
  color: var(--text-muted, #888);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 100;
  box-shadow: 0 2px 10px rgba(0,0,0,0.12);
  transition: background 0.2s, transform 0.2s;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}
.theme-toggle-btn:active { transform: scale(0.9); background: var(--nav-hover); }
.theme-toggle-btn svg {
  width: 22px;
  height: 22px;
}
.theme-panel-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 299;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.theme-panel-overlay.show {
  opacity: 1;
  pointer-events: auto;
}
.theme-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--surface, #fff);
  z-index: 300;
  transform: translateY(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border-radius: 20px 20px 0 0;
  box-shadow: 0 -4px 24px rgba(0,0,0,0.18);
  max-height: 80vh;
  overflow-y: auto;
  padding: 8px 20px calc(20px + env(safe-area-inset-bottom, 0px));
}
.theme-panel.show {
  transform: translateY(0);
}
.theme-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0 12px;
  border-bottom: 1px solid var(--border, #e0e3ef);
  margin-bottom: 12px;
}
.theme-panel-title {
  font-size: 17px;
  font-weight: 600;
  color: var(--heading, #111);
}
.theme-panel-close {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--surface-alt, #f0f2f8);
  color: var(--text-muted, #888);
  cursor: pointer;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
}
.theme-section { margin-bottom: 16px; }
.theme-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted, #888);
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.theme-options { display: flex; gap: 12px; }
.theme-option {
  flex: 1;
  cursor: pointer;
  border-radius: 12px;
  border: 2px solid transparent;
  overflow: hidden;
  transition: border-color 0.2s;
  -webkit-tap-highlight-color: transparent;
}
.theme-option.active { border-color: var(--brand, #667eea); }
.theme-preview {
  height: 72px;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 6px;
  border: 1px solid var(--border);
}
.theme-preview .tp-bar { height: 18px; }
.theme-preview .tp-body { padding: 6px 8px; }
.theme-preview .tp-line { height: 4px; border-radius: 2px; margin-bottom: 4px; }
.theme-preview .tp-line.short { width: 60%; }
.theme-preview.warm .tp-bar { background: #A67C52; }
.theme-preview.warm .tp-body { background: #F7F2E8; }
.theme-preview.warm .tp-line { background: #D9CEBC; }
.theme-preview.cool .tp-bar { background: #667eea; }
.theme-preview.cool .tp-body { background: #fafbff; }
.theme-preview.cool .tp-line { background: #e0e3ef; }
.theme-preview.dark .tp-bar { background: #556bba; }
.theme-preview.dark .tp-body { background: #181b21; }
.theme-preview.dark .tp-line { background: #2e323b; }
.theme-option-content {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
}
.theme-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--border);
  flex-shrink: 0;
  position: relative;
  transition: border-color 0.2s;
}
.theme-option.active .theme-radio {
  border-color: var(--brand, #667eea);
}
.theme-option.active .theme-radio::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--brand, #667eea);
}
.theme-label {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
}
.font-size-slider-container {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.font-label-small { font-size: 14px; color: var(--text-muted); font-weight: 600; }
.font-label-large { font-size: 20px; color: var(--text-muted); font-weight: 600; }
.font-size-slider {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border);
  border-radius: 2px;
  outline: none;
}
.font-size-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--brand, #667eea);
  cursor: pointer;
}
.font-size-value {
  font-size: 13px;
  color: var(--text-muted);
  min-width: 36px;
  text-align: right;
}
.actions-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
@media (min-width: 400px) {
  .actions-grid { grid-template-columns: repeat(3, 1fr); }
}
.action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-alt, #f0f2f8);
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  transition: background 0.15s, transform 0.1s;
  -webkit-tap-highlight-color: transparent;
}
.action-btn:active { transform: scale(0.97); background: var(--nav-hover); }
.action-btn.danger { color: var(--danger-text); }
.action-btn .cache-icon { font-size: 22px; }
.action-btn .cache-text { font-size: 12px; font-weight: 500; }
.action-btn.feedback { }
/* 偏好设置行 */
.pref-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
}
.pref-label-wrap { flex: 1; min-width: 0; }
.pref-title { font-size: 14px; color: var(--text); font-weight: 500; display: block; }
.pref-desc { font-size: 12px; color: var(--text-muted); display: block; margin-top: 2px; }
/* 开关控件 */
.pref-toggle {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 26px;
  flex-shrink: 0;
}
.pref-toggle input { display: none; }
.pref-toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--border, #e0e3ef);
  border-radius: 26px;
  cursor: pointer;
  transition: background 0.3s;
}
.pref-toggle-slider::before {
  content: '';
  position: absolute;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: white;
  top: 3px;
  left: 3px;
  transition: transform 0.3s;
  box-shadow: 0 1px 4px rgba(0,0,0,0.2);
}
.pref-toggle input:checked + .pref-toggle-slider {
  background: var(--brand, #667eea);
}
.pref-toggle input:checked + .pref-toggle-slider::before {
  transform: translateX(18px);
}
/* 滚动锁定 */
.bk-scroll-locked { overflow: hidden !important; }

/* ── 阅读内容排版 ────────────────────────────────────────── */
#chapterContent { padding: 0 16px 24px; line-height: 1.8; }
@media (min-width: 768px) { #chapterContent { padding: 0 24px 32px; } }
.bk-paragraph { margin-bottom: 1em; text-align: justify; }
.bk-heading { color: var(--heading); margin: 1.5em 0 0.5em; line-height: 1.4; }
.bk-h1 { font-size: 1.6em; }
.bk-h2 { font-size: 1.4em; }
.bk-h3 { font-size: 1.2em; }
.bk-h4 { font-size: 1.1em; }
.bk-h5, .bk-h6 { font-size: 1em; }
.bk-quote {
  margin: 1em 0;
  padding: 0;
  border-left: 3px solid var(--brand, #667eea);
}
.bk-quote-content {
  padding: 8px 16px;
  background: var(--surface-alt, #f0f2f8);
  color: var(--text-muted);
  font-style: italic;
  border-radius: 0 6px 6px 0;
}
.bk-figure {
  margin: 1.2em 0;
  text-align: center;
}
.bk-figure img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}
.bk-figure figcaption {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 6px;
}
.bk-list {
  margin: 0.8em 0;
  padding-left: 1.5em;
}
.bk-list li { margin-bottom: 0.4em; }
.bk-code {
  background: var(--surface-alt, #f0f2f8);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 14px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 13px;
  overflow-x: auto;
  margin: 0.8em 0;
}
.bk-separator {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2em 0;
}
.bk-footnotes-section {
  margin-top: 2em;
  padding-top: 1em;
  border-top: 1px solid var(--border);
}
.bk-footnotes-title {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 8px;
}
.bk-footnote {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 6px;
  display: flex;
  gap: 6px;
}
.bk-fn-number {
  color: var(--brand, #667eea);
  font-weight: 600;
  flex-shrink: 0;
}

/* ── 阅读进度条（章节阅读进度） ─────────────────────────────── */
.reading-view .bk-reading-progress {
  height: 3px;
  background: var(--border, #e0e3ef);
  overflow: hidden;
  flex-shrink: 0;
}
.bk-reading-progress-bar {
  height: 100%;
  background: var(--brand, #667eea);
  border-radius: 0 2px 2px 0;
  transition: width 0.4s ease;
}
/* 页面顶部滚动进度条 */
#bkReadingProgress {
  position: fixed;
  top: 0;
  left: 0;
  height: 2px;
  background: var(--brand, #667eea);
  z-index: 9998;
  width: 0%;
  transition: width 0.15s linear;
  pointer-events: none;
}

/* ── 独立目录页（后备路由） ─────────────────────────────────── */
.bk-chapter-list-view { max-width: 600px; margin: 0 auto; }
.bk-book-header {
  padding: 24px 16px 16px;
  text-align: center;
  border-bottom: 1px solid var(--border);
}
.bk-book-header-cover {
  width: 80px;
  height: 110px;
  object-fit: cover;
  border-radius: 6px;
  margin-bottom: 12px;
  box-shadow: var(--shadow-sm);
}
.bk-book-header-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--heading);
  margin-bottom: 6px;
}
.bk-book-header-author {
  font-size: 14px;
  color: var(--brand);
  margin-bottom: 4px;
}
.bk-book-header-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 8px;
  line-height: 1.5;
}
.bk-chapter-list {
  display: flex;
  flex-direction: column;
}
.bk-chapter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  text-decoration: none;
  color: var(--text);
  font-size: 14px;
  border-bottom: 1px solid var(--border);
  transition: background 0.15s;
  -webkit-tap-highlight-color: transparent;
}
.bk-chapter-item:active { background: var(--nav-hover); }
.bk-chapter-item.bk-chapter-current {
  background: var(--nav-hover);
  color: var(--brand);
  font-weight: 500;
}
.bk-chapter-num {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 28px;
  text-align: right;
  flex-shrink: 0;
}
.bk-chapter-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bk-chapter-badge {
  font-size: 11px;
  background: var(--brand);
  color: #fff;
  border-radius: 10px;
  padding: 1px 7px;
  flex-shrink: 0;
}

/* ── 导入书籍删除按钮 ──────────────────────────────────────── */
.imported-delete-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: rgba(198, 40, 40, 0.08);
  color: var(--danger-text, #c62828);
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
  z-index: 2;
}
.imported-delete-btn:active { background: rgba(198, 40, 40, 0.18); }
.zl-book-card { position: relative; }

/* ── 触摸优化 ──────────────────────────────────────────────── */
/* 消除 300ms 点击延迟 */
a, button, [role="button"], input, select, textarea, .book-link, .series-tab, .nav-link, .bk-toc-chapter-item {
  touch-action: manipulation;
}

/* 优化触摸高亮反馈 */
.book-link, .series-tab, .nav-link, .bk-toc-chapter-item, .action-btn, .control-btn {
  -webkit-tap-highlight-color: transparent;
}

/* ── 阅读视图过渡动画 ──────────────────────────────────────── */
#app.bk-view-enter {
  opacity: 0;
}
#app.bk-view-enter-active {
  opacity: 1;
  transition: opacity 150ms ease-out;
  will-change: opacity;
}

/* ── 高亮标记基础样式 ────────────────────────────────────────── */
.bk-highlight { cursor: pointer; border-radius: 2px; transition: opacity .2s; color: inherit !important; text-underline-offset: 3px; }
.bk-highlight:hover { opacity: .8; }
.bk-highlight[data-underline="true"] {
  text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 2px;
  background: transparent !important;
}
[data-theme="dark"] .bk-highlight { color: #2c2c2c !important; }

/* ── 选区菜单（文本选中后弹出的颜色选择浮窗） ──────────────────── */
.hl-menu { display: none; flex-direction: column; gap: 5px; padding: 8px; background: var(--surface, #fafbff); border-radius: 12px; box-shadow: var(--menu-shadow, 0 4px 20px rgba(0,0,0,.18)); border: 1px solid var(--border, #e0e3ef); z-index: 9999; min-width: min(220px, calc(100vw - 24px)); max-width: min(340px, calc(100vw - 24px)); -webkit-user-select: none; user-select: none; transition: opacity .15s ease; }
.hl-menu-row { display: flex; gap: 6px; flex-wrap: nowrap; align-items: center; width: 100%; }
.hl-sel-row { gap: 6px; flex-wrap: nowrap; }
.hl-sel-sep { width: 1px; height: 24px; background: var(--border, #e0e3ef); flex-shrink: 0; margin: 0 2px; }
.hl-sel-note-btn { min-height: 34px; padding: 4px 10px; font-size: 13px; flex-shrink: 0; white-space: nowrap; }
.hl-menu-btn { flex: 1; min-width: 0; min-height: 34px; padding: 5px 10px; background: var(--surface-alt, #f0f2f8); border: 1px solid var(--border, #e0e3ef); border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--text, #1a1a2e); cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.hl-menu-btn:active { transform: scale(.95); background: var(--muted, #ccc); }
.hl-menu-btn-danger { color: var(--danger-text, #c62828); border-color: var(--danger-border, #fed7d7); }
.hl-menu-btn-danger:active { background: var(--danger-bg, #fff5f5); }

/* ── 注解菜单：预览气泡 + 工具栏 ─────────────────── */
.hl-ann-menu { gap: 0; padding: 0; min-width: min(260px, calc(100vw - 24px)); max-width: min(360px, calc(100vw - 24px)); overflow: hidden; }
.hl-ann-note-bubble { display: none; border-bottom: 1px solid var(--border, #e0e3ef); padding: 14px 16px 10px; width: 100%; box-sizing: border-box; }
.hl-ann-note-body { font-size: .875em; color: var(--text, #1a1a2e); line-height: 1.75; word-break: break-word; max-height: 7em; overflow: hidden; display: -webkit-box; line-clamp: 4; -webkit-line-clamp: 4; -webkit-box-orient: vertical; white-space: pre-wrap; -webkit-user-select: text; user-select: text; }
.hl-ann-note-expand { display: block; text-align: center; padding: 6px 0 0; font-size: .75em; color: var(--brand, #667eea); background: none; border: none; cursor: pointer; width: 100%; line-height: 1.4; min-height: 28px; -webkit-tap-highlight-color: transparent; touch-action: manipulation; opacity: .8; }
.hl-ann-note-expand:active { opacity: 1; }
.hl-ann-toolbar { display: flex; gap: 0; align-items: stretch; width: 100%; padding: 4px 6px; box-sizing: border-box; }
.hl-ann-tool { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; flex: 1; min-width: 0; min-height: 44px; padding: 4px 2px; background: transparent; border: none; border-radius: 8px; font-size: .75em; color: var(--text, #1a1a2e); cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; transition: background .12s; }
.hl-ann-tool:active { background: var(--muted, #ccc); }
.hl-ann-tool-icon { font-size: 1.4em; line-height: 1; }
.hl-ann-tool-label { font-size: 1em; font-weight: 600; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.hl-ann-tool-danger { color: var(--danger-text, #c62828); }
.hl-ann-tool-danger:active { background: var(--danger-bg, #fff5f5); }
.hl-ann-tool-sep { width: 1px; align-self: center; height: 24px; background: var(--border, #e0e3ef); flex-shrink: 0; margin: 0 2px; }

/* ── 颜色面板（注解菜单中的可折叠面板） ──────────────────────── */
.hl-color-panel { max-height: 0; overflow: hidden; transition: max-height .25s ease; }
.hl-color-panel.open { max-height: 60px; }
.hl-color-panel .hl-menu-row { padding-top: 4px; }
.hl-color-dot { width: 28px; height: 28px; border: 2px solid transparent; border-radius: 50%; cursor: pointer; flex-shrink: 0; box-shadow: 0 1px 4px rgba(0,0,0,.15); transition: transform .15s; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.hl-color-dot:active { transform: scale(.9); }
.hl-color-dot.selected { border-color: var(--text, #1a1a2e); transform: scale(1.15); box-shadow: 0 0 0 1px var(--text, #1a1a2e); }

/* ── 下划线按钮 ────────────────────────────────────────────── */
.hl-underline-btn { min-width: 36px; min-height: 30px; padding: 4px 8px 2px; background: var(--surface-alt, #f0f2f8); color: var(--text, #1a1a2e); border: 1px solid var(--border, #e0e3ef); border-bottom: 2px solid #e53935; border-radius: 6px; font-size: .8125em; font-weight: 700; cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.hl-underline-btn.active { background: var(--brand, #667eea); color: #fff; border-color: var(--brand, #667eea); border-bottom-color: #ffcdd2; }

/* ── 笔记模态框 ──────────────────────────────────────────────── */
.hl-modal-mask { display: none; position: fixed; inset: 0; background: var(--overlay-strong, rgba(0,0,0,.45)); z-index: 10100; align-items: center; justify-content: center; padding: 16px; }
.hl-modal-card { background: var(--surface, #fafbff); border-radius: 14px; padding: 18px; width: 100%; max-width: 420px; box-sizing: border-box; box-shadow: var(--dialog-shadow, 0 8px 32px rgba(0,0,0,.2)); display: flex; flex-direction: column; gap: 12px; overflow: hidden; }
.hl-modal-title { font-size: 1em; font-weight: 700; color: var(--text, #1a1a2e); }
.hl-note-textarea { width: 100%; box-sizing: border-box; resize: vertical; overflow-y: auto; border: 1px solid var(--border, #e0e3ef); border-radius: 8px; padding: 10px; font-size: .875em; color: var(--text, #1a1a2e); background: var(--surface-alt, #f0f2f8); font-family: inherit; line-height: 1.6; min-height: 100px; max-height: 60vh; }
.hl-note-textarea:focus { outline: none; border-color: var(--brand, #667eea); box-shadow: 0 0 0 2px var(--interactive-soft-border, rgba(102,126,234,.16)); }
.hl-modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
.hl-modal-btn { min-height: 34px; padding: 5px 16px; border-radius: 8px; font-size: .8125em; font-weight: 600; cursor: pointer; border: 1px solid var(--border, #e0e3ef); flex-shrink: 0; white-space: nowrap; }
.hl-modal-cancel { background: var(--surface-alt, #f0f2f8); color: var(--text, #1a1a2e); }
.hl-modal-save { background: var(--brand, #667eea); color: #fff; border-color: var(--brand, #667eea); }
.hl-modal-save:active { opacity: .85; }

/* ── 笔记图标与展开视图 ──────────────────────────────────────── */
.bk-note-icon { font-size: .75em; cursor: pointer; vertical-align: super; line-height: 1; margin-left: 1px; -webkit-user-select: none; user-select: none; }
.bk-note-expanded-card { background: var(--surface, #fafbff); border-radius: 14px; width: 100%; max-width: 520px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: var(--dialog-shadow, 0 8px 32px rgba(0,0,0,.2)); overflow: hidden; }
.bk-note-expanded-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 12px; border-bottom: 1px solid var(--border, #e0e3ef); flex-shrink: 0; }
.bk-note-expanded-title { font-size: .9em; font-weight: 600; color: var(--brand, #667eea); flex: 1; }
.bk-note-expanded-edit { padding: 4px 12px; border-radius: 8px; font-size: .8125em; font-weight: 600; color: var(--brand, #667eea); background: var(--surface-alt, #f0f2f8); border: 1px solid var(--border, #e0e3ef); cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation; flex-shrink: 0; margin-left: 8px; }
.bk-note-expanded-edit:active { background: var(--muted, #ccc); }
.bk-note-expanded-body { overflow-y: auto; padding: 16px; font-size: .9em; color: var(--text, #1a1a2e); line-height: 1.85; white-space: pre-wrap; word-break: break-word; flex: 1; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; -webkit-user-select: text; user-select: text; }

/* ═══════════ 书签系统 (bookmark.js) ═══════════ */

/* 书签按钮 */
.bk-bm-btn {
  background: none; border: none; font-size: 18px; cursor: pointer;
  padding: 6px 10px; border-radius: 6px; color: var(--text-muted, #8888a0);
  transition: color .2s, background .2s; -webkit-tap-highlight-color: transparent;
  line-height: 1; vertical-align: middle; flex: 0 0 auto;
}
.bk-bm-btn:active { background: var(--interactive-soft-bg, rgba(102,126,234,.08)); }
.bk-bm-btn.bookmarked { color: var(--brand, #667eea); }

/* Toast 通知 */
.bk-bm-toast {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%) translateY(20px);
  background: var(--heading, #1a1a2e); color: #fff; padding: 10px 18px; border-radius: 22px;
  font-size: 13px; display: flex; align-items: center; gap: 12px;
  box-shadow: 0 4px 16px rgba(0,0,0,.2); opacity: 0;
  transition: opacity .25s, transform .25s; z-index: 9200;
  white-space: nowrap; pointer-events: none;
}
.bk-bm-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }
.bk-bm-toast-undo {
  color: var(--brand, #667eea); font-weight: 600; cursor: pointer;
  padding: 2px 6px; border-radius: 4px;
}
.bk-bm-toast-undo:active { opacity: .7; }

/* 书签列表对话框 */
.bk-bm-list-dialog {
  display: flex; flex-direction: column; max-height: 70vh;
  width: min(380px, calc(100vw - 32px)); background: var(--surface, #fafbff);
  border-radius: 14px; overflow: hidden; box-shadow: var(--dialog-shadow, 0 8px 32px rgba(0,0,0,.18));
}
.bk-bm-list-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--border, #e0e3ef); flex-shrink: 0;
}
.bk-bm-list-title { font-size: 15px; font-weight: 600; color: var(--heading, #111128); }
.bk-bm-list-close {
  background: none; border: none; font-size: 20px; color: var(--text-muted, #8888a0);
  cursor: pointer; padding: 4px 8px; border-radius: 6px; line-height: 1;
}
.bk-bm-list-close:active { background: var(--surface-alt, #f0f2f8); }
.bk-bm-list-body {
  flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 8px 0;
}
.bk-bm-list-footer {
  border-top: 1px solid var(--border, #e0e3ef); padding: 10px 16px;
  text-align: center; flex-shrink: 0;
}
.bk-bm-clear-all {
  background: none; border: 1px solid var(--border, #e0e3ef); color: var(--danger-text, #c62828);
  font-size: 12px; padding: 6px 16px; border-radius: 6px; cursor: pointer;
}
.bk-bm-clear-all:active { background: var(--surface-alt, #f0f2f8); }

/* 书签项 */
.bk-bm-item {
  display: flex; align-items: center; padding: 10px 16px; gap: 8px; transition: background .15s;
}
.bk-bm-item:active { background: var(--nav-hover, #eef1fa); }
.bk-bm-item-main { flex: 1; min-width: 0; cursor: pointer; }
.bk-bm-item-title {
  font-size: 14px; color: var(--text, #1a1a2e); line-height: 1.5;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bk-bm-item-meta { font-size: 11px; color: var(--text-muted, #8888a0); margin-top: 2px; }
.bk-bm-item-del {
  background: none; border: none; color: var(--text-muted, #8888a0); font-size: 14px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer; flex-shrink: 0;
  opacity: .6; transition: opacity .15s, color .15s;
}
.bk-bm-item-del:active { opacity: 1; color: var(--danger-text, #c62828); }

/* 空状态 */
.bk-bm-empty { padding: 40px 20px; text-align: center; }
.bk-bm-empty-icon { font-size: 36px; margin-bottom: 12px; opacity: .5; }
.bk-bm-empty-text { font-size: 14px; color: var(--text-muted, #8888a0); font-weight: 500; }
.bk-bm-empty-hint { font-size: 12px; color: var(--text-muted, #8888a0); margin-top: 6px; opacity: .7; }

/* 确认对话框（清空确认） */
.bk-bm-confirm-actions { display: flex; border-top: 1px solid var(--border, #e0e3ef); }
.bk-bm-confirm-cancel, .bk-bm-confirm-ok {
  flex: 1; padding: 13px; background: none; border: none; font-size: 14px; cursor: pointer;
}
.bk-bm-confirm-cancel { color: var(--text-muted, #8888a0); border-right: 1px solid var(--border, #e0e3ef); }
.bk-bm-confirm-ok { color: var(--danger-text, #c62828); font-weight: 600; }
.bk-bm-confirm-cancel:active, .bk-bm-confirm-ok:active { background: var(--surface-alt, #f0f2f8); }

/* ── 清除对话框选项 ──────────────────────────────────────────── */
.bk-dialog-desc { font-size: 12px; color: var(--text-muted, #8888a0); padding: 4px 16px 12px; text-align: center; line-height: 1.6; }
.bk-dialog-opts { display: flex; flex-direction: column; gap: 8px; padding: 0 16px 14px; }
.bk-dialog-opt {
  display: flex; align-items: flex-start; gap: 11px; padding: 11px 12px;
  border: 1.5px solid var(--border, #e0e3ef); border-radius: 10px; cursor: pointer;
  background: var(--surface-alt, #f0f2f8); -webkit-tap-highlight-color: transparent;
  transition: border-color .15s, background .15s;
}
.bk-dialog-opt.selected { border-color: var(--brand, #667eea); background: var(--interactive-soft-bg, rgba(102,126,234,.08)); }
.bk-dialog-opt-icon { font-size: 20px; flex-shrink: 0; margin-top: 1px; }
.bk-dialog-opt-body { flex: 1; }
.bk-dialog-opt-title { font-size: 13px; font-weight: 600; color: var(--heading, #111128); margin-bottom: 2px; }
.bk-dialog-opt-sub { font-size: 11px; color: var(--text-muted, #8888a0); line-height: 1.5; }

/* ── 经文引用可点击样式 ──────────────────────────────────────── */
.scripture-ref { color: var(--text-soft, #4b5563); font-size: 0.93em; margin-left: 2px; }
.scripture-ref[data-refs] {
  cursor: pointer; color: var(--accent-color, #4a90d9);
  text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;
  transition: color .15s, text-decoration-color .15s;
}
.scripture-ref[data-refs]:hover { color: var(--brand, #667eea); text-decoration-style: solid; }
[data-theme="dark"] .scripture-ref[data-refs] { color: var(--brand, #8ea4f0); }
[data-theme="dark"] .scripture-ref[data-refs]:hover { color: #a8bcff; }
.verse-ref {
  color: var(--brand, #667eea); text-decoration: underline; text-decoration-style: dotted;
  text-underline-offset: 2px; cursor: pointer; -webkit-tap-highlight-color: transparent;
}

/* ── 经文弹框（scripture-popup.js）──────────────────────────── */
.scripture-popup-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: var(--overlay-strong, rgba(0,0,0,.45)); z-index: 1200;
  display: flex; align-items: center; justify-content: center;
  padding: 16px; visibility: hidden; pointer-events: none;
}
.scripture-popup-overlay--open { visibility: visible; pointer-events: auto; }
.scripture-popup {
  background: var(--surface, #fafbff); border-radius: 14px; width: 100%;
  max-width: 560px; max-height: 80vh; display: flex; flex-direction: column;
  box-shadow: var(--dialog-shadow, 0 8px 32px rgba(0,0,0,.2)); overflow: hidden;
}
.scripture-popup-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px 12px; border-bottom: 1px solid var(--border, #e0e3ef); flex-shrink: 0;
}
.scripture-popup-title {
  font-size: 0.95em; font-weight: 600; color: var(--brand, #667eea);
  flex: 1; margin-right: 8px; word-break: break-all; line-height: 1.5;
}
.scripture-popup-close {
  width: 28px; height: 28px; border: none; background: var(--surface-alt, #f0f2f8);
  border-radius: 50%; cursor: pointer; font-size: 14px; color: var(--text-muted, #8888a0);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  -webkit-tap-highlight-color: transparent;
}
.scripture-popup-close:active { background: var(--border, #e0e3ef); }
.scripture-popup-body {
  overflow-y: auto; padding: 12px 16px 20px; flex: 1;
  -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
}
.scripture-popup-verse { display: flex; align-items: baseline; margin-bottom: 10px; line-height: 1.85; }
.scripture-popup-verse:last-child { margin-bottom: 0; }
.scripture-popup-ref { flex-shrink: 0; font-size: 0.88em; color: var(--brand, #667eea); font-weight: 600; padding-right: 0.4em; }
.scripture-popup-text { flex: 1; font-size: 1em; color: var(--text, #1a1a2e); }
.scripture-popup-verse--missing .scripture-popup-text { color: var(--text-muted, #8888a0); font-style: italic; }
.scripture-popup-empty { color: var(--text-muted, #8888a0); text-align: center; padding: 20px 0; font-size: 0.95em; }
.scripture-popup-loading { color: var(--text-muted, #8888a0); text-align: center; padding: 24px 0; font-size: 0.95em; min-height: 80px; }
.scripture-popup-fn-body { font-size: 1em; color: var(--text, #1a1a2e); line-height: 1.9; text-align: justify; }
.scripture-popup-back {
  width: 28px; height: 28px; border: none; background: none; cursor: pointer;
  font-size: 16px; color: var(--brand, #667eea); display: flex; align-items: center;
  justify-content: center; flex-shrink: 0; margin-right: 4px;
  -webkit-tap-highlight-color: transparent; padding: 0;
}
.scripture-popup-back:active { background: var(--surface-alt, #f0f2f8); border-radius: 50%; }
.fn-ref {
  font-size: .68em; vertical-align: super; line-height: 0; color: var(--brand, #667eea);
  font-weight: 700; cursor: pointer; padding: 0 1px;
  -webkit-tap-highlight-color: transparent; user-select: none;
}
.xref-ref {
  font-size: .65em; vertical-align: super; line-height: 0; color: var(--brand, #667eea);
  font-weight: 700; cursor: pointer; padding: 0 1px;
  -webkit-tap-highlight-color: transparent; user-select: none;
}

/* ── 平板（>=600px）底部扩展框覆盖 ─────────────────────────── */
@media (min-width: 600px) {
  .scripture-popup-overlay { background: transparent; visibility: visible; pointer-events: none; transition: none; align-items: flex-end; padding: 0; }
  .scripture-popup-overlay--open { visibility: visible; pointer-events: none; }
  .scripture-popup {
    position: fixed; bottom: 0; left: 0; right: 0; width: 100%;
    pointer-events: auto; border-radius: 16px 16px 0 0; max-width: 100%;
    max-height: 50vh; transform: translateY(100%); transition: transform .2s ease-out;
    box-shadow: 0 -4px 24px rgba(0,0,0,.15); padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .scripture-popup-overlay--open .scripture-popup { transform: translateY(0); }
  .scripture-popup::before { content: ''; display: block; width: 36px; height: 4px; border-radius: 2px; background: var(--border, #e0e3ef); margin: 8px auto 0; flex-shrink: 0; }
}

/* ── 经文块样式 ────────────────────────────────────────────── */
.scripture-block {
  margin: 8px 0; padding: 10px 14px; background: var(--surface-alt, #f0f2f8);
  border-left: 3px solid var(--brand, #667eea); border-radius: 6px;
  font-size: 1.05em; line-height: 1.85;
}
.scripture-block .scripture-popup-verse { display: flex; align-items: baseline; margin-bottom: 4px; }
.scripture-block .scripture-popup-verse:last-child { margin-bottom: 0; }
.scripture-block .scripture-popup-ref { flex-shrink: 0; font-size: 0.88em; color: var(--brand, #667eea); font-weight: 600; padding-right: 0.4em; }
.scripture-block .scripture-popup-text { flex: 1; color: var(--text, #1a1a2e); font-size: 1em; }
.scripture-block-static {
  margin: 8px 0; padding: 10px 14px; background: var(--surface-alt, #f0f2f8);
  border-left: 3px solid var(--brand, #667eea); border-radius: 6px;
  font-size: 1.01em; color: var(--text, #1a1a2e); line-height: 1.8;
  font-weight: 550; text-align: justify; letter-spacing: 0.1px;
}

/* ── 搜索高亮（search.js） ───────────────────────────────────── */
.bk-search-hl { background-color: #ffe082; color: inherit; border-radius: 3px; padding: 0 2px; font-weight: 500; box-shadow: 0 0 0 1px rgba(255,179,71,0.3); }
[data-theme="dark"] .bk-search-hl { background-color: rgba(255,179,71,0.35); box-shadow: none; }

/* ── 搜索模态框与结果样式 ──────────────────────────────────────── */
.bk-search-overlay { position: fixed; inset: 0; background: var(--overlay-strong, rgba(0,0,0,.45)); z-index: 500; display: flex; align-items: flex-start; justify-content: center; padding: 16px; }
.bk-search-modal { width: 100%; max-width: 560px; max-height: 85vh; background: var(--surface, #fafbff); border-radius: 14px; box-shadow: var(--dialog-shadow); display: flex; flex-direction: column; overflow: hidden; }
.bk-search-header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.bk-search-input { flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; font-size: 15px; background: var(--surface-alt); color: var(--text); outline: none; }
.bk-search-input:focus { border-color: var(--brand); box-shadow: 0 0 0 2px var(--interactive-soft-border, rgba(102,126,234,.16)); }
.bk-search-close { background: none; border: none; font-size: 20px; color: var(--text-muted); cursor: pointer; padding: 4px 8px; min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 50%; }
.bk-search-close:active { background: var(--surface-alt); }
.bk-search-toolbar { padding: 8px 14px; border-bottom: 1px solid var(--border); }
.bk-search-scope-toggle { display: flex; gap: 12px; }
.bk-scope-label { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-soft); cursor: pointer; }
.bk-search-count { padding: 8px 14px; font-size: 13px; color: var(--text-muted); border-bottom: 1px solid var(--border); }
.bk-search-results { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.bk-search-loading, .bk-search-empty, .bk-search-hint { padding: 32px 16px; text-align: center; color: var(--text-muted); font-size: 14px; }
.bk-search-empty { font-size: 15px; }
.bk-search-series-group { padding: 4px 0; }
.bk-search-series-title { padding: 8px 14px 4px; font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.bk-search-group { padding: 0 14px; }
.bk-search-group-title { padding: 8px 0 4px; font-size: 14px; font-weight: 600; color: var(--text); }
.bk-search-item { display: block; padding: 10px 12px; margin: 2px 0; border-radius: 8px; text-decoration: none; color: inherit; transition: background 0.15s; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.bk-search-item:hover { background: var(--nav-hover); }
.bk-search-item:active { background: var(--nav-hover); transform: scale(0.99); }
.bk-search-item-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.bk-search-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; font-weight: 500; }
.bk-tag-title { background: rgba(var(--brand-rgb, 102,126,234), 0.12); color: var(--brand, #667eea); }
.bk-tag-content { background: rgba(255,179,71,0.18); color: var(--warning-text, #e65100); }
.bk-search-chapter { font-size: 12px; color: var(--text-muted); }
.bk-search-item-text { font-size: 13px; color: var(--text-soft); line-height: 1.5; }
.bk-search-hint-text { font-style: italic; opacity: 0.7; }
.bk-search-load-more { padding: 12px; text-align: center; }
.bk-search-load-btn { padding: 8px 20px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-alt); color: var(--text); font-size: 13px; cursor: pointer; }
.bk-search-load-btn:active { transform: scale(0.97); background: var(--nav-hover); }
.bk-search-content-loading { padding: 12px 16px; text-align: center; font-size: 13px; color: var(--text-muted); }
.bk-search-popular { padding: 16px; }
.bk-search-popular-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 12px; }
.bk-search-series-list { display: flex; flex-wrap: wrap; gap: 8px; }
.bk-search-series-card { display: inline-flex; flex-direction: column; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-alt); text-decoration: none; color: inherit; cursor: pointer; transition: background 0.15s, transform 0.15s; -webkit-tap-highlight-color: transparent; }
.bk-search-series-card:hover { background: var(--nav-hover); transform: translateY(-1px); }
.bk-search-series-card:active { transform: scale(0.97); }
.bk-search-series-name { font-size: 13px; font-weight: 500; color: var(--text); }
.bk-search-series-count { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

/* ── 反馈对话框 ────────────────────────────────────────────────── */
.bk-feedback-box { background: var(--surface, #fff); border-radius: 14px; width: min(360px, calc(100vw - 40px)); max-height: 80vh; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,.22); display: flex; flex-direction: column; }
.bk-feedback-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.bk-feedback-title { font-size: 16px; font-weight: 600; color: var(--heading, #111); }
.bk-feedback-close { width: 28px; height: 28px; border-radius: 50%; border: none; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent; }
.bk-feedback-close:active { background: var(--nav-hover); }
.bk-feedback-body { flex: 1; overflow-y: auto; padding: 12px 16px 8px; }
.bk-feedback-textarea { width: 100%; min-height: 120px; max-height: 40vh; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-alt, #f5f5f5); color: var(--text); font: inherit; font-size: 14px; line-height: 1.6; resize: vertical; box-sizing: border-box; outline: none; transition: border-color .15s; }
.bk-feedback-textarea:focus { border-color: var(--brand, #667eea); }
.bk-feedback-count { text-align: right; font-size: 11px; color: var(--text-muted); margin-top: 4px; }
.bk-feedback-status { font-size: 12px; min-height: 18px; margin-top: 6px; text-align: center; }
.bk-feedback-status.success { color: #2e7d32; }
.bk-feedback-status.error { color: #c62828; }
.bk-feedback-actions { display: flex; border-top: 1px solid var(--border); flex-shrink: 0; }
.bk-feedback-cancel, .bk-feedback-submit { flex: 1; padding: 13px 8px; border: none; background: transparent; font: inherit; font-size: 15px; cursor: pointer; text-align: center; -webkit-tap-highlight-color: transparent; }
.bk-feedback-cancel { color: var(--text-muted); border-right: 1px solid var(--border); }
.bk-feedback-submit { color: var(--brand, #667eea); font-weight: 600; }
.bk-feedback-cancel:active, .bk-feedback-submit:active { background: var(--nav-hover, rgba(0,0,0,.04)); }
.bk-feedback-submit:disabled { opacity: .5; cursor: default; }

/* ── 全局交互反馈增强 ──────────────────────────────────────────── */
button:active { transition-duration: 0.05s; }

/* 页面淡入动画优化 */
@keyframes bk-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.bk-view-enter-active { animation: bk-fade-in 0.2s ease-out; }

/* ── 响应式适配 ──────────────────────────────────────────────── */
@media (max-width: 374px) {
  .series-tabs { gap: 6px; padding: 10px 12px; }
  .series-tab { padding: 5px 12px; font-size: 13px; }
  .book-grid { padding: 0 12px 12px; }
  .zl-book-card .book-link { padding: 10px 12px; }
  .header { padding: 20px 12px 10px; }
  .header h1 { font-size: 20px; }
  .bk-reading-chapter-title { font-size: 17px; }
  #chapterContent { font-size: 0.95em; }
}
@media (max-width: 768px) {
  .book-grid { grid-template-columns: 1fr !important; }
  .category-grid { grid-template-columns: 1fr !important; }
}

/* ── TTS 朗读高亮（speech.js） ───────────────────────────────── */
mark.bk-tts-sent { background-color: transparent; color: inherit; font: inherit; border-radius: 2px; transition: background-color 0.25s; }
.bk-tts-expand-tmp { display: none; }
mark.bk-tts-sent.bk-tts-active { background-color: rgba(79,125,219,0.22); }
.bk-tts-active { background-color: rgba(79,125,219,0.18); border-radius: 2px; transition: background-color 0.25s; }
.scripture-block-static.bk-tts-active { background: rgba(79,125,219,0.22); }

/* ── 主题覆盖 ──────────────────────────────────────────────── */
[data-theme="warm"] .hl-modal-save { background: var(--interactive-soft-bg, rgba(180,145,85,.12)); color: var(--brand, #A67C52); border-color: var(--brand, #A67C52); }
[data-theme="warm"] .hl-underline-btn.active { background: var(--interactive-soft-bg, rgba(180,145,85,.12)); color: var(--brand, #A67C52); border-color: var(--brand, #A67C52); border-bottom-color: #e53935; }
[data-theme="warm"] .scripture-block-static { background: #F7F2EA; }

/* ── 移动端触摸优化 ──────────────────────────────────────────── */
@media (max-width: 768px) {
  .hl-menu-btn { min-height: 44px; font-size: 14px; }
  .hl-ann-tool { min-height: 48px; }
  .hl-ann-note-expand { min-height: 36px; }
  .hl-color-dot { width: 34px; height: 34px; }
}
"""
        css_dir = os.path.join(self.output_dir, 'css')
        os.makedirs(css_dir, exist_ok=True)
        css_path = os.path.join(css_dir, 'style.css')
        with open(css_path, 'w', encoding='utf-8') as f:
            f.write(css_content)

        print("✓ style.css 已生成")

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

        # 3. 静态资源（先复制，避免后续生成的文件被覆盖）
        self.copy_static_assets()

        # 3.5 生成完整 CSS（覆盖占位 style.css）
        self.generate_css()

        # 4. 搜索索引
        self.generate_search_index(books)

        # 5. PWA manifest 和 Service Worker
        self.generate_manifest_and_sw()

        # 6. version.json
        if app_config:
            self.generate_version_json(app_config)

        # 6.5 复制 app_config.json 到 output/（供前端 loadConfig 回退路径使用）
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
