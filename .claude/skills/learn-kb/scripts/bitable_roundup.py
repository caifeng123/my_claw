#!/usr/bin/env python3
"""
飞书多维表格（Bitable）操作脚本 —— 知识库汇总索引

核心改进：状态自管理。脚本自己读写状态文件，调用方无需手动管理 app_token/table_id。

状态文件位置：<PROJECT_ROOT>/data/temp/learn-kb.json
脚本通过从 cwd 向上查找 .claude/ 目录来定位项目根（与 Claude Code 机制一致）。

用法：
  # 追加记录（自动读取状态，首次使用自动创建表格）
  python3 bitable_roundup.py append \
    --title "文章标题" --source "GitHub" \
    --doc-link "https://feishu.cn/docx/xxx" \
    --original-link "https://github.com/xxx" \
    --summary "一句话摘要" \
    --tags "Python,大模型,AI Agent" \
    --relevance-level "高" \
    --project-help "API 重试机制可直接用于容错改造" \
    --user-email user@example.com

  # 查看当前绑定的多维表格信息
  python3 bitable_roundup.py status

  # 强制创建新表格（慎用，会覆盖状态）
  python3 bitable_roundup.py create \
    --title "我的知识库汇总 | AI 整理收藏" \
    --user-email user@example.com

  # 列出已有记录
  python3 bitable_roundup.py list

  # 检查链接是否已收藏（去重）
  python3 bitable_roundup.py check --original-link "https://example.com/article"

依赖：
  - FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量
  - FEISHU_USER_EMAIL 环境变量（可选，用于自动授权）
  - Python 3 标准库（无第三方依赖）
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path


# ============================================================
# 常量与路径
# ============================================================

FEISHU_HOST = "https://open.feishu.cn"
STATE_FILENAME = "learn-kb.json"
CHINA_TZ = timezone(timedelta(hours=8))

# 重试配置
MAX_RETRIES = 3
RETRY_BASE_DELAY = 1  # 秒，指数退避基数
RETRYABLE_CODES = {429, 500, 502, 503, 504}


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .claude/.

    Mimics how Claude Code discovers its project root, so paths
    stay consistent regardless of where the script is invoked from.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def get_state_path(args) -> Path:
    """获取状态文件路径：<PROJECT_ROOT>/data/temp/learn-kb.json"""
    if hasattr(args, 'state_file') and args.state_file:
        return Path(args.state_file)

    root = find_project_root()
    return root / "data" / "temp" / STATE_FILENAME


def get_user_email(args) -> str:
    """获取用户邮箱：优先命令行参数，其次环境变量 FEISHU_USER_EMAIL"""
    email = getattr(args, 'user_email', '') or ''
    if not email:
        email = os.environ.get("FEISHU_USER_EMAIL", "")
    return email


# ============================================================
# 飞书 API 基础
# ============================================================

def get_tenant_access_token() -> str:
    """获取 Tenant Access Token（仅从环境变量读取）"""
    app_id = os.environ.get("FEISHU_APP_ID", "")
    app_secret = os.environ.get("FEISHU_APP_SECRET", "")

    if not app_id or not app_secret:
        print("❌ 未找到 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量", file=sys.stderr)
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
    """发送飞书 API 请求（带指数退避重试）"""
    url = f"{FEISHU_HOST}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    body = json.dumps(data).encode() if data is not None else None

    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method=method)
            resp = urllib.request.urlopen(req)
            return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            last_error = e
            if e.code in RETRYABLE_CODES and attempt < MAX_RETRIES:
                delay = RETRY_BASE_DELAY * (2 ** attempt)
                print(f"⚠️  API {e.code}，{delay}s 后重试 ({attempt + 1}/{MAX_RETRIES})...", file=sys.stderr)
                time.sleep(delay)
                continue
            error_body = e.read().decode() if e.fp else str(e)
            print(f"❌ API 错误 [{e.code}]: {error_body}", file=sys.stderr)
            sys.exit(1)
        except urllib.error.URLError as e:
            last_error = e
            if attempt < MAX_RETRIES:
                delay = RETRY_BASE_DELAY * (2 ** attempt)
                print(f"⚠️  网络错误 ({e.reason})，{delay}s 后重试 ({attempt + 1}/{MAX_RETRIES})...", file=sys.stderr)
                time.sleep(delay)
                continue
            print(f"❌ 网络错误: {e.reason}", file=sys.stderr)
            sys.exit(1)

    print(f"❌ 请求失败（已重试 {MAX_RETRIES} 次）: {last_error}", file=sys.stderr)
    sys.exit(1)


def fetch_all_records(app_token: str, table_id: str, token: str) -> list:
    """分页获取所有记录"""
    all_items = []
    page_token = None

    while True:
        params = "page_size=500"
        if page_token:
            params += f"&page_token={page_token}"

        result = api_request(
            "GET",
            f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records?{params}",
            token
        )

        if result.get("code") != 0:
            print(f"❌ 获取记录失败: {result}", file=sys.stderr)
            return all_items

        items = result.get("data", {}).get("items", [])
        all_items.extend(items)

        has_more = result.get("data", {}).get("has_more", False)
        if not has_more:
            break
        page_token = result.get("data", {}).get("page_token")
        if not page_token:
            break

    return all_items


# ============================================================
# 状态管理
# ============================================================

def load_state(state_path: Path) -> dict | None:
    """读取状态文件，不存在或无效则返回 None"""
    if state_path.exists():
        try:
            with open(state_path, 'r') as f:
                state = json.load(f)
            if state.get("app_token") and state.get("table_id"):
                return state
            else:
                print("⚠️  状态文件缺少必要字段，将重新创建", file=sys.stderr)
                return None
        except (json.JSONDecodeError, IOError) as e:
            print(f"⚠️  状态文件损坏 ({e})，将重新创建", file=sys.stderr)
            return None
    return None


def save_state(state_path: Path, app_token: str, table_id: str, url: str):
    """保存状态文件到 <PROJECT_ROOT>/data/temp/"""
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "app_token": app_token,
        "table_id": table_id,
        "url": url,
        "created_at": datetime.now(CHINA_TZ).isoformat(),
    }
    with open(state_path, 'w') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    print(f"💾 状态已保存: {state_path}", file=sys.stderr)


def ensure_bitable(state_path: Path, user_email: str = None, title: str = None) -> dict:
    """
    确保多维表格存在：
    1. 读状态文件 → 有则直接返回
    2. 没有 → 自动创建 → 保存状态 → 返回
    """
    state = load_state(state_path)
    if state:
        print(f"📋 使用已有多维表格: {state.get('url', state['app_token'])}", file=sys.stderr)
        return state

    if not user_email:
        user_email = os.environ.get("FEISHU_USER_EMAIL", "")

    print("📋 首次使用，自动创建多维表格...", file=sys.stderr)
    title = title or "我的知识库汇总 | AI 整理收藏"
    app_token, table_id, app_url = _create_bitable(title, user_email)
    save_state(state_path, app_token, table_id, app_url)

    return {"app_token": app_token, "table_id": table_id, "url": app_url}


# ============================================================
# 创建多维表格
# ============================================================

# 字段定义（8 个字段，无独立标题字段）
# - 标题信息体现在「整理文档链接」的 text 属性中
# - 「摘要」字段合并了一句话摘要 + 对项目的帮助，用换行分隔
ROUNDUP_FIELDS = [
    {"field_name": "来源", "type": 3,
     "property": {"options": [
         {"name": "GitHub"}, {"name": "微信公众号"}, {"name": "小红书"},
         {"name": "知乎"}, {"name": "博客"}, {"name": "其他"},
     ]}},
    {"field_name": "标签", "type": 4,
     "property": {"options": []}},
    {"field_name": "关联度", "type": 3,
     "property": {"options": [
         {"name": "极高"}, {"name": "高"}, {"name": "中"},
         {"name": "低"}, {"name": "极低"},
     ]}},
    {"field_name": "摘要", "type": 1},
    {"field_name": "整理文档链接", "type": 15},
    {"field_name": "原始链接", "type": 15},
    {"field_name": "收藏时间", "type": 5},
]


def _create_bitable(title: str, user_email: str = None) -> tuple[str, str, str]:
    """创建多维表格，返回 (app_token, table_id, url)"""
    token = get_tenant_access_token()

    create_data = {
        "name": title,
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

    tables_result = api_request("GET", f"/open-apis/bitable/v1/apps/{app_token}/tables", token)
    table_id = tables_result["data"]["items"][0]["table_id"]

    if user_email:
        _grant_permission(app_token, "bitable", user_email)

    return app_token, table_id, app_url


def _grant_permission(doc_token: str, doc_type: str, user_email: str):
    """授权用户（安全拼接命令，避免 shell 注入）"""
    add_cmd = [
        "feishu-cli", "perm", "add", doc_token,
        "--doc-type", doc_type,
        "--member-type", "email",
        "--member-id", user_email,
        "--perm", "full_access",
        "--notification",
    ]
    transfer_cmd = [
        "feishu-cli", "perm", "transfer-owner", doc_token,
        "--doc-type", doc_type,
        "--member-type", "email",
        "--member-id", user_email,
        "--notification",
    ]
    subprocess.run(add_cmd, check=False)
    subprocess.run(transfer_cmd, check=False)


def cmd_create(args):
    """强制创建新的多维表格（覆盖已有状态）"""
    state_path = get_state_path(args)

    existing = load_state(state_path)
    if existing:
        print(f"⚠️  将覆盖已有多维表格: {existing.get('url', existing['app_token'])}", file=sys.stderr)

    user_email = get_user_email(args)
    app_token, table_id, app_url = _create_bitable(args.title, user_email)
    save_state(state_path, app_token, table_id, app_url)

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

def _build_summary_text(summary: str, project_help: str) -> str:
    """合并一句话摘要和对项目的帮助为单个摘要字段内容"""
    parts = []
    if summary:
        parts.append(f"简单摘要：{summary}")
    if project_help:
        parts.append(f"项目帮助：{project_help}")
    return "\n".join(parts)


def cmd_append(args):
    """向多维表格追加一条记录。自动读取状态，首次使用自动创建表格。"""
    state_path = get_state_path(args)
    user_email = get_user_email(args)

    if args.app_token and args.table_id:
        app_token = args.app_token
        table_id = args.table_id
    else:
        state = ensure_bitable(state_path, user_email=user_email)
        app_token = state["app_token"]
        table_id = state["table_id"]

    token = get_tenant_access_token()
    now_ms = int(datetime.now(CHINA_TZ).timestamp() * 1000)

    tags_list = [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else []

    summary_text = _build_summary_text(args.summary, args.project_help)

    fields = {
        "来源": args.source,
        "标签": tags_list,
        "关联度": args.relevance_level or "",
        "摘要": summary_text,
        "整理文档链接": {"text": args.title, "link": args.doc_link},
        "原始链接": {"text": args.title, "link": args.original_link},
        "收藏时间": now_ms,
    }

    result = api_request(
        "POST",
        f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records",
        token,
        {"fields": fields}
    )

    if result.get("code") != 0:
        print(f"❌ 追加记录失败: {result}", file=sys.stderr)
        sys.exit(1)

    record_id = result["data"]["record"]["record_id"]
    state = load_state(state_path)
    bitable_url = state.get("url", "") if state else ""

    print(json.dumps({
        "record_id": record_id,
        "title": args.title,
        "tags": tags_list,
        "relevance_level": args.relevance_level or "",
        "bitable_url": bitable_url,
    }, ensure_ascii=False, indent=2))
    print(f"\n✅ 已追加记录: {args.title}", file=sys.stderr)
    if tags_list:
        print(f"🏷️  标签: {' · '.join(tags_list)}", file=sys.stderr)
    if args.relevance_level:
        print(f"📊 关联度: {args.relevance_level}", file=sys.stderr)


# ============================================================
# 去重检查
# ============================================================

def cmd_check(args):
    """检查链接是否已收藏过（服务端 filter，O(1) 不再全量扫描）"""
    state_path = get_state_path(args)
    state = load_state(state_path)

    if not state:
        print(json.dumps({"exists": False, "reason": "no_bitable"}))
        return

    token = get_tenant_access_token()
    target_link = args.original_link.rstrip("/")

    # 用服务端 filter 精确匹配，避免拉全量
    filter_payload = {
        "conjunction": "and",
        "conditions": [{
            "field_name": "原始链接",
            "operator": "contains",
            "value": [target_link]
        }]
    }

    result = api_request(
        "POST",
        f"/open-apis/bitable/v1/apps/{state['app_token']}/tables/{state['table_id']}/records/search"
        f"?page_size=5",
        token,
        {"filter": filter_payload}
    )

    if result.get("code") != 0:
        # filter API 失败时降级为全量扫描
        print("⚠️  filter API 失败，降级为全量扫描", file=sys.stderr)
        _check_fallback(state, token, target_link)
        return

    items = result.get("data", {}).get("items", [])

    # 精确匹配（filter 是 contains，可能有误匹配）
    for item in items:
        fields = item.get("fields", {})
        original = fields.get("原始链接", {})
        existing_link = ""
        if isinstance(original, dict):
            existing_link = original.get("link", "")
        elif isinstance(original, str):
            existing_link = original

        if existing_link.rstrip("/") == target_link:
            _print_check_hit(item, fields)
            return

    print(json.dumps({"exists": False}))


def _check_fallback(state: dict, token: str, target_link: str):
    """全量扫描降级（当 filter API 不可用时）"""
    items = fetch_all_records(state["app_token"], state["table_id"], token)

    for item in items:
        fields = item.get("fields", {})
        original = fields.get("原始链接", {})
        existing_link = ""
        if isinstance(original, dict):
            existing_link = original.get("link", "")
        elif isinstance(original, str):
            existing_link = original

        if existing_link.rstrip("/") == target_link:
            _print_check_hit(item, fields)
            return

    print(json.dumps({"exists": False}))


def _print_check_hit(item: dict, fields: dict):
    """输出去重命中结果"""
    doc_link_field = fields.get("整理文档链接", {})
    doc_link = ""
    doc_title = ""
    if isinstance(doc_link_field, dict):
        doc_link = doc_link_field.get("link", "")
        doc_title = doc_link_field.get("text", "")
    elif isinstance(doc_link_field, str):
        doc_link = doc_link_field

    print(json.dumps({
        "exists": True,
        "title": doc_title,
        "record_id": item.get("record_id", ""),
        "doc_link": doc_link,
        "relevance_level": fields.get("关联度", ""),
        "summary": fields.get("摘要", ""),
    }, ensure_ascii=False))


# ============================================================
# 列出记录
# ============================================================

def cmd_list(args):
    """列出多维表格中的所有记录（全量分页）"""
    state_path = get_state_path(args)

    if args.app_token and args.table_id:
        app_token = args.app_token
        table_id = args.table_id
    else:
        state = load_state(state_path)
        if not state:
            print("❌ 未找到多维表格状态，请先执行 append 或 create", file=sys.stderr)
            sys.exit(1)
        app_token = state["app_token"]
        table_id = state["table_id"]

    token = get_tenant_access_token()
    items = fetch_all_records(app_token, table_id, token)

    print(f"共 {len(items)} 条记录:\n")

    for item in items:
        fields = item.get("fields", {})

        # 标题从整理文档链接的 text 中取
        doc_link_field = fields.get("整理文档链接", {})
        if isinstance(doc_link_field, dict):
            title = doc_link_field.get("text", "无标题")
        else:
            title = "无标题"

        source = fields.get("来源", "")
        tags = fields.get("标签", [])
        summary = fields.get("摘要", "")
        relevance_level = fields.get("关联度", "")
        tags_str = " · ".join(tags) if isinstance(tags, list) else str(tags)
        print(f"  {title} | {source}")
        if tags_str:
            print(f"       🏷️  {tags_str}")
        if relevance_level:
            print(f"       📊 关联度: {relevance_level}")
        if summary:
            # 摘要可能包含换行（一句话摘要 + 对项目的帮助），缩进展示
            for line in summary.split("\n"):
                print(f"       {line}")


# ============================================================
# 状态查看
# ============================================================

def cmd_status(args):
    """查看当前绑定的多维表格信息"""
    state_path = get_state_path(args)
    state = load_state(state_path)

    if state:
        print(json.dumps(state, ensure_ascii=False, indent=2))
        print(f"\n✅ 当前绑定: {state.get('url', state['app_token'])}", file=sys.stderr)
        print(f"   状态文件: {state_path}", file=sys.stderr)
    else:
        print(json.dumps({"bound": False, "state_file": str(state_path)}))
        print(f"\n⚠️  未绑定多维表格（首次 append 时会自动创建）", file=sys.stderr)
        print(f"   状态文件: {state_path}", file=sys.stderr)


# ============================================================
# 主入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="飞书多维表格汇总索引管理（自动状态管理）")
    parser.add_argument("--state-file", help="状态文件路径（覆盖默认的 <PROJECT_ROOT>/data/temp/ 位置）")
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # status
    subparsers.add_parser("status", help="查看当前绑定的多维表格信息")

    # create
    p_create = subparsers.add_parser("create", help="强制创建新的多维表格（覆盖已有）")
    p_create.add_argument("--title", default="我的知识库汇总 | AI 整理收藏", help="表格标题")
    p_create.add_argument("--user-email", default="", help="授权用户邮箱（可选，默认读 FEISHU_USER_EMAIL 环境变量）")

    # append
    p_append = subparsers.add_parser("append", help="追加记录（自动管理状态）")
    p_append.add_argument("--app-token", default="", help="多维表格 app_token（可选，默认从状态文件读取）")
    p_append.add_argument("--table-id", default="", help="数据表 table_id（可选，默认从状态文件读取）")
    p_append.add_argument("--title", required=True, help="文章标题（显示在整理文档链接和原始链接的文本中）")
    p_append.add_argument("--source", required=True, help="来源标签")
    p_append.add_argument("--doc-link", required=True, help="飞书文档链接")
    p_append.add_argument("--original-link", required=True, help="原始链接")
    p_append.add_argument("--summary", required=True, help="一句话摘要")
    p_append.add_argument("--tags", default="", help="标签，英文逗号分隔")
    p_append.add_argument("--relevance-level", default="", help="关联度（极高/高/中/低/极低）")
    p_append.add_argument("--project-help", default="", help="对项目的帮助（一句话概括，与摘要合并展示）")
    p_append.add_argument("--user-email", default="", help="用户邮箱（可选，默认读 FEISHU_USER_EMAIL 环境变量）")

    # check
    p_check = subparsers.add_parser("check", help="检查链接是否已收藏")
    p_check.add_argument("--original-link", required=True, help="原始链接")

    # list
    p_list = subparsers.add_parser("list", help="列出已有记录")
    p_list.add_argument("--app-token", default="", help="多维表格 app_token（可选）")
    p_list.add_argument("--table-id", default="", help="数据表 table_id（可选）")

    args = parser.parse_args()

    commands = {
        "status": cmd_status,
        "create": cmd_create,
        "append": cmd_append,
        "check": cmd_check,
        "list": cmd_list,
    }

    handler = commands.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
