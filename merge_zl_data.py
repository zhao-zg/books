# -*- coding: utf-8 -*-
"""
数据合并脚本：将 zl-ysz 复制到 zl-merged
重新生成 books-index.json、manifest.json 和 _headers。

用法:
    python merge_zl_data.py                # 正常合并
    python merge_zl_data.py --dry-run      # 仅统计，不复制文件
    python merge_zl_data.py --force        # 删除已有 zl-merged 后重新合并
"""

import json
import shutil
import logging
import argparse
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
YSZ_DIR = BASE_DIR / 'resource' / 'zl-ysz'
MERGED_DIR = BASE_DIR / 'resource' / 'zl-merged'
BOOKS_DIR = BASE_DIR / 'resource' / 'books'

SUPPORTED_EXTS = {'.epub': 'epub', '.md': 'md', '.markdown': 'md', '.txt': 'txt'}

TZ_CN = timezone(timedelta(hours=8))

# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def load_json(path: Path) -> Any:
    """读取 JSON 文件并返回解析后的对象。"""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path: Path, data: Any) -> None:
    """将对象序列化为 JSON 写入文件（ensure_ascii=False, indent=2）。"""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


# ---------------------------------------------------------------------------
# 核心逻辑
# ---------------------------------------------------------------------------
def copy_base_data(src: Path, dst: Path) -> None:
    """将 zl-ysz 整体复制到 zl-merged。"""
    log.info('复制基础数据: %s → %s', src, dst)
    shutil.copytree(src, dst)


def count_chapters(merged_dir: Path, merged_index: Dict[str, Any]) -> int:
    """遍历合并后目录中的书籍 JSON 文件，统计总章节数。

    优先使用 books-index 中的 chapter_count，
    如果某本书缺少该字段则尝试从文件中读取。
    """
    total = 0
    for book in merged_index['books']:
        total += book.get('chapter_count', 0)
    return total


def generate_manifest(
    merged_index: Dict[str, Any],
    total_chapters: int,
) -> Dict[str, Any]:
    """生成 manifest.json 数据。"""
    return {
        'version': 1,
        'generated_at': datetime.now(TZ_CN).isoformat(),
        'total_books': len(merged_index['books']),
        'total_chapters': total_chapters,
    }


def generate_headers(merged_dir: Path) -> None:
    """生成 Cloudflare Pages CORS _headers 文件。"""
    headers_path = merged_dir / '_headers'
    content = (
        '/*\n'
        '  Access-Control-Allow-Origin: *\n'
        '  Access-Control-Allow-Methods: GET, HEAD\n'
        '  Access-Control-Allow-Headers: Content-Type\n'
    )
    headers_path.write_text(content, encoding='utf-8')
    log.info('生成 _headers 文件')


def scan_bundled_books() -> list:
    """扫描 resource/books/ 目录，返回与 books-manifest.json 相同结构的 series 列表。

    不依赖 books-manifest.json 是否存在，直接扫描目录生成。
    """
    if not BOOKS_DIR.is_dir():
        return []

    series_list = []
    for entry in sorted(BOOKS_DIR.iterdir()):
        if not entry.is_dir():
            continue  # 跳过 README.md 等

        series_files = []
        for f in sorted(entry.rglob('*')):
            if not f.is_file():
                continue
            ext = f.suffix.lower()
            fmt = SUPPORTED_EXTS.get(ext)
            if not fmt:
                continue
            rel_path = f.relative_to(BOOKS_DIR).as_posix()
            stem = f.stem
            series_files.append({
                'file': rel_path,
                'format': fmt,
                'size': f.stat().st_size,
                'title': stem,
            })

        if not series_files:
            continue

        series_list.append({
            'id': entry.name,
            'name': entry.name,
            'files': series_files,
        })

    return series_list


def _convert_via_node(input_path: Path, book_id: str, series_id: str) -> Dict[str, Any]:
    """调用 Node.js 转换脚本 (src/convert-bundled.js) 将文件转为 ysz JSON 格式。
    
    返回解析后的 JSON 对象，失败则返回 None。
    """
    script = BASE_DIR / 'src' / 'convert-bundled.js'
    if not script.is_file():
        log.error('Node.js 转换脚本不存在: %s', script)
        return None

    try:
        result = subprocess.run(
            ['node', str(script), str(input_path), book_id, series_id],
            capture_output=True,
            text=True,
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


def generate_bundled_book_jsons(merged_dir: Path) -> Dict[str, Any]:
    """将 resource/books/ 下的书籍解析为 ysz 格式 JSON，放入 zl-merged 目录。
    
    对每个系列目录：
    1. 在 zl-merged/{seriesId}/ 下创建目录
    2. 每本书生成 {bookId}.json（ysz 格式：{id, title, format, chapters}）
    3. 生成 index.json（ysz 格式：[{id, title, chapter_count, series}]）
    
    返回 {seriesId: [{id, title, chapter_count, series}]} 的索引摘要，
    供 merge_bundled_books() 使用。
    """
    series_list = scan_bundled_books()
    if not series_list:
        log.info('未发现内置资源目录或为空，跳过 JSON 生成')
        return {}

    index_summary: Dict[str, List[Dict[str, Any]]] = {}

    for series in series_list:
        sid = series['id']
        files = series['files']
        series_dir = merged_dir / sid
        series_dir.mkdir(parents=True, exist_ok=True)

        series_index = []
        for f in files:
            src_path = BOOKS_DIR / f['file']
            # book_id 使用 bundle-{seriesId}__{stem} 格式
            book_id = f'bundle-{sid}__{f["title"]}'

            # 调用 Node.js 转换脚本
            book_data = _convert_via_node(src_path, book_id, sid)
            if book_data is None:
                log.warning('跳过转换失败的文件: %s', src_path)
                continue

            title = book_data.get('title', f['title'])
            chapters = book_data.get('chapters', [])

            # 生成书籍 JSON（ysz 格式）
            book_json = {
                'id': book_id,
                'title': title,
                'format': 'html',  # ysz 统一格式标识
                'chapters': chapters,
            }
            book_path = series_dir / (book_id + '.json')
            save_json(book_path, book_json)

            chapter_count = len(chapters)
            series_index.append({
                'id': book_id,
                'title': title,
                'chapter_count': chapter_count,
                'series': sid,
            })

        # 生成系列 index.json（ysz 格式：纯数组）
        save_json(series_dir / 'index.json', series_index)
        index_summary[sid] = series_index

        log.info('生成内置系列 JSON: %s (%d 本, %d 章)',
                 sid, len(series_index),
                 sum(b['chapter_count'] for b in series_index))

    return index_summary


def merge_bundled_books(merged_index: Dict[str, Any], index_summary: Dict[str, Any] = None) -> None:
    """将内置资源条目注入到 books-index.json 的 merged_index 中。
    
    改造后：books 书籍已生成 ysz 格式 JSON 放入 zl-merged，
    此处仅注入索引条目。chapter_count 从 index_summary 获取（不再设 0）。
    
    - 每个 series 目录生成一个 series 条目（type: 'bundle'）
    - 每本书生成一个 book 条目（id 格式: bundle-{seriesId}__{stem}）
    - chapter_count 从实际解析结果获取（不再依赖前端回填）
    """
    series_list = scan_bundled_books()
    if not series_list:
        log.info('未发现内置资源目录或为空，跳过合并')
        return

    existing_series_ids = {s['id'] for s in merged_index.get('series', [])}
    existing_book_ids = {b['id'] for b in merged_index.get('books', [])}

    # 构建 book_id → chapter_count 映射（从 index_summary 获取真实值）
    chapter_count_map: Dict[str, int] = {}
    if index_summary:
        for sid, books in index_summary.items():
            for b in books:
                chapter_count_map[b['id']] = b['chapter_count']

    added_series = 0
    added_books = 0

    for series in series_list:
        sid = series['id']
        files = series['files']

        # 注入 series 条目
        if sid not in existing_series_ids:
            merged_index['series'].append({
                'id': sid,
                'title': series['name'],
                'count': len(files),
                'type': 'bundle',
            })
            existing_series_ids.add(sid)
            added_series += 1
        else:
            log.warning('series id 冲突，跳过: %s', sid)

        # 注入 book 条目
        for f in files:
            book_id = f'bundle-{sid}__{f["title"]}'
            if book_id in existing_book_ids:
                log.debug('book id 已存在，跳过: %s', book_id)
                continue

            # 从 index_summary 获取真实 chapter_count，否则回退到 0
            real_chapter_count = chapter_count_map.get(book_id, 0)

            merged_index['books'].append({
                'id': book_id,
                'title': f['title'],
                'series': sid,
                'chapter_count': real_chapter_count,
                'bundled': True,
                'format': f['format'],
                'file': f['file'],
            })
            existing_book_ids.add(book_id)
            added_books += 1

    log.info('内置资源注入: %d 个系列, %d 本书', added_series, added_books)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def run(dry_run: bool = False, force: bool = False) -> None:
    """执行合并流程。"""
    # 1. 检查源目录（zl-ysz 必须存在）
    if not YSZ_DIR.is_dir():
        log.error('zl-ysz 目录不存在: %s', YSZ_DIR)
        return

    # 2. 检查目标目录
    if MERGED_DIR.exists():
        if force:
            log.info('--force: 删除已有目录 %s', MERGED_DIR)
            if not dry_run:
                shutil.rmtree(MERGED_DIR)
        else:
            log.error(
                '目标目录已存在: %s\n请使用 --force 强制覆盖，或先手动删除。',
                MERGED_DIR,
            )
            return

    # 3. 加载索引
    log.info('加载 books-index.json ...')
    merged_index: Dict[str, Any] = load_json(YSZ_DIR / 'books-index.json')
    log.info('zl-ysz 系列数: %d', len(merged_index['series']))

    # 3b. 先注入索引条目（chapter_count 暂设 0，后面会从实际 JSON 回填）
    merge_bundled_books(merged_index)

    total_books = len(merged_index['books'])
    total_chapters = sum(b.get('chapter_count', 0) for b in merged_index['books'])
    log.info('统计: %d 个系列, %d 本书, %d 章',
             len(merged_index['series']), total_books, total_chapters)

    if dry_run:
        log.info('[DRY RUN] 统计完成，未执行文件操作。')
        return

    # 4. 复制数据（zl-ysz → zl-merged）
    copy_base_data(YSZ_DIR, MERGED_DIR)

    # 4b. 生成内置书籍的 ysz 格式 JSON 文件到 zl-merged 目录
    #     （在 copy_base_data 之后，此时 MERGED_DIR 已存在）
    index_summary = generate_bundled_book_jsons(MERGED_DIR)

    # 4c. 用实际 chapter_count 回填 books-index.json 中的内置书条目
    if index_summary:
        for sid, books in index_summary.items():
            for b in books:
                for idx, mb in enumerate(merged_index['books']):
                    if mb['id'] == b['id']:
                        merged_index['books'][idx]['chapter_count'] = b['chapter_count']
                        break
        log.info('已回填内置书籍 chapter_count')

    # 5. 写入 books-index.json
    index_path = MERGED_DIR / 'books-index.json'
    save_json(index_path, merged_index)
    log.info('写入 books-index.json (%d 行)', len(json.dumps(merged_index, ensure_ascii=False).splitlines()))

    # 6. 写入 manifest.json
    manifest = generate_manifest(merged_index, total_chapters)
    manifest_path = MERGED_DIR / 'manifest.json'
    save_json(manifest_path, manifest)
    log.info('写入 manifest.json: %d books, %d chapters', manifest['total_books'], manifest['total_chapters'])

    # 7. 生成 _headers
    generate_headers(MERGED_DIR)

    log.info('合并完成 → %s', MERGED_DIR)


def main() -> None:
    parser = argparse.ArgumentParser(
        description='将 zl-ysz 数据复制到 zl-merged',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='仅统计合并结果，不实际复制文件',
    )
    parser.add_argument(
        '--force',
        action='store_true',
        help='如果 zl-merged 已存在，先删除再重新生成',
    )
    args = parser.parse_args()
    run(dry_run=args.dry_run, force=args.force)


if __name__ == '__main__':
    main()
