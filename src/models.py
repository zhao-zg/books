# -*- coding: utf-8 -*-
"""
数据模型定义 + HTML→Content 公共转换逻辑
"""
import re
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any


@dataclass
class Content:
    """内容段落 - 通用内容渲染节点"""
    type: str  # 'paragraph', 'heading', 'quote', 'image', 'list', 'code', 'footnote', 'separator'
    text: str = ""
    level: int = 0  # heading level (1-6)
    src: str = ""  # image src
    items: list = field(default_factory=list)  # list items
    attrs: dict = field(default_factory=dict)  # extra attributes

    def to_dict(self) -> dict:
        d: dict = {'type': self.type}
        if self.text:
            d['text'] = self.text
        if self.level:
            d['level'] = self.level
        if self.src:
            d['src'] = self.src
        if self.items:
            d['items'] = self.items
        if self.attrs:
            d['attrs'] = self.attrs
        return d


@dataclass
class Chapter:
    """章节"""
    number: int
    title: str
    content: List[Content] = field(default_factory=list)
    footnotes: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            'number': self.number,
            'title': self.title,
            'content': [c.to_dict() for c in self.content],
            'footnotes': self.footnotes,
        }


@dataclass
class Book:
    """电子书"""
    id: str  # 唯一标识，用于路由和目录名
    title: str
    author: str = ""
    format: str = ""  # epub/md/txt
    cover: str = ""  # 封面图片路径（相对于 output/{book_id}/）
    language: str = "zh"
    date_added: str = ""
    description: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    chapters: List[Chapter] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'title': self.title,
            'author': self.author,
            'format': self.format,
            'cover': self.cover,
            'language': self.language,
            'date_added': self.date_added,
            'description': self.description,
            'metadata': self.metadata,
            'chapters': [ch.to_dict() for ch in self.chapters],
        }

    def summary_dict(self) -> dict:
        """摘要信息，用于全局索引 books.json"""
        return {
            'id': self.id,
            'title': self.title,
            'author': self.author,
            'format': self.format,
            'cover': self.cover,
            'language': self.language,
            'date_added': self.date_added,
            'description': self.description,
            'chapter_count': len(self.chapters),
        }


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def slugify(text: str) -> str:
    """将文本转换为 URL-safe 的 slug，用作 book_id"""
    # 去除扩展名（如果传入的是文件名）
    text = re.sub(r'\.[^.]+$', '', text)
    # 替换非字母数字字符为短横线
    slug = re.sub(r'[^\w\u4e00-\u9fff]+', '-', text)
    slug = slug.strip('-').lower()
    return slug if slug else 'untitled'


# ---------------------------------------------------------------------------
# HTML → Content 列表转换（EPUB 与 Markdown 解析器共享）
# ---------------------------------------------------------------------------

def _extract_text(el) -> str:
    """提取元素的纯文本，去除多余空白"""
    text = el.get_text(strip=True)
    # 合并连续空白为单个空格
    return re.sub(r'\s+', ' ', text).strip()


def html_to_contents(html: str, images_base: str = "") -> List[Content]:
    """将 HTML 片段解析为 Content 对象列表。

    Args:
        html: HTML 字符串
        images_base: 图片路径前缀（如 'images/'）

    Returns:
        Content 列表
    """
    from bs4 import BeautifulSoup, Tag

    soup = BeautifulSoup(html, 'html.parser')
    contents: List[Content] = []
    footnotes: List[str] = []

    def _process_element(el: Tag):
        """递归处理 HTML 元素"""
        if not isinstance(el, Tag):
            return

        tag = el.name

        # 跳过 script / style
        if tag in ('script', 'style', 'head', 'meta', 'link'):
            return

        # heading
        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            level = int(tag[1])
            text = _extract_text(el)
            if text:
                contents.append(Content(type='heading', text=text, level=level))
            return

        # paragraph
        if tag == 'p':
            # 检查段落内是否只有图片
            imgs = el.find_all('img')
            if imgs and not _extract_text(el):
                for img in imgs:
                    src = img.get('src', '')
                    if src:
                        contents.append(Content(type='image', src=src))
                return
            text = _extract_text(el)
            if text:
                # 检查段落内是否有图片
                for img in imgs:
                    src = img.get('src', '')
                    if src:
                        contents.append(Content(type='image', src=src))
                contents.append(Content(type='paragraph', text=text))
            return

        # blockquote
        if tag == 'blockquote':
            text = _extract_text(el)
            if text:
                contents.append(Content(type='quote', text=text))
            return

        # image
        if tag == 'img':
            src = el.get('src', '')
            if src:
                alt = el.get('alt', '')
                contents.append(Content(type='image', src=src, attrs={'alt': alt} if alt else {}))
            return

        # list
        if tag in ('ul', 'ol'):
            items = []
            for li in el.find_all('li', recursive=False):
                item_text = _extract_text(li)
                if item_text:
                    items.append(item_text)
            if items:
                contents.append(Content(type='list', items=items,
                                        attrs={'ordered': tag == 'ol'}))
            return

        # code block
        if tag == 'pre':
            code_el = el.find('code')
            text = _extract_text(code_el if code_el else el)
            if text:
                lang = ''
                if code_el and code_el.get('class'):
                    for cls in code_el['class']:
                        if cls.startswith('language-'):
                            lang = cls.replace('language-', '')
                            break
                attrs = {'language': lang} if lang else {}
                contents.append(Content(type='code', text=text, attrs=attrs))
            return

        if tag == 'code' and el.parent and el.parent.name != 'pre':
            # inline code — treat as paragraph
            text = _extract_text(el)
            if text:
                contents.append(Content(type='paragraph', text=text))
            return

        # separator
        if tag == 'hr':
            contents.append(Content(type='separator'))
            return

        # table — flatten to text
        if tag == 'table':
            rows = []
            for tr in el.find_all('tr'):
                cells = [_extract_text(td) for td in tr.find_all(['td', 'th'])]
                row_text = ' | '.join(c for c in cells if c)
                if row_text:
                    rows.append(row_text)
            if rows:
                contents.append(Content(type='paragraph', text='\n'.join(rows)))
            return

        # footnotes (common pattern: <aside epub:type="footnote"> or class="footnote")
        if tag == 'aside' or (tag == 'div' and 'footnote' in el.get('class', [])):
            text = _extract_text(el)
            if text:
                footnotes.append(text)
                contents.append(Content(type='footnote', text=text))
            return

        # For container tags (div, section, article, body, html, etc.), recurse
        if tag in ('div', 'section', 'article', 'main', 'body', 'html',
                    'header', 'footer', 'nav', 'figure', 'figcaption',
                    'span', 'a', 'em', 'strong', 'b', 'i', 'u', 'sup', 'sub',
                    'br', '[document]'):
            for child in el.children:
                if isinstance(child, Tag):
                    _process_element(child)
            return

        # Fallback: try to get text
        text = _extract_text(el)
        if text:
            contents.append(Content(type='paragraph', text=text))

    # Start processing from body or root
    body = soup.find('body')
    root = body if body else soup
    for child in root.children:
        if isinstance(child, Tag):
            _process_element(child)

    return contents


def extract_images_from_html(html: str) -> List[str]:
    """从 HTML 中提取所有图片 src"""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    srcs = []
    for img in soup.find_all('img'):
        src = img.get('src', '')
        if src:
            srcs.append(src)
    return srcs
