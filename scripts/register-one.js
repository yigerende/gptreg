#!/usr/bin/env node
'use strict';

/**
 * Register a single ChatGPT account via command line.
 * Usage:
 *   node scripts/register-one.js --email <email> [--proxy <proxyUrl>] [--email-code <code>] [--phone <phone>] [--phone-code <code>]
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const cliPath = path.resolve(__dirname, '../bin/gpt-re.js');

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
GPT-Register 单账号注册工具

用法:
  node scripts/register-one.js --email <邮箱地址> [选项]

选项:
  --email <email>         待注册的邮箱地址 (必填)
  --proxy <proxy>         使用的代理 (如 http://127.0.0.1:7890 或 socks5://...)
  --email-code <code>     邮箱验证码 (若未配置自动接码平台则手动输入)
  --phone <phone>         手机号 (如 +123456789)
  --phone-code <code>     手机短信验证码
  --state <path>          自定义状态保存文件路径
  --raw                   输出原始 JSON 格式结果

示例:
  node scripts/register-one.js --email test1@example.com --proxy http://127.0.0.1:7890
`);
  process.exit(0);
}

const child = spawnSync(process.execPath, [cliPath, 'registration-run', ...args], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});

process.exit(child.status || 0);
