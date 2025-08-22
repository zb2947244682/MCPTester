#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智能发版工具
支持三种发布类型：BUG修复、小功能更新、大版本更新
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def load_package_json():
    """读取 package.json 文件"""
    try:
        with open('package.json', 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print("❌ 错误：找不到 package.json 文件")
        sys.exit(1)
    except json.JSONDecodeError:
        print("❌ 错误：package.json 文件格式不正确")
        sys.exit(1)


def save_package_json(package_data):
    """保存 package.json 文件"""
    try:
        with open('package.json', 'w', encoding='utf-8') as f:
            json.dump(package_data, f, indent=2, ensure_ascii=False)
            f.write('\n')
        return True
    except Exception as e:
        print(f"❌ 错误：无法保存 package.json 文件 - {e}")
        return False


def parse_version(version_str):
    """解析版本号字符串为数组"""
    try:
        parts = version_str.split('.')
        return [int(part) for part in parts]
    except ValueError:
        print(f"❌ 错误：无效的版本号格式 - {version_str}")
        sys.exit(1)


def update_version(current_version, release_type):
    """根据发布类型更新版本号"""
    version_parts = parse_version(current_version)
    
    # 确保版本号至少有3位
    while len(version_parts) < 3:
        version_parts.append(0)
    
    if release_type == 'patch':
        # BUG修复：增加 patch 版本号
        version_parts[2] += 1
    elif release_type == 'minor':
        # 小功能更新：增加 minor 版本号，重置 patch 为0
        version_parts[1] += 1
        version_parts[2] = 0
    elif release_type == 'major':
        # 大版本更新：增加 major 版本号，重置 minor 和 patch 为0
        version_parts[0] += 1
        version_parts[1] = 0
        version_parts[2] = 0
    
    return '.'.join(map(str, version_parts))


def run_git_commit(version, release_name):
    """执行 Git 提交操作"""
    try:
        print("📝 正在提交到 Git 仓库...")
        
        # Git 添加 package.json
        result_add = subprocess.run([
            'git', 'add', 'package.json'
        ], capture_output=True, text=True, encoding='utf-8')
        
        if result_add.returncode != 0:
            print("❌ Git add 失败！")
            if result_add.stderr:
                print(f"错误信息：{result_add.stderr}")
            return False
        
        # Git 提交
        commit_message = f"🚀 发布版本 v{version} ({release_name})"
        result_commit = subprocess.run([
            'git', 'commit', '-m', commit_message
        ], capture_output=True, text=True, encoding='utf-8')
        
        if result_commit.returncode != 0:
            print("❌ Git commit 失败！")
            if result_commit.stderr:
                print(f"错误信息：{result_commit.stderr}")
            return False
        
        # Git 推送到远程仓库
        result_push = subprocess.run([
            'git', 'push'
        ], capture_output=True, text=True, encoding='utf-8')
        
        if result_push.returncode != 0:
            print("❌ Git push 失败！")
            if result_push.stderr:
                print(f"错误信息：{result_push.stderr}")
            return False
        
        print("✅ 已成功提交并推送到远程仓库！")
        print(f"📝 提交信息：{commit_message}")
        return True
        
    except Exception as e:
        print(f"❌ Git 操作过程中出现错误：{e}")
        return False


def run_npm_publish():
    """执行 npm publish 命令"""
    try:
        print("🚀 正在发布到 npm...")
        
        # 尝试不同的 npm 命令路径
        npm_commands = ['npm', 'npm.cmd', 'npm.exe']
        
        for npm_cmd in npm_commands:
            try:
                result = subprocess.run([
                    npm_cmd, 'publish', 
                    '--access', 'public', 
                    '--registry=https://registry.npmjs.org/'
                ], capture_output=True, text=True, encoding='utf-8')
                
                if result.returncode == 0:
                    print("✅ 发布成功！")
                    return True
                else:
                    print("❌ 发布失败！")
                    if result.stderr:
                        print(f"错误信息：{result.stderr}")
                    if result.stdout:
                        print(f"输出信息：{result.stdout}")
                    return False
                    
            except FileNotFoundError:
                continue  # 尝试下一个命令
                
        # 如果所有命令都失败了
        print("❌ 找不到 npm 命令！请确保 Node.js 和 npm 已正确安装并在 PATH 中。")
        print("💡 你也可以手动运行：npm publish --access public --registry=https://registry.npmjs.org/")
        return False
        
    except Exception as e:
        print(f"❌ 发布过程中出现错误：{e}")
        return False


def main():
    """主函数"""
    print("=" * 50)
    print("           🚀 智能发版工具")
    print("=" * 50)
    print()
    
    # 读取当前版本
    package_data = load_package_json()
    current_version = package_data.get('version', '1.0.0')
    
    print(f"📦 当前版本：{current_version}")
    print()
    print("请选择发布类型：")
    print("1. 🐛 BUG修复 (增加 0.0.1)")
    print("2. ✨ 小功能更新 (增加 0.1.0，重置patch为0)")
    print("3. 🎉 大版本更新 (增加 1.0.0，重置minor和patch为0)")
    print()
    
    # 获取用户选择
    while True:
        try:
            choice = input("请输入选择 (1/2/3): ").strip()
            if choice in ['1', '2', '3']:
                break
            else:
                print("⚠️  无效选择，请输入 1、2 或 3")
        except KeyboardInterrupt:
            print("\n\n👋 操作已取消")
            sys.exit(0)
    
    # 设置发布类型
    release_types = {
        '1': ('patch', 'BUG修复'),
        '2': ('minor', '小功能更新'),
        '3': ('major', '大版本更新')
    }
    
    release_type, release_name = release_types[choice]
    
    print(f"\n📋 选择的发布类型：{release_name}")
    print("🔄 正在更新版本号...")
    
    # 更新版本号
    new_version = update_version(current_version, release_type)
    package_data['version'] = new_version
    
    # 保存更新后的 package.json
    if not save_package_json(package_data):
        sys.exit(1)
    
    print(f"✅ 版本号已从 {current_version} 更新为 {new_version} ({release_name})")
    
    # 直接发布到 npm
    npm_success = run_npm_publish()
    
    # 如果 npm 发布成功，则提交到 Git
    git_success = False
    if npm_success:
        git_success = run_git_commit(new_version, release_name)
    
    print()
    print("=" * 50)
    if npm_success:
        print("          ✅ npm 发布成功！")
        print(f"发布类型：{release_name}")
        print(f"新版本：{new_version}")
        
        if git_success:
            print("          ✅ Git 提交成功！")
        else:
            print("          ⚠️  Git 提交失败（但 npm 发布已完成）")
    else:
        print("          ❌ npm 发布失败！")
    print("=" * 50)


if __name__ == "__main__":
    main()
