# -*- coding: utf-8 -*-
"""
TXT 纯文本文本电子书解析器

支持多种中文编码自动检测，以及基于中文章节标记的智能章节分割。
"""
import os
import re
from pathlib import Path
from typing import Optional, List

from .models import Book, Chapter, Content, slugify


# ---------------------------------------------------------------------------
# 编码检测
# ---------------------------------------------------------------------------

def _detect_encoding(file_path: str) -> str:
    """自动检测文件编码，优先 UTF-8，回退 GBK/GB2312"""
    # 尝试 UTF-8
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            f.read(4096)
        return 'utf-8'
    except (UnicodeDecodeError, ValueError):
        pass

    # 尝试 chardet
    try:
        import chardet
        with open(file_path, 'rb') as f:
            raw = f.read(32768)  # 读前 32K 检测
        result = chardet.detect(raw)
        encoding = result.get('encoding', '')
        if encoding:
            return encoding
    except ImportError:
        pass

    # 回退 GBK
    return 'gbk'


def _read_file(file_path: str) -> str:
    """读取文本文件，自动检测编码"""
    encoding = _detect_encoding(file_path)
    try:
        with open(file_path, 'r', encoding=encoding, errors='replace') as f:
            return f.read()
    except Exception as e:
        print(f"  ✗ 文件读取失败 ({encoding}): {file_path} — {e}")
        # 最后尝试 UTF-8
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()


# ---------------------------------------------------------------------------
# 章节分割
# ---------------------------------------------------------------------------

# 中文章节标记模式
_CHAPTER_PATTERNS = [
    # 第X章 / 第X节 / 第X回 / 第X部分 / 第X篇
    re.compile(r'^第[零一二三四五六七八九十百千\d]+[章节回部篇集卷]\s*(.*)$'),
    # 第 X 章（带空格）
    re.compile(r'^第\s*[零一二三四五六七八九十百千\d]+\s*[章节回部篇集卷]\s*(.*)$'),
    # CHAPTER 1 / Chapter 1
    re.compile(r'^(?:CHAPTER|Chapter|chapter)\s+\d+\s*(.*)$'),
]

# 分隔线模式
_SEPARATOR_LINE = re.compile(r'^[=\-—–]{3,}\s*$')


def _is_title_line(line: str) -> bool:
    """判断一行是否像书名（较短、无标点结尾、非空）"""
    line = line.strip()
    if not line:
        return False
    if len(line) > 50:
        return False
    # 不以句号、问号、感叹号等结尾
    if line[-1] in '。！？.!?,，;；:：':
        return False
    # 不含太多标点
    punctuation_count = sum(1 for c in line if c in '，。！？,.!?;；:：、')
    if punctuation_count > len(line) * 0.3:
        return False
    return True


def _match_chapter_heading(line: str) -> Optional[str]:
    """尝试匹配中文章节标记，返回章节标题（含序号）"""
    stripped = line.strip()
    if not stripped:
        return None
    for pattern in _CHAPTER_PATTERNS:
        m = pattern.match(stripped)
        if m:
            # 返回完整匹配（含"第X章"前缀）
            return stripped
    return None


def _split_chapters_by_heading(lines: List[str]) -> List[tuple]:
    """按中文章节标记分割。

    Returns:
        [(title, [text_lines, ...]), ...] 或空列表（表示未匹配到章节标记）
    """
    segments: List[tuple] = []
    current_title = ""
    current_lines: List[str] = []

    for line in lines:
        heading = _match_chapter_heading(line)
        if heading:
            if current_lines:
                segments.append((current_title, current_lines))
            current_title = heading
            current_lines = []
        else:
            current_lines.append(line)

    if current_lines:
        segments.append((current_title, current_lines))

    # 至少匹配到 2 个章节才认为有效
    matched_count = sum(1 for title, _ in segments if title)
    if matched_count < 2:
        return []

    return segments


def _split_chapters_by_separator(lines: List[str]) -> List[tuple]:
    """按分隔线（=== 或 ---）分割章节。

    Returns:
        [(title, [text_lines, ...]), ...] 或空列表
    """
    segments: List[tuple] = []
    current_title = ""
    current_lines: List[str] = []
    prev_blank = False

    for line in lines:
        if _SEPARATOR_LINE.match(line.strip()):
            if current_lines:
                segments.append((current_title, current_lines))
            current_title = ""
            current_lines = []
            prev_blank = False
            continue
        current_lines.append(line)

    if current_lines:
        segments.append((current_title, current_lines))

    if len(segments) < 2:
        return []

    # 尝试为每个段落提取标题（第一行非空行）
    result = []
    for title, text_lines in segments:
        if not title:
            # 取第一行非空行作为标题
            for i, tl in enumerate(text_lines):
                stripped = tl.strip()
                if stripped:
                    title = stripped
                    text_lines = text_lines[i + 1:]
                    break
        result.append((title, text_lines))

    return result


def _split_by_double_blank(lines: List[str]) -> List[tuple]:
    """按双空行分割段落（最后手段）。

    Returns:
        [(title, [text_lines, ...]), ...]
    """
    segments: List[tuple] = []
    current_lines: List[str] = []
    blank_count = 0

    for line in lines:
        if not line.strip():
            blank_count += 1
            if blank_count >= 2 and current_lines:
                segments.append(("", current_lines))
                current_lines = []
                blank_count = 0
            else:
                current_lines.append(line)
        else:
            blank_count = 0
            current_lines.append(line)

    if current_lines:
        segments.append(("", current_lines))

    # 提取标题
    result = []
    for _, text_lines in segments:
        title = ""
        clean_lines = []
        for tl in text_lines:
            stripped = tl.strip()
            if stripped:
                if not title:
                    title = stripped
                clean_lines.append(stripped)
        if clean_lines:
            result.append((title, clean_lines))

    return result


def _lines_to_contents(lines: List[str]) -> List[Content]:
    """将文本行转换为 Content 列表"""
    contents: List[Content] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        contents.append(Content(type='paragraph', text=line))
    return contents


# ---------------------------------------------------------------------------
# 主解析函数
# ---------------------------------------------------------------------------

def parse_txt(file_path, output_dir: str = "output") -> Optional[Book]:
    """解析 TXT 格式电子书。

    Args:
        file_path: TXT 文件路径
        output_dir: 输出根目录

    Returns:
        Book 对象，解析失败返回 None
    """
    file_path = Path(file_path)
    book_id = slugify(file_path.stem)

    try:
        text = _read_file(str(file_path))
    except Exception as e:
        print(f"  ✗ TXT 读取失败: {file_path.name} — {e}")
        return None

    lines = text.splitlines()
    if not lines:
        print(f"  ✗ TXT 文件为空: {file_path.name}")
        return None

    # 检测书名（第一行如果像标题）
    book_title = file_path.stem
    title_line_idx = -1
    for i, line in enumerate(lines[:5]):  # 只看前 5 行
        stripped = line.strip()
        if stripped and _is_title_line(stripped):
            book_title = stripped
            title_line_idx = i
            break

    # 如果检测到书名行，跳过它（避免被当作章节内容）
    content_lines = lines[title_line_idx + 1:] if title_line_idx >= 0 else lines

    # 尝试不同的章节分割策略
    segments = _split_chapters_by_heading(content_lines)
    strategy = "中文章节标记"

    if not segments:
        segments = _split_chapters_by_separator(content_lines)
        strategy = "分隔线"

    if not segments:
        segments = _split_by_double_blank(content_lines)
        strategy = "双空行"

    # 构建章节（过滤空章节，重新编号）
    chapters: List[Chapter] = []
    for ch_title, ch_lines in segments:
        contents = _lines_to_contents(ch_lines)
        if contents:
            chapters.append(Chapter(
                number=len(chapters) + 1,
                title=ch_title if ch_title else f"第{len(chapters) + 1}章",
                content=contents,
            ))

    if not chapters:
        # 极端情况：整个文件作为一章
        contents = _lines_to_contents(content_lines)
        chapters.append(Chapter(number=1, title=book_title, content=contents))

    from datetime import date
    book = Book(
        id=book_id,
        title=book_title,
        format='txt',
        language='zh',
        date_added=date.today().isoformat(),
        chapters=chapters,
    )

    return book
