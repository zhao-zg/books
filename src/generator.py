# -*- coding: utf-8 -*-
"""
静态站点生成器

生成全局索引、静态资源、PWA 文件等。
"""
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path


class BooksGenerator:
    """电子书静态站点生成器"""

    def __init__(self, output_dir: str, config: dict):
        """
        Args:
            output_dir: 输出目录路径
            config: 配置字典（来自 config.yaml）
        """
        self.output_dir = output_dir
        self.config = config
        os.makedirs(output_dir, exist_ok=True)

    # ------------------------------------------------------------------
    # 静态资源
    # ------------------------------------------------------------------

    def copy_static_assets(self):
        """复制静态资源到 output/"""
        static_dir = os.path.join(os.path.dirname(__file__), 'static')
        if not os.path.isdir(static_dir):
            print("⚠ src/static/ 目录不存在，跳过静态资源复制")
            return

        # 复制整个 static 目录下的子目录和文件
        # 注意：image/ 目录由 main.py 的 copy_static_images() 专门处理
        # （src/static/image/ → output/images/，带 sponsor_enabled 控制）
        _SKIP_DIRS = {'image'}
        for item in os.listdir(static_dir):
            if item in _SKIP_DIRS:
                continue
            src_path = os.path.join(static_dir, item)
            dst_path = os.path.join(self.output_dir, item)

            if os.path.isdir(src_path):
                # 复制目录（js/, css/, icons/, data/, vendor/ 等）
                if os.path.exists(dst_path):
                    shutil.rmtree(dst_path)
                shutil.copytree(src_path, dst_path)
            else:
                # 复制文件（index.html 等）
                shutil.copy2(src_path, dst_path)

        print("✓ 静态资源已复制到 output/")

    def generate_manifest_and_sw(self, app_config: dict = None):
        """生成 PWA manifest.json 和 sw.js（从 templates 目录复制）"""
        template_dir = os.path.join(os.path.dirname(__file__), 'templates')
        if not os.path.isdir(template_dir):
            return

        app_version = (app_config or {}).get('version', 'dev')

        # manifest.json
        manifest_src = os.path.join(template_dir, 'main_manifest.json')
        if os.path.exists(manifest_src):
            shutil.copy2(manifest_src, os.path.join(self.output_dir, 'manifest.json'))
            print("✓ manifest.json 已生成")

        # sw.js - 注入应用版本号到 CACHE_NAME
        sw_src = os.path.join(template_dir, 'main_sw.js')
        if os.path.exists(sw_src):
            sw_dst = os.path.join(self.output_dir, 'sw.js')
            with open(sw_src, 'r', encoding='utf-8') as f:
                sw_content = f.read()
            sw_content = sw_content.replace('__APP_VERSION__', app_version)

            # 注入 vendor/cmaps + vendor/standard_fonts 文件列表到 SW 预缓存
            # 确保首次离线打开中文 PDF 时 CJK 字体映射和标准字体可用
            static_dir = os.path.join(os.path.dirname(__file__), 'static')
            vendor_urls = []
            for sub in ('cmaps', 'standard_fonts'):
                sub_dir = os.path.join(static_dir, 'vendor', sub)
                if not os.path.isdir(sub_dir):
                    continue
                for fname in sorted(os.listdir(sub_dir)):
                    fpath = os.path.join(sub_dir, fname)
                    if os.path.isfile(fpath):
                        vendor_urls.append(f"'./vendor/{sub}/{fname}'")
            vendor_list_str = ',\n  '.join(vendor_urls)
            sw_content = sw_content.replace(
                '/* __VENDOR_PRECACHE_URLS__ */', vendor_list_str
            )

            with open(sw_dst, 'w', encoding='utf-8') as f:
                f.write(sw_content)
            print(f"✓ sw.js 已生成 (版本: {app_version}, vendor 预缓存: {len(vendor_urls)} 个文件)")

        # 将版本号注入已复制的 output/index.html
        index_dst = os.path.join(self.output_dir, 'index.html')
        if os.path.exists(index_dst):
            with open(index_dst, 'r', encoding='utf-8') as f:
                html_content = f.read()
            html_content = html_content.replace('__APP_VERSION__', app_version)
            with open(index_dst, 'w', encoding='utf-8') as f:
                f.write(html_content)

        # 校验 PRECACHE_URLS 与 __bkCoreUrls 的一致性
        # PRECACHE_URLS 应为 __bkCoreUrls 的子集，确保 SW 预缓存的所有资源
        # 都在页面端缓存校验列表中，避免验证时遗漏。
        sw_check = os.path.join(self.output_dir, 'sw.js')
        html_check = os.path.join(self.output_dir, 'index.html')
        if os.path.exists(sw_check) and os.path.exists(html_check):
            try:
                with open(sw_check, 'r', encoding='utf-8') as f:
                    sw_text = f.read()
                with open(html_check, 'r', encoding='utf-8') as f:
                    html_text = f.read()
                precache_m = re.search(r'PRECACHE_URLS\s*=\s*\[(.*?)\]', sw_text, re.DOTALL)
                core_m = re.search(r'window\.__bkCoreUrls\s*=\s*\[(.*?)\]', html_text, re.DOTALL)
                if precache_m and core_m:
                    precache_urls = set(re.findall(r"'(\./[^']+)'", precache_m.group(1)))
                    core_urls = set(re.findall(r"'(\./[^']+)'", core_m.group(1)))
                    missing = sorted(precache_urls - core_urls)
                    if missing:
                        print(f"⚠ PRECACHE_URLS 中有 {len(missing)} 项不在 __bkCoreUrls 中: {missing[:5]}")
                    print(f"✓ 缓存列表校验: PRECACHE_URLS {len(precache_urls)} 项, __bkCoreUrls {len(core_urls)} 项")
            except Exception as e:
                print(f"⚠ 缓存列表校验失败: {e}")

        # _redirects（Cloudflare Pages）
        redirects_src = os.path.join(template_dir, '_redirects')
        if os.path.exists(redirects_src):
            shutil.copy2(redirects_src, os.path.join(self.output_dir, '_redirects'))
            print("✓ _redirects 已复制")

        # _headers
        headers_src = os.path.join(template_dir, '_headers')
        if os.path.exists(headers_src):
            shutil.copy2(headers_src, os.path.join(self.output_dir, '_headers'))

    def generate_version_json(self, app_config: dict):
        """生成 version.json（从 app_config.json 读取版本信息）"""
        version_data = {
            'version': app_config.get('version', '1.0.0'),
            'build_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'app_name': app_config.get('name', '书报'),
        }

        # 合并其他版本相关字段
        for key in ('min_android_version', 'update_url', 'changelog'):
            if key in app_config:
                version_data[key] = app_config[key]

        json_path = os.path.join(self.output_dir, 'version.json')
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(version_data, f, ensure_ascii=False, indent=2)

        print(f"✓ version.json 已生成 (v{version_data['version']})")

    # ------------------------------------------------------------------
    # CSS 样式
    # ------------------------------------------------------------------

    def generate_css(self):
        """从独立 CSS 文件生成 style.css"""
        css_src = os.path.join(os.path.dirname(__file__), 'static', 'css', 'style.css')
        css_dir = os.path.join(self.output_dir, 'css')
        os.makedirs(css_dir, exist_ok=True)
        css_path = os.path.join(css_dir, 'style.css')
        with open(css_src, 'r', encoding='utf-8') as f:
            css_content = f.read()
        with open(css_path, 'w', encoding='utf-8') as f:
            f.write(css_content)
        print(f"  style.css ({len(css_content)} bytes)")

    # ------------------------------------------------------------------
    # 完整生成流程
    # ------------------------------------------------------------------

    def generate_all(self, app_config: dict = None):
        """完整生成流程：静态资源 → PWA → version"""

        # 1. 静态资源（先复制，避免后续生成的文件被覆盖）
        self.copy_static_assets()

        # 2. CSS（split 后由 copy_static_assets 递归复制，无需独立步骤）

        # 3. PWA manifest 和 Service Worker（注入版本号）
        self.generate_manifest_and_sw(app_config)

        # 5. version.json
        if app_config:
            self.generate_version_json(app_config)

        # 6. 复制 app_config.json 到 output/（供前端 loadConfig 回退路径使用）
        app_config_src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'app_config.json')
        if os.path.exists(app_config_src):
            shutil.copy2(app_config_src, os.path.join(self.output_dir, 'app_config.json'))
            print("✓ app_config.json 已复制到 output/")
        else:
            print("⚠ app_config.json 未找到，跳过复制")

        # 7. .nojekyll（GitHub Pages 兼容）
        nojekyll_path = os.path.join(self.output_dir, '.nojekyll')
        with open(nojekyll_path, 'w') as f:
            f.write('')
