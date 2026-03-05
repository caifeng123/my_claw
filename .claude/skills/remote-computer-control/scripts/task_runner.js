#!/usr/bin/env node

/**
 * 智能任务执行器 - 条件性图片处理，支持图片和非图片场景
 * Node.js 22，零第三方依赖
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { uploadImage } from './upload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== 配置 ====================
const TASK_GO = resolve(__dirname, 'task.go');

// ==================== 图片查找 ====================
function findLatestImages(imageDir) {
  const files = readdirSync(imageDir);
  if (files.length === 0) return [];

  const sorted = files.slice().sort();
  const latestFile = sorted.at(-1);
  const latestCT = latestFile.split('-')[0];

  return files
    .filter((f) => f.startsWith(`${latestCT}-image-`))
    .sort()
    .map((f) => resolve(imageDir, f));
}

// ==================== 项目根目录查找 ====================
function findProjectRoot() {
  let current = process.cwd();
  while (true) {
    if (existsSync(resolve(current, '.claude'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break; // 到根目录了
    current = parent;
  }
  return process.cwd();
}

// ==================== 主流程 ====================
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('❌ 参数不足');
    console.log('用法: node smart_task_runner.js <path/to/TASK_LIST.md>');
    process.exit(1);
  }

  const taskListFile = resolve(args[0]);
  const projectRoot = findProjectRoot();

  if (!existsSync(taskListFile)) {
    console.error(`❌ 任务列表文件不存在: ${taskListFile}`);
    process.exit(1);
  }
  if (!existsSync(projectRoot)) {
    console.error(`❌ 项目根路径不存在: ${projectRoot}`);
    process.exit(1);
  }
  if (!existsSync(TASK_GO)) {
    console.error(`❌ 任务执行器不存在: ${TASK_GO}`);
    process.exit(1);
  }

  // 读取任务列表
  const aiTaskList = readFileSync(taskListFile, 'utf-8');
  if (!aiTaskList.trim()) {
    console.error('❌ 任务列表文件为空');
    process.exit(1);
  }

  let finalTaskList = aiTaskList;

  // ==================== 图片处理 ====================
  if (aiTaskList.includes('{IMAGE_URL}')) {
    console.log('🔍 检测到任务需要图片处理，开始自动检测图片...');

    const imageDir = resolve(projectRoot, 'data/lark/images');

    if (!existsSync(imageDir)) {
      console.warn(`⚠️  图片目录不存在: ${imageDir}，将使用原始 TASK_LIST 执行`);
    } else {
      const imageFiles = findLatestImages(imageDir);

      if (imageFiles.length === 0) {
        console.warn('⚠️  图片目录为空，将使用原始 TASK_LIST 执行');
      } else {
        const latestCT = basename(imageFiles[0]).split('-')[0];
        console.log(`✅ 最新 create_time: ${latestCT}`);
        console.log(`✅ 找到 ${imageFiles.length} 张图片:`);
        imageFiles.forEach((f) => console.log(`   - ${basename(f)}`));

        const results = await Promise.allSettled(
          imageFiles.map((img) => {
            console.log(`📤 上传图片: ${basename(img)} ...`);
            return uploadImage(img);
          })
        );

        const cdnUrls = [];
        let hasFailure = false;

        results.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            cdnUrls.push(result.value);
            console.log(`   ✅ ${basename(imageFiles[i])} → ${result.value}`);
          } else {
            hasFailure = true;
            console.error(`   ❌ ${basename(imageFiles[i])}: ${result.reason.message}`);
          }
        });

        if (cdnUrls.length > 0) {
          const cdnUrlList = cdnUrls.join(',');
          finalTaskList = aiTaskList.replaceAll('{IMAGE_URL}', cdnUrlList);
          console.log(`✅ 已将 ${cdnUrls.length} 个图片链接注入到任务列表`);
        } else {
          console.warn('⚠️  所有图片上传均失败，将使用原始 TASK_LIST 执行');
        }

        if (hasFailure && cdnUrls.length > 0) {
          console.warn(`⚠️  部分图片上传失败，已注入成功的 ${cdnUrls.length} 个链接`);
        }
      }
    }
  } else {
    console.log('ℹ️  任务不需要图片处理，直接执行原始 TASK_LIST');
  }

  // 写回文件（供 Go 读取）
  writeFileSync(taskListFile, finalTaskList, 'utf-8');
  console.log(`✅ 已更新任务列表文件: ${taskListFile}`);

  // ==================== 执行任务 ====================
  console.log('');
  console.log('🚀 开始执行远程控制任务...');
  console.log(`   项目路径: ${projectRoot}`);
  console.log('');

  try {
    console.log(`go run ${TASK_GO} ${taskListFile} ${projectRoot}`);
    execFileSync('go', ['run', TASK_GO, taskListFile, projectRoot], {
      cwd: __dirname,
      stdio: 'inherit',
      env: {
        ...process.env,
        NO_PROXY: process.env.no_proxy || '',
      },
    });
    console.log('✅ 任务执行完成！');
  } catch (err) {
    console.error(`❌ 任务执行失败:`, err.message);
    if (err.stderr) console.error(err.stderr.toString());
    process.exit(err.status || 1);
  }
}

main();