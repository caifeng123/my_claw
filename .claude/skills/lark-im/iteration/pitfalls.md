# 注意避免的错误实践

### 使用错误的参数名--member_ids和--chat-type搜索P2P聊天
- **场景**: 使用+chat-search查找两个用户的P2P聊天时
- **规避方式**: 使用正确的参数名`--member-ids`(带连字符)而不是`--member_ids`(下划线)，使用`--search-types=private`而不是`--chat-type=p2p`
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 尝试`--member_ids`和`--chat-type=p2p`都导致命令失败

### 使用不存在的参数--sender_id、--from_time、--to_time搜索消息
- **场景**: 使用+messages-search按发送者和时间范围搜索消息时
- **规避方式**: 使用正确的参数名`--sender`、`--start`、`--end`，而不是`--sender_id`、`--from_time`、`--to_time`
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 初始尝试使用错误参数名导致命令失败

### 未指定时区的时间格式可能导致搜索范围不准确
- **场景**: 搜索特定日期消息时使用不带时区的时间格式
- **规避方式**: 始终使用带时区的时间格式，如`2026-03-31T00:00:00+08:00`（北京时间）
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 初始尝试使用`2026-03-31T00:00:00`（无时区）失败，后续成功命令都使用了`+08:00`时区

### 直接使用复杂参数而不查看帮助文档
- **场景**: 对命令参数不确定时直接尝试可能导致多次失败
- **规避方式**: 使用`--help`查看命令详细参数格式，特别是对于+messages-search等复杂命令
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 首次失败后查看`lark-cli im +messages-search --help`才了解正确参数格式