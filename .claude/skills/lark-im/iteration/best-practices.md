# 最佳实践

### 使用+chat-search查找P2P聊天时优先使用--member-ids和--search-types参数
- **场景**: 需要查找两个用户之间的P2P私聊聊天时
- **推荐做法**: 使用`lark-cli im +chat-search --member-ids=user1_open_id,user2_open_id --search-types=private --as user`命令
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 尝试使用`--member_ids`(失败)和`--chat-type=p2p`(失败)后，最终使用`--member-ids`和`--search-types=private`成功找到P2P聊天

### 搜索消息时使用正确的参数格式--sender和--start/--end
- **场景**: 需要按时间范围和发送者搜索消息时
- **推荐做法**: 使用`lark-cli im +messages-search --sender=sender_open_id --start=YYYY-MM-DDTHH:MM:SS+08:00 --end=YYYY-MM-DDTHH:MM:SS+08:00 --as user`
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 初始尝试使用`--sender_id`和`--from_time`/`--to_time`失败，查看帮助后使用`--sender`和`--start`/`--end`成功

### 使用+chat-messages-list获取特定聊天的时间范围消息
- **场景**: 获取特定聊天在某个时间范围内的完整消息记录
- **推荐做法**: 使用`lark-cli im +chat-messages-list --chat-id=chat_id --start=YYYY-MM-DDTHH:MM:SS+08:00 --end=YYYY-MM-DDTHH:MM:SS+08:00 --as user`
- **证据**:
  - [2026-04-01] session=feishu_oc_dbd1e613d846dd602c27b245577a8f61, 成功获取蔡锋和张野私聊的完整消息记录

### 操作前先阅读lark-shared/SKILL.md了解身份和权限
- **场景**: 使用lark-im技能进行任何操作前
- **推荐做法**: 首先使用Read工具读取`../lark-shared/SKILL.md`，了解user/bot身份区别、权限要求和认证流程
- **证据**:
  - [2026-04-01] 两个trace都在第一步读取了lark-shared/SKILL.md，确保正确理解身份和权限要求