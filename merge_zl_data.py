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
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
YSZ_DIR = BASE_DIR / 'resource' / 'zl-ysz'
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

    total_books = len(merged_index['books'])
    total_chapters = sum(b.get('chapter_count', 0) for b in merged_index['books'])
    log.info('统计: %d 个系列, %d 本书, %d 章',
             len(merged_index['series']), total_books, total_chapters)

    if dry_run:
        log.info('[DRY RUN] 统计完成，未执行文件操作。')
        return

    # 4. 复制数据
    copy_base_data(YSZ_DIR, MERGED_DIR)

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
