# -*- coding: utf-8 -*-
"""
Markdown 电子书解析器

使用 markdown + python-frontmatter 解析 Markdown 文件，支持 YAML frontmatter。
"""
import os
import re
from pathlib import Path
from typing import Optional, List

from .models import Book, Chapter, Content, slugify, html_to_contents


def _md_to_html(md_text: str) -> str:
    """将 Markdown 文本转换为 HTML"""
    import markdown
    extensions = ['tables', 'fenced_code', 'codehilite', 'toc', 'nl2br', 'sane_lists']
    available_extensions = []
    for ext in extensions:
        try:
            markdown.Markdown(extensions=[ext])
            available_extensions.append(ext)
        except Exception:
            pass

    md = markdown.Markdown(extensions=available_extensions)
    return md.convert(md_text)


def _split_by_headings(contents: List[Content]) -> List[tuple]:
    """按标题分割内容。

    策略：
    1. 优先按一级标题（h1）分割
    2. 无 h1 则按二级标题（h2）分割
    3. 无任何标题则整体作为一个章节

    Returns:
        [(title, [Content, ...]), ...]
    """
    # 找到所有 heading
    heading_levels = set()
    for c in contents:
        if c.type == 'heading':
            heading_levels.add(c.level)

    # 确定分割级别
    if 1 in heading_levels:
        split_level = 1
    elif 2 in heading_levels:
        split_level = 2
    else:
        # 无标题，整体作为一个章节
        return [("", contents)]

    # 按选定级别分割
    segments: List[tuple] = []
    current_title = ""
    current_contents: List[Content] = []

    for c in contents:
        if c.type == 'heading' and c.level == split_level:
            # 保存之前的段落
            if current_contents:
                segments.append((current_title, current_contents))
            current_title = c.text
            current_contents = []
        else:
            current_contents.append(c)

    # 保存最后一段
    if current_contents:
        segments.append((current_title, current_contents))

    return segments


def _remap_md_images(contents: List[Content], md_dir: str, book_id: str, output_dir: str) -> List[Content]:
    """处理 Markdown 中相对路径的图片引用。

    将图片从 Markdown 文件所在目录复制到 output/{book_id}/images/，
    并更新 Content 中的 src 路径。
    """
    import shutil
    images_dir = os.path.join(output_dir, book_id, 'images')
    os.makedirs(images_dir, exist_ok=True)

    for c in contents:
        if c.type == 'image' and c.src:
            src = c.src
            # 跳过网络图片
            if src.startswith(('http://', 'https://', '//')):
                continue
            # 解析相对路径
            if not os.path.isabs(src):
                abs_src = os.path.normpath(os.path.join(md_dir, src))
            else:
                abs_src = src

            if os.path.exists(abs_src):
                filename = os.path.basename(abs_src)
                dst = os.path.join(images_dir, filename)
                if not os.path.exists(dst):
                    shutil.copy2(abs_src, dst)
                c.src = f"images/{filename}"

    return contents


def parse_markdown(file_path, output_dir: str = "output") -> Optional[Book]:
    """解析 Markdown 格式电子书。

    Args:
        file_path: Markdown 文件路径
        output_dir: 输出根目录

    Returns:
        Book 对象，解析失败返回 None
    """
    file_path = Path(file_path)

    try:
        import frontmatter
    except ImportError:
        print(f"  ✗ python-frontmatter 未安装，无法解析 Markdown: {file_path}")
        return None

    try:
        post = frontmatter.load(str(file_path))
        md_text = post.content
        fm = dict(post.metadata)
    except Exception as e:
        print(f"  ✗ Markdown 读取失败: {file_path.name} — {e}")
        return None

    # 从 frontmatter 提取元数据
    title = fm.get('title', file_path.stem)
    author = fm.get('author', '')
    language = fm.get('language', 'zh')
    description = fm.get('description', '')

    book_id = slugify(file_path.stem)

    # 将 Markdown 转换为 HTML
    html = _md_to_html(md_text)

    # 将 HTML 转换为 Content 列表
    contents = html_to_contents(html)

    # 处理图片路径
    md_dir = str(file_path.parent)
    contents = _remap_md_images(contents, md_dir, book_id, output_dir)

    # 按标题分割章节
    segments = _split_by_headings(contents)

    chapters: List[Chapter] = []
    for i, (ch_title, ch_contents) in enumerate(segments, 1):
        if not ch_title:
            ch_title = f"第{i}章" if len(segments) > 1 else title
        chapters.append(Chapter(
            number=i,
            title=ch_title,
            content=ch_contents,
        ))

    # 检查是否有封面图片（frontmatter 或同名图片）
    cover = ""
    cover_fm = fm.get('cover', '')
    if cover_fm:
        # 尝试从 frontmatter 指定的封面
        cover_path = os.path.join(md_dir, cover_fm) if not os.path.isabs(cover_fm) else cover_fm
        if os.path.exists(cover_path):
            import shutil
            images_dir = os.path.join(output_dir, book_id, 'images')
            os.makedirs(images_dir, exist_ok=True)
            cover_filename = os.path.basename(cover_path)
            dst = os.path.join(images_dir, cover_filename)
            if not os.path.exists(dst):
                shutil.copy2(cover_path, dst)
            cover = f"images/{cover_filename}"

    from datetime import date
    book = Book(
        id=book_id,
        title=title,
        author=author,
        format='md',
        cover=cover,
        language=str(language)[:2] if language else 'zh',
        date_added=date.today().isoformat(),
        description=description,
        metadata=fm,
        chapters=chapters,
    )

    return book
