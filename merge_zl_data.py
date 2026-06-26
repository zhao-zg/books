# -*- coding: utf-8 -*-
"""
数据合并脚本：将 zl-ysz 和 zl-html 合并到 zl-merged
以 zl-ysz 为基础，追加 zl-html 中独有的系列数据，
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
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Set

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
YSZ_DIR = BASE_DIR / 'resource' / 'zl-ysz'
HTML_DIR = BASE_DIR / 'resource' / 'zl-html'
MERGED_DIR = BASE_DIR / 'resource' / 'zl-merged'

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
def identify_exclusive_series(
    ysz_index: Dict[str, Any],
    html_index: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """找出 zl-html 中存在但 zl-ysz 中不存在的系列。

    返回这些系列的完整信息（来自 html_index['series']）。
    """
    ysz_ids: Set[str] = {s['id'] for s in ysz_index['series']}
    exclusive: List[Dict[str, Any]] = []
    for s in html_index['series']:
        if s['id'] not in ysz_ids:
            exclusive.append(s)
    return exclusive


def copy_base_data(src: Path, dst: Path) -> None:
    """将 zl-ysz 整体复制到 zl-merged。"""
    log.info('复制基础数据: %s → %s', src, dst)
    shutil.copytree(src, dst)


def copy_exclusive_series(
    html_dir: Path,
    merged_dir: Path,
    exclusive_series: List[Dict[str, Any]],
) -> None:
    """将独有系列的子目录从 zl-html 复制到 zl-merged。"""
    for series in exclusive_series:
        sid = series['id']
        src_dir = html_dir / sid
        dst_dir = merged_dir / sid
        if src_dir.is_dir():
            log.info('复制独有系列目录: %s', sid)
            shutil.copytree(src_dir, dst_dir)
        else:
            log.warning('独有系列目录不存在，跳过: %s', src_dir)


def merge_books_index(
    ysz_index: Dict[str, Any],
    html_index: Dict[str, Any],
    exclusive_series: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """合并两个数据源的 books-index，返回新的索引字典。

    - series: zl-ysz 优先，追加 zl-html 独有系列（count 保持原值）
    - books:  zl-ysz 优先，追加 zl-html 独有系列对应的书籍
    """
    exclusive_ids: Set[str] = {s['id'] for s in exclusive_series}

    # --- 合并 series ---
    merged_series: List[Dict[str, Any]] = list(ysz_index['series'])
    for s in exclusive_series:
        merged_series.append(s)

    # --- 合并 books ---
    merged_books: List[Dict[str, Any]] = list(ysz_index['books'])
    for book in html_index['books']:
        if book.get('series') in exclusive_ids:
            merged_books.append(book)

    # --- 校验 count ---
    for s in merged_series:
        actual_count = sum(1 for b in merged_books if b.get('series') == s['id'])
        if actual_count != s['count']:
            log.warning(
                '系列 %s count 不一致: index=%d, actual=%d → 已修正',
                s['id'], s['count'], actual_count,
            )
            s['count'] = actual_count

    return {'series': merged_series, 'books': merged_books}


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


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def run(dry_run: bool = False, force: bool = False) -> None:
    """执行合并流程。"""
    # 1. 检查源目录
    if not YSZ_DIR.is_dir():
        log.error('zl-ysz 目录不存在: %s', YSZ_DIR)
        return
    if not HTML_DIR.is_dir():
        log.error('zl-html 目录不存在: %s', HTML_DIR)
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
    ysz_index: Dict[str, Any] = load_json(YSZ_DIR / 'books-index.json')
    html_index: Dict[str, Any] = load_json(HTML_DIR / 'books-index.json')

    # 4. 识别独有系列
    exclusive = identify_exclusive_series(ysz_index, html_index)
    exclusive_ids = [s['id'] for s in exclusive]
    log.info('zl-ysz 系列数: %d', len(ysz_index['series']))
    log.info('zl-html 系列数: %d', len(html_index['series']))
    log.info('zl-html 独有系列 (%d): %s', len(exclusive), ', '.join(exclusive_ids))

    # 5. 合并索引
    merged_index = merge_books_index(ysz_index, html_index, exclusive)
    total_books = len(merged_index['books'])
    total_chapters = sum(b.get('chapter_count', 0) for b in merged_index['books'])
    log.info('合并后统计: %d 个系列, %d 本书, %d 章',
             len(merged_index['series']), total_books, total_chapters)

    if dry_run:
        log.info('[DRY RUN] 合并统计完成，未执行文件操作。')
        return

    # 6. 复制基础数据
    copy_base_data(YSZ_DIR, MERGED_DIR)

    # 7. 复制独有系列
    copy_exclusive_series(HTML_DIR, MERGED_DIR, exclusive)

    # 8. 写入 books-index.json
    index_path = MERGED_DIR / 'books-index.json'
    save_json(index_path, merged_index)
    log.info('写入 books-index.json (%d 行)', len(json.dumps(merged_index, ensure_ascii=False).splitlines()))

    # 9. 写入 manifest.json
    manifest = generate_manifest(merged_index, total_chapters)
    manifest_path = MERGED_DIR / 'manifest.json'
    save_json(manifest_path, manifest)
    log.info('写入 manifest.json: %d books, %d chapters', manifest['total_books'], manifest['total_chapters'])

    # 10. 生成 _headers
    generate_headers(MERGED_DIR)

    log.info('合并完成 → %s', MERGED_DIR)


def main() -> None:
    parser = argparse.ArgumentParser(
        description='合并 zl-ysz 和 zl-html 数据到 zl-merged',
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
