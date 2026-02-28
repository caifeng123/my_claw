# Skill 搜索与安装

## 搜索机制

### 语义搜索
```python
def search_skills(query, filters=None):
    """语义搜索skill"""
    search_api = "https://skills.registry.ai/search"
    
    search_params = {
        "q": query,
        "filters": filters or {},
        "limit": 20,
        "offset": 0
    }
    
    response = requests.get(search_api, params=search_params)
    return response.json()
```

### 搜索过滤器
```python
# 可用过滤器
filters = {
    "category": ["data", "web", "automation"],
    "difficulty": ["beginner", "intermediate", "advanced"],
    "license": ["MIT", "Apache-2.0", "GPL-3.0"],
    "rating": {"min": 4.0, "max": 5.0},
    "downloads": {"min": 1000}
}
```

## 安装流程

### 自动安装
```bash
#!/bin/bash
# install-skill.sh - 自动安装skill

SKILL_NAME="$1"
INSTALL_DIR="$2"

# 搜索skill
echo "🔍 搜索skill: $SKILL_NAME"
search_result=$(search_skills "$SKILL_NAME")

if [[ -z "$search_result" ]]; then
    echo "❌ 未找到匹配的skill"
    exit 1
fi

# 选择最佳匹配
best_match=$(select_best_match "$search_result")

# 下载skill包
echo "📦 下载skill包..."
download_url="$best_match[download_url]"
wget -O "/tmp/skill-package.zip" "$download_url"

# 解压安装
echo "🚀 安装skill..."
unzip -q "/tmp/skill-package.zip" -d "$INSTALL_DIR"

# 验证安装
if [[ -f "$INSTALL_DIR/SKILL.md" ]]; then
    echo "✅ Skill安装成功: $INSTALL_DIR"
else
    echo "❌ 安装验证失败"
    exit 1
fi

# 清理临时文件
rm "/tmp/skill-package.zip"
```

### 依赖检查
```python
def check_dependencies(skill_metadata):
    """检查skill依赖"""
    dependencies = skill_metadata.get("dependencies", [])
    missing_deps = []
    
    for dep in dependencies:
        if not is_dependency_installed(dep):
            missing_deps.append(dep)
    
    return missing_deps

def install_dependencies(dependencies):
    """安装缺失依赖"""
    for dep in dependencies:
        install_command = get_install_command(dep)
        subprocess.run(install_command, shell=True, check=True)
```

## 搜索工具

### 命令行搜索
```bash
#!/bin/bash
# search-skills.sh - 命令行搜索工具

QUERY="$1"
FILTERS="$2"

# 搜索skill
echo "搜索: $QUERY"
results=$(search_skills "$QUERY" "$FILTERS")

# 格式化输出
echo ""
echo "搜索结果:"
echo "=========="

for i in "${!results[@]}"; do
    skill="${results[$i]}"
    echo "$((i+1)). ${skill[name]} - ${skill[rating]}⭐"
    echo "   描述: ${skill[description]}"
    echo "   下载: ${skill[downloads]}次"
    echo ""
done

# 安装提示
echo "安装命令: install-skill.sh <skill-name> <安装目录>"
```

### 交互式搜索
```python
def interactive_search():
    """交互式搜索界面"""
    while True:
        query = input("🔍 搜索skill (输入q退出): ")
        
        if query.lower() == 'q':
            break
        
        results = search_skills(query)
        
        if not results:
            print("未找到匹配的skill")
            continue
        
        # 显示搜索结果
        display_results(results)
        
        # 选择安装
        choice = input("选择要安装的skill编号 (0取消): ")
        
        if choice == '0':
            continue
        
        selected_skill = results[int(choice) - 1]
        install_skill(selected_skill)
```

## 安装验证

### 安装后检查
```bash
#!/bin/bash
# verify-installation.sh - 安装验证

SKILL_PATH="$1"

# 检查必需文件
echo "🔍 验证skill安装..."

required_files=("SKILL.md" "scripts/")
for file in "${required_files[@]}"; do
    if [[ ! -e "$SKILL_PATH/$file" ]]; then
        echo "❌ 安装不完整: 缺少 $file"
        exit 1
    fi
done

# 检查脚本可执行性
for script in "$SKILL_PATH/scripts/*.sh"; do
    if [[ -f "$script" ]]; then
        if [[ ! -x "$script" ]]; then
            chmod +x "$script"
            echo "✅ 设置执行权限: $script"
        fi
    fi
done

# 测试基本功能
echo "🧪 测试基本功能..."
if [[ -f "$SKILL_PATH/scripts/test.sh" ]]; then
    cd "$SKILL_PATH" && ./scripts/test.sh
    if [[ $? -eq 0 ]]; then
        echo "✅ 功能测试通过"
    else
        echo "❌ 功能测试失败"
        exit 1
    fi
fi

echo "✅ Skill安装验证完成"
```

## 更新管理

### 检查更新
```python
def check_for_updates(skill_name, current_version):
    """检查skill更新"""
    registry_api = f"https://skills.registry.ai/skills/{skill_name}"
    
    response = requests.get(registry_api)
    skill_info = response.json()
    
    latest_version = skill_info["latest_version"]
    
    if version.parse(latest_version) > version.parse(current_version):
        return {
            "update_available": True,
            "current_version": current_version,
            "latest_version": latest_version,
            "changelog": skill_info["changelog"]
        }
    else:
        return {"update_available": False}
```

### 自动更新
```bash
#!/bin/bash
# update-skill.sh - 自动更新skill

SKILL_NAME="$1"
SKILL_PATH="$2"

# 检查当前版本
current_version=$(get_current_version "$SKILL_PATH")

# 检查更新
echo "🔍 检查更新..."
update_info=$(check_for_updates "$SKILL_NAME" "$current_version")

if [[ "$update_info[update_available]" == "false" ]]; then
    echo "✅ 已是最新版本: $current_version"
    exit 0
fi

echo "📦 发现新版本: $update_info[latest_version]"
echo "当前版本: $current_version"

# 确认更新
read -p "是否更新? (y/n): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "更新已取消"
    exit 0
fi

# 备份当前版本
backup_dir="$SKILL_PATH.backup.$(date +%Y%m%d)"
cp -r "$SKILL_PATH" "$backup_dir"

# 下载新版本
install_skill "$SKILL_NAME" "$SKILL_PATH" "$update_info[latest_version]"

echo "✅ 更新完成: $update_info[latest_version]"
echo "📋 变更日志:"
echo "$update_info[changelog]"
```

## 最佳实践

### 搜索技巧
- **使用具体关键词** - "数据清洗" 比 "数据处理" 更精确
- **结合过滤器** - 使用分类、难度等过滤器缩小范围
- **查看评分和下载量** - 高评分和高下载量通常表示质量较好

### 安装建议
- **先测试后使用** - 在新环境中测试skill功能
- **检查依赖** - 确保所有依赖项已安装
- **阅读文档** - 仔细阅读README和SKILL.md
- **备份重要数据** - 更新前备份当前配置

记住：**选择合适的skill比安装更多skill更重要**。质量优先于数量。