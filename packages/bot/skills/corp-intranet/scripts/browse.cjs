#!/usr/bin/env node
// 内网页面浏览器 — 使用保存的认证状态访问 SSO 保护的页面
// 用法：node browse.js <url> [--screenshot path] [--html path] [--text] [--wait ms] [--selector css] [--cdp endpoint] [--auth path] [--headless]

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEFAULT_AUTH_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.corp-intranet-auth.json');

function parseArgs(argv) {
    const args = argv.slice(2);
    const opts = {
        url: null,
        screenshot: null,
        html: null,
        text: false,
        wait: 2000,
        selector: null,
        cdp: process.env.CDP_ENDPOINT || 'http://localhost:9222',
        auth: process.env.AUTH_PATH || DEFAULT_AUTH_PATH,
        headless: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--screenshot': opts.screenshot = args[++i]; break;
            case '--html': opts.html = args[++i]; break;
            case '--text': opts.text = true; break;
            case '--wait': opts.wait = parseInt(args[++i]) || 2000; break;
            case '--selector': opts.selector = args[++i]; break;
            case '--cdp': opts.cdp = args[++i]; break;
            case '--auth': opts.auth = args[++i]; break;
            case '--headless': opts.headless = true; break;
            default:
                if (!args[i].startsWith('--') && !opts.url) {
                    opts.url = args[i];
                }
        }
    }
    return opts;
}

async function connectBrowser(opts) {
    // 策略 1：尝试 CDP 连接已运行的 Chrome
    try {
        const browser = await chromium.connectOverCDP(opts.cdp);
        console.error('✅ CDP 连接成功');
        return { browser, mode: 'cdp' };
    } catch (e) {
        console.error(`⚠️  CDP 连接失败: ${e.message}`);
    }

    // 策略 2：使用 auth.json 启动新浏览器
    if (fs.existsSync(opts.auth)) {
        console.error('🔑 使用保存的认证状态启动浏览器...');
        const browser = await chromium.launch({
            headless: opts.headless,
            executablePath: '/Users/eastward/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        });
        console.error('✅ 浏览器已启动');
        return { browser, mode: 'auth' };
    }

    console.error('\n❌ 无法连接浏览器。请选择以下任一方式：\n');
    console.error('  方式 1（推荐）：启动 Chrome 并开启远程调试端口');
    console.error('    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222');
    console.error('    然后手动在 Chrome 中登录目标网站\n');
    console.error('  方式 2：运行认证助手保存登录状态');
    console.error(`    node ${path.join(__dirname, 'setup-auth.js')} <target-url>\n`);
    process.exit(1);
}

(async () => {
    const opts = parseArgs(process.argv);

    if (!opts.url) {
        console.error('用法: node browse.js <url> [options]');
        console.error('选项:');
        console.error('  --screenshot <path>  保存全页截图');
        console.error('  --html <path>        保存页面 HTML');
        console.error('  --text               输出可见文本到 stdout');
        console.error('  --wait <ms>          页面加载后额外等待时间（默认 2000）');
        console.error('  --selector <css>     仅提取匹配选择器的元素文本');
        console.error('  --cdp <endpoint>     CDP 端点（默认 http://localhost:9222）');
        console.error('  --auth <path>        认证文件路径（默认 ~/.corp-intranet-auth.json）');
        console.error('  --headless           无头模式运行');
        process.exit(1);
    }

    const { browser, mode } = await connectBrowser(opts);
    let context, page;

    try {
        if (mode === 'cdp') {
            const contexts = browser.contexts();
            context = contexts.length > 0 ? contexts[0] : await browser.newContext();
            page = await context.newPage();
        } else {
            context = await browser.newContext({ storageState: opts.auth });
            page = await context.newPage();
        }

        console.error(`🌐 正在访问: ${opts.url}`);
        await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 30000 });

        // 等待页面渲染稳定
        if (opts.wait > 0) {
            console.error(`⏳ 等待渲染 ${opts.wait}ms...`);
            await page.waitForTimeout(opts.wait);
        }

        // 检查是否被重定向到登录页（简单启发式）
        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/sso') || currentUrl.includes('/cas/')) {
            console.error('⚠️  页面似乎被重定向到了登录页面，认证可能已过期。');
            console.error(`   当前 URL: ${currentUrl}`);
            console.error(`   请重新运行: node ${path.join(__dirname, 'setup-auth.js')} "${opts.url}"`);
        }

        // 保存截图
        if (opts.screenshot) {
            const dir = path.dirname(opts.screenshot);
            if (dir) fs.mkdirSync(dir, { recursive: true });
            await page.screenshot({ path: opts.screenshot, fullPage: true });
            console.error(`📸 截图已保存: ${opts.screenshot}`);
        }

        // 保存 HTML
        if (opts.html) {
            const dir = path.dirname(opts.html);
            if (dir) fs.mkdirSync(dir, { recursive: true });
            const htmlContent = await page.content();
            fs.writeFileSync(opts.html, htmlContent);
            console.error(`📄 HTML 已保存: ${opts.html}（${htmlContent.length} 字符）`);
        }

        // 输出文本
        if (opts.text) {
            let text;
            if (opts.selector) {
                const elements = await page.locator(opts.selector).allTextContents();
                text = elements.join('\n');
            } else {
                text = await page.evaluate(() => document.body.innerText);
            }
            // 文本输出到 stdout（其他日志走 stderr），方便管道处理
            process.stdout.write(text + '\n');
        }

        // 如果什么都没指定，默认输出页面标题和 URL
        if (!opts.screenshot && !opts.html && !opts.text) {
            const title = await page.title();
            console.log(`标题: ${title}`);
            console.log(`URL: ${currentUrl}`);
        }

    } catch (e) {
        console.error(`❌ 错误: ${e.message}`);
        process.exit(1);
    } finally {
        if (mode === 'auth') {
            await context.close();
            await browser.close();
        } else {
            // CDP 模式：关闭我们新开的标签页，不关浏览器
            if (page) await page.close().catch(() => {});
        }
    }
})();
