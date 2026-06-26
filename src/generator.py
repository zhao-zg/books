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
  --text: #1a1a2e; --text-muted: #8888a0; --heading: #111128;
  --brand: #667eea; --accent-color: #4a90d9;
  --border: #e0e3ef; --group-divider-bg: #ebedf5;
  --header-text: #333; --btn-primary-bg: #667eea;
  --btn-primary-text: #fff; --btn-primary-border: #667eea;
  --card-bg: #fff; --shadow-sm: 0 1px 3px rgba(0,0,0,.08);
  --success-text: #2e7d32; --danger-text: #c62828; --warning-text: #e65100;
  --muted: #ccc;
}
[data-theme="warm"] {
  --surface: #F7F2E8; --surface-alt: #EDE7D9; --nav-hover: #E8E0CE;
  --text: #3E2F1C; --text-muted: #8C7A62; --heading: #2B1E0E;
  --brand: #A67C52; --accent-color: #A67C52;
  --border: #D9CEBC; --group-divider-bg: #E0D5C3;
  --header-text: #3E2F1C; --btn-primary-bg: #A67C52;
  --btn-primary-text: #fff; --btn-primary-border: #A67C52;
  --card-bg: #FBF7EF; --shadow-sm: 0 1px 3px rgba(0,0,0,.06);
  --success-text: #558B2F; --danger-text: #BF360C; --warning-text: #E65100;
  --muted: #C4B9A8;
}
[data-theme="dark"] {
  --surface: #181b21; --surface-alt: #1e2128; --nav-hover: #272b34;
  --text: #e0e0e0; --text-muted: #888; --heading: #f0f0f0;
  --brand: #8ea4f0; --accent-color: #8ea4f0;
  --border: #2e323b; --group-divider-bg: #22252c;
  --header-text: #e0e0e0; --btn-primary-bg: #556bba;
  --btn-primary-text: #fff; --btn-primary-border: #556bba;
  --card-bg: #1e2128; --shadow-sm: 0 1px 3px rgba(0,0,0,.3);
  --success-text: #66bb6a; --danger-text: #ef5350; --warning-text: #ffa726;
  --muted: #444;
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
.series-tabs { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; }
.series-tab { padding: 6px 16px; border-radius: 20px; border: 1px solid var(--border); background: transparent; color: var(--text); font-size: 14px; cursor: pointer; transition: all 0.2s; -webkit-tap-highlight-color: transparent; }
.series-tab:active { transform: scale(0.96); }
.series-tab.active { background: var(--accent-color, #4a90d9); color: white; border-color: var(--accent-color, #4a90d9); }

/* ── 书籍卡片增强 ───────────────────────────────────────── */
.book-grid { display: grid; gap: 1px; padding: 0 16px 16px; background: transparent; }
@media (min-width: 768px) { .book-grid { grid-template-columns: repeat(2, 1fr); gap: 12px; } }
@media (min-width: 1024px) { .book-grid { grid-template-columns: repeat(3, 1fr); } }
.zl-book-card { background: var(--card-bg, var(--surface)); border-radius: 8px; overflow: hidden; transition: background-color .2s; border: 1px solid var(--border); }
.zl-book-card:hover { background: var(--nav-hover); }
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

/* ── 批量下载面板 ───────────────────────────────────────── */
.download-panel { position: fixed; bottom: 0; left: 0; right: 0; background: var(--card-bg, var(--surface)); border-top: 1px solid var(--border); padding: 16px; transform: translateY(100%); transition: transform 0.3s ease; z-index: 200; max-height: 70vh; overflow-y: auto; border-radius: 16px 16px 0 0; box-shadow: 0 -4px 20px rgba(0,0,0,.15); }
.download-panel.open { transform: translateY(0); }
.download-panel-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 199; }
.download-panel-overlay.open { display: block; }
.download-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.download-panel-title { font-size: 16px; font-weight: 600; color: var(--text); }
.download-panel-close { background: none; border: none; font-size: 18px; color: var(--text-muted); cursor: pointer; padding: 4px 8px; }
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
.nav-link { display: flex; align-items: center; gap: 4px; padding: 10px 14px; text-decoration: none; color: var(--brand); font-size: 14px; border-radius: 8px; transition: background .15s; -webkit-tap-highlight-color: transparent; cursor: pointer; }
.nav-link:active { background: var(--nav-hover); }
.nav-link.nav-disabled { color: var(--text-muted); opacity: .4; pointer-events: none; }
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
  width: 32px;
  height: 32px;
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

        # 7. .nojekyll（GitHub Pages 兼容）
        nojekyll_path = os.path.join(self.output_dir, '.nojekyll')
        with open(nojekyll_path, 'w') as f:
            f.write('')
