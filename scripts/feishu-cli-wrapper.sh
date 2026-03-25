#!/bin/sh
export FEISHU_USER_ACCESS_TOKEN=$(jq -r '.access_token' data/temp/feishu-user-token.json 2>/dev/null)
exec feishu-cli "$@"
