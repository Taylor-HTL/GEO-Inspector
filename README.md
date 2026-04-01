# 篡改猴脚本开发模板

这个目录已经按“开发 + 调试”的思路初始化好了，直接可用于编写 Tampermonkey/Greasemonkey 脚本。

当前环境确认结果：

- `playwright` skill：已安装
- `playwright-interactive` skill：已安装
- `screenshot` skill：已安装
- `skill-installer`：系统预装
- `npx`：已可用

## 目录说明

- `userscripts/starter.user.js`：篡改猴脚本模板
- `userscripts/deepseek-geo-risk.user.js`：DeepSeek 对话页的 GEO 风险最小实现
- `playwright-cli.json`：Playwright CLI 默认配置
- `output/playwright/`：浏览器调试输出目录

## 快速开始

1. 修改 [userscripts/starter.user.js](/Users/huangtianle/Library/Mobile%20Documents/com~apple~CloudDocs/research/GEO_detection_support/userscripts/starter.user.js) 里的：
   - `@match`
   - `SCRIPT_NAME`
   - `main()` 中的业务逻辑
2. 把脚本导入 Tampermonkey。
3. 打开目标网页，观察控制台输出和页面效果。

如果你现在就要做 DeepSeek 对话页的 GEO 风险侧边栏，优先导入：

- [userscripts/deepseek-geo-risk.user.js](/Users/huangtianle/Library/Mobile%20Documents/com~apple~CloudDocs/research/GEO_detection_support/userscripts/deepseek-geo-risk.user.js)

这个版本已经包含：

- 自动发现最近一次回复中的外部信源
- 抓取网页标题、URL 和 meta description
- 用关键词规则解释 GEO 风险
- 生成“排除高风险信源”的治理提示词
- 用 DeepSeek API 识别最后一次回复中提到的产品/品牌
- 为每个实体补 1 个高质量链接：官网 / Wikipedia / 百度百科
- 生成“优先参考补源链接”的提示词
- 在右侧插入三块侧边栏：高风险信源、GEO Governance、Trusted Source Support

首次使用时：

1. 打开 DeepSeek 对话页
2. 如果要用第三个功能，点击侧边栏右上角 `API`
3. 填入 DeepSeek API Key
4. 点击 `扫描`

注意：

- 当前会严格只分析最近一次助手回复
- DeepSeek API 现在只用于“产品/品牌实体提取”，不参与风险打分
- 风险打分基于标题、URL、描述里的关键词规则
- Trusted Source Support 每个实体最多只保留 1 个补充链接

## 推荐开发方式

### 1. 直接在 Tampermonkey 里迭代

适合先把逻辑跑通。模板里已经带了：

- 可切换的 `DEBUG` 开关
- `waitForElement()` 等待 DOM
- `MutationObserver` 重跑入口
- `markProcessed()` 防止重复处理

### 2. 用 Playwright 辅助调试页面

先设置 skill 脚本路径：

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
```

打开页面并开始调试：

```bash
"$PWCLI" --config playwright-cli.json open https://example.com --headed
"$PWCLI" --config playwright-cli.json snapshot
```

常用命令：

```bash
"$PWCLI" --config playwright-cli.json click e3
"$PWCLI" --config playwright-cli.json fill e4 "test"
"$PWCLI" --config playwright-cli.json eval "document.title"
"$PWCLI" --config playwright-cli.json screenshot
```

提示：

- 每次页面结构变化后，重新执行一次 `snapshot`
- 调试产物统一放在 `output/playwright/`

### 3. 需要长会话调试时

如果你要在同一页面上反复改脚本、保留浏览器状态持续验证，再切到 `playwright-interactive`。

## 模板建议

默认建议保持这几个最小公共面：

- Tampermonkey 元数据头
- 一个主入口函数
- 一个调试开关
- 一个 DOM 等待函数
- 一个 DOM 观察器入口

后续如果你需要，我可以继续在这个模板上帮你补：

- 特定网站的脚本逻辑
- `GM_xmlhttpRequest` 网络封装
- 设置面板
- 自动化回归调试脚本
