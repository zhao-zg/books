# 书报 - 电子书存放目录

将您的电子书文件放入此目录，支持以下格式：

## 支持的格式

- **EPUB** (.epub) - 标准电子书格式，支持目录、封面、富文本
- **Markdown** (.md) - 支持 YAML frontmatter 元数据
- **TXT** (.txt) - 纯文本格式，自动检测编码（UTF-8/GBK）

## 目录结构

您可以将书籍文件放在 `resource/books/` 下的任意子目录中：

```
resource/books/
├── 小说/
│   ├── 三体.epub
│   └── 活着.md
├── 技术/
│   └── Python编程.txt
└── README.md
```

## Markdown 格式说明

Markdown 文件支持 YAML frontmatter：

```markdown
---
title: 书名
author: 作者名
language: zh
description: 书籍简介
---

# 第一章 标题

章节内容...
```

## 构建

运行以下命令构建静态站点：

```bash
python main.py
```
