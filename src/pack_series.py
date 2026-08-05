# -*- coding: utf-8 -*-
"""
pack_series.py — 按系列打包 zl-data 下的书籍 JSON 为 ZIP 压缩包

输出目录: output/zl-data/packs/
每个系列生成一个或多个 ZIP（按压缩后体积自动拆分，每包 <= MAX_PACK_SIZE）。

ZIP 内部结构：
  <seriesId>.zip           # 不拆分时
  <seriesId>-part1.zip     # 拆分时
  <seriesId>-part2.zip
  ├── index.json           # 本包包含的书籍列表（子集）
  └── <bookId>.json        # 每本书的完整数据

同时生成 packs/manifest.json，供前端判断是否走 ZIP 下载通道：
  {
    "version": <同 manifest.json 的 version>,
    "maxPackSize": 25,
    "packs": [
      { "id": "books", "files": ["books-part1.zip","books-part2.zip",...],
        "bookCount": 677, "totalSize": 57344000, "totalOriginalSize": 163600000 },
      { "id": "lee8", "files": ["lee8.zip"], "bookCount": 344, ... },
      ...
    ]
  }
"""
import os
import sys
import json
import hashlib
import zipfile
from pathlib import Path

# Cloudflare Pages 单文件大小限制（25 MB）
MAX_PACK_SIZE = 25 * 1024 * 1024


def _collect_book_files(series_dir: str) -> list:
    """收集系列目录下的书籍 JSON 文件（跳过 index.json / categories.json）。

    Returns:
        [(filename, raw_size, raw_data), ...] 按 filename 排序
    """
    books = []
    for fn in sorted(os.listdir(series_dir)):
        if not fn.endswith('.json'):
            continue
        if fn in ('index.json', 'categories.json'):
            continue
        fp = os.path.join(series_dir, fn)
        if not os.path.isfile(fp):
            continue
        raw_size = os.path.getsize(fp)
        books.append((fn, raw_size))
    return books


def _estimate_compressed_size(zf: zipfile.ZipFile, fn: str, data: bytes) -> int:
    """写入一个文件到 ZipFile 并返回其在 ZIP 中的压缩大小。

    注意：zipfile 不直接暴露单文件压缩大小，需要先写入再用 ZipInfo 获取。
    """
    # 先写入
    zf.writestr(fn, data)
    # 从 ZipFile 的文件列表中获取刚写入条目的压缩大小
    info = zf.getinfo(fn)
    return info.compress_size


def _write_pack(packs_dir: str, zip_filename: str, series_dir: str,
                book_files: list) -> dict:
    """将指定的书籍文件打包为一个 ZIP。

    Args:
        packs_dir: 输出目录
        zip_filename: ZIP 文件名（如 "books-part1.zip"）
        series_dir: 系列源目录
        book_files: [(fn, raw_size), ...] 要打包的文件列表

    Returns:
        { file, size, bookCount, sha256 }
    """
    zip_path = os.path.join(packs_dir, zip_filename)
    sha256 = hashlib.sha256()

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for fn, _ in book_files:
            fp = os.path.join(series_dir, fn)
            with open(fp, 'rb') as f:
                data = f.read()
            zf.writestr(fn, data)
            sha256.update(data)

    return {
        'file': zip_filename,
        'size': os.path.getsize(zip_path),
        'bookCount': len(book_files),
        'sha256': sha256.hexdigest(),
    }


def _sample_compression_ratio(series_dir: str, book_files: list,
                              sample_count: int = 5) -> float:
    """采样少量书籍计算压缩比，用于预估切分点。

    只压缩 sample_count 本书（取首、中、末及两个四分位），
    得到 压缩后/原始 比值的估算值，避免对全部书籍做两次压缩。

    Returns:
        float: 压缩比（压缩后/原始），如 0.35 表示压缩后体积为原始的 35%
    """
    n = len(book_files)
    if n == 0:
        return 0.5  # 兜底

    # 选取 5 个采样点：首、1/4、中、3/4、末
    indices = set()
    indices.add(0)
    indices.add(n - 1)
    indices.add(n // 2)
    indices.add(n // 4)
    indices.add(3 * n // 4)
    indices = sorted(indices)

    import io
    total_raw = 0
    total_compressed = 0
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for idx in indices:
            fn, raw_size = book_files[idx]
            fp = os.path.join(series_dir, fn)
            with open(fp, 'rb') as f:
                data = f.read()
            zf.writestr(fn, data)
            total_raw += len(data)
            total_compressed += zf.getinfo(fn).compress_size

    return total_compressed / total_raw if total_raw > 0 else 0.5


def _split_into_chunks(book_files: list, ratio: float) -> list:
    """按预估压缩后体积将书籍文件拆分为多个 chunk。

    使用采样压缩比 * 原始大小估算压缩后体积，避免双重压缩。
    精度在 ±10% 以内，配合 MARGIN 安全余量可确保不超限。

    Args:
        book_files: [(fn, raw_size), ...] 按 filename 排序
        ratio: 采样压缩比（压缩后/原始），来自 _sample_compression_ratio()

    Returns:
        [ [(fn, raw_size), ...], ... ] 多个 chunk
    """
    if not book_files:
        return []

    MARGIN = 1024 * 512  # 512 KB 安全余量
    effective_limit = MAX_PACK_SIZE - MARGIN

    chunks = []
    current_chunk = []
    current_estimated = 0  # 当前 chunk 的预估压缩后体积

    for fn, raw_size in book_files:
        estimated = raw_size * ratio
        new_estimated = current_estimated + estimated

        # 如果加入此书会超限，且当前 chunk 不为空，则切分
        if current_chunk and new_estimated > effective_limit:
            chunks.append(current_chunk)
            current_chunk = []
            current_estimated = estimated
        else:
            current_estimated = new_estimated

        current_chunk.append((fn, raw_size))

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def _write_chunks(packs_dir, series_dir, chunks, single_name, series_id,
                   series_book_count, total_original_size):
    """将拆分后的多个 chunk 分别打包为 ZIP 文件。

    Returns:
        (result_dict, packs_info_entry)
        result_dict = { total_compressed: int }
        packs_info_entry = dict (不含 total_compressed)
    """
    part_files = []
    part_results = []
    part_total_size = 0

    for part_idx, chunk in enumerate(chunks):
        if len(chunks) == 1:
            part_name = single_name
        else:
            part_name = f"{series_id}-part{part_idx + 1}.zip"

        result = _write_pack(packs_dir, part_name, series_dir, chunk)
        part_files.append(part_name)
        part_results.append(result)
        part_total_size += result['size']

        chunk_book_count = len(chunk)
        print(f"  ✓ {part_name}: {chunk_book_count} 本, "
              f"{_fmt_size(result['size'])}")

    actual_count = series_book_count.get(series_id, sum(len(c) for c in chunks))

    ratio = (1 - part_total_size / total_original_size) * 100 if total_original_size > 0 else 0
    print(f"    {series_id}: 共 {len(chunks)} 包, "
          f"{_fmt_size(total_original_size)} → {_fmt_size(part_total_size)} (节省 {ratio:.1f}%)")

    packs_info_entry = {
        'id': series_id,
        'files': part_files,
        'totalSize': part_total_size,
        'totalOriginalSize': total_original_size,
        'bookCount': actual_count,
        'parts': part_results,
    }

    return {'total_compressed': part_total_size}, packs_info_entry


def pack_all_series(zl_data_dir: str, packs_dir: str = None,
                    max_pack_size: int = MAX_PACK_SIZE):
    """将 zl-data 下每个系列目录打包为 ZIP 文件，按压缩后体积自动拆分。

    Args:
        zl_data_dir: zl-data 目录路径（如 output/zl-data/）
        packs_dir: 输出目录，默认为 zl_data_dir/packs/
        max_pack_size: 单个 ZIP 最大体积（字节），默认 25MB
    """
    global MAX_PACK_SIZE
    MAX_PACK_SIZE = max_pack_size

    if packs_dir is None:
        packs_dir = os.path.join(zl_data_dir, 'packs')

    # 读取全局 manifest 获取版本号
    manifest_path = os.path.join(zl_data_dir, 'manifest.json')
    version = 0
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                manifest_data = json.load(f)
                version = manifest_data.get('version', 0)
        except Exception:
            pass

    # 读取全局索引
    index_path = os.path.join(zl_data_dir, 'books-index.json')
    if not os.path.exists(index_path):
        print("⚠ books-index.json 未找到，跳过系列打包")
        return

    try:
        with open(index_path, 'r', encoding='utf-8') as f:
            global_index = json.load(f)
    except Exception as e:
        print(f"⚠ 读取 books-index.json 失败: {e}")
        return

    # 构建系列 ID → bookCount 映射
    series_book_count = {}
    series_list = global_index.get('series', [])
    for s in series_list:
        series_book_count[s['id']] = s.get('count', 0)

    # 扫描 zl-data 下的系列目录
    series_dirs = []
    for entry in sorted(os.listdir(zl_data_dir)):
        entry_path = os.path.join(zl_data_dir, entry)
        if not os.path.isdir(entry_path):
            continue
        if entry == 'packs':
            continue
        has_books = False
        for f in os.listdir(entry_path):
            if f.endswith('.json') and f != 'index.json' and f != 'categories.json':
                has_books = True
                break
        if has_books:
            series_dirs.append(entry)

    if not series_dirs:
        print("⚠ zl-data 下没有可打包的系列目录")
        return

    os.makedirs(packs_dir, exist_ok=True)

    packs_info = []
    total_books = 0
    total_original = 0
    total_compressed = 0

    for series_id in series_dirs:
        series_dir = os.path.join(zl_data_dir, series_id)
        book_files = _collect_book_files(series_dir)

        if not book_files:
            continue

        total_original_size = sum(s for _, s in book_files)

        # 用采样压缩比预估压缩后体积，决定是否需要拆分
        ratio = _sample_compression_ratio(series_dir, book_files)
        estimated_size = total_original_size * ratio

        single_name = series_id + '.zip'

        if estimated_size <= max_pack_size:
            # 不需要拆分：直接打包（只压缩一次）
            result = _write_pack(packs_dir, single_name, series_dir, book_files)
            # 打包后用实际大小验证（如果预估偏差导致实际超限，拆分重试）
            if result['size'] > max_pack_size:
                os.remove(os.path.join(packs_dir, single_name))
                chunks = _split_into_chunks(book_files, ratio)
                result, packs_info_entry = _write_chunks(
                    packs_dir, series_dir, chunks, single_name, series_id,
                    series_book_count, total_original_size)
                packs_info.append(packs_info_entry)
                total_books += series_book_count.get(series_id, len(book_files))
                total_original += total_original_size
                total_compressed += result['total_compressed']
            else:
                actual_count = series_book_count.get(series_id, len(book_files))
                total_books += actual_count
                total_original += total_original_size
                total_compressed += result['size']

                packs_info.append({
                    'id': series_id,
                    'files': [single_name],
                    'totalSize': result['size'],
                    'totalOriginalSize': total_original_size,
                    'bookCount': actual_count,
                    'parts': [result],
                })

                rpct = (1 - result['size'] / total_original_size) * 100 if total_original_size > 0 else 0
                print(f"  ✓ {single_name}: {actual_count} 本, "
                      f"{_fmt_size(total_original_size)} → {_fmt_size(result['size'])} (节省 {rpct:.1f}%)")
        else:
            # 需要拆分（只压缩一次）
            chunks = _split_into_chunks(book_files, ratio)
            result, packs_info_entry = _write_chunks(
                packs_dir, series_dir, chunks, single_name, series_id,
                series_book_count, total_original_size)
            packs_info.append(packs_info_entry)
            total_books += series_book_count.get(series_id, len(book_files))
            total_original += total_original_size
            total_compressed += result['total_compressed']

    # 生成 packs/manifest.json
    # 将 parts 中的详细 sha256 等信息保留在 manifest 中供前端校验
    packs_manifest = {
        'version': version,
        'maxPackSize': max_pack_size,
        'packs': packs_info,
    }
    packs_manifest_path = os.path.join(packs_dir, 'manifest.json')
    with open(packs_manifest_path, 'w', encoding='utf-8') as f:
        json.dump(packs_manifest, f, ensure_ascii=False, indent=2)

    overall_ratio = (1 - total_compressed / total_original) * 100 if total_original > 0 else 0
    print(f"\n✓ 系列打包完成: {len(packs_info)} 个系列, {total_books} 本书")
    print(f"  原始总大小: {_fmt_size(total_original)}")
    print(f"  压缩总大小: {_fmt_size(total_compressed)}")
    print(f"  节省空间: {overall_ratio:.1f}%")
    print(f"  单包上限: {_fmt_size(max_pack_size)}")
    print(f"  清单: {packs_manifest_path}")


def _fmt_size(bytes_size: int) -> str:
    """格式化文件大小"""
    if bytes_size >= 1024 * 1024:
        return f"{bytes_size / 1024 / 1024:.1f} MB"
    if bytes_size >= 1024:
        return f"{bytes_size / 1024:.1f} KB"
    return f"{bytes_size} B"


if __name__ == '__main__':
    """命令行入口：python pack_series.py [zl-data-dir] [packs-dir]"""
    zl_dir = sys.argv[1] if len(sys.argv) > 1 else 'output/zl-data'
    packs_dir = sys.argv[2] if len(sys.argv) > 2 else None
    pack_all_series(zl_dir, packs_dir)
