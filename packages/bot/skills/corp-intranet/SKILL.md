---
name: corp-intranet
description: Access authenticated company intranet pages (SSO-protected sites) using Playwright with saved browser auth state. Use this skill whenever the user wants to visit, browse, read, scrape, or extract content from internal/corporate URLs (e.g., dev.sankuai.com, any *.sankuai.com, or other SSO-gated sites), take screenshots of internal pages, or set up browser authentication for internal tools. Also use when the user mentions "intranet", "internal site", "corp site", "SSO login", or references URLs that require company authentication.
---

# Corp Intranet Browser

Access SSO-protected company intranet pages from Claude Code using Playwright with persisted authentication state.

## How It Works

The skill uses Playwright's `storageState` mechanism to persist browser cookies and localStorage after a manual SSO login. Once saved, this auth state can be reused across sessions without re-authenticating.

Two connection strategies, tried in order:

1. **CDP mode** (preferred): Attach to an already-running Chrome via `--remote-debugging-port=9222`. This inherits the user's full logged-in session — no separate auth file needed.
2. **Auth file mode** (fallback): Launch a fresh Chromium with a saved `auth.json` containing cookies/localStorage from a prior login session.

## Setup: Save Auth State

Before using this skill for the first time (or when auth expires), the user needs to save their SSO login state. Run the setup script:

```bash
node <skill-path>/scripts/setup-auth.js <target-url>
```

For example:
```bash
node <skill-path>/scripts/setup-auth.js "https://dev.sankuai.com"
```

This will:
1. Launch a visible Chromium window navigated to the target URL
2. Wait for the user to complete SSO login manually
3. Save the browser state (cookies + localStorage) to `~/.corp-intranet-auth.json` on Enter

The auth file path defaults to `~/.corp-intranet-auth.json`. Override with `AUTH_PATH` env var.

If the user says their auth is expired or they're getting redirected to a login page, re-run the setup script.

## Accessing Intranet Pages

After setup, use the browse script to visit any authenticated page:

```bash
node <skill-path>/scripts/browse.js <url> [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--screenshot <path>` | Save a full-page screenshot | (none) |
| `--html <path>` | Save the page HTML to a file | (none) |
| `--text` | Print extracted visible text to stdout | false |
| `--wait <ms>` | Extra wait time after page load (for JS rendering) | 2000 |
| `--selector <css>` | Extract text only from elements matching this selector | (none) |
| `--cdp <endpoint>` | CDP endpoint to try first | `http://localhost:9222` |
| `--auth <path>` | Path to auth state file | `~/.corp-intranet-auth.json` |
| `--headless` | Run in headless mode (no visible browser window) | false |

### Examples

**Read a page and print its text:**
```bash
node <skill-path>/scripts/browse.js "https://dev.sankuai.com/code/repo-detail/ai-assistant/iie-worklog/file/list" --text
```

**Take a screenshot:**
```bash
node <skill-path>/scripts/browse.js "https://dev.sankuai.com/code/repo-detail/..." --screenshot /tmp/page.png
```

**Save HTML and screenshot together:**
```bash
node <skill-path>/scripts/browse.js "https://some-internal-site.sankuai.com/dashboard" --html /tmp/page.html --screenshot /tmp/page.png --text
```

**Extract specific content with a CSS selector:**
```bash
node <skill-path>/scripts/browse.js "https://dev.sankuai.com/..." --selector ".file-list-container" --text
```

**Use CDP connection to already-running Chrome:**
```bash
# First, start Chrome with: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
node <skill-path>/scripts/browse.js "https://dev.sankuai.com/..." --cdp http://localhost:9222 --text
```

## Troubleshooting

- **"Auth file not found"**: Run the setup script first to save your login state.
- **Redirected to SSO login page**: Auth has expired. Re-run setup to refresh.
- **CDP connection failed, no auth file**: Either start Chrome with `--remote-debugging-port=9222` and log in manually, or run the setup script.
- **Page loads but content is empty**: Some pages render dynamically via JavaScript. Increase `--wait` (e.g., `--wait 5000`) to give the page more time.
- **Specific content not found with --selector**: Use browser DevTools to verify the CSS selector. Try without `--selector` first to see the full page text.

## Important Notes

- The `auth.json` file contains sensitive session data (cookies, tokens). Treat it as a credential — do not commit it to version control or share it.
- Auth state typically expires after some time (depends on the SSO provider). When pages start redirecting to login, just re-run setup.
- CDP mode is preferred when available because it uses the user's real Chrome session with all extensions and existing logins.
- The browse script auto-detects the connection strategy: tries CDP first, falls back to auth file.
