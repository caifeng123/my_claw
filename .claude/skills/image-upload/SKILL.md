---
name: image-upload
description: 当需要上传本地图片到cdn时调用。该技能会调用一个上传脚本传入图片路径，返回上传后的CDN链接。
---

# 图片上传技能

这个技能用于将本地图片上传到CDN，并返回CDN链接。

## 使用方法

当用户需要上传图片到CDN时，使用这个技能。用户需要提供图片的本地路径

## scripts
上传图片的脚本: `<SKILL_DIR>/scripts/upload.js`

### demo
`node <SKILL_DIR>/scripts/upload.js <file_path>`

## 步骤
1. 确认用户提供了图片路径
2. 检查图片文件是否存在
3. 调用上传脚本，传入必要的参数
4. 返回CDN链接给用户

## 注意
- 如果上传失败，会抛出错误信息