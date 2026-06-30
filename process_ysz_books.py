#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YSZ 书籍批量处理脚本
处理 resource/ysz/ 下 122 个 txt 文件缓存，
提取纯文本内容，输出结构化 JSON 到 resource/zl-ysz/。
"""

import os
import re
import json
import logging
import argparse
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
DEFAULT_INPUT_DIR = BASE_DIR / 'resource' / 'ysz'
DEFAULT_OUTPUT_DIR = BASE_DIR / 'resource' / 'zl-ysz'

# 跳过的文件（圣经 + 目录索引）
SKIP_FILES = {'Zo.txt', 'CJ.txt', 'Y11.txt', 'DE.txt'}

# 敏感词替换规则
SENSITIVE_REPLACEMENTS = [
    ("李常受文集", "李文集"),
    ("生命读经", "LS"),
]

# 系列标题映射
SERIES_TITLE_MAP = {
    'books': '职事书报',
    'smdj8': 'LS',
    'nee': '倪柝声文集',
    'lee8': '李文集',
    'sy_auto': '信息拾遗',
    'zlt': '真理专題',
    'sjdy': '圣经导读',
    'zmxx': '姊妹们的学习课程',
    'hlpxl': '活力排训练',
    'qnqc': '青年成全',
    'qdzys': '全备真理福音系列',
    'dfnc': '对付主恢复中的难处',
    'sjzzz': '神建造中的柱子',
    'gjczl': '管家成全训练',
    'cddf': '姊妹成全-才德的妇人',
    'xpwy': '小排喂养',
    'smddz': '神命定之路',
    'sldx': '属灵短信',
    'bbjh': '擘饼聚会',
    'jksc': '健康生活操练',
    'hfqc': '恢复对主起初的爱',
    'wypl': '为主培育属灵后代',
    'cjxl': '成为系列',
    'smddsf': '生命读经示范',
    'xysl': '新耶路撒冷',
    'qcxl': '成全训练',
    'jczz': '基础造就',
    'slz': '十二篮子',
    'sldd': '属灵书报及导读',
    'hzjr': '这孩子将来如何',
    'jjzd': '结晶读经合辑',
    'xlxl': '新路实行成全训练',
    'sjrx': '神今日的行动',
    'jzjj': '极重要的经节',
    'qfsw': '区服事实务手册',
    'xlcl': '新路成全系列',
}

# 系列输出顺序（sy_auto 拆分后的新系列追加在后）
SERIES_ORDER = [
    'books', 'smdj8', 'nee', 'lee8',
    'zlt', 'sjdy', 'zmxx', 'hlpxl', 'qnqc', 'qdzys',
    'dfnc', 'sjzzz', 'gjczl', 'cddf', 'xpwy', 'smddz',
    'sldx', 'bbjh', 'jksc', 'hfqc', 'wypl', 'cjxl',
    'smddsf', 'xysl', 'qcxl', 'jczz',
    'slz', 'sldd', 'hzjr', 'jjzd', 'xlxl', 'sjrx',
    'jzjj', 'qfsw', 'xlcl',
    'sy_auto',
]

# sy_auto 分组 → 独立系列 提升映射
# key: Zo.txt 中 "信息拾遗" 下的分组名称
# value: 提升后的 series_id（多个分组可映射到同一 series_id 以实现合并）
SY_AUTO_PROMOTE = {
    '真理专題': 'zlt',
    '圣经导读': 'sjdy',
    '新约圣经导读': 'sjdy',
    '姊妹们的学习课程': 'zmxx',
    '活力排的训练与实行': 'hlpxl',
    '活力排手册 约翰福音': 'hlpxl',
    '青年人的福音与成全': 'qnqc',
    '青少年的三件事': 'qnqc',
    '全备真理的鸟瞰─福音系列': 'qdzys',
    '对付主恢复中工作的各种难处': 'dfnc',
    '神建造中的柱子': 'sjzzz',
    '管家成全训练': 'gjczl',
    '姊妹成全聚会-才德的妇人': 'cddf',
    '小排喂养系列': 'xpwy',
    '神命定之路的实质（问答题）': 'smddz',
    '属灵短信': 'sldx',
    '擘饼聚会': 'bbjh',
    '健康生活操练': 'jksc',
    '恢复对主起初的爱': 'hfqc',
    '为主培育属灵后代': 'wypl',
    '成为系列': 'cjxl',
    '生命读经示范': 'smddsf',
    '新耶路撒冷的解释应用于寻求的信徒': 'xysl',
    # 合并小系列
    '牧养成全': 'qcxl',
    '牧养生活的建立': 'qcxl',
    '如何成全人': 'qcxl',
    '父母成全信息': 'qcxl',
    '家主成全及操练与课程': 'qcxl',
    '基础造就': 'jczz',
    '基督徒生活的基本要素': 'jczz',
    # 第二批提升
    '十二篮子': 'slz',
    '属灵书报及导读': 'sldd',
    '这孩子将来如何': 'hzjr',
    '结晶读经合辑': 'jjzd',
    '新路实行成全训练系列': 'xlxl',
    '神今日的行动': 'sjrx',
    '给寻求信徒之1000处极重要的经节': 'jzjj',
    '区服事实务手册': 'qfsw',
    '新路成全系列': 'xlcl',
}

# 系列名 → Zo.txt 中的名称
SERIES_ZO_NAMES = {
    '书报合辑': 'books',
    '生命读经': 'smdj8',
    '倪柝声文集': 'nee',
    '李文集': 'lee8',
    '信息拾遗': 'sy_auto',
}

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def sanitize_text(text: str) -> str:
    """替换敏感词汇"""
    for old, new in SENSITIVE_REPLACEMENTS:
        text = text.replace(old, new)
    return text


def natural_sort_key(s: str):
    """自然排序 key，使 '2' 排在 '10' 前面"""
    return [int(c) if c.isdigit() else c.lower()
            for c in re.split(r'(\d+)', str(s))]


def normalize_url(url: str) -> str:
    """归一化 URL：去除协议前缀，用于查找表匹配"""
    url = url.strip()
    for prefix in ('https://', 'http://'):
        if url.startswith(prefix):
            return url[len(prefix):]
    return url


def read_file(file_path: str) -> Optional[str]:
    """安全读取文件"""
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception as e:
        log.warning(f"无法读取文件 {file_path}: {e}")
        return None


# ---------------------------------------------------------------------------
# Zo.txt 解析 — 构建主目录骨架
# ---------------------------------------------------------------------------

def parse_zo_line(line: str) -> Tuple[int, str]:
    """解析一行 Zo.txt，返回 (dash_count, content)"""
    m = re.match(r'^(-+)(.*)', line)
    if not m:
        return (0, '')
    dashes = len(m.group(1))
    content = m.group(2).strip()
    return (dashes, content)


def extract_books_category(line: str) -> Optional[Tuple[str, str]]:
    """从 books 系列分类行提取 (prefix, name)，如 '1000 福音类' → ('1', '福音类')"""
    m = re.match(r'^(\d+)\s+(.+)$', line)
    if m:
        num = m.group(1)
        name = m.group(2).strip()
        prefix = num[0]  # 首位数字即为 prefix
        return (prefix, name)
    return None


def make_book_url(url: str) -> str:
    """构建用于内容查找的 URL key（归一化）"""
    return normalize_url(url)


def parse_zo_index(zo_path: Path) -> Dict:
    """
    解析 Zo.txt，构建主目录骨架。
    返回结构:
    {
      'series': {
        'books': {
          'categories': [
            {
              'prefix': '1', 'name': '福音类',
              'books': [
                {
                  'title': '1001 到底有没有神',
                  'category': '福音类', 'category_prefix': '1',
                  'chapters': [{'url': '...', 'title': '...'}],
                  'links': [{'book_id': '2263', 'title': '...'}],
                }
              ]
            }
          ]
        },
        'smdj8': {
          'groups': [
            {
              'name': '创',
              'chapters': [{'url': '...', 'title': '...'}]
            }
          ]
        },
        'nee': {
          'groups': [
            {
              'name': '第一辑',
              'books': [
                {
                  'title': '第01册 灵修指微',
                  'chapters': [{'url': '...', 'title': '...'}]
                }
              ]
            }
          ]
        },
        ...
      }
    }
    """
    text = read_file(str(zo_path))
    if not text:
        log.error(f"无法读取 Zo.txt: {zo_path}")
        return {'series': {}}

    lines = text.split('\n')
    result = {'series': {}}

    current_series = None
    current_series_id = None
    # 对于 books: current_category
    current_category = None
    # 对于 nee/lee8: current_group (辑/年代)
    current_group = None
    # 当前书籍
    current_book = None

    for line_no, raw_line in enumerate(lines, 1):
        line = raw_line.rstrip()
        if not line:
            continue

        dash_count, content = parse_zo_line(line)
        if dash_count == 0:
            continue  # 首页 或空行

        # ----- Level 1: 系列 -----
        if dash_count == 1:
            series_id = SERIES_ZO_NAMES.get(content)
            if series_id:
                current_series_id = series_id
                if series_id == 'books':
                    result['series'][series_id] = {'categories': []}
                elif series_id in ('nee', 'lee8'):
                    result['series'][series_id] = {'groups': []}
                elif series_id == 'smdj8':
                    result['series'][series_id] = {'groups': []}
                elif series_id == 'sy_auto':
                    result['series'][series_id] = {'items': [], 'groups': []}
            else:
                current_series_id = None
            current_category = None
            current_group = None
            current_book = None
            continue

        if not current_series_id:
            continue

        # ----- Level 2: 分类 / 子组 -----
        if dash_count == 2:
            if current_series_id == 'books':
                cat_info = extract_books_category(content)
                if cat_info:
                    prefix, name = cat_info
                    current_category = {
                        'prefix': prefix,
                        'name': name,
                        'books': [],
                    }
                    result['series']['books']['categories'].append(current_category)
                else:
                    current_category = None
            elif current_series_id == 'sy_auto':
                # 可能是 http://title (说明文字), 独立条目 URL, 或子分组名
                if content.startswith('http://title'):
                    pass  # 说明文字，跳过
                elif re.match(r'https?://', content):
                    # 独立条目（如 sy_auto-first-N.md）
                    parts = content.split(' ', 1)
                    url = parts[0]
                    title = parts[1] if len(parts) > 1 else ''
                    result['series']['sy_auto']['items'].append({
                        'url': url,
                        'title': title,
                    })
                else:
                    # 子分组
                    current_group = {
                        'name': content,
                        'items': [],
                        'sub_groups': [],
                    }
                    result['series']['sy_auto']['groups'].append(current_group)
            elif current_series_id in ('nee', 'lee8', 'smdj8'):
                current_group = {
                    'name': content,
                    'books': [] if current_series_id == 'nee' else None,
                    'chapters': [] if current_series_id in ('smdj8',) else None,
                    'entries': [] if current_series_id == 'lee8' else None,
                }
                result['series'][current_series_id]['groups'].append(current_group)
            current_book = None
            continue

        # ----- Level 3: 书籍 / 条目 -----
        if dash_count == 3:
            if current_series_id == 'books':
                _parse_books_level3(content, current_category)
            elif current_series_id == 'smdj8':
                _parse_smdj8_level3(content, current_group)
            elif current_series_id == 'nee':
                _parse_nee_level3(content, current_group)
            elif current_series_id == 'lee8':
                _parse_lee8_level3(content, current_group)
            elif current_series_id == 'sy_auto':
                _parse_sy_auto_level3(content, current_group)
            current_book = None
            continue

        # ----- Level 4: 章节 URL / 子分组 -----
        if dash_count == 4:
            if current_series_id == 'books':
                _parse_books_level4(content, current_category)
            elif current_series_id == 'nee':
                _parse_nee_level4(content, current_group)
            elif current_series_id == 'sy_auto':
                _parse_sy_auto_level4(content, current_group)
            continue

        # ----- Level 5: 子章节 URL -----
        if dash_count == 5:
            if current_series_id == 'books':
                _parse_books_level5(content, current_category)
            elif current_series_id == 'sy_auto':
                _parse_sy_auto_level5(content, current_group)
            continue

    # Debug: 打印骨架摘要
    for sid, sdata in result['series'].items():
        if sid == 'books':
            total_b = sum(len(c.get('books', [])) for c in sdata.get('categories', []))
            log.info(f"  {sid}: {len(sdata.get('categories', []))} 个分类, {total_b} 本书")
        elif sid in ('smdj8', 'nee'):
            total_b = 0
            for g in sdata.get('groups', []):
                if sid == 'nee':
                    total_b += len(g.get('books', []))
                else:
                    total_b += 1 if g.get('chapters') else 0
            log.info(f"  {sid}: {len(sdata.get('groups', []))} 个分组, {total_b} 本书")
        elif sid == 'lee8':
            total_e = sum(len(g.get('entries', [])) for g in sdata.get('groups', []))
            log.info(f"  {sid}: {len(sdata.get('groups', []))} 个分组, {total_e} 个条目")
        elif sid == 'sy_auto':
            promoted_groups = []
            remaining_groups = []
            for g in sdata.get('groups', []):
                if g['name'] in SY_AUTO_PROMOTE:
                    promoted_groups.append(g)
                else:
                    remaining_groups.append(g)
            promote_sids = set()
            for g in promoted_groups:
                promote_sids.add(SY_AUTO_PROMOTE[g['name']])
            log.info(f"  {sid}: {len(sdata.get('items', []))} 个独立条目, "
                     f"{len(sdata.get('groups', []))} 个分组 "
                     f"(提升 {len(promoted_groups)} 组 → {len(promote_sids)} 个新系列, "
                     f"保留 {len(remaining_groups)} 组)")

    return result


def _is_url(s: str) -> bool:
    return bool(re.match(r'https?://', s))


def _split_url_title(content: str) -> Tuple[str, str]:
    """分割 'URL 标题' 格式"""
    parts = content.split(' ', 1)
    url = parts[0]
    title = parts[1].strip() if len(parts) > 1 else ''
    return url, title


def _parse_books_level3(content: str, category: Optional[dict]):
    """解析 books 系列 level 3（书籍条目）"""
    if not category:
        return
    if _is_url(content):
        # 单页书籍: ---http://mana.stmn1.com/books/1/1004.html 1004 有神
        url, title_part = _split_url_title(content)
        # title_part 格式: "1004 有神"
        m = re.match(r'^(\d+)\s+(.*)', title_part)
        if m:
            book_num = m.group(1)
            book_title = m.group(2)
        else:
            book_num = ''
            book_title = title_part
        book = {
            'book_num': book_num,
            'title': title_part or book_num,
            'category': category['name'],
            'category_prefix': category['prefix'],
            'chapters': [{'url': url, 'title': book_title or book_num}],
            'is_single_page': True,
        }
        category['books'].append(book)
    else:
        # 多章书籍: ---1001 到底有没有神
        m = re.match(r'^(\d+)\s+(.*)', content)
        if m:
            book_num = m.group(1)
            book_title = m.group(2)
        else:
            book_num = ''
            book_title = content
        book = {
            'book_num': book_num,
            'title': content,
            'category': category['name'],
            'category_prefix': category['prefix'],
            'chapters': [],
            'is_single_page': False,
        }
        category['books'].append(book)


def _parse_books_level4(content: str, category: Optional[dict]):
    """解析 books 系列 level 4（章节 URL 或书籍内子分组）"""
    if not category or not category['books']:
        return
    current_book = category['books'][-1]
    if _is_url(content):
        url, title = _split_url_title(content)
        current_book['chapters'].append({'url': url, 'title': title})
    else:
        # 书籍内子分组（如 "基督与神"），不需要特殊处理，
        # 后续 level 5 的 URL 直接加入当前书
        pass


def _parse_books_level5(content: str, category: Optional[dict]):
    """解析 books 系列 level 5（子分组下的章节 URL）"""
    if not category or not category['books']:
        return
    current_book = category['books'][-1]
    if _is_url(content):
        url, title = _split_url_title(content)
        current_book['chapters'].append({'url': url, 'title': title})


def _parse_smdj8_level3(content: str, group: Optional[dict]):
    """解析 smdj8 系列 level 3（章节 URL）"""
    if not group:
        return
    if group.get('chapters') is None:
        return
    if _is_url(content):
        url, title = _split_url_title(content)
        # 跳过导读 URL (four.soqimp.com)
        if 'four.soqimp.com' in url or 'soqimp.com' in url:
            return
        group['chapters'].append({'url': url, 'title': title})


def _parse_nee_level3(content: str, group: Optional[dict]):
    """解析 nee 系列 level 3（册/书籍）"""
    if not group:
        return
    if group.get('books') is None:
        return
    if _is_url(content):
        # 不太常见，但处理直接 URL
        pass
    else:
        # 书籍: ---第01册 灵修指微
        book = {
            'title': content,
            'chapters': [],
        }
        group['books'].append(book)


def _parse_nee_level4(content: str, group: Optional[dict]):
    """解析 nee 系列 level 4（章节 URL）"""
    if not group or not group.get('books'):
        return
    current_book = group['books'][-1]
    if _is_url(content):
        url, title = _split_url_title(content)
        current_book['chapters'].append({'url': url, 'title': title})


def _parse_lee8_level3(content: str, group: Optional[dict]):
    """解析 lee8 系列 level 3（条目）"""
    if not group:
        return
    if group.get('entries') is None:
        return
    if content.startswith('http://title'):
        # 年份分隔符: ---http://title 1950年
        parts = content.split(' ', 1)
        year = parts[1] if len(parts) > 1 else ''
        group['entries'].append({
            'type': 'year',
            'year': year,
        })
    elif content.startswith('link '):
        # 引用: ---link 2263 在乎灵不在乎仪文
        parts = content.split(' ', 2)
        book_id = parts[1] if len(parts) > 1 else ''
        title = parts[2] if len(parts) > 2 else ''
        group['entries'].append({
            'type': 'link',
            'book_id': book_id,
            'title': title.strip(),
        })
    elif _is_url(content):
        url, title = _split_url_title(content)
        group['entries'].append({
            'type': 'url',
            'url': url,
            'title': title,
        })


def _parse_sy_auto_level3(content: str, group: Optional[dict]):
    """解析 sy_auto 系列 level 3（子分组内的条目）"""
    if not group:
        return
    if _is_url(content):
        if content.startswith('http://title'):
            return  # 标题行，跳过
        url, title = _split_url_title(content)
        group['items'].append({'url': url, 'title': title})
    else:
        # 子子分组
        sub_group = {'name': content, 'items': []}
        group['sub_groups'].append(sub_group)


def _parse_sy_auto_level4(content: str, group: Optional[dict]):
    """解析 sy_auto 系列 level 4（子子分组内的条目）"""
    if not group:
        return
    if _is_url(content):
        if content.startswith('http://title'):
            return  # 标题行，跳过
        url, title = _split_url_title(content)
        # 添加到最近的子子分组
        if group['sub_groups']:
            group['sub_groups'][-1]['items'].append({'url': url, 'title': title})
        else:
            group['items'].append({'url': url, 'title': title})
    else:
        # 更深层的子分组（如结晶读经合辑的"01 创世纪结晶读经"）
        if group['sub_groups']:
            sub_group = {'name': content, 'items': []}
            group['sub_groups'][-1].setdefault('sub_groups', []).append(sub_group)


def _parse_sy_auto_level5(content: str, group: Optional[dict]):
    """解析 sy_auto 系列 level 5（深层嵌套条目）"""
    if not group:
        return
    if _is_url(content):
        if content.startswith('http://title'):
            return
        url, title = _split_url_title(content)
        # 添加到最近的子子分组的最近子分组
        if group['sub_groups']:
            last_sub = group['sub_groups'][-1]
            sub_subs = last_sub.get('sub_groups', [])
            if sub_subs:
                sub_subs[-1]['items'].append({'url': url, 'title': title})
            else:
                last_sub['items'].append({'url': url, 'title': title})
        else:
            group['items'].append({'url': url, 'title': title})


# ---------------------------------------------------------------------------
# 内容查找表 — 扫描 ysz 文件构建 URL→内容 映射
# ---------------------------------------------------------------------------

def build_content_lookup(input_dir: Path) -> Dict[str, str]:
    """
    扫描所有 ysz txt 文件（跳过 Zo.txt 和圣经文件），
    构建 URL → 原始内容（HTML/Markdown）查找表。
    key= 行分隔不同文档。
    """
    lookup = {}
    txt_files = sorted(input_dir.glob('*.txt'))
    skipped = 0

    for txt_file in txt_files:
        if txt_file.name in SKIP_FILES:
            skipped += 1
            continue

        text = read_file(str(txt_file))
        if not text:
            continue

        # 按 key= 行分割文档
        current_url = None
        current_lines = []

        for line in text.split('\n'):
            if line.startswith('key='):
                # 保存上一个文档
                if current_url and current_lines:
                    lookup[current_url] = '\n'.join(current_lines)
                # 开始新文档
                url = line[4:].strip()
                current_url = normalize_url(url)
                current_lines = []
            else:
                current_lines.append(line)

        # 保存最后一个文档
        if current_url and current_lines:
            lookup[current_url] = '\n'.join(current_lines)

    log.info(f"内容查找表: {len(lookup)} 个文档 (跳过 {skipped} 个文件)")
    return lookup


# ---------------------------------------------------------------------------
# HTML 内容提取 — 自动检测 DOM 结构
# ---------------------------------------------------------------------------

def extract_html_chapter(html_text: str) -> Optional[dict]:
    """
    从 ysz HTML 文档提取章节信息。
    自动检测三种 DOM 结构并分发到对应提取器：
      1. smdj8 系列: <div id="tabcontent"> + <p class="AA/BB/...">
      2. nee 系列:   <header class="title"> + <section class="about">
      3. books 系列:  <header> + 嵌套 <div>
    如果内容不是 HTML（纯文本），则直接使用原始文本。
    返回 {'title': str, 'content': str} 或 None。
    """
    # 快速检测是否为纯文本（无 HTML 标签）
    if not re.search(r'<[a-zA-Z][^>]*>', html_text):
        # 纯文本内容，直接使用
        content = html_text.strip()
        if not content:
            return None
        # 提取第一行作为标题
        lines = content.split('\n')
        title = lines[0].strip() if lines else ''
        content = sanitize_text(content)
        return {'title': sanitize_text(title), 'content': content}

    try:
        soup = BeautifulSoup(html_text, 'html.parser')
    except Exception:
        return None

    # 检测 smdj8: 有 <div id="tabcontent">
    if soup.find('div', id='tabcontent'):
        result = _extract_smdj8_chapter(soup)
        if result:
            return result

    # 检测 nee: 有 <header class="title">
    header_title = soup.find('header', class_='title')
    if header_title:
        result = _extract_nee_chapter(soup)
        if result:
            return result

    # 默认: books 系列
    result = _extract_books_chapter(soup)
    if result:
        return result

    # 回退: HTML 解析失败，尝试使用纯文本
    text = soup.get_text(separator='\n', strip=True)
    if text and len(text) > 5:
        lines = text.split('\n')
        title = lines[0].strip() if lines else ''
        content = sanitize_text(text)
        return {'title': sanitize_text(title), 'content': content}

    return None


# ---- books 系列提取器 ----

def _extract_books_chapter(soup) -> Optional[dict]:
    """books 系列: <header> 书名/章节标题 + 嵌套 div 正文"""
    book_name = ''
    chapter_title = ''
    headers = soup.find_all('header')
    if len(headers) >= 1:
        a_tag = headers[0].find('a')
        if a_tag:
            book_name = a_tag.get_text(strip=True)
        else:
            book_name = headers[0].get_text(strip=True)
    if len(headers) >= 2:
        chapter_title = headers[1].get_text(strip=True)

    body = soup.find('body')
    if not body:
        return None

    content_parts = []
    for child in body.children:
        if not hasattr(child, 'name'):
            continue
        if child.name != 'div':
            continue
        if child.find('header'):
            continue
        # 仅检查直接子 <a> 标签，避免深层嵌套的空导航链接误跳过正文 div
        a_tags = child.find_all('a', recursive=False)
        if a_tags and all(not a.get_text(strip=True) for a in a_tags):
            continue
        _extract_content_div(child, content_parts)

    content = '\n'.join(content_parts).strip()
    if not content:
        return None

    content = sanitize_text(content)
    title = chapter_title or book_name
    return {
        'title': sanitize_text(title),
        'content': content,
    }


def _extract_content_div(div, parts: list):
    """
    从 books 系列正文 div 提取文本内容。
    优先三层嵌套，回退到扁平模式。
    """
    inner_divs = div.find_all('div', recursive=False)
    has_nested = False
    initial_len = len(parts)

    for inner in inner_divs:
        if inner.get('id'):
            # 如果带 id 的 div 有子 div，递归提取内容而非仅当标题
            sub_divs = inner.find_all('div', recursive=False)
            if sub_divs:
                has_nested = True
                _extract_content_div(inner, parts)
            else:
                title_text = inner.get_text(strip=True)
                if title_text and len(title_text) < 100:
                    parts.append(f"\n{title_text}\n")
            continue
        sub_divs = inner.find_all('div', recursive=False)
        if sub_divs:
            has_nested = True
            for sub in sub_divs:
                text = sub.get_text(strip=True)
                if text:
                    text = re.sub(r'\s+', ' ', text)
                    parts.append(text)
        else:
            text = inner.get_text(strip=True)
            if text and len(text) > 2:
                text = re.sub(r'\s+', ' ', text)
                parts.append(text)

    if not has_nested and len(parts) == initial_len:
        text = div.get_text(separator='\n', strip=True)
        if text:
            parts.append(text)


# ---- smdj8 系列提取器 ----

def _extract_smdj8_chapter(soup) -> Optional[dict]:
    """
    smdj8 系列 DOM 结构:
      <title>《书名》章节标题</title>
      <div id="tabcontent">
        <ul class="hidden">  ← 纲目（可选）
        <ul name="tabul">    ← 信息正文
          <li><div>
            <p class="text12_150">章节标题</p>
            <p class="AA">正文段落</p>
            <p class="YY">小节标题</p>
            <p class="ZZ">大节标题</p>
            <p class="BB">子标题</p>
            <p class="CC">子子标题</p>
            <p class="DD">细项</p>
            <p class="EE">细项</p>
          </div></li>
        </ul>
      </div>
    """
    # 从 <title> 提取标题
    title_tag = soup.find('title')
    full_title = title_tag.get_text(strip=True) if title_tag else ''
    # 去除书名号: 《创世记生命读经》第一篇 ... → 第一篇 ...
    chapter_title = re.sub(r'^《[^》]*》\s*', '', full_title).strip()

    # 从 <div id="tabcontent"> 提取正文
    tab_content = soup.find('div', id='tabcontent')
    if not tab_content:
        return None

    content_parts = []

    # 优先从 <ul name="tabul"> 提取信息正文
    tab_ul = tab_content.find('ul', attrs={'name': 'tabul'})
    if tab_ul:
        _extract_smdj8_ul(tab_ul, content_parts)
    else:
        # 回退: 从所有 <ul> 提取
        for ul in tab_content.find_all('ul', recursive=False):
            _extract_smdj8_ul(ul, content_parts)

    content = '\n'.join(content_parts).strip()
    if not content:
        return None

    content = sanitize_text(content)
    return {
        'title': sanitize_text(chapter_title) or sanitize_text(full_title),
        'content': content,
    }


def _extract_smdj8_ul(ul, parts: list):
    """从 smdj8 的 <ul> 提取正文段落"""
    for li in ul.find_all('li', recursive=False):
        div = li.find('div', recursive=False)
        if not div:
            continue
        for p_tag in div.find_all('p', recursive=False):
            cls = p_tag.get('class', [])
            # 跳过空段落和导航段落
            text = p_tag.get_text(strip=True)
            if not text:
                continue
            # 跳过 typ 类空段落
            if 'yp' in cls or 'text12_150' in cls:
                continue
            # 标题类段落: 作为小节标题插入
            if any(c in cls for c in ('YY', 'ZZ', 'BB', 'CC', 'DD', 'EE',
                                       'text8', 'text7', 'text6')):
                parts.append(f"\n{text}\n")
            else:
                # 正文段落 (AA 等)
                text = re.sub(r'\s+', ' ', text)
                parts.append(text)


# ---- nee 系列提取器 ----

def _extract_nee_chapter(soup) -> Optional[dict]:
    """
    nee 系列 Bootstrap DOM 结构:
      <header class="title">
        <hgroup>
          <h1 class="side">书名</h1>
          <h2 class="side">章节标题</h2>
        </hgroup>
      </header>
      <section class="about">
        <ul class="container">
          <li>
            <blockquote class="b">
              <p class="AA">标题性段落</p>
              <h4>标题</h4>
            </blockquote>
            <blockquote class="c">
              <p class="AA">正文段落</p>
            </blockquote>
          </li>
        </ul>
      </section>
    """
    # 从 <h1 class="side"> 获取书名, <h2 class="side"> 获取章节标题
    h1 = soup.find('h1', class_='side')
    h2 = soup.find('h2', class_='side')
    book_name = h1.get_text(strip=True) if h1 else ''
    chapter_title = h2.get_text(strip=True) if h2 else ''

    # 从 <section class="about"> 提取正文
    about_section = soup.find('section', class_='about')
    if not about_section:
        return None

    content_parts = []
    # 提取所有 blockquote 内的内容
    for bq in about_section.find_all('blockquote'):
        # 提取 <p> 标签内容
        for p_tag in bq.find_all('p'):
            text = p_tag.get_text(strip=True)
            if not text:
                continue
            cls = p_tag.get('class', [])
            # BB 类通常是签名/日期
            if 'BB' in cls:
                content_parts.append(f"\n{text}\n")
            else:
                text = re.sub(r'\s+', ' ', text)
                content_parts.append(text)
        # 提取 <h4> 标签作为小节标题
        for h4_tag in bq.find_all('h4'):
            text = h4_tag.get_text(strip=True)
            if text:
                content_parts.append(f"\n{text}\n")

    # 回退: 如果 blockquote 内没有内容，提取所有 <p> 标签
    if not content_parts:
        for p_tag in about_section.find_all('p'):
            text = p_tag.get_text(strip=True)
            if text:
                text = re.sub(r'\s+', ' ', text)
                content_parts.append(text)

    content = '\n'.join(content_parts).strip()
    if not content:
        return None

    content = sanitize_text(content)
    title = chapter_title or book_name
    return {
        'title': sanitize_text(title),
        'content': content,
    }


# ---------------------------------------------------------------------------
# Markdown 内容提取
# ---------------------------------------------------------------------------

def extract_markdown_chapter(md_text: str) -> Optional[dict]:
    """
    从 ysz Markdown 文档提取内容。
    按 # 纲目、# 听抄、# 标语 分割。
    """
    if not md_text or not md_text.strip():
        return None

    lines = md_text.strip().split('\n')

    # 提取标题（第一行通常是标题）
    title_line = lines[0].strip() if lines else ''
    # 去除可能的 Markdown 标题前缀
    title = re.sub(r'^#+\s*', '', title_line).strip()

    # 分割 sections
    sections = {}
    current_section = '_header'
    current_lines = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith('# '):
            # 保存上一个 section
            if current_lines:
                sections[current_section] = '\n'.join(current_lines)
            section_name = stripped[2:].strip()
            # 去除 ─引用经文 后缀
            section_name = re.sub(r'─引用经文$', '', section_name)
            current_section = section_name
            current_lines = []
        elif stripped.startswith('### '):
            text = stripped[4:].strip()
            text = re.sub(r'─引用经文$', '', text)
            current_lines.append(f"  {text}")
        elif stripped.startswith('## '):
            # 纲目中的层级标题
            text = stripped[3:].strip()
            text = re.sub(r'─引用经文$', '', text)
            current_lines.append(f"\n{text}")
        elif re.match(r'^\d+\s', stripped):
            # 数字列表项 (如 "1 神在祂的救恩里...")
            text = re.sub(r'─引用经文$', '', stripped)
            current_lines.append(f"    {text}")
        else:
            text = re.sub(r'─引用经文$', '', stripped)
            current_lines.append(text)

    # 保存最后一个 section
    if current_lines:
        sections[current_section] = '\n'.join(current_lines)

    # 组装内容
    content_parts = []

    # 纲目
    if '纲目' in sections:
        outline = sections['纲目'].strip()
        if outline:
            content_parts.append(outline)

    # 听抄
    if '听抄' in sections:
        transcript = sections['听抄'].strip()
        # 去除开头的说明文字
        transcript = re.sub(r'^未经讲者审阅[^\n]*\n?', '', transcript)
        if transcript:
            content_parts.append(transcript)

    # 标语
    if '标语' in sections:
        slogan = sections['标语'].strip()
        if slogan:
            content_parts.append(slogan)

    # 如果没有识别到任何 section，使用全部文本
    if not content_parts:
        full_text = '\n'.join(lines[1:]).strip()  # 跳过标题行
        if full_text:
            content_parts.append(full_text)

    content = '\n'.join(content_parts).strip()
    if not content:
        return None

    content = sanitize_text(content)

    return {
        'title': sanitize_text(title) if title else '',
        'content': content,
    }


# ---------------------------------------------------------------------------
# 组装书籍 — 骨架与查找表合并
# ---------------------------------------------------------------------------

def assemble_books(skeleton: Dict, lookup: Dict[str, str],
                   verbose: bool = False) -> Dict[str, List[dict]]:
    """
    将骨架数据与内容查找表合并，组装最终的书籍数据。
    返回 {series_id: [book_dict, ...]}
    """
    all_books = {}

    series_data = skeleton.get('series', {})

    # ----- books 系列 -----
    if 'books' in series_data:
        all_books['books'] = _assemble_books_series(series_data['books'], lookup, verbose)

    # ----- smdj8 系列 -----
    if 'smdj8' in series_data:
        all_books['smdj8'] = _assemble_smdj8_series(series_data['smdj8'], lookup, verbose)

    # ----- nee 系列 -----
    if 'nee' in series_data:
        all_books['nee'] = _assemble_nee_series(series_data['nee'], lookup, verbose)

    # ----- lee8 系列 -----
    if 'lee8' in series_data:
        all_books['lee8'] = _assemble_lee8_series(series_data['lee8'], lookup, verbose, all_books.get('books', []))

    # ----- sy_auto 系列（含拆分）-----
    if 'sy_auto' in series_data:
        sy_result = _assemble_sy_auto_series(series_data['sy_auto'], lookup, verbose)
        all_books.update(sy_result)

    return all_books


def _lookup_and_extract(url: str, lookup: Dict[str, str], is_markdown: bool = False) -> Optional[dict]:
    """从查找表中获取内容并提取"""
    key = normalize_url(url)
    raw = lookup.get(key)
    if not raw:
        return None
    if is_markdown or key.endswith('.md'):
        return extract_markdown_chapter(raw)
    else:
        return extract_html_chapter(raw)


def _assemble_books_series(data: dict, lookup: dict, verbose: bool) -> List[dict]:
    """组装 books 系列"""
    books = []
    for cat in data.get('categories', []):
        cat_name = cat['name']
        cat_prefix = cat['prefix']
        for book_info in cat.get('books', []):
            book_num = book_info.get('book_num', '')
            book_title = book_info.get('title', '')
            chapters_raw = book_info.get('chapters', [])

            # 提取章节内容
            chapters = []
            for i, ch in enumerate(chapters_raw, 1):
                extracted = _lookup_and_extract(ch['url'], lookup)
                if extracted:
                    chapters.append({
                        'number': len(chapters) + 1,
                        'title': extracted.get('title') or ch.get('title', ''),
                        'content': extracted['content'],
                    })
                elif verbose:
                    log.debug(f"  未找到内容: {ch['url']}")

            if chapters:
                book_id = f"books-{cat_prefix}-{book_num}" if book_num else f"books-{cat_prefix}-unknown"
                # book_title 可能已包含 book_num（如 "1001 到底有没有神"），避免重复拼接
                if book_num and book_title.startswith(book_num):
                    display_title = f"{book_num}-{book_title[len(book_num):].lstrip()}" if book_num else book_title
                else:
                    display_title = f"{book_num}-{book_title}" if book_num else book_title
                books.append({
                    'id': book_id.lower(),
                    'title': display_title,
                    'category': cat_name,
                    'category_prefix': cat_prefix,
                    'format': 'html',
                    'chapters': chapters,
                })

    log.info(f"  books: {len(books)} 本书")
    return books


def _assemble_smdj8_series(data: dict, lookup: dict, verbose: bool) -> List[dict]:
    """组装 smdj8 系列"""
    books = []
    book_num = 0
    for group in data.get('groups', []):
        group_name = group.get('name', '')
        chapters_raw = group.get('chapters', [])
        if not chapters_raw:
            continue

        book_num += 1
        chapters = []
        for ch in chapters_raw:
            extracted = _lookup_and_extract(ch['url'], lookup)
            if extracted:
                chapters.append({
                    'number': len(chapters) + 1,
                    'title': extracted.get('title') or ch.get('title', ''),
                    'content': extracted['content'],
                })

        if chapters:
            book_id = f"smdj8-{book_num:02d}"
            books.append({
                'id': book_id,
                'title': sanitize_text(group_name),
                'format': 'html',
                'chapters': chapters,
            })

    log.info(f"  smdj8: {len(books)} 本书")
    return books


def _assemble_nee_series(data: dict, lookup: dict, verbose: bool) -> List[dict]:
    """组装 nee 系列"""
    books = []
    book_num = 0
    for group in data.get('groups', []):
        group_name = group.get('name', '')
        for book_info in group.get('books', []):
            book_num += 1
            book_title = book_info.get('title', '')
            chapters_raw = book_info.get('chapters', [])

            chapters = []
            for ch in chapters_raw:
                extracted = _lookup_and_extract(ch['url'], lookup)
                if extracted:
                    chapters.append({
                        'number': len(chapters) + 1,
                        'title': extracted.get('title') or ch.get('title', ''),
                        'content': extracted['content'],
                    })

            if chapters:
                book_id = f"nee-{book_num:03d}"
                # 标题格式: "辑名 册名"
                display_title = f"{group_name} {book_title}".strip()
                display_title = sanitize_text(display_title)
                books.append({
                    'id': book_id,
                    'title': display_title,
                    'format': 'html',
                    'chapters': chapters,
                })

    log.info(f"  nee: {len(books)} 本书")
    return books


def _assemble_lee8_series(data: dict, lookup: dict, verbose: bool,
                          books_series: List[dict]) -> List[dict]:
    """组装 lee8 系列"""
    books = []
    book_num = 0

    # 构建 books 系列的 book_num → book_data 查找表
    books_by_num = {}
    for b in books_series:
        # id 格式: books-1-1001
        parts = b.get('id', '').split('-')
        if len(parts) >= 3:
            num = parts[-1]
            books_by_num[num] = b

    for group in data.get('groups', []):
        group_name = group.get('name', '')
        entries = group.get('entries', [])
        current_year = ''

        for entry in entries:
            if entry['type'] == 'year':
                current_year = entry.get('year', '')
            elif entry['type'] == 'link':
                book_id = entry.get('book_id', '')
                title = entry.get('title', '')

                # 查找对应 books 系列的书
                linked_book = books_by_num.get(book_id)
                if linked_book and linked_book.get('chapters'):
                    book_num += 1
                    lee_id = f"lee8-{book_num:02d}"
                    year_prefix = f"{current_year} " if current_year else ''
                    display_title = f"{year_prefix}{title}".strip()
                    books.append({
                        'id': lee_id,
                        'title': sanitize_text(display_title),
                        'format': 'html',
                        'chapters': linked_book['chapters'],  # 复用 books 系列的章节
                    })
                elif verbose:
                    log.debug(f"  lee8 link 未找到: {book_id} {title}")
            elif entry['type'] == 'url':
                url = entry.get('url', '')
                extracted = _lookup_and_extract(url, lookup)
                if extracted:
                    book_num += 1
                    lee_id = f"lee8-{book_num:02d}"
                    year_prefix = f"{current_year} " if current_year else ''
                    display_title = f"{year_prefix}{entry.get('title', '')}".strip()
                    books.append({
                        'id': lee_id,
                        'title': sanitize_text(display_title),
                        'format': 'html',
                        'chapters': [{
                            'number': 1,
                            'title': extracted.get('title', ''),
                            'content': extracted['content'],
                        }],
                    })

    log.info(f"  lee8: {len(books)} 本书")
    return books


def _assemble_sy_auto_series(data: dict, lookup: dict, verbose: bool) -> Dict[str, List[dict]]:
    """
    组装 sy_auto 系列，同时根据 SY_AUTO_PROMOTE 将部分分组提升为独立系列。
    返回 {series_id: [book_dict, ...]}，包含 'sy_auto' 和所有提升后的新系列。
    """

    def _is_markdown_url(url: str) -> bool:
        return normalize_url(url).endswith('.md')

    def _extract_items_to_books(items: list, series_id: str,
                                start_num: int) -> Tuple[List[dict], int]:
        """将条目列表转换为书籍列表"""
        books = []
        book_num = start_num
        for item in items:
            is_md = _is_markdown_url(item['url'])
            extracted = _lookup_and_extract(item['url'], lookup, is_markdown=is_md)
            if extracted:
                book_num += 1
                book_id = f"{series_id}-{book_num:03d}"
                title = item.get('title') or extracted.get('title', '')
                books.append({
                    'id': book_id,
                    'title': sanitize_text(title),
                    'format': 'html',
                    'chapters': [{
                        'number': 1,
                        'title': extracted.get('title', '') or title,
                        'content': extracted['content'],
                    }],
                })
            elif verbose:
                log.debug(f"  {series_id} 未找到: {item.get('url', '')}")
        return books, book_num

    def _collect_group_items(group: dict) -> list:
        """收集分组中所有条目（递归收集所有层级的子分组）"""
        all_items = list(group.get('items', []))
        for sub in group.get('sub_groups', []):
            all_items.extend(_collect_group_items(sub))
        return all_items

    # 按 SY_AUTO_PROMOTE 分组
    promoted = {}   # series_id → [(group_name, [items])]
    remaining_groups = []

    for group in data.get('groups', []):
        group_name = group.get('name', '')
        if group_name in SY_AUTO_PROMOTE:
            series_id = SY_AUTO_PROMOTE[group_name]
            all_items = _collect_group_items(group)
            if all_items:
                promoted.setdefault(series_id, []).append((group_name, all_items))
        else:
            remaining_groups.append(group)

    # 构建结果
    result = {}

    # 组装提升后的独立系列（每个分组作为一本书，条目作为章节）
    for series_id, group_list in promoted.items():
        books = []
        book_num = 0
        for group_name, items in group_list:
            book_num += 1
            book_id = f"{series_id}-{book_num:03d}"
            chapters = []
            for item in items:
                is_md = _is_markdown_url(item['url'])
                extracted = _lookup_and_extract(
                    item['url'], lookup, is_markdown=is_md)
                if extracted:
                    chapters.append({
                        'number': len(chapters) + 1,
                        'title': extracted.get('title', '') or item.get('title', ''),
                        'content': extracted['content'],
                    })
                elif verbose:
                    log.debug(f"  {series_id} 未找到: {item.get('url', '')}")
            if chapters:
                books.append({
                    'id': book_id,
                    'title': sanitize_text(group_name),
                    'format': 'html',
                    'chapters': chapters,
                })
        result[series_id] = books
        log.info(f"  {series_id} (从sy_auto提升): {len(books)} 本书")

    # 组装剩余的 sy_auto
    sy_books = []
    book_num = 0

    # 处理独立条目
    for item in data.get('items', []):
        is_md = _is_markdown_url(item['url'])
        extracted = _lookup_and_extract(item['url'], lookup, is_markdown=is_md)
        if extracted:
            book_num += 1
            book_id = f"sy_auto-{book_num:03d}"
            title = item.get('title') or extracted.get('title', '')
            sy_books.append({
                'id': book_id,
                'title': sanitize_text(title),
                'format': 'html',
                'chapters': [{
                    'number': 1,
                    'title': extracted.get('title', '') or title,
                    'content': extracted['content'],
                }],
            })

    # 处理剩余分组：每个分组整体作为一本书，所有直接条目和子分组条目均作为章节
    for group in remaining_groups:
        all_items = _collect_group_items(group)
        if not all_items:
            continue
        book_num += 1
        book_id = f"sy_auto-{book_num:03d}"
        chapters = []
        for item in all_items:
            is_md = _is_markdown_url(item['url'])
            extracted = _lookup_and_extract(item['url'], lookup, is_markdown=is_md)
            if extracted:
                chapters.append({
                    'number': len(chapters) + 1,
                    'title': extracted.get('title', '') or item.get('title', ''),
                    'content': extracted['content'],
                })
            elif verbose:
                log.debug(f"  sy_auto 未找到: {item.get('url', '')}")
        if chapters:
            sy_books.append({
                'id': book_id,
                'title': sanitize_text(group.get('name', '')),
                'format': 'html',
                'chapters': chapters,
            })

    result['sy_auto'] = sy_books
    log.info(f"  sy_auto (剩余): {len(sy_books)} 本书")

    return result


# ---------------------------------------------------------------------------
# 输出函数
# ---------------------------------------------------------------------------

def save_book_json(book_data: dict, output_dir: Path, series: str, dry_run: bool = False):
    """保存单本书的 JSON"""
    series_dir = output_dir / series
    if not dry_run:
        series_dir.mkdir(parents=True, exist_ok=True)
    path = series_dir / f"{book_data['id']}.json"
    if dry_run:
        return
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(book_data, f, ensure_ascii=False, indent=2)
        log.info(f"  => 已保存 {series}/{path.name} ({len(book_data.get('chapters', []))} 章)")
    except Exception as e:
        log.error(f"  保存 {path} 失败: {e}")


def generate_series_index(output_dir: Path, series: str, books: List[dict],
                          dry_run: bool = False):
    """生成系列子目录的 index.json"""
    series_dir = output_dir / series
    if not dry_run:
        series_dir.mkdir(parents=True, exist_ok=True)
    index_path = series_dir / 'index.json'
    entries = []
    for book in books:
        entry = {
            'id': book['id'],
            'title': book['title'],
            'chapter_count': len(book.get('chapters', [])),
            'series': series,
        }
        if series == 'books':
            entry['category'] = book.get('category', '')
            entry['category_prefix'] = book.get('category_prefix', '')
        entries.append(entry)
    if dry_run:
        return
    try:
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump(entries, f, ensure_ascii=False, indent=2)
        log.info(f"  => 已生成 {series}/index.json ({len(entries)} 本书)")
    except Exception as e:
        log.error(f"  生成 {index_path} 失败: {e}")

    # 为 books 系列额外生成 categories.json
    if series == 'books' and books:
        categories = []
        seen = set()
        for book in books:
            cat = book.get('category', '')
            prefix = book.get('category_prefix', '')
            key = f"{prefix}-{cat}"
            if key not in seen and cat:
                seen.add(key)
                categories.append({
                    'prefix': prefix,
                    'name': cat,
                    'count': sum(1 for b in books
                                 if b.get('category') == cat
                                 and b.get('category_prefix') == prefix),
                })
        cat_path = series_dir / 'categories.json'
        try:
            with open(cat_path, 'w', encoding='utf-8') as f:
                json.dump(categories, f, ensure_ascii=False, indent=2)
            log.info(f"  => 已生成 {series}/categories.json ({len(categories)} 个分类)")
        except Exception as e:
            log.error(f"  生成 {cat_path} 失败: {e}")


def generate_global_index(output_dir: Path, all_books_by_series: Dict[str, List[dict]],
                          dry_run: bool = False):
    """生成根目录的 books-index.json"""
    index_path = output_dir / 'books-index.json'
    series_list = []
    books_list = []

    for series_id in SERIES_ORDER:
        books = all_books_by_series.get(series_id, [])
        series_entry = {
            'id': series_id,
            'title': SERIES_TITLE_MAP.get(series_id, series_id),
            'count': len(books),
        }
        # books 系列添加分类摘要
        if series_id == 'books' and books:
            cats = []
            seen = set()
            for book in books:
                cat = book.get('category', '')
                prefix = book.get('category_prefix', '')
                key = f"{prefix}-{cat}"
                if key not in seen and cat:
                    seen.add(key)
                    cats.append({
                        'prefix': prefix,
                        'name': cat,
                        'count': sum(1 for b in books
                                     if b.get('category') == cat
                                     and b.get('category_prefix') == prefix),
                    })
            series_entry['categories'] = cats
        series_list.append(series_entry)

        for book in books:
            entry = {
                'id': book['id'],
                'title': book['title'],
                'series': series_id,
                'chapter_count': len(book.get('chapters', [])),
            }
            if series_id == 'books':
                entry['category'] = book.get('category', '')
                entry['category_prefix'] = book.get('category_prefix', '')
            books_list.append(entry)

    data = {'series': series_list, 'books': books_list}
    if dry_run:
        return
    try:
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        log.info(f"=> 已生成 books-index.json ({len(books_list)} 本书)")
    except Exception as e:
        log.error(f"生成 {index_path} 失败: {e}")


def generate_manifest(output_dir: Path, total_books: int, total_chapters: int,
                      dry_run: bool = False):
    """生成根目录的 manifest.json"""
    manifest_path = output_dir / 'manifest.json'
    tz_utc8 = timezone(timedelta(hours=8))
    now = datetime.now(tz_utc8)
    data = {
        'version': 1,
        'generated_at': now.isoformat(),
        'total_books': total_books,
        'total_chapters': total_chapters,
    }
    if dry_run:
        return
    try:
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        log.info(f"=> 已生成 manifest.json")
    except Exception as e:
        log.error(f"生成 {manifest_path} 失败: {e}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='YSZ 书籍批量处理脚本')
    parser.add_argument('--input-dir', type=str, default=str(DEFAULT_INPUT_DIR),
                        help=f'输入目录（默认 {DEFAULT_INPUT_DIR}）')
    parser.add_argument('--output-dir', type=str, default=str(DEFAULT_OUTPUT_DIR),
                        help=f'输出目录（默认 {DEFAULT_OUTPUT_DIR}）')
    parser.add_argument('--dry-run', action='store_true',
                        help='模拟运行，不写入文件')
    parser.add_argument('--verbose', action='store_true',
                        help='详细日志')
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    log.info(f"YSZ 输入目录: {input_dir}")
    log.info(f"JSON 输出目录: {output_dir}")
    if args.dry_run:
        log.info("=== 模拟运行模式 (dry-run) ===")

    # 检查输入目录
    if not input_dir.exists():
        log.error(f"输入目录不存在: {input_dir}")
        return

    zo_path = input_dir / 'Zo.txt'
    if not zo_path.exists():
        log.error(f"Zo.txt 不存在: {zo_path}")
        return

    # 清理旧输出
    if not args.dry_run:
        if output_dir.exists():
            log.info(f"清理旧输出目录: {output_dir}")
            shutil.rmtree(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: 解析 Zo.txt
    log.info(f"\n{'='*60}")
    log.info("Step 1: 解析 Zo.txt 主目录骨架")
    log.info(f"{'='*60}")
    skeleton = parse_zo_index(zo_path)

    # Step 2: 构建内容查找表
    log.info(f"\n{'='*60}")
    log.info("Step 2: 构建 URL→内容 查找表")
    log.info(f"{'='*60}")
    lookup = build_content_lookup(input_dir)

    # Step 3: 组装书籍
    log.info(f"\n{'='*60}")
    log.info("Step 3: 组装书籍数据")
    log.info(f"{'='*60}")
    all_books = assemble_books(skeleton, lookup, verbose=args.verbose)

    # Step 4: 生成输出
    log.info(f"\n{'='*60}")
    log.info("Step 4: 生成输出文件")
    log.info(f"{'='*60}")
    total_books = 0
    total_chapters = 0
    summary = []

    for series_id in SERIES_ORDER:
        books = all_books.get(series_id, [])
        log.info(f"\n处理系列: {series_id} ({len(books)} 本书)")

        for book in books:
            save_book_json(book, output_dir, series_id, dry_run=args.dry_run)
            ch_count = len(book.get('chapters', []))
            total_books += 1
            total_chapters += ch_count
            summary.append(f"  {book['id']}: {book['title']} ({ch_count} 章)")

        generate_series_index(output_dir, series_id, books, dry_run=args.dry_run)

    # 生成全局索引和 manifest
    log.info(f"\n生成全局索引...")
    generate_global_index(output_dir, all_books, dry_run=args.dry_run)
    generate_manifest(output_dir, total_books, total_chapters, dry_run=args.dry_run)

    # 输出总结
    log.info(f"\n{'='*60}")
    log.info("处理完成!")
    log.info(f"{'='*60}")
    log.info(f"总计: {total_books} 本书, {total_chapters} 章")
    log.info(f"输出目录: {output_dir}")
    for line in summary:
        log.info(line)


if __name__ == '__main__':
    main()
