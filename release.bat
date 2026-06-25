@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================================
echo  发布新版本 - 书报
echo ============================================================
echo.

REM 读取当前版本号
for /f "tokens=2 delims=:, " %%a in ('findstr /C:"\"version\"" app_config.json') do (
    set CURRENT_VERSION=%%a
    set CURRENT_VERSION=!CURRENT_VERSION:"=!
)

echo 当前版本: v!CURRENT_VERSION!
echo.

REM 输入新版本号
set /p NEW_VERSION="请输入新版本号 (直接回车使用当前版本): "
if "!NEW_VERSION!"=="" (
    set NEW_VERSION=!CURRENT_VERSION!
    echo 使用当前版本: v!NEW_VERSION!
) else (
    echo 新版本: v!NEW_VERSION!
    
    REM 更新 app_config.json
    python -c "import json; f=open('app_config.json','r',encoding='utf-8'); d=json.load(f); f.close(); d['version']='!NEW_VERSION!'; f=open('app_config.json','w',encoding='utf-8'); json.dump(d,f,ensure_ascii=False,indent=2); f.close()"
    echo ✓ app_config.json 已更新
)

echo.

REM ============================================================
REM  版本更新内容（Changelog）
REM ============================================================

REM 检查该版本 tag 是否已存在（重发场景）
set IS_REPUBLISH=0
git rev-parse v!NEW_VERSION! >nul 2>&1
if not errorlevel 1 set IS_REPUBLISH=1

set WRITE_CHANGELOG=1
if "!IS_REPUBLISH!"=="0" goto :do_changelog_input
echo 检测到 v!NEW_VERSION! 已发布过（重发模式）
set /p UPDATE_CL="是否更新此版本的更新内容？(y/n，直接回车跳过): "
if /i "!UPDATE_CL!"=="y" goto :do_changelog_input
set WRITE_CHANGELOG=0
goto :after_changelog

:do_changelog_input
echo.
python update_changelog.py --version !NEW_VERSION!
if errorlevel 1 echo ⚠ changelog 写入失败，但继续发布流程
echo.

:after_changelog

REM 将配置修改和 changelog 公示完毕

REM 最后确认：推送 tag 是不可撤销操作
set /p CONFIRM="确认发布 v!NEW_VERSION! 吗？(y/n): "
if /i not "!CONFIRM!"=="y" (
    echo 已取消
    exit /b 0
)

echo.
echo === 创建并推送 tag ===

REM 如果版本号有变化，先提交 app_config.json 和 changelog.json
if not "!NEW_VERSION!"=="!CURRENT_VERSION!" goto :commit_version_change
REM 版本号未变但 changelog 可能有更新，单独提交
if not "!WRITE_CHANGELOG!"=="1" goto :after_commit
if not exist changelog.json goto :after_commit
git diff --quiet changelog.json >nul 2>&1
if errorlevel 1 (
    git add changelog.json
    git commit -m "更新 v!NEW_VERSION! 更新内容"
    git push
    echo ✓ changelog 已提交
    echo.
)
goto :after_commit

:commit_version_change
echo 提交版本更新...
git add app_config.json
if exist changelog.json git add changelog.json
git commit -m "更新版本号到 v!NEW_VERSION!"
git push
echo ✓ 版本更新已提交
echo.

:after_commit

REM 检查 tag 是否已存在，若不存在则先删除
git rev-parse v!NEW_VERSION! >nul 2>&1
if not errorlevel 1 (
    echo Tag v!NEW_VERSION! 已存在，正在删除并重新发布...
    git tag -d v!NEW_VERSION!
    git push origin :refs/tags/v!NEW_VERSION! >nul 2>&1
    echo ✓ 已删除旧 Tag v!NEW_VERSION!
)

REM 创建 tag
git tag -a v!NEW_VERSION! -m "Release v!NEW_VERSION!"
if errorlevel 1 (
    echo ✗ 创建 tag 失败
    exit /b 1
)
echo ✓ Tag v!NEW_VERSION! 已创建

REM 推送 tag
git push origin v!NEW_VERSION!
if errorlevel 1 (
    echo ✗ 推送 tag 失败
    exit /b 1
)
echo ✓ Tag v!NEW_VERSION! 已推送到 GitHub

echo.
echo ============================================================
echo ✓ 发布完成！
echo ============================================================
echo.
echo GitHub Actions 将自动：
echo   1. 构建离线版 APK
echo   2. 创建 GitHub Release
echo   3. 上传 APK 到 Release
echo.
echo 查看构建进度：
echo https://github.com/zhao-zg/books/actions
echo.

pause
