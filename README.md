# GEO Inspector

`GEO Inspector` 是一个面向 DeepSeek 对话页的 Tampermonkey 插件原型，用来辅助识别 AI 回答中引用的潜在高风险信源，并为后续回答提供治理提示词和可信补源链接。

当前项目重点是验证一套最小可用的 GEO governance 工作流：

- 抽取最近一次回复中的外部信源
- 基于标题、URL、meta description 做关键词规则风险判断
- 展示高风险信源并解释判断理由
- 生成“排除这些高风险网页”的治理提示词
- 识别回复中提到的产品/品牌
- 为实体补充官网 / Wikipedia / 百度百科中的一个高质量链接
- 生成“优先参考这些可信链接”的补源提示词

## 核心功能

### 1. Risk Source Governance

- 严格只分析 DeepSeek 最近一次助手回复
- 按 DeepSeek 信源编号顺序展示高风险项
- 支持勾选高风险信源
- 自动生成排除型治理提示词
- 支持一键插入聊天框或复制

### 2. Trusted Source Support

- 用 DeepSeek API 识别回复中提到的产品/品牌
- 每个实体只补 1 个链接
- 优先级固定为：官网 > Wikipedia > 百度百科
- 支持勾选补源链接并生成补源提示词

### 3. 可用性交互

- 右侧浮窗可直接拖动
- 支持右下角拖拽缩放
- 自动记住面板位置、尺寸和模块展开状态
- 内容较多时保持稳定滚动，不依赖多层嵌套滚动区

## 安装方式

### 方式一：直接从 GitHub 安装

打开下面这个 raw 链接，Tampermonkey 一般会自动识别安装：

- [安装脚本](https://raw.githubusercontent.com/Taylor-HTL/GEO-Inspector/main/userscripts/deepseek-geo-risk.user.js)

### 方式二：手动安装

1. 安装浏览器扩展 `Tampermonkey`
2. 打开 [userscripts/deepseek-geo-risk.user.js](/Users/huangtianle/Library/Mobile%20Documents/com~apple~CloudDocs/research/GEO_detection_support/userscripts/deepseek-geo-risk.user.js)
3. 复制完整脚本内容
4. 在 Tampermonkey 中新建脚本并覆盖默认模板
5. 保存后打开 `https://chat.deepseek.com/`

## 使用方法

1. 打开 DeepSeek 对话页面
2. 右侧会出现 `GEO Inspector` 面板
3. 点击 `扫描`
4. 如果要启用实体补源功能，点击 `API` 填入你的 DeepSeek API Key
5. 在 `Risk Source Governance` 中勾选高风险信源并生成治理提示词
6. 在 `Trusted Source Support` 中勾选可信链接并生成补源提示词

## 自动更新

脚本头部已经配置：

- `@updateURL`
- `@downloadURL`

只要你通过 GitHub raw 链接安装，后续更新并推送到 `main` 后，Tampermonkey 就可以按它的更新机制检测新版本。

如果你修改了脚本内容，记得同步更新脚本头部的 `@version`。

## 项目结构

- [userscripts/deepseek-geo-risk.user.js](/Users/huangtianle/Library/Mobile%20Documents/com~apple~CloudDocs/research/GEO_detection_support/userscripts/deepseek-geo-risk.user.js)
  DeepSeek GEO Inspector 主脚本
- [userscripts/starter.user.js](/Users/huangtianle/Library/Mobile%20Documents/com~apple~CloudDocs/research/GEO_detection_support/userscripts/starter.user.js)
  通用 userscript 起始模板
- [playwright-cli.json](/Users/huangtianle/Library/Mobile%20Documents/com~apple~CloudDocs/research/GEO_detection_support/playwright-cli.json)
  页面调试配置

## 开发说明

当前版本是偏原型验证的研究工具，判断逻辑以可解释、可演示为优先，不追求完整生产化。

已知特点：

- 风险判断当前是关键词规则，不是完整内容审查
- 实体识别依赖 DeepSeek API
- 官网识别依赖公开网页检索，个别品牌可能需要后续继续优化

如果你要继续演进这个项目，下一步通常值得做的是：

- 优化官网识别准确率
- 引入更细的风险标签体系
- 增加脚本设置面板
- 做移动端/窄屏交互适配

## License

当前仓库未单独附加 License；若后续准备公开协作，建议补一个明确许可证。

