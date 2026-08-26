# -*- coding: utf-8 -*-
"""
书报 - 电子书阅读应用构建工具

从 resource/ysz/ 转换书籍数据，生成静态站点和配置文件。
"""
import os
import re
import sys
import json
import shutil
import base64
import subprocess
import yaml
from pathlib import Path

from src.generator import BooksGenerator


def load_config(config_path='config.yaml'):
    """加载配置文件"""
    with open(config_path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def load_app_config(config_path='app_config.json'):
    """加载应用配置"""
    if not os.path.exists(config_path):
        return {
            'name': '书报',
            'version': '1.0.0',
        }
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def copy_book_resources(resource_dir: str, output_dir: str):
    """扫描 resource/books/ 下的系列目录，复制所有书籍资源到 output/books/，并生成 books-manifest.json。

    目录结构约定：每个子目录 = 一个系列，里面混合 .epub/.md/.txt 文件。
    构建产物 output/books/ 保持同样的系列目录结构，并在根目录生成 books-manifest.json，
    前端启动时 fetch 此 manifest，按系列和格式分别解析（EPUB → importFromBuffer，
    MD → parseMd，TXT → parseTxt）后合并到书城。

    示例：
      resource/books/
      ├── 内置书库/
      │   ├── 阅读的艺术.md
      │   ├── 祷读神的话.md
      │   └── classic-tales.txt
      └── MDC/
          └── 2026-3-MDC.epub

    → 生成 output/books/（同结构） + output/books/books-manifest.json:
      {
        "series": [
          {
            "id": "内置书库",
            "name": "内置书库",
            "files": [
              {"file": "内置书库/阅读的艺术.md", "format": "md", "size": 3631, "title": "阅读的艺术"},
              {"file": "内置书库/祷读神的话.md", "format": "md", "size": 5697, "title": "祷读神的话"},
              {"file": "内置书库/classic-tales.txt", "format": "txt", "size": 2852, "title": "经典民间故事"}
            ]
          },
          {
            "id": "MDC",
            "name": "MDC",
            "files": [
              {"file": "MDC/2026-3-MDC.epub", "format": "epub", "size": 1643307, "title": "2026-3-MDC"}
            ]
          }
        ]
      }
    """
    books_src_dir = os.path.join(resource_dir, 'books')
    if not os.path.isdir(books_src_dir):
        print("⚠ resource/books/ 不存在，跳过书籍资源复制")
        return

    SUPPORTED_EXTS = {'.epub': 'epub', '.md': 'md', '.markdown': 'md', '.txt': 'txt'}

    # 扫描系列目录
    series_list = []
    total_files = 0
    for entry in sorted(os.listdir(books_src_dir)):
        entry_path = os.path.join(books_src_dir, entry)
        if not os.path.isdir(entry_path):
            continue  # 跳过 README.md 等

        series_files = []
        for root, dirs, files in os.walk(entry_path):
            for f in sorted(files):
                ext = os.path.splitext(f)[1].lower()
                fmt = SUPPORTED_EXTS.get(ext)
                if not fmt:
                    continue  # 跳过不支持的格式
                full_path = os.path.join(root, f)
                rel_path = os.path.relpath(full_path, books_src_dir).replace('\\', '/')
                stem = os.path.splitext(f)[0]  # 文件名去扩展名，作为默认 title
                file_info = {
                    'file': rel_path,
                    'format': fmt,
                    'size': os.path.getsize(full_path),
                    'title': stem,
                }
                # 从子文件夹路径提取 category（相对于系列目录的一级子文件夹名）
                rel_to_series = os.path.relpath(root, entry_path).replace('\\', '/')
                if rel_to_series and rel_to_series != '.':
                    # 取第一级子文件夹名作为 category
                    category = rel_to_series.split('/')[0]
                    file_info['category'] = category
                series_files.append(file_info)

        if not series_files:
            continue

        series_list.append({
            'id': entry,
            'name': entry,
            'files': series_files,
        })
        total_files += len(series_files)

    if not series_list:
        print("⚠ resource/books/ 中没有可用的书籍文件，跳过")
        return

    # 复制到 output/books/，保持系列目录结构
    dst_dir = os.path.join(output_dir, 'books')
    if os.path.exists(dst_dir):
        shutil.rmtree(dst_dir)
    shutil.copytree(books_src_dir, dst_dir)

    # 删除 output/books/README.md（不需要随构建下发）
    readme_dst = os.path.join(dst_dir, 'README.md')
    if os.path.exists(readme_dst):
        os.remove(readme_dst)

    # 生成 manifest
    manifest_path = os.path.join(dst_dir, 'books-manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump({'series': series_list}, f, ensure_ascii=False, indent=2)

    print(f"✓ 书籍资源已复制（{len(series_list)} 个系列，{total_files} 本书）")
    for s in series_list:
        formats = {}
        for sf in s['files']:
            formats[sf['format']] = formats.get(sf['format'], 0) + 1
        fmt_str = ', '.join(f"{k} {v}本" for k, v in sorted(formats.items()))
        print(f"  - {s['name']}（{fmt_str}）")
    print(f"  清单: {manifest_path}")


def prepare_zl_data(output_dir: str):
    """将 output/zl-merged/ 重命名为 output/zl-data/（前端 DataManager 约定路径）。

    ysz_to_md.py 已直接输出 JSON 到 output/zl-merged/，
    此处只需重命名目录即可。
    """
    merged_dir = os.path.join(output_dir, 'zl-merged')
    if not os.path.isdir(merged_dir):
        print("⚠ output/zl-merged/ 不存在，跳过 zl-data 准备")
        return

    dst_dir = os.path.join(output_dir, 'zl-data')
    if os.path.exists(dst_dir):
        shutil.rmtree(dst_dir)
    # Windows 下 os.rename 目录可能因前序子进程（ysz_to_md.py）写入句柄
    # 延迟释放而抛 PermissionError（WinError 5）。手动重命名往往成功，
    # 说明是瞬时占用，重试即可。
    import time as _time
    _last_err = None
    for _attempt in range(5):
        try:
            os.rename(merged_dir, dst_dir)
            _last_err = None
            break
        except OSError as _e:
            _last_err = _e
            _time.sleep(0.3 * (_attempt + 1))
    if _last_err is not None:
        raise _last_err

    # 统计索引信息
    index_path = os.path.join(dst_dir, 'books-index.json')
    book_count = 0
    series_count = 0
    if os.path.exists(index_path):
        try:
            with open(index_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            book_count = len(data.get('books', []))
            series_count = len(data.get('series', []))
        except Exception:
            pass

    print(f"✓ zl-data 已生成（{series_count} 个系列，{book_count} 本书）")
    print(f"  目标: {dst_dir}")


def generate_remote_config(config: dict, output_dir: str = 'output'):
    """根据 config.yaml 中的 remote_servers 生成 remote-config.js。

    将所有 URL 进行 base64 编码，运行时由前端 atob() 解码还原，
    配合 CI 中的 javascript-obfuscator 进行二次混淆。
    """
    remote_servers = config.get('remote_servers')
    if not remote_servers:
        print("⚠ config.yaml 中未找到 remote_servers 配置，跳过 remote-config.js 生成")
        return

    # 收集所有需要编码的 URL
    encoded = {}
    for key, value in remote_servers.items():
        if isinstance(value, list):
            encoded[key] = [base64.b64encode(url.encode('utf-8')).decode('utf-8') for url in value]
        elif isinstance(value, str):
            encoded[key] = base64.b64encode(value.encode('utf-8')).decode('utf-8')

    # 赞助功能开关（布尔值，不编码，直接透传）
    sponsor_enabled = config.get('sponsor_enabled', True)
    encoded['sponsor_enabled'] = sponsor_enabled

    # 下载竞速测速配置（数值/字符串，不编码，直接透传）
    st_cfg = config.get('speedtest', {})
    if st_cfg:
        encoded['speedtest_size_kb'] = st_cfg.get('size_kb', 100)
        encoded['speedtest_filename'] = st_cfg.get('filename', 'speedtest.bin')
        encoded['speedtest_timeout_per_kb'] = st_cfg.get('timeout_per_kb', 20)
        encoded['speedtest_fast_enough_ms'] = st_cfg.get('fast_enough_ms', 2000)


    # 生成 JS 内容
    js_content = f"""\
/**
 * 远程服务器配置（自动生成，请勿手动修改）
 * 由 main.py generate_remote_config() 生成
 * URL 已 base64 编码，运行时通过 atob() 解码还原
 */
(function() {{
  var _c = {json.dumps(encoded, ensure_ascii=False)};

  function _d(v) {{
    if (typeof v !== 'string') return v;
    if (!/^[A-Za-z0-9+/=]+$/.test(v)) return v;
    try {{ return atob(v); }} catch(e) {{ return v; }}
  }}

  var config = {{}};
  for (var k in _c) {{
    if (Array.isArray(_c[k])) {{
      config[k] = _c[k].map(_d);
    }} else {{
      config[k] = _d(_c[k]);
    }}
  }}

  window.REMOTE_CONFIG = config;
  window.BK_SERVERS = window.REMOTE_CONFIG;
}})();
"""

    js_dir = os.path.join(output_dir, 'js')
    os.makedirs(js_dir, exist_ok=True)
    js_path = os.path.join(js_dir, 'remote-config.js')
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)

    print("✓ js/remote-config.js 已生成（URL 已 base64 编码）")


def generate_webdav_presets(config: dict, output_dir: str = 'output'):
    """根据 config.yaml 中的 webdav.presets 生成 webdav-presets.js。

    凭据（url/username/password）以 base64(JSON) 编码，运行时解码还原；
    note 为明文备注，直接展示。预置服务器随包下发，用户不可删除。
    """
    webdav = config.get('webdav') or {}
    presets_raw = webdav.get('presets')
    if not presets_raw:
        print("⚠ config.yaml 中未找到 webdav.presets 配置，跳过 webdav-presets.js 生成")
        return

    presets = []
    for i, p in enumerate(presets_raw):
        if not isinstance(p, dict):
            continue
        raw_urls = p.get('urls')
        if isinstance(raw_urls, list):
            raw_urls = [u for u in raw_urls if isinstance(u, str) and u.strip()]
        url = p.get('url') or (raw_urls[0] if raw_urls else '')
        name = p.get('name') or (url or f'预置服务器 {i + 1}')
        note = p.get('note') or ''
        secret = {
            'url': url,
            'urls': raw_urls if raw_urls else None,
            'username': p.get('username') or '',
            'password': p.get('password') or '',
            'authType': p.get('authType') or 'basic',
            'startPath': p.get('startPath') or '',
        }
        secret_b64 = base64.b64encode(
            json.dumps(secret, ensure_ascii=False).encode('utf-8')
        ).decode('utf-8')
        presets.append({
            'id': p.get('id') or f'preset-{i}',
            'name': name,
            'note': note,
            'secret': secret_b64,
        })

    js_content = f"""\
/**
 * WebDAV 预置服务器配置（自动生成，请勿手动修改）
 * 由 main.py generate_webdav_presets() 生成
 * 凭据已 base64(JSON) 编码，运行时通过 atob(JSON.parse()) 解码还原
 */
(function() {{
  window.BK_WEBDAV_PRESETS = {json.dumps(presets, ensure_ascii=False)};
}})();
"""

    js_dir = os.path.join(output_dir, 'js')
    os.makedirs(js_dir, exist_ok=True)
    js_path = os.path.join(js_dir, 'webdav-presets.js')
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)

    print(f"✓ js/webdav-presets.js 已生成（{len(presets)} 个预置服务器）")


def inject_app_version(app_version, output_dir: str = 'output'):
    """将 APP_VERSION 注入到 output/index.html 的 BK_APP_VERSION_INJECT 占位符"""
    index_path = os.path.join(output_dir, 'index.html')
    if not os.path.exists(index_path):
        print("⚠ 未找到 index.html，跳过 APP_VERSION 注入")
        return
    with open(index_path, 'r', encoding='utf-8') as f:
        html = f.read()
    placeholder = '/* BK_APP_VERSION_INJECT */'
    if placeholder not in html:
        print("⚠ index.html 中未找到 BK_APP_VERSION_INJECT 占位符，跳过注入")
        return
    inject_script = "window.BK_APP_VERSION = '%s';" % app_version
    html = html.replace(placeholder, inject_script)
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print("✓ BK_APP_VERSION=%s 已注入 index.html" % app_version)


def inject_disguise_config(config: dict, output_dir: str = 'output'):
    """根据 config.yaml 的 disguise_enabled 注入 window.BK_CONFIG.disguiseEnabled。

    在 generate_all 之后调用：覆盖 output/index.html（及 Android 副本）中
    `window.BK_CONFIG = window.BK_CONFIG || { disguiseEnabled: ... }` 的默认值，
    使构建产物真正受 config.yaml 控制，而非写死在源码里。

    默认 false（普通浏览器直接可用）；设为 true 则开启伪装/访问控制。
    """
    enabled = bool(config.get('disguise_enabled', False))
    val_str = 'true' if enabled else 'false'

    pattern = re.compile(
        r"window\.BK_CONFIG = window\.BK_CONFIG \|\| \{ disguiseEnabled: (?:true|false) \};"
    )
    replacement = f"window.BK_CONFIG = window.BK_CONFIG || {{ disguiseEnabled: {val_str} }};"

    targets = []
    out_index = os.path.join(output_dir, 'index.html')
    if os.path.exists(out_index):
        targets.append(out_index)
    # Android 包内副本（由 cap sync 从 output 同步；此处构建时一并更新，确保一致性）
    android_index = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        'android', 'app', 'src', 'main', 'assets', 'public', 'index.html'
    )
    if os.path.exists(android_index):
        targets.append(android_index)

    if not targets:
        print("⚠ 未找到 index.html，跳过 disguise 配置注入")
        return

    count = 0
    for path in targets:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
            new_content, n = pattern.subn(replacement, content)
            if n == 0:
                print(f"  ⚠ {path} 未找到 BK_CONFIG 伪装配置行，跳过")
                continue
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            count += 1
            print(f"  ✓ {path}: disguiseEnabled = {val_str}")
        except Exception as e:
            print(f"  ⚠ 注入 {path} 失败: {e}")

    if count:
        print(f"✓ 伪装配置已注入（disguise_enabled={val_str}，共 {count} 个文件）")


def copy_static_images(config: dict, output_dir: str):
    """复制 src/static/image/ → output/images/（复数）。

    赞助二维码图片（zanzhu-wx.png, zanzhu-zfb.jpg）仅在 sponsor_enabled 时复制，
    关闭时跳过并清理旧残留。其他图片始终复制。
    图片不打进 APK/PWA 本地缓存，通过 BK.loadRemoteImage 从远程服务器获取。
    """
    sponsor_enabled = config.get('sponsor_enabled', True)
    _SPONSOR_IMAGE_FILES = {'zanzhu-wx.png', 'zanzhu-zfb.jpg'}

    script_dir = os.path.dirname(os.path.abspath(__file__))
    static_img_src = os.path.join(script_dir, 'src', 'static', 'image')
    static_img_dst = os.path.join(output_dir, 'images')

    # 清理可能残留的 output/image（单数）目录（旧构建产物）
    old_image_dir = os.path.join(output_dir, 'image')
    if os.path.isdir(old_image_dir):
        shutil.rmtree(old_image_dir, ignore_errors=True)

    if not os.path.isdir(static_img_src):
        print("⚠ src/static/image/ 目录不存在，跳过静态图片复制")
        return

    os.makedirs(static_img_dst, exist_ok=True)
    for fn in os.listdir(static_img_src):
        src_f = os.path.join(static_img_src, fn)
        if not os.path.isfile(src_f):
            continue
        # 赞助关闭时跳过二维码图片
        if not sponsor_enabled and fn in _SPONSOR_IMAGE_FILES:
            continue
        shutil.copy2(src_f, os.path.join(static_img_dst, fn))

    if sponsor_enabled:
        print("✓ 静态图片已复制到 images/")
    else:
        print("✓ 静态图片已复制到 images/（赞助二维码已跳过）")
        # 清理旧残留赞助图片
        for fn in _SPONSOR_IMAGE_FILES:
            old = os.path.join(static_img_dst, fn)
            if os.path.isfile(old):
                os.remove(old)
                print(f"  ✗ 已删除旧赞助图片 images/{fn}")


def main():
    """主函数"""
    # 确保 stdout 使用 UTF-8
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    print("=" * 60)
    print(" 书报 - 电子书阅读应用构建工具")
    print("=" * 60)
    print()

    # 加载配置
    try:
        config = load_config()
        print("✓ 配置文件加载成功")
    except FileNotFoundError:
        print("⚠ config.yaml 未找到，使用默认配置")
        config = {
            'resource_dir': 'resource',
            'output_dir': 'output',
        }
    except Exception as e:
        print(f"✗ 配置文件加载失败: {e}")
        return 1

    try:
        app_config = load_app_config()
    except Exception as e:
        print(f"⚠ 应用配置加载失败: {e}")
        app_config = {'name': '书报', 'version': '1.0.0'}

    resource_dir = config.get('resource_dir', 'resource')
    output_dir = config.get('output_dir', 'output')

    # 清理并创建输出目录
    if os.path.exists(output_dir):
        import time as _time
        for _retry in range(3):
            try:
                shutil.rmtree(output_dir)
                break
            except PermissionError:
                if _retry < 2:
                    _time.sleep(0.5)
                else:
                    # 最后一次尝试：仅清空内容而不删除目录本身
                    for item in os.listdir(output_dir):
                        p = os.path.join(output_dir, item)
                        if os.path.isdir(p):
                            shutil.rmtree(p, ignore_errors=True)
                        else:
                            try: os.remove(p)
                            except: pass
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # ── 数据准备：ysz → books(md) + zl-merged(JSON) ──────────────
    print("── 数据准备 ──")

    # Step 0-pre: 检查 Node.js 环境（内置书转换依赖 Node.js）
    _node_ok = False
    try:
        _r = subprocess.run(['node', '--version'], capture_output=True, text=True, timeout=5)
        if _r.returncode == 0:
            _ver = _r.stdout.strip()
            print(f"✓ Node.js {_ver} 已安装")
            _node_ok = True
        else:
            print("⚠ Node.js 不可用，内置书籍转换将被跳过")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        print("⚠ Node.js 未安装或不在 PATH 中，内置书籍转换将被跳过")
        print("  提示: 内置书（MD/EPUB/TXT）需要 Node.js 解析，请安装 Node.js 20+")

    if _node_ok:
        # 检查关键 npm 依赖是否存在
        _script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'convert-bundled.js')
        if os.path.exists(_script):
            _check_deps = False
            try:
                _r2 = subprocess.run(
                    ['node', '-e', 'require("jsdom"); require("jszip"); console.log("deps-ok")'],
                    capture_output=True, text=True, timeout=10,
                    cwd=os.path.dirname(os.path.abspath(__file__)),
                )
                if _r2.returncode == 0 and 'deps-ok' in _r2.stdout:
                    _check_deps = True
            except Exception:
                pass

            if not _check_deps:
                print("⚠ npm 依赖缺失（jsdom/jszip），尝试自动安装...")
                try:
                    _r3 = subprocess.run(
                        ['npm', 'install', '--production'],
                        capture_output=True, text=True, timeout=120,
                        cwd=os.path.dirname(os.path.abspath(__file__)),
                    )
                    if _r3.returncode == 0:
                        print("✓ npm 依赖安装成功")
                    else:
                        print(f"⚠ npm install 失败 (exit={_r3.returncode})")
                        if _r3.stderr:
                            print(f"  {_r3.stderr[:200]}")
                except Exception as e:
                    print(f"⚠ npm install 异常: {e}")
        else:
            print("⚠ 内置书转换脚本不存在: src/convert-bundled.js")

    # Step 0: 执行统一构建脚本 (ysz → books + zl-merged)
    # 替代了原来的 process_ysz_books.py + merge_zl_data.py 两步管线
    _ysz_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ysz_to_md.py')
    _ysz_args = [sys.executable, _ysz_script, '--clean']
    if not _node_ok:
        _ysz_args.append('--skip-bundled')
    try:
        print("▶ 统一数据构建 (ysz → books + zl-merged) ...")
        result = subprocess.run(
            _ysz_args,
            capture_output=True, text=True, timeout=600
        )
        if result.returncode == 0:
            print("✓ 数据构建完成")
            if result.stdout:
                lines = result.stdout.strip().splitlines()
                for line in lines[-8:]:
                    print(f"  {line}")
        else:
            print(f"⚠ 数据构建警告 (exit={result.returncode})")
            if result.stderr:
                print(f"  {result.stderr[:300]}")
    except Exception as e:
        print(f"⚠ 数据构建异常: {e}")

    print()

    # 生成静态站点
    generator = BooksGenerator(output_dir, config)
    generator.generate_all(app_config)

    # 复制静态图片 src/static/image/ → output/images/（带 sponsor_enabled 控制）
    copy_static_images(config, output_dir)

    # 生成 remote-config.js（base64 编码 URL）
    generate_remote_config(config, output_dir)

    # 生成 webdav-presets.js（config.yaml 预置 WebDAV 服务器，base64 编码凭据）
    generate_webdav_presets(config, output_dir)

    # 注入伪装/访问控制配置（由 config.yaml 的 disguise_enabled 控制，默认关闭）
    inject_disguise_config(config, output_dir)

    # 注入 APP_VERSION 到 index.html（供 pwaCache 无网络建桶）
    inject_app_version(app_config.get('version', 'dev'), output_dir)

    # 复制 changelog.json 到 output/（供前端 fetchChangelog 使用）
    changelog_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'changelog.json')
    if os.path.exists(changelog_src):
        shutil.copy2(changelog_src, os.path.join(output_dir, 'changelog.json'))
        print("✓ changelog.json 已复制到 output/")
    else:
        print("⚠ changelog.json 未找到，跳过复制")

    # 准备 zl-data（将 output/zl-merged/ 重命名为 output/zl-data/）
    prepare_zl_data(output_dir)

    # ── 系列打包：将每个系列的 JSON 打包为 ZIP（减少 HTTP 请求次数）────
    print("── 系列打包 ──")
    _pack_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'pack_series.py')
    if os.path.exists(_pack_script):
        zl_data_dir = os.path.join(output_dir, 'zl-data')
        if os.path.isdir(zl_data_dir):
            try:
                from src.pack_series import pack_all_series
                pack_all_series(zl_data_dir)
            except Exception as e:
                print(f"⚠ 系列打包失败（不影响功能，仅失去 ZIP 下载优化）: {e}")
        else:
            print("⚠ zl-data 目录不存在，跳过系列打包")
    else:
        print("⚠ src/pack_series.py 未找到，跳过系列打包")

    # resource/books/ 下的源文件已由 ysz_to_md.py 在构建时处理并入 zl-merged
    # 此开关仅用于本地调试时需要直接访问原始文件（EPUB/MD/TXT）的场景
    if config.get('copy_book_resources', False):
        copy_book_resources(resource_dir, output_dir)
    else:
        print("⏭ 内置书籍资源复制已跳过（内置书已走 CDN，如需本地副本请在 config.yaml 设置 copy_book_resources: true）")

    print(f"\n{'=' * 60}")
    print(f" 构建完成!")
    print(f" 输出目录: {output_dir}/")
    print(f"{'=' * 60}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
