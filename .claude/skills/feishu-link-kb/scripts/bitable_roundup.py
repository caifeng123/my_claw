#!/usr/bin/env python3
"""
飞书多维表格（Bitable）操作脚本 —— 用于知识库汇总索引

功能：
  1. 创建多维表格 + 数据表 + 字段定义
  2. 往已有数据表追加一条记录
  3. 列出已有记录

依赖：
  - FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量（或 feishu-cli 已配置）
  - Python 3 标准库（无第三方依赖）

用法：
  # 创建新的多维表格
  python3 bitable_roundup.py create --title "我的知识库汇总" --user-email user@example.com

  # 追加记录
  python3 bitable_roundup.py append --app-token <app_token> --table-id <table_id> \
    --title "文章标题" --source "GitHub" \
    --doc-link "https://feishu.cn/docx/xxx" \
    --original-link "https://github.com/xxx" \
    --summary "一句话摘要" \
    --tags "Python,大模型,AI Agent,开源项目"

  # 列出记录
  python3 bitable_roundup.py list --app-token <app_token> --table-id <table_id>
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
import subprocess
from datetime import datetime


# ============================================================
# 飞书 API 基础
# ============================================================

FEISHU_HOST = "https://open.feishu.cn"


def get_tenant_access_token() -> str:
    """获取 Tenant Access Token"""
    app_id = os.environ.get("FEISHU_APP_ID", "")
    app_secret = os.environ.get("FEISHU_APP_SECRET", "")

    if not app_id or not app_secret:
        # 尝试从 feishu-cli 配置读取
        config_path = os.path.expanduser("~/.feishu-cli/config.yaml")
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("app_id:"):
                        app_id = line.split(":", 1)[1].strip().strip('"').strip("'")
                    elif line.startswith("app_secret:"):
                        app_secret = line.split(":", 1)[1].strip().strip('"').strip("'")

    if not app_id or not app_secret:
        print("❌ 未找到 FEISHU_APP_ID / FEISHU_APP_SECRET", file=sys.stderr)
        sys.exit(1)

    url = f"{FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal"
    data = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req)
    result = json.loads(resp.read())

    if result.get("code") != 0:
        print(f"❌ 获取 Token 失败: {result}", file=sys.stderr)
        sys.exit(1)

    return result["tenant_access_token"]


def api_request(method: str, path: str, token: str, data: dict = None) -> dict:
    """发送飞书 API 请求"""
    url = f"{FEISHU_HOST}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    if data is not None:
        body = json.dumps(data).encode()
    else:
        body = None

    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else str(e)
        print(f"❌ API 错误 [{e.code}]: {error_body}", file=sys.stderr)
        sys.exit(1)


# ============================================================
# 创建多维表格
# ============================================================

# 汇总表字段定义
ROUNDUP_FIELDS = [
    {"field_name": "标题", "type": 1},          # 1 = 文本
    {"field_name": "来源", "type": 3,           # 3 = 单选
     "property": {"options": [
         {"name": "GitHub"}, {"name": "微信公众号"}, {"name": "小红书"},
         {"name": "知乎"}, {"name": "博客"}, {"name": "其他"},
     ]}},
    {"field_name": "标签", "type": 4,           # 4 = 多选
     "property": {"options": []}},              # 多选选项会在写入时自动创建
    {"field_name": "整理文档链接", "type": 15},  # 15 = 超链接
    {"field_name": "原始链接", "type": 15},      # 15 = 超链接
    {"field_name": "一句话摘要", "type": 1},     # 1 = 文本
    {"field_name": "收藏时间", "type": 5},       # 5 = 日期
]


def cmd_create(args):
    """创建新的多维表格"""
    token = get_tenant_access_token()

    # Step 1: 创建多维表格（带数据表和字段）
    create_data = {
        "name": args.title,
        "table": {
            "name": "已整理内容",
            "fields": ROUNDUP_FIELDS,
        }
    }

    result = api_request("POST", "/open-apis/bitable/v1/apps", token, create_data)

    if result.get("code") != 0:
        print(f"❌ 创建失败: {result}", file=sys.stderr)
        sys.exit(1)

    app = result["data"]["app"]
    app_token = app["app_token"]
    app_url = app.get("url", f"https://bytedance.larkoffice.com/base/{app_token}")

    # Step 2: 获取默认数据表 ID
    tables_result = api_request("GET", f"/open-apis/bitable/v1/apps/{app_token}/tables", token)
    table_id = tables_result["data"]["items"][0]["table_id"]

    # Step 3: 给用户加权限
    if args.user_email:
        # 用 feishu-cli perm add
        perm_cmd = (
            f"feishu-cli perm add {app_token} "
            f"--doc-type bitable "
            f"--member-type email "
            f"--member-id {args.user_email} "
            f"--perm full_access "
            f"--notification"
        )
        subprocess.run(perm_cmd, shell=True, check=False)

        transfer_cmd = (
            f"feishu-cli perm transfer-owner {app_token} "
            f"--doc-type bitable "
            f"--member-type email "
            f"--member-id {args.user_email} "
            f"--notification"
        )
        subprocess.run(transfer_cmd, shell=True, check=False)

    # 输出结果
    output = {
        "app_token": app_token,
        "table_id": table_id,
        "url": app_url,
        "title": args.title,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    print(f"\n✅ 多维表格已创建: {app_url}", file=sys.stderr)


# ============================================================
# 追加记录
# ============================================================

def cmd_append(args):
    """向多维表格追加一条记录"""
    token = get_tenant_access_token()

    now_ms = int(datetime.now().timestamp() * 1000)

    # 解析标签：逗号分隔 → 多选列表
    tags_list = []
    if args.tags:
        tags_list = [t.strip() for t in args.tags.split(",") if t.strip()]

    # 构建记录
    fields = {
        "标题": args.title,
        "来源": args.source,
        "标签": tags_list,
        "整理文档链接": {"text": "查看文档", "link": args.doc_link},
        "原始链接": {"text": "原文", "link": args.original_link},
        "一句话摘要": args.summary,
        "收藏时间": now_ms,
    }

    result = api_request(
        "POST",
        f"/open-apis/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records",
        token,
        {"fields": fields}
    )

    if result.get("code") != 0:
        print(f"❌ 追加记录失败: {result}", file=sys.stderr)
        sys.exit(1)

    record_id = result["data"]["record"]["record_id"]
    print(json.dumps({
        "record_id": record_id,
        "title": args.title,
        "tags": tags_list,
    }, ensure_ascii=False, indent=2))
    print(f"\n✅ 已追加记录: {args.title}", file=sys.stderr)
    if tags_list:
        print(f"🏷️  标签: {' · '.join(tags_list)}", file=sys.stderr)


# ============================================================
# 列出记录
# ============================================================

def cmd_list(args):
    """列出多维表格中的所有记录"""
    token = get_tenant_access_token()

    result = api_request(
        "GET",
        f"/open-apis/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records?page_size=500",
        token
    )

    if result.get("code") == 0:
        items = result.get("data", {}).get("items", [])
    else:
        print(f"❌ 列出记录失败: {result}", file=sys.stderr)
        sys.exit(1)

    print(f"共 {len(items)} 条记录:\n")

    for item in items:
        fields = item.get("fields", {})

        title = fields.get("标题", "无标题")
        source = fields.get("来源", "")
        tags = fields.get("标签", [])
        summary = fields.get("一句话摘要", "")
        tags_str = " · ".join(tags) if isinstance(tags, list) else str(tags)
        print(f"  {title} | {source}")
        if tags_str:
            print(f"       🏷️  {tags_str}")
        if summary:
            print(f"       {summary}")


# ============================================================
# 主入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="飞书多维表格汇总索引管理")
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # create
    p_create = subparsers.add_parser("create", help="创建新的多维表格")
    p_create.add_argument("--title", default="我的知识库汇总 | AI 整理收藏", help="表格标题")
    p_create.add_argument("--user-email", help="授权用户邮箱")

    # append
    p_append = subparsers.add_parser("append", help="追加记录")
    p_append.add_argument("--app-token", required=True, help="多维表格 app_token")
    p_append.add_argument("--table-id", required=True, help="数据表 table_id")
    p_append.add_argument("--title", required=True, help="文章标题")
    p_append.add_argument("--source", required=True, help="来源标签")
    p_append.add_argument("--doc-link", required=True, help="飞书文档链接")
    p_append.add_argument("--original-link", required=True, help="原始链接")
    p_append.add_argument("--summary", required=True, help="一句话摘要")
    p_append.add_argument("--tags", default="", help="标签，英文逗号分隔（如 Python,大模型,AI Agent）")

    # list
    p_list = subparsers.add_parser("list", help="列出记录")
    p_list.add_argument("--app-token", required=True, help="多维表格 app_token")
    p_list.add_argument("--table-id", required=True, help="数据表 table_id")

    args = parser.parse_args()

    if args.command == "create":
        cmd_create(args)
    elif args.command == "append":
        cmd_append(args)
    elif args.command == "list":
        cmd_list(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
