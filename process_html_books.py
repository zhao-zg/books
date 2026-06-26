#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HTML 书籍批量处理脚本
处理 resource/html/ 下 8 个子目录的 HTML 文件，
提取纯文本，按书籍分类，输出 JSON 到 resource/zl-html/。
"""

import os
import re
import json
import logging
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Optional
from bs4 import BeautifulSoup, Tag

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
HTML_DIR = BASE_DIR / 'resource' / 'html'
OUTPUT_DIR = BASE_DIR / 'resource' / 'zl-html'

# 系列名映射：原始目录名 → 小写系列名
SERIES_MAP = {
    '1n1bA': '1n1ba',
    '1n1bB': '1n1bb',
    'Lee8': 'lee8',
    'Nee': 'nee',
    'cxxl': 'cxxl',
    'smdj8': 'smdj8',
    'zsrm365': 'zsrm365',
    'books': 'books',
}

# 敏感词替换规则
SENSITIVE_REPLACEMENTS = [
    ("李常受文集", "CWWL"),
    ("生命读经", "LS"),
]

# 系列标题映射
SERIES_TITLE_MAP = {
    '1n1ba': '读经一年一遍（A计划）',
    '1n1bb': '读经一年一遍（B计划）',
    'cxxl': '初信喂养',
    'lee8': 'CWWL',
    'nee': '倪柝声文集',
    'smdj8': 'LS',
    'zsrm365': '圣经真理365',
    'books': '职事书报',
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


def extract_text(element) -> str:
    """从 BeautifulSoup 元素提取纯文本，合并多余空白"""
    if element is None:
        return ''
    text = element.get_text(separator=' ', strip=True)
    text = re.sub(r'\s+', ' ', text).strip()
    return sanitize_text(text)


def read_html(file_path: str) -> Optional[str]:
    """安全读取 HTML 文件"""
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception as e:
        log.warning(f"无法读取文件 {file_path}: {e}")
        return None


def parse_soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, 'html.parser')


def save_book_json(book_data: dict, output_dir: Path, series: str):
    """保存单本书的 JSON 到系列子目录"""
    series_dir = output_dir / series
    series_dir.mkdir(parents=True, exist_ok=True)
    path = series_dir / f"{book_data['id']}.json"
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(book_data, f, ensure_ascii=False, indent=2)
        log.info(f"  => 已保存 {series}/{path.name} ({len(book_data.get('chapters', []))} 章)")
    except Exception as e:
        log.error(f"  保存 {path} 失败: {e}")


def generate_series_index(output_dir: Path, series: str, books: List[dict]):
    """生成系列子目录的 index.json"""
    series_dir = output_dir / series
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
                    'count': sum(1 for b in books if b.get('category') == cat and b.get('category_prefix') == prefix),
                })
        cat_path = series_dir / 'categories.json'
        try:
            with open(cat_path, 'w', encoding='utf-8') as f:
                json.dump(categories, f, ensure_ascii=False, indent=2)
            log.info(f"  => 已生成 {series}/categories.json ({len(categories)} 个分类)")
        except Exception as e:
            log.error(f"  生成 {cat_path} 失败: {e}")


def generate_global_index(output_dir: Path, all_books_by_series: Dict[str, List[dict]]):
    """生成根目录的 books-index.json 全局索引"""
    index_path = output_dir / 'books-index.json'
    series_list = []
    books_list = []
    # 按 SERIES_MAP 的顺序输出
    for series_id in ['1n1ba', '1n1bb', 'cxxl', 'lee8', 'nee', 'smdj8', 'zsrm365', 'books']:
        books = all_books_by_series.get(series_id, [])
        series_entry = {
            'id': series_id,
            'title': SERIES_TITLE_MAP.get(series_id, series_id),
            'count': len(books),
        }
        # 为 books 系列添加分类摘要
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
                        'count': sum(1 for b in books if b.get('category') == cat and b.get('category_prefix') == prefix),
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
            # 为 books 系列添加分类信息
            if series_id == 'books':
                entry['category'] = book.get('category', '')
                entry['category_prefix'] = book.get('category_prefix', '')
            books_list.append(entry)
    data = {
        'series': series_list,
        'books': books_list,
    }
    try:
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        log.info(f"=> 已生成 books-index.json ({len(books_list)} 本书)")
    except Exception as e:
        log.error(f"生成 {index_path} 失败: {e}")


def generate_manifest(output_dir: Path, total_books: int, total_chapters: int):
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
    try:
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        log.info(f"=> 已生成 manifest.json")
    except Exception as e:
        log.error(f"生成 {manifest_path} 失败: {e}")


def lowercase_book_id(book: dict) -> dict:
    """将书籍的 id 字段转为小写"""
    book['id'] = book['id'].lower()
    return book


def strip_elements(soup, selectors: list):
    """从 soup 中移除匹配选择器的元素"""
    for sel in selectors:
        for el in soup.select(sel):
            el.decompose()


# ---------------------------------------------------------------------------
# 1. parse_1n1bA - 读经一年一遍 A计划
# ---------------------------------------------------------------------------

def parse_1n1bA(dir_path: Path) -> List[dict]:
    """读经一年一遍 A计划: jy1n1b{N}.html + xy1n1b{N}.html -> 1 本书 365 章"""
    log.info("解析 1n1bA (读经一年一遍 A计划)...")
    chapters = []

    # 收集所有正文文件，按数字排序
    files = []
    for p in dir_path.iterdir():
        name = p.name
        if name == 'index.html' or name == 'indexRL.html' or not name.endswith('.html'):
            continue
        m = re.match(r'(jy|xy)1n1b(\d+)\.html$', name)
        if m:
            files.append((int(m.group(2)), p))

    files.sort(key=lambda x: x[0])

    for num, fpath in files:
        try:
            html = read_html(str(fpath))
            if not html:
                continue
            soup = parse_soup(html)

            # 提取标题 <h1>
            h1 = soup.find('h1')
            title = extract_text(h1) if h1 else f"第{num}天"

            # 移除音频、导航、脚本
            strip_elements(soup, [
                'audio', 'script', 'style',
                '#deanbottom', '#deanbottom1',
                '.cd-top', '#chap1',
                '.text12_88',
            ])

            # 移除 overlib 脚注链接 (sup > a with onclick overlib)
            for a in soup.find_all('a', onclick=re.compile(r'overlib')):
                a.decompose()

            # 移除 "回首页" 链接段落
            for a in soup.find_all('a', string=re.compile(r'回首页')):
                parent_p = a.find_parent('p')
                if parent_p:
                    parent_p.decompose()

            # 收集正文内容
            content_parts = []
            # 大纲 div.o0 ~ o3
            for div in soup.find_all('div', class_=re.compile(r'^o[0-3]$')):
                t = extract_text(div)
                if t:
                    content_parts.append(t)

            # 段落 <p>
            for p in soup.find_all('p'):
                # 跳过只含音频或导航的段落
                if p.find('audio'):
                    continue
                t = extract_text(p)
                if t and len(t) > 1:
                    content_parts.append(t)

            # 真理问答也包含在 <p> 中，已自动收集

            content = '\n'.join(content_parts).strip()
            if content:
                chapters.append({
                    'number': num,
                    'title': title,
                    'content': content,
                })
        except Exception as e:
            log.warning(f"  解析 {fpath.name} 失败: {e}")

    book = {
        'id': '1n1bA',
        'title': '读经一年一遍（A计划）',
        'format': 'html',
        'chapters': chapters,
    }
    log.info(f"  1n1bA: {len(chapters)} 章")
    return [book]


# ---------------------------------------------------------------------------
# 2. parse_1n1bB - 读经一年一遍 B计划
# ---------------------------------------------------------------------------

def parse_1n1bB(dir_path: Path) -> List[dict]:
    """读经一年一遍 B计划: ynyb_B_{N}.html -> 1 本书 365 章"""
    log.info("解析 1n1bB (读经一年一遍 B计划)...")
    chapters = []

    files = []
    for p in dir_path.iterdir():
        m = re.match(r'ynyb_B_(\d+)\.html$', p.name)
        if m:
            files.append((int(m.group(1)), p))
    files.sort(key=lambda x: x[0])

    for num, fpath in files:
        try:
            html = read_html(str(fpath))
            if not html:
                continue
            soup = parse_soup(html)

            # 移除导航、音频、脚本
            strip_elements(soup, [
                'audio', 'script', 'style',
                '.AA1', '#navbottom', '.text12_88',
            ])

            # 提取标题 - 第一个 <h3>
            h3 = soup.find('h3')
            title = extract_text(h3) if h3 else f"第{num}天"

            # 收集经文正文 (biblejw) 和章节标题 (biblezj) 及主题 (biblezt)
            content_parts = []
            verses_div = soup.find('div', id='verses')
            if verses_div:
                for el in verses_div.find_all(['p', 'h3']):
                    cls = el.get('class', [])
                    tag = el.name
                    if tag == 'h3':
                        # 隐藏的不收集 (hidden 属性)
                        if el.has_attr('hidden'):
                            continue
                        t = extract_text(el)
                        if t:
                            content_parts.append(f"\n【{t}】\n")
                    elif 'biblezt' in cls:
                        t = extract_text(el)
                        if t:
                            content_parts.append(f"主题：{t}")
                    elif 'biblezj' in cls:
                        t = extract_text(el)
                        if t:
                            content_parts.append(f"\n{t}")
                    elif 'biblejw' in cls:
                        t = extract_text(el)
                        if t:
                            content_parts.append(t)
                    # 过滤 gm001~gm006, sz, dxx, xxx 等大纲/标注类
            else:
                # fallback: 直接找 biblejw
                for el in soup.find_all('p', class_='biblejw'):
                    t = extract_text(el)
                    if t:
                        content_parts.append(t)

            content = '\n'.join(content_parts).strip()
            if content:
                chapters.append({
                    'number': num,
                    'title': title,
                    'content': content,
                })
        except Exception as e:
            log.warning(f"  解析 {fpath.name} 失败: {e}")

    book = {
        'id': '1n1bB',
        'title': '读经一年一遍（B计划）',
        'format': 'html',
        'chapters': chapters,
    }
    log.info(f"  1n1bB: {len(chapters)} 章")
    return [book]


# ---------------------------------------------------------------------------
# 3. parse_lee8 - 李常受文集 1963-1972
# ---------------------------------------------------------------------------

def parse_lee8(dir_path: Path) -> List[dict]:
    """李常受文集: 按册分组，多本书"""
    log.info("解析 Lee8 (李常受文集)...")

    # 解析 index.html 获取册信息
    index_html = read_html(str(dir_path / 'index.html'))
    if not index_html:
        return []

    soup = parse_soup(index_html)

    # 提取册列表: <p class="A1"> 年份标题, <p class="A2"> 册链接
    volumes = []  # [(title, start_file), ...]
    a1_tags = soup.find_all('p', class_='A1')
    for a1 in a1_tags:
        year_title = extract_text(a1)
        # 紧跟的 A2 段落包含册链接
        a2 = a1.find_next_sibling('p', class_='A2')
        if a2:
            links = a2.find_all('a')
            for i, link in enumerate(links):
                href = link.get('href', '')
                vol_title = extract_text(link)
                m = re.match(r'(\d+)\.html', href)
                if m:
                    start_num = int(m.group(1))
                    full_title = f"{year_title} {vol_title}"
                    volumes.append((full_title, start_num))

    # 按起始编号排序
    volumes.sort(key=lambda x: x[1])

    # 收集所有正文文件
    all_files = {}
    for p in dir_path.iterdir():
        m = re.match(r'(\d{6})\.html$', p.name)
        if m:
            all_files[int(m.group(1))] = p

    books = []
    for i, (vol_title, start_num) in enumerate(volumes):
        # 确定此册的文件范围
        if i + 1 < len(volumes):
            end_num = volumes[i + 1][1]
        else:
            end_num = max(all_files.keys()) + 1

        vol_files = sorted(
            [(num, fp) for num, fp in all_files.items() if start_num <= num < end_num],
            key=lambda x: x[0]
        )

        # 生成 book_id
        vol_num = i + 1
        book_id = f"Lee8-{vol_num:02d}"
        chapters = []
        chapter_num = 0

        for num, fpath in vol_files:
            try:
                html = read_html(str(fpath))
                if not html:
                    continue
                fsoup = parse_soup(html)

                # 移除导航
                strip_elements(fsoup, ['.daoh', 'script', 'style', 'hr'])

                # 提取标题 - Z0 或 A0/A1
                z0 = fsoup.find('p', class_='Z0')
                main_title = extract_text(z0) if z0 else ''

                # 收集内容
                content_parts = []
                for el in fsoup.find_all('p', class_=True):
                    cls = el.get('class', [])
                    if 'daoh' in cls or 'Z0' in cls or 'B0' in cls:
                        continue
                    t = extract_text(el)
                    if t and len(t) > 1:
                        content_parts.append(t)

                content = '\n'.join(content_parts).strip()
                if content and len(content) > 10:
                    chapter_num += 1
                    # 用文件名推断章节标题
                    a1 = fsoup.find('p', class_='A1')
                    a0 = fsoup.find('p', class_='A0')
                    ch_title = extract_text(a0) if a0 else (extract_text(a1) if a1 else f"第{chapter_num}篇")
                    chapters.append({
                        'number': chapter_num,
                        'title': ch_title,
                        'content': content,
                    })
            except Exception as e:
                log.warning(f"  解析 {fpath.name} 失败: {e}")

        if chapters:
            books.append({
                'id': book_id,
                'title': vol_title.strip(),
                'format': 'html',
                'chapters': chapters,
            })
            log.info(f"  {book_id}: {len(chapters)} 章")

    log.info(f"  Lee8: {len(books)} 本书")
    return books


# ---------------------------------------------------------------------------
# 4. parse_nee - 倪柝声文集
# ---------------------------------------------------------------------------

def parse_nee(dir_path: Path) -> List[dict]:
    """倪柝声文集: 按册分组，多本书"""
    log.info("解析 Nee (倪柝声文集)...")

    # 解析 indexNee*.html 获取册信息和文件范围
    nee_index_files = sorted(
        [p for p in dir_path.iterdir() if re.match(r'indexNee\d+\.html$', p.name)],
        key=lambda x: natural_sort_key(x.name)
    )

    # 每个 indexNee 文件对应一册
    volumes = []  # [(title, [file_list])]
    for idx_file in nee_index_files:
        try:
            html = read_html(str(idx_file))
            if not html:
                continue
            soup = parse_soup(html)

            # 标题
            h1 = soup.find('h1', class_='side')
            h2 = soup.find('h2', class_='side')
            vol_title = f"{extract_text(h1)} {extract_text(h2)}".strip() if h1 else idx_file.stem

            # 文件列表
            file_list = []
            for a in soup.find_all('a', href=re.compile(r'Nee\d+\.html')):
                href = a.get('href', '')
                m = re.match(r'(Nee\d+)\.html', href)
                if m:
                    file_list.append(m.group(1))

            if file_list:
                volumes.append((vol_title, file_list))
        except Exception as e:
            log.warning(f"  解析 {idx_file.name} 失败: {e}")

    books = []
    for i, (vol_title, file_names) in enumerate(volumes):
        book_id = f"Nee-{i+1:03d}"
        chapters = []
        chapter_num = 0

        for fname in file_names:
            fpath = dir_path / f"{fname}.html"
            if not fpath.exists():
                continue
            try:
                html = read_html(str(fpath))
                if not html:
                    continue
                soup = parse_soup(html)

                # 移除导航
                strip_elements(soup, ['nav', '.navbar', 'footer', 'script', 'style'])

                # 章节标题
                h1 = soup.find('h1', class_='side')
                h2 = soup.find('h2', class_='side')
                ch_title = extract_text(h2) if h2 else (extract_text(h1) if h1 else fname)

                # 内容: blockquote.b 和 blockquote.c 中的 p.AA 和 p.BB
                content_parts = []
                for bq in soup.find_all('blockquote', class_=re.compile(r'^[bc]$')):
                    for p in bq.find_all('p', class_=re.compile(r'^(AA|BB)$')):
                        t = extract_text(p)
                        if t:
                            content_parts.append(t)

                # 如果没找到 blockquote，尝试直接取 p.AA
                if not content_parts:
                    for p in soup.find_all('p', class_='AA'):
                        t = extract_text(p)
                        if t:
                            content_parts.append(t)

                content = '\n'.join(content_parts).strip()
                if content:
                    chapter_num += 1
                    chapters.append({
                        'number': chapter_num,
                        'title': ch_title,
                        'content': content,
                    })
            except Exception as e:
                log.warning(f"  解析 {fname}.html 失败: {e}")

        if chapters:
            books.append({
                'id': book_id,
                'title': vol_title,
                'format': 'html',
                'chapters': chapters,
            })
            log.info(f"  {book_id}: {len(chapters)} 章 ({vol_title})")

    log.info(f"  Nee: {len(books)} 本书")
    return books


# ---------------------------------------------------------------------------
# 5. parse_cxxl - 初信喂养系列
# ---------------------------------------------------------------------------

def parse_cxxl(dir_path: Path) -> List[dict]:
    """初信喂养系列: 按系列分组"""
    log.info("解析 cxxl (初信喂养系列)...")

    # 解析 index.html 获取系列和周次结构
    index_html = read_html(str(dir_path / 'index.html'))
    if not index_html:
        return []

    soup = parse_soup(index_html)

    # 从 list-divider 获取系列名，从 Gallery 页面获取每周的文件列表
    series_list = []  # [(series_name, [(week_title, [file_paths])])]
    current_series = None
    current_weeks = []

    # 遍历所有 data-role="page"
    for page in soup.find_all('div', attrs={'data-role': 'page'}):
        page_id = page.get('id', '')

        if page_id == 'page1':
            # 主页面，提取系列分组
            for li in page.find_all('li', attrs={'data-role': 'list-divider'}):
                series_name = extract_text(li)
                if current_series and current_weeks:
                    series_list.append((current_series, current_weeks))
                current_series = series_name
                current_weeks = []
            continue

        # Gallery 页面 - 每周
        if page_id.startswith('Gallery'):
            header = page.find('div', attrs={'data-role': 'header'})
            h1 = header.find('h1') if header else None
            week_title = extract_text(h1) if h1 else page_id

            files = []
            for a in page.find_all('a', href=re.compile(r'chuxinhtml/S\d+_\d+\.html')):
                href = a.get('href', '')
                # 提取文件路径
                m = re.search(r'chuxinhtml/(S\d+_\d+)\.html', href)
                if m:
                    files.append(m.group(1))

            if files:
                current_weeks.append((week_title, files))

    if current_series and current_weeks:
        series_list.append((current_series, current_weeks))

    books = []
    for si, (series_name, weeks) in enumerate(series_list):
        book_id = f"cxxl-{si+1:02d}"
        chapters = []
        chapter_num = 0

        for week_title, file_names in weeks:
            # 每周合并为一个章节
            week_content_parts = []
            for fname in file_names:
                fpath = dir_path / 'chuxinhtml' / f"{fname}.html"
                if not fpath.exists():
                    continue
                try:
                    html = read_html(str(fpath))
                    if not html:
                        continue
                    fsoup = parse_soup(html)

                    # 移除导航和音频
                    strip_elements(fsoup, ['audio', 'script', 'style'])
                    for a in fsoup.find_all('a', id='topwhite'):
                        parent_p = a.find_parent('p')
                        if parent_p and parent_p.get('class') and 'AA1' in parent_p.get('class', []):
                            parent_p.decompose()
                            break

                    # 收集内容
                    for el in fsoup.find_all(['p', 'div'], class_=True):
                        cls = el.get('class', [])
                        # 跳过导航类
                        if 'AA1' in cls:
                            continue
                        t = extract_text(el)
                        if t and len(t) > 1:
                            week_content_parts.append(t)
                except Exception as e:
                    log.warning(f"  解析 {fname}.html 失败: {e}")

            if week_content_parts:
                chapter_num += 1
                chapters.append({
                    'number': chapter_num,
                    'title': week_title,
                    'content': '\n'.join(week_content_parts).strip(),
                })

        if chapters:
            books.append({
                'id': book_id,
                'title': series_name,
                'format': 'html',
                'chapters': chapters,
            })
            log.info(f"  {book_id}: {len(chapters)} 章 ({series_name})")

    log.info(f"  cxxl: {len(books)} 本书")
    return books


# ---------------------------------------------------------------------------
# 6. parse_smdj8 - 生命读经 66 卷
# ---------------------------------------------------------------------------

def parse_smdj8(dir_path: Path) -> List[dict]:
    """生命读经: 66 卷，每卷一本书"""
    log.info("解析 smdj8 (生命读经)...")

    # 解析各卷目录 {NN}index.html
    vol_indexes = sorted(
        [p for p in dir_path.iterdir() if re.match(r'\d{2}index\.html$', p.name)],
        key=lambda x: natural_sort_key(x.name)
    )

    # 检查缺失的卷号（01-66），为其创建合成条目
    existing_vols = set()
    for p in vol_indexes:
        m = re.match(r'(\d{2})index\.html$', p.name)
        if m:
            existing_vols.add(m.group(1))
    
    books = []
    
    # 缺失卷的标题映射
    missing_vol_titles = {
        '10': '撒-撒母耳记下',
        '12': '王-列王纪下',
        '14': '代-历代志下',
    }
    for vol in range(1, 67):
        vol_str = f'{vol:02d}'
        if vol_str not in existing_vols:
            title = missing_vol_titles.get(vol_str, f'卷{vol_str}')
            log.info(f"  卷 {vol_str} 缺少索引文件，使用文章文件直接解析 ({title})")
            # 收集该卷的所有文章文件
            article_files = sorted(
                [p for p in dir_path.iterdir()
                 if re.match(rf'{vol_str}\d{{2}}\.html$', p.name)],
                key=lambda x: natural_sort_key(x.name)
            )
            if article_files:
                chapters = []
                for ch_num, fpath in enumerate(article_files, 1):
                    try:
                        html = read_html(str(fpath))
                        if not html:
                            continue
                        asoup = parse_soup(html)
                        p_title = asoup.find('p', class_='text12_150')
                        ch_title = extract_text(p_title) if p_title else f"第{ch_num}篇"
                        content_parts = []
                        tab_uls = asoup.find_all('ul', attrs={'name': 'tabul'})
                        info_ul = tab_uls[0] if tab_uls else None
                        if info_ul:
                            for el in info_ul.find_all('p', class_=re.compile(r'^(AA|YY|text12_150)$')):
                                if el.find('audio'):
                                    continue
                                cls = el.get('class', [])
                                if 'yp' in cls:
                                    continue
                                t = extract_text(el)
                                if t:
                                    content_parts.append(t)
                        else:
                            for el in asoup.find_all('p', class_=re.compile(r'^(AA|YY)$')):
                                t = extract_text(el)
                                if t:
                                    content_parts.append(t)
                        content = '\n'.join(content_parts).strip()
                        if content:
                            chapters.append({
                                'number': ch_num,
                                'title': ch_title,
                                'content': content,
                            })
                    except Exception as e:
                        log.warning(f"  解析 {fpath.name} 失败: {e}")
                if chapters:
                    book_id = f"smdj8-{vol_str}"
                    books.append({
                        'id': book_id,
                        'title': title,
                        'format': 'html',
                        'chapters': chapters,
                    })
                    log.info(f"  {book_id}: {len(chapters)} 章 ({title})")

    # 解析有索引文件的卷
    for idx_file in vol_indexes:
        m = re.match(r'(\d{2})index\.html$', idx_file.name)
        if not m:
            continue
        vol_num = m.group(1)
        book_id = f"smdj8-{vol_num}"

        try:
            html = read_html(str(idx_file))
            if not html:
                continue
            isoup = parse_soup(html)

            # 卷标题
            h2 = isoup.find('h2', class_='text12_brown')
            vol_title = extract_text(h2) if h2 else f"第{vol_num}卷"

            # 各篇链接
            article_links = []
            for p in isoup.find_all('p', class_='UU'):
                a = p.find('a')
                if a:
                    href = a.get('href', '')
                    am = re.match(r'(\d+)\.html', href)
                    if am:
                        article_links.append(int(am.group(1)))

            # 解析每篇 (信息 Tab)
            chapters = []
            for ch_num, article_num in enumerate(article_links, 1):
                fpath = dir_path / f"{article_num:04d}.html"
                if not fpath.exists():
                    continue
                try:
                    ahtml = read_html(str(fpath))
                    if not ahtml:
                        continue
                    asoup = parse_soup(ahtml)

                    # 提取篇标题
                    p_title = asoup.find('p', class_='text12_150')
                    ch_title = extract_text(p_title) if p_title else f"第{ch_num}篇"

                    # 只提取信息 Tab 内容
                    # 信息 Tab 是第二个 <ul name="tabul">
                    tab_uls = asoup.find_all('ul', attrs={'name': 'tabul'})
                    info_ul = tab_uls[0] if tab_uls else None  # 信息 tab 是第一个 name="tabul"

                    content_parts = []
                    if info_ul:
                        for el in info_ul.find_all('p', class_=re.compile(r'^(AA|YY|text12_150)$')):
                            if el.find('audio'):
                                continue
                            cls = el.get('class', [])
                            if 'yp' in cls:
                                continue
                            t = extract_text(el)
                            if t:
                                content_parts.append(t)
                    else:
                        # fallback: 直接提取所有 AA 和 YY
                        for el in asoup.find_all('p', class_=re.compile(r'^(AA|YY)$')):
                            t = extract_text(el)
                            if t:
                                content_parts.append(t)

                    content = '\n'.join(content_parts).strip()
                    if content:
                        chapters.append({
                            'number': ch_num,
                            'title': ch_title,
                            'content': content,
                        })
                except Exception as e:
                    log.warning(f"  解析 {article_num:04d}.html 失败: {e}")

            if chapters:
                books.append({
                    'id': book_id,
                    'title': vol_title,
                    'format': 'html',
                    'chapters': chapters,
                })
                log.info(f"  {book_id}: {len(chapters)} 章 ({vol_title})")
        except Exception as e:
            log.warning(f"  解析 {idx_file.name} 失败: {e}")

    # 按卷号排序
    books.sort(key=lambda b: natural_sort_key(b['id']))
    log.info(f"  smdj8: {len(books)} 本书")
    return books


# ---------------------------------------------------------------------------
# 7. parse_zsrm365 - 圣经真理 365
# ---------------------------------------------------------------------------

def parse_zsrm365(dir_path: Path) -> List[dict]:
    """圣经真理 365: 7 卷，每卷一本书"""
    log.info("解析 zsrm365 (圣经真理365)...")

    # 收集所有 {卷号}-{序号}.htm 文件
    vol_files = {}  # {vol_num: [(seq, filepath)]}
    for p in dir_path.iterdir():
        m = re.match(r'(\d+)-(\d+)\.htm$', p.name)
        if m:
            vol = int(m.group(1))
            seq = int(m.group(2))
            vol_files.setdefault(vol, []).append((seq, p))

    # 卷名映射 (从 index.htm 提取)
    vol_names = {}
    index_html = read_html(str(dir_path / 'index.htm'))
    if index_html:
        isoup = parse_soup(index_html)
        for p in isoup.find_all('p', class_='AA17'):
            # 提取卷名
            t = extract_text(p)
            if t:
                # 检查是否包含卷标题（如 "福音", "属灵的操练" 等）
                # 这些段落有时是卷标题，有时是链接组
                # 卷标题段落不包含 <a> 标签
                if not p.find('a'):
                    # 这是纯标题行
                    pass

        # 从 index.htm 的结构推断卷名
        # 卷 1-7 对应: 福音, 属灵的操练, 属灵的渴慕, 灵与生命, 基督徒的生活, 圣经真理, 召会生活
        # 从 AA17 段落中提取
        aa17_texts = []
        for p in isoup.find_all('p', class_='AA17'):
            # 获取第一个文本节点（不含链接文本）
            first_text = ''
            for child in p.children:
                if isinstance(child, str):
                    first_text = child.strip()
                    break
                elif isinstance(child, Tag) and child.name == 'a':
                    continue
                elif isinstance(child, Tag):
                    first_text = extract_text(child)
                    break
            if first_text and not p.find('a'):
                aa17_texts.append(first_text)

        # 也有带链接的 AA17 是卷标题
        for p in isoup.find_all('p', class_='AA17'):
            text_nodes = list(p.stripped_strings)
            if text_nodes:
                # 如果第一个文本节点不是链接，可能是卷名
                first_a = p.find('a')
                if not first_a or text_nodes[0] not in [extract_text(first_a)]:
                    candidate = text_nodes[0].rstrip('\n').strip()
                    if candidate and len(candidate) < 20 and candidate not in aa17_texts:
                        aa17_texts.append(candidate)

    # 使用硬编码的卷名映射（从 index.htm 确认的）
    vol_name_map = {
        1: '福音',
        2: '属灵的操练',
        3: '属灵的渴慕',
        4: '灵与生命',
        5: '基督徒的生活',
        6: '圣经真理',
        7: '召会生活',
    }

    books = []
    for vol in sorted(vol_files.keys()):
        book_id = f"zsrm365-{vol}"
        vol_name = vol_name_map.get(vol, f"卷{vol}")
        files = sorted(vol_files[vol], key=lambda x: x[0])

        chapters = []
        for ch_num, (seq, fpath) in enumerate(files, 1):
            try:
                html = read_html(str(fpath))
                if not html:
                    continue
                soup = parse_soup(html)

                # 标题
                ff = soup.find('p', class_='FF')
                ch_title = extract_text(ff) if ff else fpath.stem

                # 移除导航
                strip_elements(soup, ['script', 'style'])
                for a in soup.find_all('a', string=re.compile(r'回目录')):
                    parent_p = a.find_parent('p')
                    if parent_p:
                        parent_p.decompose()

                # 收集内容: AA, AA17, AA18, AA19, BB, CC, DD
                content_parts = []
                for p in soup.find_all('p', class_=re.compile(r'^(AA|AA17|AA18|AA19|BB|CC|DD)$')):
                    # 跳过图片段落
                    if p.find('img') and not extract_text(p):
                        continue
                    t = extract_text(p)
                    if t:
                        content_parts.append(t)

                content = '\n'.join(content_parts).strip()
                if content:
                    chapters.append({
                        'number': ch_num,
                        'title': ch_title,
                        'content': content,
                    })
            except Exception as e:
                log.warning(f"  解析 {fpath.name} 失败: {e}")

        if chapters:
            books.append({
                'id': book_id,
                'title': f"圣经真理365 - {vol_name}",
                'format': 'html',
                'chapters': chapters,
            })
            log.info(f"  {book_id}: {len(chapters)} 章 ({vol_name})")

    log.info(f"  zsrm365: {len(books)} 本书")
    return books


# ---------------------------------------------------------------------------
# 8. parse_books - 职事书报
# ---------------------------------------------------------------------------

def parse_books(dir_path: Path) -> List[dict]:
    """职事书报: 多个子目录，每本书一个 JSON"""
    log.info("解析 books (职事书报)...")

    books = []
    # 遍历子目录
    subdirs = sorted([
        d for d in dir_path.iterdir()
        if d.is_dir() and not d.name.startswith('.')
    ], key=lambda x: natural_sort_key(x.name))

    for subdir in subdirs:
        subdir_name = subdir.name
        log.info(f"  处理子目录: books/{subdir_name}")

        # 找分类目录 {N}000.html 或类似文件
        category_files = sorted(
            [p for p in subdir.iterdir() if re.match(r'\d+000\.html$', p.name)],
            key=lambda x: natural_sort_key(x.name)
        )

        # 从分类目录提取书号列表
        book_ids_in_cat = []  # [(book_num, title, author, category_name)]
        for cat_file in category_files:
            try:
                html = read_html(str(cat_file))
                if not html:
                    continue
                csoup = parse_soup(html)
                # 提取分类名称（从 <div id="chap1">，如 "1福音类" → "福音类"）
                category_name = ''
                chap1 = csoup.find('div', id='chap1')
                if chap1:
                    cat_text = extract_text(chap1)
                    category_name = re.sub(r'^\d+', '', cat_text).strip()
                table = csoup.find('table', id='list')
                if table:
                    for tr in table.find_all('tr'):
                        tds = tr.find_all('td')
                        if len(tds) >= 3:
                            num_text = extract_text(tds[0])
                            a_tag = tds[1].find('a')
                            title_text = extract_text(tds[1])
                            author_text = extract_text(tds[2])
                            if num_text and num_text.isdigit():
                                book_ids_in_cat.append((
                                    num_text,
                                    title_text,
                                    author_text,
                                    category_name,
                                ))
            except Exception as e:
                log.warning(f"  解析分类目录 {cat_file.name} 失败: {e}")

        # 处理每本书
        for book_num, book_title, author, category_name in book_ids_in_cat:
            book_id = f"books-{subdir_name}-{book_num}"
            book_dir_file = subdir / f"{book_num}.html"

            if not book_dir_file.exists():
                continue

            try:
                # 解析书目录页获取章节列表
                bhtml = read_html(str(book_dir_file))
                if not bhtml:
                    continue
                bsoup = parse_soup(bhtml)

                # 收集章节链接
                chapter_files = []
                # 查找 {book_num}-{N}.html 的链接
                for a in bsoup.find_all('a', href=re.compile(rf'{book_num}-\d+\.html')):
                    href = a.get('href', '')
                    m = re.match(rf'{book_num}-(\d+)\.html', href)
                    if m:
                        ch_num = int(m.group(1))
                        ch_title = extract_text(a)
                        chapter_files.append((ch_num, ch_title))

                # 也检查 div 包裹的链接
                for div in bsoup.find_all('div', style=re.compile(r'display:flex')):
                    a = div.find('a', href=re.compile(rf'{book_num}-\d+\.html'))
                    if a:
                        href = a.get('href', '')
                        m = re.match(rf'{book_num}-(\d+)\.html', href)
                        if m:
                            ch_num = int(m.group(1))
                            ch_title = extract_text(a)
                            if (ch_num, ch_title) not in chapter_files:
                                chapter_files.append((ch_num, ch_title))

                # 去重并按章节号排序
                seen = set()
                unique_chapters = []
                for ch_num, ch_title in sorted(chapter_files, key=lambda x: x[0]):
                    if ch_num not in seen:
                        seen.add(ch_num)
                        unique_chapters.append((ch_num, ch_title))

                # 如果书目录页没有章节链接，检查目录页本身是否有内容
                if not unique_chapters:
                    # 有些书只有单页内容
                    # 检查 div#chap2 或 div#c 中是否有内容
                    c_div = bsoup.find('div', id='c')
                    if c_div:
                        t = extract_text(c_div)
                        if t and len(t) > 20:
                            unique_chapters.append((1, book_title))

                # 解析每个章节文件
                chapters = []
                for ch_num, ch_title in unique_chapters:
                    ch_file = subdir / f"{book_num}-{ch_num}.html"
                    if not ch_file.exists():
                        # 可能内容在书目录页本身
                        if ch_num == 1 and not unique_chapters[0][0] == 1:
                            continue
                        continue
                    try:
                        chtml = read_html(str(ch_file))
                        if not chtml:
                            continue
                        csoup = parse_soup(chtml)

                        # 移除 header 导航
                        strip_elements(csoup, [
                            'header', 'script', 'style',
                            '#header', '.header',
                            '#toptitle', '.btt',
                        ])

                        # 章节标题: <div id=chap1>
                        chap_divs = csoup.find_all('div', id='chap1')
                        ch_full_title = ' '.join(extract_text(d) for d in chap_divs if extract_text(d))
                        if not ch_full_title:
                            ch_full_title = ch_title

                        # 正文: div.main > div#c > div.cont
                        content_parts = []
                        main_div = csoup.find('div', class_='main')
                        if main_div:
                            for cont in main_div.find_all('div', class_='cont'):
                                t = extract_text(cont)
                                if t:
                                    content_parts.append(t)
                            # 也检查 cn1, cn2 标题
                            for cn in main_div.find_all('div', class_=re.compile(r'^cn[12]$')):
                                t = extract_text(cn)
                                if t:
                                    content_parts.append(t)
                            # 检查 div.main 内的 div#c（可能与 .cont 共存或替代）
                            c_texts = []
                            for c_div in main_div.find_all('div', id='c'):
                                t = extract_text(c_div)
                                if t and len(t) > 5:
                                    c_texts.append(t)
                            # 如果 div#c 的文本比 .cont/.cn 更丰富，优先使用 div#c
                            c_total = sum(len(t) for t in c_texts)
                            parts_total = sum(len(t) for t in content_parts)
                            if c_total > parts_total:
                                content_parts = c_texts
                        else:
                            # fallback: div#c
                            c_div = csoup.find('div', id='c')
                            if c_div:
                                for cont in c_div.find_all('div', class_='cont'):
                                    t = extract_text(cont)
                                    if t:
                                        content_parts.append(t)
                                # div#c 本身也可能直接包含文本
                                if not content_parts:
                                    t = extract_text(c_div)
                                    if t and len(t) > 5:
                                        content_parts.append(t)

                        # 如果还是没内容，取 feature 后的所有文本
                        if not content_parts:
                            feature = csoup.find('header', class_='feature')
                            if feature:
                                for sibling in feature.find_next_siblings():
                                    t = extract_text(sibling)
                                    if t and len(t) > 5:
                                        content_parts.append(t)

                        content = '\n'.join(content_parts).strip()
                        if content:
                            chapters.append({
                                'number': ch_num,
                                'title': ch_full_title or ch_title,
                                'content': content,
                            })
                    except Exception as e:
                        log.warning(f"  解析 {book_num}-{ch_num}.html 失败: {e}")

                # 如果从书目录页本身获取了内容
                if not chapters and unique_chapters:
                    # 尝试从书目录页提取内容
                    c_div = bsoup.find('div', id='c')
                    if c_div:
                        t = extract_text(c_div)
                        if t and len(t) > 20:
                            chapters.append({
                                'number': 1,
                                'title': book_title,
                                'content': t,
                            })

                if chapters:
                    display_title = f"{book_num}-{book_title}"
                    category_prefix = book_num[0] if book_num else ''
                    books.append({
                        'id': book_id,
                        'title': display_title,
                        'category': category_name,
                        'category_prefix': category_prefix,
                        'format': 'html',
                        'chapters': chapters,
                    })
            except Exception as e:
                log.warning(f"  解析书 {book_num} 失败: {e}")

    log.info(f"  books: {len(books)} 本书")
    return books


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

PARSER_MAP = {
    '1n1bA': parse_1n1bA,
    '1n1bB': parse_1n1bB,
    'Lee8': parse_lee8,
    'Nee': parse_nee,
    'cxxl': parse_cxxl,
    'smdj8': parse_smdj8,
    'zsrm365': parse_zsrm365,
    'books': parse_books,
}


def clean_output_dir(output_dir: Path):
    """清理旧输出目录"""
    if output_dir.exists():
        log.info(f"清理旧输出目录: {output_dir}")
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)


def main():
    log.info(f"HTML 输入目录: {HTML_DIR}")
    log.info(f"JSON 输出目录: {OUTPUT_DIR}")

    # 清理旧输出
    clean_output_dir(OUTPUT_DIR)

    total_books = 0
    total_chapters = 0
    summary = []
    all_books_by_series: Dict[str, List[dict]] = {}

    # 扫描子目录
    subdirs = sorted([d for d in HTML_DIR.iterdir() if d.is_dir()])
    log.info(f"发现 {len(subdirs)} 个子目录")

    for subdir in subdirs:
        dir_name = subdir.name
        parser = PARSER_MAP.get(dir_name)
        if not parser:
            log.info(f"跳过未知目录: {dir_name}")
            continue

        series_name = SERIES_MAP.get(dir_name, dir_name.lower())

        log.info(f"\n{'='*60}")
        log.info(f"处理目录: {dir_name} → 系列: {series_name}")
        log.info(f"{'='*60}")

        try:
            book_list = parser(subdir)
            series_books = []
            for book in book_list:
                # 统一小写 id
                lowercase_book_id(book)
                save_book_json(book, OUTPUT_DIR, series_name)
                ch_count = len(book.get('chapters', []))
                total_books += 1
                total_chapters += ch_count
                summary.append(f"  {book['id']}: {book['title']} ({ch_count} 章)")
                series_books.append(book)
            all_books_by_series[series_name] = series_books
            # 生成系列 index.json
            generate_series_index(OUTPUT_DIR, series_name, series_books)
        except Exception as e:
            log.error(f"处理目录 {dir_name} 时出错: {e}", exc_info=True)

    # 生成全局索引和 manifest
    log.info(f"\n生成全局索引...")
    generate_global_index(OUTPUT_DIR, all_books_by_series)
    generate_manifest(OUTPUT_DIR, total_books, total_chapters)

    # 输出总结
    log.info(f"\n{'='*60}")
    log.info(f"处理完成!")
    log.info(f"{'='*60}")
    log.info(f"总计: {total_books} 本书, {total_chapters} 章")
    log.info(f"输出目录: {OUTPUT_DIR}")
    for line in summary:
        log.info(line)


if __name__ == '__main__':
    main()
