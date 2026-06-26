#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
更新 changelog.json（根目录）中的版本更新内容
由 release.bat 调用

非交互用法（由脚本批量传参）：
  python update_changelog.py --version 1.3.3 --new "功能A" --new "功能B" --opt "优化1" --fix "修复1"

交互用法（无 --new/--opt/--fix 时自动进入）：
  python update_changelog.py --version 1.3.3
"""
import argparse
import json
import os
import sys
import io
from datetime import date

# 确保 Windows CMD 下中文正常输出
if sys.platform == 'win32':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stdin  = io.TextIOWrapper(sys.stdin.buffer,  encoding='utf-8', errors='replace')
    except AttributeError:
        pass

CHANGELOG_FILE = 'changelog.json'

LABELS = {
    'new': '✨ 新增功能',
    'opt': '⚡ 优化内容',
    'fix': '🔧 修复Bug',
}
KEYS = ['new', 'opt', 'fix']
SHORT = {'a': 'new', 'o': 'opt', 'f': 'fix'}


def load_changelog():
    if os.path.exists(CHANGELOG_FILE):
        with open(CHANGELOG_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_changelog(data):
    with open(CHANGELOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def print_items(items_map):
    """打印所有条目（统一编号）"""
    idx = 1
    index_map = {}  # global_idx -> (key, local_idx)
    for key in KEYS:
        items = items_map.get(key, [])
        tag = LABELS[key]
        if items:
            print(f'  [{tag}]')
            for i, item in enumerate(items):
                print(f'    {idx}. {item}')
                index_map[idx] = (key, i)
                idx += 1
        else:
            print(f'  [{tag}]  （暂无）')
    return index_map


def interactive_edit(version, existing_entry):
    """交互式编辑某版本的更新内容，返回 (new_items, opt_items, fix_items) 或 None 表示放弃"""
    items_map = {
        'new': list(existing_entry.get('new', [])),
        'opt': list(existing_entry.get('opt', [])),
        'fix': list(existing_entry.get('fix', [])),
    }

    help_text = (
        '操作: a <内容> 新增  |  o <内容> 优化  |  f <内容> 修复\n'
        '      e <编号> 修改  |  d <编号> 删除  |  s 保存  |  q 放弃不保存'
    )

    while True:
        print()
        print(f'  版本 v{version} 更新内容（共 {sum(len(v) for v in items_map.values())} 条）')
        print('  ' + '─' * 40)
        index_map = print_items(items_map)
        print()
        print(f'  {help_text}')
        print()

        try:
            raw = input('  > ').strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None

        if not raw:
            continue

        parts = raw.split(None, 1)
        cmd = parts[0].lower()
        arg = parts[1].strip() if len(parts) > 1 else ''

        if cmd == 'q':
            print('  已放弃，未保存。')
            return None

        elif cmd == 's':
            return items_map

        elif cmd in SHORT:
            key = SHORT[cmd]
            if arg:
                items_map[key].append(arg)
                print(f'  ✓ 已添加到【{LABELS[key]}】')
            else:
                try:
                    val = input(f'  输入内容（{LABELS[key]}）: ').strip()
                except (EOFError, KeyboardInterrupt):
                    continue
                if val:
                    items_map[key].append(val)
                    print(f'  ✓ 已添加')

        elif cmd == 'e':
            try:
                n = int(arg)
            except (ValueError, TypeError):
                print('  ✗ 请输入有效编号，例如: e 2')
                continue
            if n not in index_map:
                print(f'  ✗ 编号 {n} 不存在')
                continue
            key, local_i = index_map[n]
            print(f'  当前内容: {items_map[key][local_i]}')
            try:
                new_val = input('  新内容（直接回车保持不变）: ').strip()
            except (EOFError, KeyboardInterrupt):
                continue
            if new_val:
                items_map[key][local_i] = new_val
                print('  ✓ 已修改')

        elif cmd == 'd':
            try:
                n = int(arg)
            except (ValueError, TypeError):
                print('  ✗ 请输入有效编号，例如: d 2')
                continue
            if n not in index_map:
                print(f'  ✗ 编号 {n} 不存在')
                continue
            key, local_i = index_map[n]
            removed = items_map[key].pop(local_i)
            print(f'  ✓ 已删除: {removed}')

        else:
            print('  ✗ 未知命令，请输入 a/o/f/e/d/s/q')


def main():
    parser = argparse.ArgumentParser(description='更新 changelog.json')
    parser.add_argument('--version', required=True, help='版本号，如 1.3.3')
    parser.add_argument('--new', dest='new_features', action='append', default=[], metavar='ITEM', help='新增功能（可多次使用）')
    parser.add_argument('--opt', dest='optimizations', action='append', default=[], metavar='ITEM', help='优化内容（可多次使用）')
    parser.add_argument('--fix', dest='bug_fixes', action='append', default=[], metavar='ITEM', help='修复Bug（可多次使用）')
    parser.add_argument('--date', default='', help='发布日期，默认为今天（格式 YYYY-MM-DD）')
    args = parser.parse_args()

    version = args.version.lstrip('v')
    release_date = args.date.strip() if args.date.strip() else str(date.today())
    changelog = load_changelog()
    existing = changelog.get(version, {})

    # 非交互模式：有 --new/--opt/--fix 参数时直接写入
    new_items = [s.strip() for s in args.new_features if s.strip()]
    opt_items = [s.strip() for s in args.optimizations if s.strip()]
    fix_items = [s.strip() for s in args.bug_fixes if s.strip()]
    if new_items or opt_items or fix_items:
        entry = {'date': release_date}
        if new_items: entry['new'] = new_items
        if opt_items: entry['opt'] = opt_items
        if fix_items: entry['fix'] = fix_items
        changelog[version] = entry
        save_changelog(changelog)
        print(f'✓ changelog.json 已更新：版本 {version}（{release_date}）')
        return

    # 交互模式
    print()
    print(f'  === 版本 v{version} 更新内容编辑 ===')
    if existing:
        print(f'  （已有内容，可继续修改）')

    result = interactive_edit(version, existing)
    if result is None:
        sys.exit(0)

    all_items = result['new'] + result['opt'] + result['fix']
    if not all_items:
        print(f'  ⚠ 无任何更新内容，跳过写入')
        sys.exit(0)

    entry = {'date': existing.get('date', release_date)}
    if result['new']: entry['new'] = result['new']
    if result['opt']: entry['opt'] = result['opt']
    if result['fix']: entry['fix'] = result['fix']

    changelog[version] = entry
    save_changelog(changelog)
    print(f'  ✓ changelog.json 已保存：版本 {version}（{entry["date"]}）')
    total = len(result['new']) + len(result['opt']) + len(result['fix'])
    print(f'  共 {total} 条更新内容')


if __name__ == '__main__':
    main()
