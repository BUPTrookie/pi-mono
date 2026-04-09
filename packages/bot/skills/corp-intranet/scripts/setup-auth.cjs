#!/usr/bin/env node
// SSO 认证状态持久化助手
// 用法：node setup-auth.js <target-url>
// 启动有界面的 Chromium，用户手动登录后按回车保存 storageState

const { chromium } = require('playwright');
const readline = require('readline');
const path = require('path');

const DEFAULT_AUTH_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.corp-intranet-auth.json');

(async () => {
    const targetUrl = process.argv[2];
    const authPath = process.env.AUTH_PATH || DEFAULT_AUTH_PATH;

    if (!targetUrl) {
        console.error('用法: node setup-auth.js <target-url>');
        console.error('示例: node setup-auth.js "https://dev.sankuai.com"');
        process.exit(1);
    }

    console.log('🔐 启动浏览器，请在打开的窗口中手动完成 SSO 登录...\n');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(targetUrl, { timeout: 30000 });

    console.log(`📌 已导航到: ${targetUrl}`);
    console.log('   请在浏览器中完成登录操作。\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => {
        rl.question('✅ 登录完成后按 Enter 键保存认证状态...', () => {
            rl.close();
            resolve();
        });
    });

    await context.storageState({ path: authPath });
    console.log(`\n💾 认证状态已保存到: ${authPath}`);

    await browser.close();
    console.log('✨ 完成！现在可以使用 browse.js 访问内网页面了。');
})();
