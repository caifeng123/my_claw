#!/bin/bash
# 智能任务执行器 - 条件性图片处理，支持图片和非图片场景

# 设置变量
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_DETECTOR="$HOME/.openclaw/workspace/find_latest_image.sh"
TASK_GO="$SCRIPT_DIR/task.go"

# 检查任务执行器是否存在
if [ ! -f "$TASK_GO" ]; then
    echo "❌ 任务执行器不存在: $TASK_GO"
    exit 1
fi

# 检查是否提供了TASK_LIST参数
if [ $# -eq 0 ]; then
    echo "❌ 请提供AI制定的TASK_LIST作为参数"
    echo "用法: $0 \"<TASK_LIST>\""
    exit 1
fi

AI_TASK_LIST="$1"
FINAL_TASK_LIST="$AI_TASK_LIST"

# 智能判断：检查是否需要图片处理（只检测{IMAGE_URL}占位符）
if [[ "$AI_TASK_LIST" == *"{IMAGE_URL}"* ]]; then
    echo "🔍 检测到任务需要图片处理，开始自动检测图片..."
    
    # 检查图片检测器是否存在
    if [ ! -f "$IMAGE_DETECTOR" ]; then
        echo "❌ 图片检测器不存在: $IMAGE_DETECTOR"
        echo "⚠️  将使用原始TASK_LIST执行（不包含图片处理）"
    else
        # 自动检测最新图片
        LATEST_IMAGE=$($IMAGE_DETECTOR)
        
        if [ $? -eq 0 ] && [ -f "$LATEST_IMAGE" ]; then
            echo "✅ 找到最新图片: $LATEST_IMAGE"
            
            # 上传图片到CDN
            echo "📤 上传图片到CDN..."
            UPLOAD_RESULT=$(node $HOME/.agents/skills/image-upload/scripts/upload.js "$LATEST_IMAGE" 2>/dev/null)
            
            if [[ $UPLOAD_RESULT == *"lf3-static"* ]]; then
                CDN_URL=$(echo "$UPLOAD_RESULT" | grep -o 'lf3-static[^ ]*' | head -1)
                echo "✅ 图片上传成功: $CDN_URL"
                
                # 将图片信息集成到AI制定的TASK_LIST中（只替换{IMAGE_URL}占位符）
                FINAL_TASK_LIST=$(echo "$AI_TASK_LIST" | sed "s|{IMAGE_URL}|$CDN_URL|g")
            else
                echo "❌ 图片上传失败，将使用原始TASK_LIST执行"
            fi
        else
            echo "⚠️  未找到图片文件，将使用原始TASK_LIST执行"
        fi
    fi
else
    echo "ℹ️  任务不需要图片处理，直接执行原始TASK_LIST"
fi

echo "🚀 开始执行远程控制任务..."
echo "最终任务列表: $FINAL_TASK_LIST"

# 执行任务
cd "$SCRIPT_DIR" && go run task.go "$FINAL_TASK_LIST"

echo "✅ 任务执行完成！"