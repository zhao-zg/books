---
applyTo: "src/**/*.py"
---

# Python 生成器规范

## 数据模型（src/models.py）

核心类层次：根据书报项目的实际电子书/阅读内容结构定义。

修改模型时注意序列化映射（如 `to_dict()`）也需同步更新。

## 解析器（src/parser_improved.py）

- `load_document(path)` 自动区分 `.doc`（LibreOffice 转换）和 `.docx`（python-docx 直接解析）
- 使用**双格式自动检测**：先检测段落样式名，再回退正则
- 禁止使用 `win32com`；`.doc` 转换依赖 LibreOffice（可选），不存在时应优雅报错而非崩溃

## 生成器（src/generator.py）

- 所有静态资源从 `src/static/` 复制到 `output/`，由 `_copy_static_assets()` 完成
- 页面用 `../js/` 和 `../css/` 相对路径引用根目录共享资源
- Jinja2 自定义过滤器在 `__init__` 中注册

## 构建入口（main.py）

```bash
python main.py          # 重新生成 output/ 全部静态文件
```

- 读取 `config.yaml` 获取配置
- 生成 `output/js/remote-config.js`（URL 以 base64 混淆存储）

## 依赖

```
python-docx   # docx 解析
Pillow        # 图片处理
jinja2        # 模板引擎
PyYAML        # config.yaml 解析
```
