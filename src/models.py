# -*- coding: utf-8 -*-
"""
数据模型定义（Content / Chapter / Book）+ slugify 工具函数

注意：HTML → Content 列表的转换逻辑由前端 import-manager.js::htmlToContents()
统一负责，后端不再维护解析逻辑，避免两份相同代码。
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
