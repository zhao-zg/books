# -*- coding: utf-8 -*-
"""
EPUB 电子书解析器

使用 ebooklib 解析 EPUB 格式电子书，提取元数据、章节结构和内嵌图片。
"""
import os
import re
import mimetypes
from pathlib import Path
from typing import Optional

from .models import Book, Chapter, Content, slugify, html_to_contents, extract_images_from_html


def _get_metadata(epub, key: str, default: str = "") -> str:
    """安全提取 EPUB 元数据"""
    try:
        values = epub.get_metadata('DC', key)
        if values:
            return values[0][0] if isinstance(values[0], tuple) else str(values[0])
    except Exception:
        pass
    return default


def _extract_cover(epub, output_images_dir: str) -> str:
    """提取封面图片，返回相对于 book 目录的路径"""
    # 方法1: 通过 metadata cover 属性
    try:
        cover_id = None
        for meta in epub.get_metadata('OPF', 'cover'):
            if isinstance(meta, tuple) and len(meta) > 1:
                attrs = meta[1] if isinstance(meta[1], dict) else {}
                cover_id = attrs.get('content', '')
            break

        if cover_id:
            for item in epub.get_items():
                if item.get_id() == cover_id:
                    ext = _guess_ext(item.get_name(), item.media_type)
                    cover_filename = f"cover{ext}"
                    cover_path = os.path.join(output_images_dir, cover_filename)
                    os.makedirs(output_images_dir, exist_ok=True)
                    with open(cover_path, 'wb') as f:
                        f.write(item.get_content())
                    return f"images/{cover_filename}"
    except Exception:
        pass

    # 方法2: 找第一个图片类型的 item，文件名包含 cover
    try:
        import ebooklib
        for item in epub.get_items_of_type(ebooklib.ITEM_COVER):
            ext = _guess_ext(item.get_name(), item.media_type)
            cover_filename = f"cover{ext}"
            cover_path = os.path.join(output_images_dir, cover_filename)
            os.makedirs(output_images_dir, exist_ok=True)
            with open(cover_path, 'wb') as f:
                f.write(item.get_content())
            return f"images/{cover_filename}"
    except Exception:
        pass

    return ""


def _guess_ext(filename: str, media_type: str = "") -> str:
    """根据文件名或 MIME 类型推断扩展名"""
    ext = Path(filename).suffix.lower()
    if ext:
        return ext
    ext_map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
    }
    return ext_map.get(media_type, '.jpg')


def _save_images(epub, book_id: str, output_dir: str) -> dict:
    """提取并保存 EPUB 中的内嵌图片。

    Returns:
        映射表 {epub_internal_path: saved_relative_path}
    """
    import ebooklib
    images_dir = os.path.join(output_dir, book_id, 'images')
    os.makedirs(images_dir, exist_ok=True)

    image_map: dict = {}
    count = 0
    for item in epub.get_items_of_type(ebooklib.ITEM_IMAGE):
        count += 1
        ext = _guess_ext(item.get_name(), item.media_type)
        # 用序号避免重名
        saved_name = f"img_{count:03d}{ext}"
        saved_path = os.path.join(images_dir, saved_name)
        with open(saved_path, 'wb') as f:
            f.write(item.get_content())
        # 记录映射：EPUB 内部路径 → 保存后路径
        image_map[item.get_name()] = f"images/{saved_name}"
        # 也记录文件名，便于匹配
        image_map[os.path.basename(item.get_name())] = f"images/{saved_name}"

    return image_map


def _remap_image_src(src: str, image_map: dict) -> str:
    """将 EPUB 内部图片路径映射为保存后的相对路径"""
    if not src:
        return src
    # 精确匹配
    if src in image_map:
        return image_map[src]
    # 文件名匹配
    basename = os.path.basename(src)
    if basename in image_map:
        return image_map[basename]
    # 尝试去掉 ../ 前缀
    cleaned = re.sub(r'^(\.\./)+', '', src)
    if cleaned in image_map:
        return image_map[cleaned]
    return src


def _remap_contents(contents: list, image_map: dict) -> list:
    """将 Content 列表中的图片路径重映射"""
    for c in contents:
        if c.type == 'image' and c.src:
            c.src = _remap_image_src(c.src, image_map)
    return contents


def _parse_spine_items(epub) -> list:
    """按 spine 顺序获取章节 HTML 内容。

    Returns:
        [(item_id, html_str), ...]
    """
    import ebooklib
    # 构建 id → item 映射
    id_to_item = {}
    for item in epub.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        id_to_item[item.get_id()] = item

    spine_items = []
    for spine_id, _linear in epub.spine:
        item = id_to_item.get(spine_id)
        if item:
            html = item.get_content().decode('utf-8', errors='replace')
            spine_items.append((spine_id, html))

    # 如果 spine 为空，回退到所有 document items
    if not spine_items:
        for item in epub.get_items_of_type(ebooklib.ITEM_DOCUMENT):
            html = item.get_content().decode('utf-8', errors='replace')
            spine_items.append((item.get_id(), html))

    return spine_items


def _extract_toc_titles(epub) -> dict:
    """从 TOC 提取标题映射 {href_fragment: title}"""
    toc_map: dict = {}

    def _walk_toc(nodes, depth=0):
        for node in nodes:
            if hasattr(node, 'title') and hasattr(node, 'href'):
                # Link 节点
                href = node.href.split('#')[0] if node.href else ''
                if href and node.title:
                    toc_map[href] = node.title.strip()
            elif hasattr(node, 'children'):
                # Section 节点
                if hasattr(node, 'title') and hasattr(node, 'href'):
                    href = node.href.split('#')[0] if node.href else ''
                    if href and node.title:
                        toc_map[href] = node.title.strip()
                _walk_toc(node.children, depth + 1)
            elif isinstance(node, tuple) and len(node) >= 2:
                # (Section, [Link, ...]) 形式
                section, links = node[0], node[1]
                if hasattr(section, 'href') and section.href:
                    href = section.href.split('#')[0]
                    if href and hasattr(section, 'title') and section.title:
                        toc_map[href] = section.title.strip()
                if isinstance(links, list):
                    _walk_toc(links, depth + 1)

    try:
        _walk_toc(epub.toc)
    except Exception:
        pass

    return toc_map


def parse_epub(file_path, output_dir: str = "output") -> Optional[Book]:
    """解析 EPUB 格式电子书。

    Args:
        file_path: EPUB 文件路径
        output_dir: 输出根目录

    Returns:
        Book 对象，解析失败返回 None
    """
    try:
        import ebooklib
        from ebooklib import epub as epublib
    except ImportError:
        print(f"  ✗ ebooklib 未安装，无法解析 EPUB: {file_path}")
        return None

    file_path = Path(file_path)
    book_id = slugify(file_path.stem)

    try:
        epub = epublib.read_epub(str(file_path), options={'ignore_ncx': False})
    except Exception as e:
        print(f"  ✗ EPUB 读取失败: {file_path.name} — {e}")
        return None

    # 提取元数据
    title = _get_metadata(epub, 'title', file_path.stem)
    author = _get_metadata(epub, 'creator', '')
    language = _get_metadata(epub, 'language', 'zh')
    description = _get_metadata(epub, 'description', '')

    # 保存封面和内嵌图片
    book_output_dir = os.path.join(output_dir, book_id)
    images_output_dir = os.path.join(book_output_dir, 'images')
    cover = _extract_cover(epub, images_output_dir)
    image_map = _save_images(epub, book_id, output_dir)

    # 提取 TOC 标题
    toc_titles = _extract_toc_titles(epub)

    # 按 spine 顺序解析章节
    spine_items = _parse_spine_items(epub)
    chapters: list = []
    chapter_num = 0

    for item_id, html in spine_items:
        # 查找文件名映射
        item = None
        for it in epub.get_items():
            if it.get_id() == item_id:
                item = it
                break
        item_name = os.path.basename(item.get_name()) if item else ''

        # 查找 TOC 标题
        toc_title = toc_titles.get(item_name, '')

        # 转换 HTML → Content 列表
        contents = html_to_contents(html)
        contents = _remap_contents(contents, image_map)

        # 如果内容为空，跳过
        if not contents:
            continue

        # 尝试从内容中提取章节标题
        chapter_title = toc_title
        if not chapter_title:
            for c in contents:
                if c.type == 'heading' and c.level <= 2 and c.text:
                    chapter_title = c.text
                    break

        chapter_num += 1
        if not chapter_title:
            chapter_title = f"第{chapter_num}章"

        chapters.append(Chapter(
            number=chapter_num,
            title=chapter_title,
            content=contents,
        ))

    from datetime import date
    book = Book(
        id=book_id,
        title=title,
        author=author,
        format='epub',
        cover=cover,
        language=language[:2] if language else 'zh',
        date_added=date.today().isoformat(),
        description=description,
        chapters=chapters,
    )

    return book
