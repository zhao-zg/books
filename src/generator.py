# -*- coding: utf-8 -*-
"""
静态站点生成器

生成全局索引、静态资源、PWA 文件等。
"""
import json
import os
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
        for item in os.listdir(static_dir):
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

    def generate_manifest_and_sw(self):
        """生成 PWA manifest.json 和 sw.js（从 templates 目录复制）"""
        template_dir = os.path.join(os.path.dirname(__file__), 'templates')
        if not os.path.isdir(template_dir):
            return

        # manifest.json
        manifest_src = os.path.join(template_dir, 'main_manifest.json')
        if os.path.exists(manifest_src):
            shutil.copy2(manifest_src, os.path.join(self.output_dir, 'manifest.json'))
            print("✓ manifest.json 已生成")

        # sw.js - 注入构建版本号，使 CACHE_NAME 每次都变化，确保 SW 能正确更新缓存
        sw_src = os.path.join(template_dir, 'main_sw.js')
        if os.path.exists(sw_src):
            with open(sw_src, 'r', encoding='utf-8') as f:
                sw_content = f.read()
            build_version = datetime.now().strftime('%Y%m%d%H%M%S')
            sw_content = sw_content.replace('__BUILD_VERSION__', build_version)
            sw_dst = os.path.join(self.output_dir, 'sw.js')
            with open(sw_dst, 'w', encoding='utf-8') as f:
                f.write(sw_content)
            print(f"✓ sw.js 已生成 (版本: {build_version})")

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

        # 2. 生成完整 CSS
        self.generate_css()

        # 3. PWA manifest 和 Service Worker
        self.generate_manifest_and_sw()

        # 4. version.json
        if app_config:
            self.generate_version_json(app_config)

        # 5. 复制 app_config.json 到 output/（供前端 loadConfig 回退路径使用）
        app_config_src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'app_config.json')
        if os.path.exists(app_config_src):
            shutil.copy2(app_config_src, os.path.join(self.output_dir, 'app_config.json'))
            print("✓ app_config.json 已复制到 output/")
        else:
            print("⚠ app_config.json 未找到，跳过复制")

        # 6. .nojekyll（GitHub Pages 兼容）
        nojekyll_path = os.path.join(self.output_dir, '.nojekyll')
        with open(nojekyll_path, 'w') as f:
            f.write('')
