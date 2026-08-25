#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一书籍数据构建脚本

直接读取 resource/ysz/ 下的 122 个 txt 原始缓存文件，
复用 process_ysz_books.py 的解析逻辑（Zo.txt 目录骨架 + HTML/MD 内容提取），
输出 ysz JSON + 索引到 output/zl-merged/（前端 DataManager 消费）。

同时处理 resource/books/ 下的非 ysz 内置书（epub/md/txt），转为 JSON 并入同一输出目录。

目录结构:
  output/zl-merged/
  ├── books-index.json       (全局索引)
  ├── manifest.json           (版本信息)
  ├── _headers                (CORS 配置)
  ├── books/                  (系列目录，含 index.json + 书籍 JSON)
  │   ├── index.json
  │   ├── books-1-1001.json
  │   └── ...
  ├── smdj8/
  └── ...
"""

import sys
import os
import re
import json
import logging
import argparse
import shutil
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional, Any

# 复用 process_ysz_books.py 的核心解析函数
sys.path.insert(0, str(Path(__file__).parent))
from process_ysz_books import (
    parse_zo_index,
    build_content_lookup,
    assemble_books,
    sanitize_text,
    clean_chapter_title,
    SERIES_TITLE_MAP,
    SERIES_ORDER,
)

BASE_DIR = Path(__file__).parent
DEFAULT_INPUT_DIR = BASE_DIR / 'resource' / 'ysz'
DEFAULT_BOOKS_SRC_DIR = BASE_DIR / 'resource' / 'books'
DEFAULT_OUTPUT_DIR = BASE_DIR / 'output'
DEFAULT_MERGED_DIR = DEFAULT_OUTPUT_DIR / 'zl-merged'

# books 系列的分类 prefix → 名称
BOOKS_CATEGORIES = {
    '1': '福音类',
    '2': '造就类',
    '3': '教会与事奉类',
    '4': '读经类',
    '5': '传记文集类',
    '7': '代售及期刊类',
    '8': '其他类',
}

# 内置书支持的扩展名
SUPPORTED_EXTS = {'.epub': 'epub', '.md': 'md', '.markdown': 'md', '.txt': 'txt'}

# 中国时区
TZ_CN = timezone(timedelta(hours=8))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def sanitize_filename(name: str) -> str:
    """将标题转为安全的文件名"""
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    if len(name) > 200:
        name = name[:200]
    return name


def save_json(path: Path, data: Any) -> None:
    """将对象序列化为 JSON 写入文件"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')





# ---------------------------------------------------------------------------
# ysz JSON 生成
# ---------------------------------------------------------------------------

def generate_book_ysz_json(book_data: dict) -> dict:
    """将书籍数据转为 ysz JSON 格式（前端 DataManager 消费）

    输出格式：
    {
      "id": "books-1-1001",
      "title": "1001-到底有没有神",
      "category": "福音类",        // 仅 books 系列
      "category_prefix": "1",      // 仅 books 系列
      "format": "html",
      "chapters": [{"number": 1, "title": "序言", "content": "..."}]
    }
    """
    book_id = book_data.get('id', '')
    title = book_data.get('title', '')
    category = book_data.get('category', '')
    category_prefix = book_data.get('category_prefix', '')
    chapters = book_data.get('chapters', [])

    result = {
        'id': book_id,
        'title': title,
        'format': 'html',
        'chapters': [
            {
                'number': ch.get('number', 0),
                'title': clean_chapter_title(ch.get('title', '')),
                'content': ch.get('content', ''),
            }
            for ch in chapters
        ],
    }

    # books 系列额外字段
    if category:
        result['category'] = category
    if category_prefix:
        result['category_prefix'] = category_prefix

    return result


def generate_series_index(books_info: list, series_id: str) -> list:
    """生成系列 index.json（ysz 格式：纯数组）

    books 系列的条目有额外的 category / category_prefix 字段。
    """
    index = []
    for b in books_info:
        entry = {
            'id': b['id'],
            'title': b['title'],
            'chapter_count': b['chapter_count'],
            'series': series_id,
        }
        if 'category' in b:
            entry['category'] = b['category']
        if 'category_prefix' in b:
            entry['category_prefix'] = b['category_prefix']
        index.append(entry)
    return index


# ---------------------------------------------------------------------------
# 内置书处理（非 ysz 来源的 md/epub/txt）
# ---------------------------------------------------------------------------

def scan_bundled_books(books_dir: Path) -> list:
    """扫描 resource/books/ 下非 ysz 系列目录，返回系列列表"""
    if not books_dir.is_dir():
        return []

    ysz_series_names = set(SERIES_TITLE_MAP.values())
    series_list = []

    for entry in sorted(books_dir.iterdir()):
        if not entry.is_dir():
            continue
        # 跳过 ysz 生成的系列目录
        if entry.name in ysz_series_names:
            continue

        series_files = []
        for f in sorted(entry.rglob('*')):
            if not f.is_file():
                continue
            ext = f.suffix.lower()
            fmt = SUPPORTED_EXTS.get(ext)
            if not fmt:
                continue
            rel_path = f.relative_to(books_dir).as_posix()
            stem = f.stem
            file_info = {
                'file': rel_path,
                'format': fmt,
                'size': f.stat().st_size,
                'title': stem,
            }
            # 从子文件夹路径提取 category
            rel_to_series = f.relative_to(entry).as_posix()
            parts = rel_to_series.split('/')
            if len(parts) > 1:
                file_info['category'] = parts[0]
            series_files.append(file_info)

        if not series_files:
            continue

        series_list.append({
            'id': entry.name,
            'name': entry.name,
            'files': series_files,
        })

    return series_list


def _convert_via_node(input_path: Path, book_id: str, series_id: str) -> Optional[dict]:
    """调用 Node.js convert-bundled.js 将文件转为 ysz JSON 格式"""
    script = BASE_DIR / 'src' / 'convert-bundled.js'
    if not script.is_file():
        log.error('Node.js 转换脚本不存在: %s', script)
        return None

    try:
        result = subprocess.run(
            ['node', str(script), str(input_path), book_id, series_id],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=60,
            cwd=str(BASE_DIR),
        )
    except FileNotFoundError:
        log.error('node 命令未找到，请确保 Node.js 已安装并在 PATH 中')
        return None
    except subprocess.TimeoutExpired:
        log.error('Node.js 转换超时 (60s): %s', input_path)
        return None

    if result.returncode != 0:
        log.error('Node.js 转换失败 (%d): %s\n  stderr: %s',
                  result.returncode, input_path,
                  result.stderr.strip()[:500] if result.stderr else '')
        return None

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as e:
        log.error('Node.js 输出 JSON 解析失败: %s - %s', input_path, e)
        return None


def process_bundled_books(books_src_dir: Path, merged_dir: Path,
                          dry_run: bool = False) -> Dict[str, Any]:
    """处理非 ysz 内置书：转为 ysz JSON 放入 zl-merged，返回索引信息"""
    series_list = scan_bundled_books(books_src_dir)
    if not series_list:
        log.info('未发现非ysz内置资源目录，跳过')
        return {'series': [], 'books': []}

    log.info(f'\n发现 {len(series_list)} 个非ysz内置系列: '
             f'{", ".join(s["id"] for s in series_list)}')

    index_series = []
    index_books = []

    for series in series_list:
        sid = series['id']
        files = series['files']

        if not dry_run:
            series_dir = merged_dir / sid
            series_dir.mkdir(parents=True, exist_ok=True)

        series_index = []

        for f in files:
            src_path = books_src_dir / f['file']
            book_id = f'bundle-{sid}__{f["title"]}'

            log.info(f'  转换: {f["file"]} → {book_id}')

            book_data = _convert_via_node(src_path, book_id, sid)
            if book_data is None:
                log.warning('  跳过转换失败的文件: %s', src_path)
                continue

            title = book_data.get('title', f['title'])
            chapters = book_data.get('chapters', [])
            chapter_count = len(chapters)

            # 生成书籍 JSON（ysz 格式）
            book_json = {
                'id': book_id,
                'title': title,
                'format': 'html',
                'chapters': chapters,
            }

            if not dry_run:
                book_path = merged_dir / sid / (book_id + '.json')
                save_json(book_path, book_json)

            series_index.append({
                'id': book_id,
                'title': title,
                'chapter_count': chapter_count,
                'series': sid,
            })

            # books-index 条目
            index_books.append({
                'id': book_id,
                'title': title,
                'series': sid,
                'chapter_count': chapter_count,
                'bundled': True,
                'format': f['format'],
                'file': f['file'],
            })

        if not dry_run and series_index:
            save_json(merged_dir / sid / 'index.json', series_index)

        # series 条目（仅当系列内有实际书籍时才注册，避免 0 本书的空系列污染索引）
        if not series_index:
            log.info(f'  => 内置系列 {sid}: 0 本，跳过注册（无有效书籍）')
            continue
        index_series.append({
            'id': sid,
            'title': series['name'],
            'count': len(series_index),
            'type': 'bundle',
        })

        log.info(f'  => 内置系列 {sid}: {len(series_index)} 本, '
                 f'{sum(b["chapter_count"] for b in series_index)} 章')

    return {'series': index_series, 'books': index_books}


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def build_all(input_dir: Path, books_src_dir: Path, merged_dir: Path,
              dry_run: bool = False,
              series_filter: Optional[List[str]] = None,
              clean: bool = False,
              skip_bundled: bool = False) -> dict:
    """
    统一构建流程：
    1. 解析 Zo.txt 目录骨架
    2. 构建 URL→内容 查找表
    3. 组装书籍数据
    4. 输出 ysz JSON + 索引
    5. 处理非 ysz 内置书
    """
    zo_path = input_dir / 'Zo.txt'
    if not zo_path.exists():
        log.error(f'Zo.txt 不存在: {zo_path}')
        return {}

    # ── 清理旧内容 ──────────────────────────────────────────────
    if clean and not dry_run:
        if merged_dir.exists():
            log.info(f'清理输出目录: {merged_dir}')
            shutil.rmtree(merged_dir)

    if not dry_run:
        merged_dir.mkdir(parents=True, exist_ok=True)

    # ── Step 1: 解析 Zo.txt ────────────────────────────────────
    log.info(f'\n{"="*60}')
    log.info('Step 1: 解析 Zo.txt 主目录骨架')
    log.info(f'{"="*60}')
    skeleton = parse_zo_index(zo_path)

    # ── Step 2: 构建内容查找表 ──────────────────────────────────
    log.info(f'\n{"="*60}')
    log.info('Step 2: 构建 URL→内容 查找表')
    log.info(f'{"="*60}')
    lookup = build_content_lookup(input_dir)

    # ── Step 3: 组装书籍数据 ────────────────────────────────────
    log.info(f'\n{"="*60}')
    log.info('Step 3: 组装书籍数据')
    log.info(f'{"="*60}')
    all_books = assemble_books(skeleton, lookup, verbose=False, promote=False)

    # ── Step 4: 输出 ysz JSON ─────────────────────────────────
    log.info(f'\n{"="*60}')
    log.info('Step 4: 输出 ysz JSON')
    log.info(f'{"="*60}')

    stats = {'total_books': 0, 'total_series': 0, 'total_chapters': 0}

    # 索引数据（用于 books-index.json）
    index_series = []
    index_books = []

    for series_id in SERIES_ORDER:
        books = all_books.get(series_id, [])
        if not books:
            continue

        # 过滤指定系列
        if series_filter and series_id not in series_filter:
            continue

        series_title = SERIES_TITLE_MAP.get(series_id, series_id)
        log.info(f'\n系列: {series_title} ({series_id}), {len(books)} 本书')

        if not dry_run:
            series_merged_dir = merged_dir / series_id
            series_merged_dir.mkdir(parents=True, exist_ok=True)

        book_count = 0
        chapter_count = 0
        dup_check = {}  # 同系列下 book_id 去重
        series_index_entries = []
        series_categories = {}  # prefix -> {name, count}

        for book_data in books:
            # ── 同标题去重 ──
            book_id = book_data.get('id', '')
            title = book_data.get('title', '')
            if title in dup_check:
                first_id = dup_check[title]
                log.warning(f'  跳过重复书籍: {title} '
                           f'(book_id={book_id}), '
                           f'保留已有 book_id={first_id}')
                continue
            else:
                dup_check[title] = book_id

            # ── 输出 ysz JSON ──
            if not dry_run:
                book_json = generate_book_ysz_json(book_data)
                save_json(series_merged_dir / (book_id + '.json'), book_json)

            # 系列索引条目
            ch_count = len(book_data.get('chapters', []))
            index_entry = {
                'id': book_id,
                'title': book_data.get('title', ''),
                'chapter_count': ch_count,
                'series': series_id,
            }
            if 'group' in book_data:
                index_entry['group'] = book_data['group']
            if 'category' in book_data:
                index_entry['category'] = book_data['category']
            if 'category_prefix' in book_data:
                index_entry['category_prefix'] = book_data['category_prefix']
                # 统计分类
                cp = book_data['category_prefix']
                if cp not in series_categories:
                    series_categories[cp] = {
                        'name': book_data.get('category', ''),
                        'count': 0,
                    }
                series_categories[cp]['count'] += 1

            series_index_entries.append(index_entry)

            # 全局索引条目
            book_index_entry = {
                'id': book_id,
                'title': book_data.get('title', ''),
                'series': series_id,
                'chapter_count': ch_count,
            }
            if 'group' in book_data:
                book_index_entry['group'] = book_data['group']
            if 'category' in book_data:
                book_index_entry['category'] = book_data['category']
            if 'category_prefix' in book_data:
                book_index_entry['category_prefix'] = book_data['category_prefix']
            index_books.append(book_index_entry)

            book_count += 1
            chapter_count += ch_count

        # 写系列 index.json
        if not dry_run and series_index_entries:
            save_json(series_merged_dir / 'index.json', series_index_entries)

        # 系列索引摘要
        series_entry = {
            'id': series_id,
            'title': series_title,
            'count': book_count,
        }
        # 任何有分类的系列都生成 categories
        if series_categories:
            series_entry['categories'] = [
                {'prefix': cp, 'name': info['name'], 'count': info['count']}
                for cp, info in sorted(series_categories.items(),
                                       key=lambda x: int(x[0]) if x[0].isdigit() else 0)
            ]
        # 统计 groups（分组信息，如信息拾遗下的「清明上河图」「属灵书报及导读」等）
        series_groups = {}
        for book_data in books:
            gname = book_data.get('group', '')
            if gname:
                if gname not in series_groups:
                    series_groups[gname] = {'name': gname, 'count': 0}
                series_groups[gname]['count'] += 1
        if series_groups:
            series_entry['groups'] = [
                {'name': g, 'count': info['count']}
                for g, info in series_groups.items()
            ]
        index_series.append(series_entry)

        stats['total_books'] += book_count
        stats['total_series'] += 1
        stats['total_chapters'] += chapter_count
        log.info(f'  => {book_count} 本书, {chapter_count} 章')

    # ── Step 5: 处理非 ysz 内置书 ────────────────────────────────
    if not skip_bundled:
        log.info(f'\n{"="*60}')
        log.info('Step 5: 处理非ysz内置书')
        log.info(f'{"="*60}')
        bundled = process_bundled_books(books_src_dir, merged_dir, dry_run=dry_run)
        index_series.extend(bundled['series'])
        index_books.extend(bundled['books'])
        stats['total_books'] += len(bundled['books'])
        stats['total_series'] += len(bundled['series'])

    # ── Step 6: 生成全局索引文件 ─────────────────────────────────
    log.info(f'\n{"="*60}')
    log.info('Step 6: 生成全局索引文件')
    log.info(f'{"="*60}')

    # books-index.json
    merged_index = {
        'series': index_series,
        'books': index_books,
    }
    if not dry_run:
        save_json(merged_dir / 'books-index.json', merged_index)
    log.info(f'  books-index.json: {len(index_series)} 个系列, '
             f'{len(index_books)} 本书')

    # manifest.json（version 用时间戳，确保 APP 检测更新）
    total_chapters = sum(b.get('chapter_count', 0) for b in index_books)
    now = datetime.now(TZ_CN)
    manifest = {
        'version': int(now.strftime('%Y%m%d%H')),
        'generated_at': now.isoformat(),
        'total_books': len(index_books),
        'total_chapters': total_chapters,
    }
    if not dry_run:
        save_json(merged_dir / 'manifest.json', manifest)
    log.info(f'  manifest.json: version={manifest["version"]}, '
             f'{manifest["total_books"]} 本书, {manifest["total_chapters"]} 章')

    # _headers (CORS)
    if not dry_run:
        headers_path = merged_dir / '_headers'
        headers_path.write_text(
            '/*\n'
            '  Access-Control-Allow-Origin: *\n'
            '  Access-Control-Allow-Methods: GET, HEAD\n'
            '  Access-Control-Allow-Headers: Content-Type\n',
            encoding='utf-8',
        )
        log.info('  _headers (CORS) 已生成')

    # books/categories.json（从 books-index.json 中 books 系列的 categories 提取）
    if not dry_run:
        for s in index_series:
            if s['id'] == 'books' and s.get('categories'):
                save_json(merged_dir / 'books' / 'categories.json', s['categories'])
                log.info(f'  books/categories.json: {len(s["categories"])} 个分类')
                break

    # ── 输出统计 ──────────────────────────────────────────────────
    log.info(f'\n{"="*60}')
    log.info('构建完成!')
    log.info(f'{"="*60}')
    log.info(f'总计: {stats["total_series"]} 个系列, '
             f'{stats["total_books"]} 本书, '
             f'{stats["total_chapters"]} 章')
    log.info(f'  ysz JSON 输出: {merged_dir}')

    return stats


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='统一书籍数据构建脚本 (替代 process_ysz_books.py + merge_zl_data.py)')
    parser.add_argument('--input-dir', type=str, default=str(DEFAULT_INPUT_DIR),
                        help=f'YSZ 输入目录 (默认 {DEFAULT_INPUT_DIR})')
    parser.add_argument('--books-src-dir', type=str, default=str(DEFAULT_BOOKS_SRC_DIR),
                        help=f'内置书源文件目录 (默认 {DEFAULT_BOOKS_SRC_DIR})')
    parser.add_argument('--merged-dir', type=str, default=str(DEFAULT_MERGED_DIR),
                        help=f'ysz JSON 输出目录 (默认 {DEFAULT_MERGED_DIR})'
                             '（默认输出到 output/zl-merged/，不再落盘 resource/）')
    parser.add_argument('--dry-run', action='store_true',
                        help='模拟运行，不写入文件')
    parser.add_argument('--series', type=str, nargs='*', default=None,
                        help='只处理指定系列（如 books smdj8 nee）')
    parser.add_argument('--clean', action='store_true',
                        help='清空输出目录后再生成')
    parser.add_argument('--skip-bundled', action='store_true',
                        help='跳过非ysz内置书处理')
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    books_src_dir = Path(args.books_src_dir)
    merged_dir = Path(args.merged_dir)

    log.info(f'YSZ 输入目录: {input_dir}')
    log.info(f'内置书源目录: {books_src_dir}')
    log.info(f'ysz JSON 输出: {merged_dir}')
    if args.dry_run:
        log.info('=== 模拟运行模式 (dry-run) ===')

    if not input_dir.exists():
        log.error(f'输入目录不存在: {input_dir}')
        return 1

    stats = build_all(
        input_dir, books_src_dir, merged_dir,
        dry_run=args.dry_run,
        series_filter=args.series,
        clean=args.clean,
        skip_bundled=args.skip_bundled,
    )

    if not stats:
        log.error('构建失败，未生成任何数据')
        return 1

    return 0


if __name__ == '__main__':
    exit(main())
