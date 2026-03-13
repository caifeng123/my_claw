#!/usr/bin/env node

/**
 * 智能任务执行器 — 编排 TASK_LIST 并驱动远程沙箱执行
 *
 * 职责：
 *   1. 加载 .env 环境变量（项目根目录）
 *   2. 读取 TASK_LIST.md
 *   3. 检测 {IMAGE_URL} 占位符 → 自动查找最新图片 → 上传 CDN → 替换
 *   4. 调用 task.go 将任务发送到远程沙箱
 *
 * 用法：
 *   node task_runner.js <path/to/TASK_LIST.md>
 *
 * 零第三方依赖（Node.js 22+，使用内置 .env 加载）
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { uploadImage } from './upload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TASK_GO = resolve(__dirname, 'task.go');

// ─── .env 加载 ────────────────────────────────────────────

/**
 * 手动解析 .env 文件并注入 process.env（不覆盖已有值）。
 * 不引入第三方依赖，保持零依赖原则。
 */
function loadEnvFile(envPath) {
  if (!existsSync(envPath)) {
    console.log(`ℹ️  未找到 .env 文件: ${envPath}，跳过`);
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  let loaded = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // 去除引号包裹
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 不覆盖已有环境变量（系统/CI 优先）
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded++;
    }
  }

  console.log(`✅ 从 .env 加载了 ${loaded} 个环境变量`);
}

// ─── 图片查找 ─────────────────────────────────────────────

/**
 * 从 imageDir 中按文件名前缀（create_time）找到最新一批图片。
 * 文件命名约定：`{create_time}-image-{index}.{ext}`
 */
function findLatestImages(imageDir) {
  const files = readdirSync(imageDir).filter((f) => !f.startsWith('.'));
  if (files.length === 0) return [];

  const sorted = files.slice().sort();
  const latestFile = sorted.at(-1);
  const latestCT = latestFile.split('-')[0];

  return files
    .filter((f) => f.startsWith(`${latestCT}-image-`))
    .sort()
    .map((f) => resolve(imageDir, f));
}

// ─── 项目根目录查找 ────────────────────────────────────────

function findProjectRoot() {
  let current = process.cwd();
  while (true) {
    if (existsSync(resolve(current, '.claude'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

// ─── 图片处理 ─────────────────────────────────────────────

async function processImages(aiTaskList, projectRoot) {
  if (!aiTaskList.includes('{IMAGE_URL}')) {
    console.log('ℹ️  任务不需要图片处理，直接执行原始 TASK_LIST');
    return aiTaskList;
  }

  console.log('🔍 检测到 {IMAGE_URL} 占位符，开始自动处理图片...');
  const imageDir = resolve(projectRoot, 'data/lark/images');

  if (!existsSync(imageDir)) {
    console.warn(`⚠️  图片目录不存在: ${imageDir}，跳过图片处理`);
    return aiTaskList;
  }

  const imageFiles = findLatestImages(imageDir);
  if (imageFiles.length === 0) {
    console.warn('⚠️  图片目录为空，跳过图片处理');
    return aiTaskList;
  }

  const latestCT = basename(imageFiles[0]).split('-')[0];
  console.log(`✅ 最新批次 create_time: ${latestCT}，共 ${imageFiles.length} 张图片`);

  const results = await Promise.allSettled(
    imageFiles.map((img) => {
      console.log(`📤 上传: ${basename(img)} ...`);
      return uploadImage(img);
    })
  );

  const cdnUrls = [];
  const failures = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      cdnUrls.push(result.value);
      console.log(`   ✅ ${basename(imageFiles[i])} → ${result.value}`);
    } else {
      failures.push(basename(imageFiles[i]));
      console.error(`   ❌ ${basename(imageFiles[i])}: ${result.reason.message}`);
    }
  });

  if (cdnUrls.length === 0) {
    console.warn('⚠️  所有图片上传失败，使用原始 TASK_LIST');
    return aiTaskList;
  }

  if (failures.length > 0) {
    console.warn(`⚠️  ${failures.length} 张图片上传失败: ${failures.join(', ')}`);
  }

  const cdnUrlList = cdnUrls.join(',');
  const replaced = aiTaskList.replaceAll('{IMAGE_URL}', cdnUrlList);
  console.log(`✅ 已将 ${cdnUrls.length} 个 CDN 链接注入 TASK_LIST`);
  return replaced;
}

// ─── 远程任务执行 ──────────────────────────────────────────

function executeRemoteTask(taskListFile, projectRoot) {
  console.log('');
  console.log('🚀 开始执行远程控制任务...');
  console.log(`   任务文件: ${taskListFile}`);
  console.log(`   项目路径: ${projectRoot}`);
  console.log('');

  try {
    execFileSync('go', ['run', TASK_GO, taskListFile, projectRoot], {
      cwd: __dirname,
      stdio: 'inherit',
      env: {
        ...process.env,
        NO_PROXY: process.env.no_proxy || process.env.NO_PROXY || '',
      },
    });
    console.log('✅ 远程任务执行完成');
  } catch (err) {
    console.error(`❌ 远程任务执行失败: ${err.message}`);
    if (err.stderr) console.error(err.stderr.toString());
    process.exit(err.status || 1);
  }
}

// ─── 主流程 ───────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('❌ 缺少参数');
    console.log('用法: node task_runner.js <path/to/TASK_LIST.md>');
    process.exit(1);
  }

  const taskListFile = resolve(args[0]);
  const projectRoot = findProjectRoot();

  // ── 加载 .env（在一切业务逻辑之前） ──
  loadEnvFile(resolve(projectRoot, '.env'));

  // 前置校验
  const checks = [
    [taskListFile, '任务列表文件'],
    [TASK_GO, '任务执行器 (task.go)'],
  ];
  for (const [path, label] of checks) {
    if (!existsSync(path)) {
      console.error(`❌ ${label}不存在: ${path}`);
      process.exit(1);
    }
  }

  const aiTaskList = readFileSync(taskListFile, 'utf-8').trim();
  if (!aiTaskList) {
    console.error('❌ 任务列表文件为空');
    process.exit(1);
  }

  // 图片处理（条件性）
  const finalTaskList = await processImages(aiTaskList, projectRoot);

  // 写回文件供 Go 读取
  writeFileSync(taskListFile, finalTaskList, 'utf-8');
  console.log(`✅ 任务列表已更新: ${taskListFile}`);

  // 执行远程任务
  executeRemoteTask(taskListFile, projectRoot);
}

main();
