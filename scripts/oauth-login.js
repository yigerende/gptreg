#!/usr/bin/env node
'use strict';

/**
 * Authenticate an existing account via OAuth PKCE and obtain tokens.
 * Usage:
 *   node scripts/oauth-login.js --email <email> --password <password> [--proxy <proxyUrl>]
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const cliPath = path.resolve(__dirname, '../bin/gpt-re.js');

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
GPT-Register OAuth 登录与 Token 获取工具

用法:
  node scripts/oauth-login.js --email <邮箱地址> --password <密码> [选项]

选项:
  --email <email>         账号邮箱 (必填)
  --password <password>   账号密码 (必填)
  --proxy <proxy>         使用的代理 (如 http://127.0.0.1:7890)
  --state <path>          自定义状态保存文件路径
  --raw                   输出原始 JSON 格式结果

示例:
  node scripts/oauth-login.js --email myuser@example.com --password MySecretPassword! --proxy http://127.0.0.1:7890
`);
  process.exit(0);
}

const child = spawnSync(process.execPath, [cliPath, 'oauth-login-run', ...args], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});

process.exit(child.status || 0);
