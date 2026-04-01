// ==UserScript==
// @name         DeepSeek GEO Risk Sidebar
// @namespace    https://tampermonkey.net/
// @version      0.5.2
// @description  Review latest DeepSeek answer sources, explain GEO risks, and add trusted source support for mentioned products/brands.
// @author       huangtianle
// @match        https://chat.deepseek.com/*
// @homepageURL  https://github.com/Taylor-HTL/GEO-Inspector
// @supportURL   https://github.com/Taylor-HTL/GEO-Inspector/issues
// @updateURL    https://raw.githubusercontent.com/Taylor-HTL/GEO-Inspector/main/userscripts/deepseek-geo-risk.user.js
// @downloadURL  https://raw.githubusercontent.com/Taylor-HTL/GEO-Inspector/main/userscripts/deepseek-geo-risk.user.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_NAME = "DeepSeek GEO Risk Sidebar";
  const DEBUG = true;
  const PANEL_ID = "geo-risk-sidebar-panel";
  const STYLE_ID = "geo-risk-sidebar-style";
  const STORAGE_KEY_API = "geo.deepseek.apiKey";
  const STORAGE_KEY_PANEL_COLLAPSED = "geo.panelCollapsed";
  const STORAGE_KEY_PANEL_SECTIONS = "geo.panelSections";
  const SCAN_DEBOUNCE_MS = 1800;
  const HIGH_RISK_THRESHOLD = 60;
  const MAX_SOURCES_PER_SCAN = 12;
  const MAX_ENTITIES_PER_SCAN = 12;
  const REQUEST_TIMEOUT_MS = 12000;
  const SCAN_CONCURRENCY = 3;
  const SIDEBAR_EXPANDED_WIDTH = 380;
  const SIDEBAR_COLLAPSED_WIDTH = 56;
  const SIDEBAR_OFFSET_WIDTH = 396;
  const SIDEBAR_COLLAPSED_OFFSET = 64;
  const FIELD_WEIGHTS = {
    title: 40,
    url: 24,
    description: 18,
  };
  const KEYWORD_RULES = [
    { pattern: /评测/i, label: "评测", score: 28, reason: "包含评测词" },
    { pattern: /测评/i, label: "测评", score: 28, reason: "包含测评词" },
    { pattern: /对比/i, label: "对比", score: 26, reason: "包含对比词" },
    { pattern: /横评/i, label: "横评", score: 28, reason: "包含横评词" },
    { pattern: /\breview\b/i, label: "review", score: 28, reason: "包含 review 词" },
    { pattern: /\breviews\b/i, label: "reviews", score: 28, reason: "包含 reviews 词" },
    { pattern: /\bcompare\b/i, label: "compare", score: 26, reason: "包含 compare 词" },
    { pattern: /\bcomparison\b/i, label: "comparison", score: 26, reason: "包含 comparison 词" },
    { pattern: /\bvs\b/i, label: "vs", score: 24, reason: "包含 vs 对比词" },
    { pattern: /推荐/i, label: "推荐", score: 18, reason: "包含推荐词" },
    { pattern: /首选/i, label: "首选", score: 18, reason: "包含首选词" },
    { pattern: /最佳/i, label: "最佳", score: 18, reason: "包含最佳词" },
    { pattern: /排行/i, label: "排行", score: 18, reason: "包含排行词" },
    { pattern: /\bbest\b/i, label: "best", score: 18, reason: "包含 best 词" },
    { pattern: /\btop\b/i, label: "top", score: 16, reason: "包含 top 词" },
  ];
  const REJECT_OFFICIAL_HOST_PATTERNS = [
    /sohu\.com$/i,
    /163\.com$/i,
    /ithome\.com$/i,
    /it168\.com$/i,
    /leiphone\.com$/i,
    /smzdm\.com$/i,
    /techradar\.com$/i,
    /digitaltrends\.com$/i,
    /slashgear\.com$/i,
    /taobao\.com$/i,
    /tmall\.com$/i,
    /jd\.com$/i,
    /amazon\./i,
    /reddit\.com$/i,
    /wikipedia\.org$/i,
    /baike\.baidu\.com$/i,
    /zhihu\.com$/i,
    /weibo\.com$/i,
    /xiaohongshu\.com$/i,
  ];
  const OFFICIAL_HINT_PATTERNS = [
    /官网/i,
    /官方网站/i,
    /\bofficial\b/i,
    /\bofficial site\b/i,
    /\bsite officiel\b/i,
  ];

  const state = {
    panel: null,
    elements: {},
    sourceItems: [],
    entityItems: [],
    resultCache: new Map(),
    entityLinkCache: new Map(),
    lastSourceSignature: "",
    lastEntitySignature: "",
    scanTimer: null,
    scanningSources: false,
    scanningEntities: false,
    selectedRiskUrls: new Set(),
    selectedEntityLinks: new Set(),
    generatedPrompt: "",
    generatedSupportPrompt: "",
    entityStatus: "等待实体识别...",
    viewportHandlerBound: false,
    layoutTargets: [],
  };

  function log(...args) {
    if (!DEBUG) return;
    console.log(`[${SCRIPT_NAME}]`, ...args);
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        timeout: REQUEST_TIMEOUT_MS,
        ...options,
        onload: resolve,
        onerror: reject,
        ontimeout: reject,
      });
    });
  }

  async function requestText(url, options = {}) {
    const response = await gmRequest({
      method: "GET",
      url,
      ...options,
    });

    if (typeof response.status === "number" && response.status >= 400) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.responseText || "";
  }

  async function requestJson(url, options = {}) {
    const text = await requestText(url, options);
    return JSON.parse(text || "{}");
  }

  function safeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function createEntityError(code, message, meta = {}) {
    const error = new Error(message);
    error.code = code;
    error.meta = meta;
    return error;
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text || "{}");
    } catch (error) {
      return null;
    }
  }

  function describeEntityError(error) {
    const code = error?.code || "";
    const message = safeText(error?.message || "");

    if (code === "missing_api_key") {
      return "未配置 API key，无法做实体识别。";
    }
    if (code === "api_auth_failed") {
      return `实体识别失败：DeepSeek API 鉴权失败${message ? `（${message}）` : ""}。`;
    }
    if (code === "api_rate_limited") {
      return `实体识别失败：DeepSeek API 限流${message ? `（${message}）` : ""}。`;
    }
    if (code === "api_http_error") {
      return `实体识别失败：DeepSeek API 请求异常${message ? `（${message}）` : ""}。`;
    }
    if (code === "api_request_failed") {
      return `实体识别失败：DeepSeek API 网络请求失败${message ? `（${message}）` : ""}。`;
    }
    if (code === "api_response_invalid") {
      return "实体识别失败：DeepSeek API 返回了不可解析的响应。";
    }
    if (code === "api_entity_json_invalid") {
      return "实体识别失败：DeepSeek API 返回的实体 JSON 格式不符合预期。";
    }
    if (code === "entity_empty") {
      return "没有识别到明确的产品/品牌实体。";
    }
    if (code === "entity_support_none") {
      return "实体识别成功，但没有找到官网 / Wikipedia / 百度百科链接。";
    }
    if (code === "entity_support_partial") {
      return `实体识别成功，但只有部分实体找到了补充链接（${message}）。`;
    }

    return `实体识别失败：${message || String(error)}`;
  }

  function normalizeUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.href);
      url.hash = "";
      return url.toString();
    } catch (error) {
      return "";
    }
  }

  function extractCitationIndex(value) {
    const text = safeText(value);
    const match = text.match(/(\d+)/);
    return match ? Number(match[1]) : null;
  }

  function getApiKey() {
    return window.localStorage.getItem(STORAGE_KEY_API) || "";
  }

  function setApiKey(value) {
    const trimmed = (value || "").trim();
    if (!trimmed) {
      window.localStorage.removeItem(STORAGE_KEY_API);
      return;
    }

    window.localStorage.setItem(STORAGE_KEY_API, trimmed);
  }

  function promptForApiKey() {
    const current = getApiKey();
    const next = window.prompt(
      "请输入 DeepSeek API Key。该 Key 仅用于“产品/品牌实体提取”，保存在当前浏览器 localStorage 中。",
      current
    );

    if (next === null) return current;

    setApiKey(next);
    updateStatus(next.trim() ? "API Key 已保存。" : "API Key 已清除。");
    return getApiKey();
  }

  function readStorageJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeStorageJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      log("Failed to persist storage state", key, error);
    }
  }

  function loadSidebarCollapsedState() {
    return window.localStorage.getItem(STORAGE_KEY_PANEL_COLLAPSED) === "true";
  }

  function saveSidebarCollapsedState(value) {
    window.localStorage.setItem(STORAGE_KEY_PANEL_COLLAPSED, value ? "true" : "false");
  }

  function clearSidebarCollapsedState() {
    window.localStorage.removeItem(STORAGE_KEY_PANEL_COLLAPSED);
  }

  function loadPanelSections() {
    const stored = readStorageJson(STORAGE_KEY_PANEL_SECTIONS, {});
    return {
      riskGovernanceOpen: stored.riskGovernanceOpen !== false,
      trustedSupportOpen: stored.trustedSupportOpen !== false,
    };
  }

  function savePanelSections() {
    if (!state.elements.riskSection || !state.elements.trustedSection) return;
    writeStorageJson(STORAGE_KEY_PANEL_SECTIONS, {
      riskGovernanceOpen: state.elements.riskSection.open,
      trustedSupportOpen: state.elements.trustedSection.open,
    });
  }

  function clearPanelSections() {
    window.localStorage.removeItem(STORAGE_KEY_PANEL_SECTIONS);
  }

  function updatePanelResponsiveState(panel) {
    if (!panel) return;
    const width = panel.classList.contains("is-collapsed")
      ? SIDEBAR_COLLAPSED_WIDTH
      : SIDEBAR_EXPANDED_WIDTH;
    panel.dataset.layoutSize = width < 430 ? "narrow" : width < 560 ? "medium" : "wide";
  }

  function getTextareaMaxHeight() {
    return Math.min(260, Math.max(132, Math.floor(window.innerHeight * 0.28)));
  }

  function autoResizeTextarea(textarea) {
    if (!textarea) return;
    const maxHeight = getTextareaMaxHeight();
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(110, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function refreshPromptTextareaHeights() {
    autoResizeTextarea(state.elements.promptBox);
    autoResizeTextarea(state.elements.supportPromptBox);
  }

  function bindPromptTextarea(textarea) {
    if (!textarea || textarea.dataset.autoResizeBound === "true") return;
    textarea.dataset.autoResizeBound = "true";
    textarea.addEventListener("input", () => {
      autoResizeTextarea(textarea);
    });
    autoResizeTextarea(textarea);
  }

  function getLayoutTargets() {
    return Array.from(
      new Set(
        [
          document.body,
          document.querySelector("body > div#__next"),
          document.querySelector("body > div"),
          document.querySelector('[role="main"]'),
          document.querySelector("main"),
          document.querySelector("main")?.parentElement,
        ].filter(Boolean)
      )
    );
  }

  function clearPageLayoutOffset() {
    state.layoutTargets.forEach((node) => {
      if (!node) return;
      delete node.dataset.geoSidebarActive;
      node.style.transition = "";
      node.style.paddingRight = "";
      node.style.marginRight = "";
      node.style.width = "";
      node.style.maxWidth = "";
      node.style.boxSizing = "";
    });
    state.layoutTargets = [];
  }

  function applyPageLayoutOffset(collapsed) {
    const offset = collapsed ? SIDEBAR_COLLAPSED_OFFSET : SIDEBAR_OFFSET_WIDTH;
    const targets = getLayoutTargets().filter((node) => node !== state.panel);
    clearPageLayoutOffset();
    document.documentElement.style.setProperty("--geo-sidebar-offset", `${offset}px`);
    targets.forEach((node) => {
      node.dataset.geoSidebarActive = "true";
      node.style.transition = "padding-right 180ms ease, margin-right 180ms ease, width 180ms ease";
      node.style.boxSizing = "border-box";

      if (node === document.body) {
        node.style.paddingRight = `${offset}px`;
        return;
      }

      if (node.tagName === "MAIN") {
        node.style.marginRight = `${offset}px`;
        node.style.maxWidth = `calc(100% - ${offset}px)`;
        return;
      }

      node.style.paddingRight = `${offset}px`;
    });
    state.layoutTargets = targets;
  }

  function applySidebarState() {
    if (!state.panel) return;
    const collapsed = loadSidebarCollapsedState();
    state.panel.classList.toggle("is-collapsed", collapsed);
    state.panel.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (state.elements.collapseButton) {
      state.elements.collapseButton.textContent = collapsed ? "展开" : "收起";
      state.elements.collapseButton.setAttribute("aria-label", collapsed ? "展开侧边栏" : "收起侧边栏");
    }
    updatePanelResponsiveState(state.panel);
    applyPageLayoutOffset(collapsed);
    refreshPromptTextareaHeights();
  }

  function toggleSidebarCollapsed() {
    const next = !loadSidebarCollapsedState();
    saveSidebarCollapsedState(next);
    applySidebarState();
  }

  function resetSidebarState() {
    clearSidebarCollapsedState();
    clearPanelSections();
    if (state.elements.riskSection) {
      state.elements.riskSection.open = true;
    }
    if (state.elements.trustedSection) {
      state.elements.trustedSection.open = true;
    }
    savePanelSections();
    applySidebarState();
    refreshPromptTextareaHeights();
    updateStatus("GEO 侧边栏状态已重置。");
  }

  function getRootContainer() {
    return (
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.body
    );
  }

  function isLikelySourceLink(anchor) {
    if (!anchor) return false;
    if (anchor.closest(`#${PANEL_ID}`)) return false;
    if (anchor.closest("header, nav, footer, aside, form")) return false;
    if (anchor.closest("button, [role='button']")) return false;

    const href = normalizeUrl(anchor.getAttribute("href") || "");
    if (!href) return false;

    let parsed;
    try {
      parsed = new URL(href);
    } catch (error) {
      return false;
    }

    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (parsed.hostname.includes("deepseek.com")) return false;

    const text = safeText(anchor.textContent);
    const title = safeText(anchor.getAttribute("title"));
    const ariaLabel = safeText(anchor.getAttribute("aria-label"));
    const label = text || title || ariaLabel;
    const isNumericMarker = /^[-–—]?\s*\d+$/.test(label);

    if (isNumericMarker && !anchor.closest(".ds-markdown")) return false;
    if (!label && parsed.pathname === "/") return false;

    return true;
  }

  function hasCitationLikeContext(anchor) {
    if (!anchor) return false;

    const text = safeText(anchor.textContent);
    const title = safeText(anchor.getAttribute("title"));
    const ariaLabel = safeText(anchor.getAttribute("aria-label"));
    const joined = `${text} ${title} ${ariaLabel}`;
    const parentText = safeText(anchor.parentElement?.textContent);
    const surroundingText = safeText(anchor.closest("p, li, div, span")?.textContent);

    if (/^\[\d+\]$/.test(text)) return true;
    if (/^[-–—]?\s*\d+$/.test(text)) return true;
    if (/^\[\d+\]$/.test(title)) return true;
    if (/^\[\d+\]$/.test(ariaLabel)) return true;
    if (anchor.closest("sup")) return true;
    if (/\[\d+\]/.test(parentText)) return true;
    if (/\[\d+\]/.test(surroundingText)) return true;
    if (/source|sources|reference|references|citation|引用|参考|信源/i.test(joined)) return true;

    return false;
  }

  function getLatestDeepSeekAssistantMessage() {
    const messages = Array.from(document.querySelectorAll(".ds-message._63c77b1")).filter(
      (node) =>
        !node.closest(`#${PANEL_ID}`) &&
        !node.classList.contains("d29f3d7d")
    );

    return messages.length > 0 ? messages[messages.length - 1] : null;
  }

  function getLatestAssistantAnswerText() {
    const message = getLatestDeepSeekAssistantMessage();
    if (!message) return "";

    const markdown = message.querySelector(".ds-markdown");
    return safeText((markdown || message).textContent);
  }

  function getLatestRelevantAnchors(root) {
    const latestAssistant = getLatestDeepSeekAssistantMessage();
    if (latestAssistant) {
      const anchors = Array.from(
        latestAssistant.querySelectorAll(".ds-markdown a[href^='http']")
      ).filter(isLikelySourceLink);

      if (anchors.length > 0) {
        return anchors;
      }
    }

    return Array.from(root.querySelectorAll('a[href^="http"]')).filter(isLikelySourceLink);
  }

  function createSourceLabel(anchor, url) {
    const parsed = new URL(url);
    const text = safeText(anchor.textContent);
    const title = safeText(anchor.getAttribute("title"));
    const ariaLabel = safeText(anchor.getAttribute("aria-label"));
    const fallback = parsed.hostname.replace(/^www\./, "");
    const label = text || title || ariaLabel || fallback;
    const marker = label.replace(/\s+/g, "");
    const citationIndex = extractCitationIndex(marker);

    if (/^\[\d+\]$/.test(label) || /^-\d+$/.test(marker) || /^\d+$/.test(marker)) {
      return citationIndex ? `信源 ${citationIndex} · ${fallback}` : fallback;
    }

    return label;
  }

  function collectSources() {
    const root = getRootContainer();
    const anchors = getLatestRelevantAnchors(root);
    const citationAnchors = anchors.filter(hasCitationLikeContext);
    const targetAnchors = citationAnchors.length > 0 ? citationAnchors : anchors;
    const byUrl = new Map();

    targetAnchors.forEach((anchor, index) => {
      const url = normalizeUrl(anchor.href);
      if (!url || byUrl.has(url)) return;

      byUrl.set(url, {
        id: `source-${index + 1}`,
        url,
        label: createSourceLabel(anchor, url),
        domain: new URL(url).hostname.replace(/^www\./, ""),
        citationIndex: extractCitationIndex(anchor.textContent) ?? index + 1,
      });
    });

    return Array.from(byUrl.values()).slice(0, MAX_SOURCES_PER_SCAN);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        display: flex;
        flex-direction: column;
        top: 0;
        right: 0;
        width: ${SIDEBAR_EXPANDED_WIDTH}px;
        height: 100vh;
        height: 100dvh;
        max-height: 100vh;
        max-height: 100dvh;
        overflow-x: hidden;
        overflow-y: auto;
        z-index: 999999;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 0;
        border-right: 0;
        border-top: 0;
        border-bottom: 0;
        background: rgba(15, 23, 42, 0.94);
        color: #e5edf7;
        box-shadow: -16px 0 40px rgba(0, 0, 0, 0.22);
        backdrop-filter: blur(12px);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        transition: width 180ms ease, transform 180ms ease;
        overscroll-behavior: contain;
        overscroll-behavior-y: contain;
        -webkit-overflow-scrolling: touch;
      }

      #${PANEL_ID} * {
        box-sizing: border-box;
      }

      #${PANEL_ID} a {
        color: #9fd6ff;
        text-decoration: none;
      }

      #${PANEL_ID} a:hover {
        text-decoration: underline;
      }

      #${PANEL_ID} .geo-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        user-select: none;
        position: sticky;
        top: 0;
        z-index: 2;
        background: rgba(15, 23, 42, 0.96);
        backdrop-filter: blur(12px);
      }

      #${PANEL_ID} .geo-panel-title {
        font-size: 15px;
        font-weight: 700;
      }

      #${PANEL_ID} .geo-panel-subtitle {
        margin-top: 4px;
        color: #95a4bc;
        font-size: 12px;
      }

      #${PANEL_ID} .geo-panel-hint {
        margin-top: 4px;
        color: #6fb8ff;
        font-size: 11px;
      }

      #${PANEL_ID} .geo-panel-actions {
        display: flex;
        gap: 8px;
      }

      #${PANEL_ID} .geo-btn {
        border: 0;
        border-radius: 10px;
        padding: 8px 10px;
        min-width: 0;
        min-height: 38px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        white-space: normal;
        line-height: 1.25;
        cursor: pointer;
        background: #1f2937;
        color: #e5edf7;
        font-size: 12px;
      }

      #${PANEL_ID} .geo-btn:hover {
        background: #273446;
      }

      #${PANEL_ID} .geo-btn-primary {
        background: linear-gradient(135deg, #0ea5e9, #2563eb);
      }

      #${PANEL_ID} .geo-btn-primary:hover {
        filter: brightness(1.08);
      }

      #${PANEL_ID} .geo-status {
        flex: 0 0 auto;
        padding: 10px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        color: #b8c6da;
        position: sticky;
        top: 74px;
        z-index: 1;
        background: rgba(15, 23, 42, 0.96);
        backdrop-filter: blur(12px);
      }

      #${PANEL_ID} .geo-panel-body {
        flex: 0 0 auto;
        min-height: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow-x: hidden;
        overflow-y: visible;
        padding: 12px 14px calc(32px + env(safe-area-inset-bottom, 0px));
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        -webkit-overflow-scrolling: touch;
        touch-action: pan-y;
        overscroll-behavior-y: contain;
      }

      #${PANEL_ID}.is-collapsed {
        width: ${SIDEBAR_COLLAPSED_WIDTH}px;
      }

      #${PANEL_ID}.is-collapsed .geo-panel-subtitle,
      #${PANEL_ID}.is-collapsed .geo-panel-hint,
      #${PANEL_ID}.is-collapsed .geo-status,
      #${PANEL_ID}.is-collapsed .geo-panel-body,
      #${PANEL_ID}.is-collapsed .geo-panel-actions .geo-btn:not([data-action="toggle-sidebar"]) {
        display: none !important;
      }

      #${PANEL_ID}.is-collapsed .geo-panel-header {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        padding: 12px 10px;
      }

      #${PANEL_ID}.is-collapsed .geo-panel-title {
        writing-mode: vertical-rl;
        text-orientation: mixed;
        font-size: 14px;
        margin: 0 auto;
      }

      #${PANEL_ID}.is-collapsed .geo-panel-actions {
        justify-content: center;
      }

      #${PANEL_ID}.is-collapsed .geo-panel-actions .geo-btn[data-action="toggle-sidebar"] {
        width: 100%;
      }

      #${PANEL_ID}.is-collapsed .geo-status {
        top: 0;
      }

      #${PANEL_ID} details {
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
        overflow: hidden;
      }

      #${PANEL_ID} details + details {
        margin-top: 0;
      }

      #${PANEL_ID} summary {
        list-style: none;
        cursor: pointer;
        padding: 12px 12px;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      #${PANEL_ID} summary::-webkit-details-marker {
        display: none;
      }

      #${PANEL_ID} .geo-summary-meta {
        color: #fca5a5;
        font-size: 12px;
      }

      #${PANEL_ID} .geo-module-content {
        padding: 0 12px 12px;
      }

      #${PANEL_ID} .geo-module-section + .geo-module-section {
        margin-top: 12px;
      }

      #${PANEL_ID} .geo-section-title {
        font-size: 12px;
        font-weight: 700;
        color: #d7e3f4;
      }

      #${PANEL_ID} .geo-risk-list,
      #${PANEL_ID} .geo-entity-list {
        margin-top: 10px;
      }

      #${PANEL_ID} .geo-risk-item,
      #${PANEL_ID} .geo-entity-item {
        padding: 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        margin-left: 0;
        margin-right: 0;
      }

      #${PANEL_ID} .geo-risk-item {
        background: rgba(239, 68, 68, 0.08);
        border-color: rgba(248, 113, 113, 0.24);
      }

      #${PANEL_ID} .geo-risk-item + .geo-risk-item,
      #${PANEL_ID} .geo-entity-item + .geo-entity-item {
        margin-top: 10px;
      }

      #${PANEL_ID} .geo-risk-topline,
      #${PANEL_ID} .geo-entity-topline {
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }

      #${PANEL_ID} .geo-select {
        flex: 0 0 auto;
        width: 16px;
        height: 16px;
        margin: 2px 0 0;
        align-self: flex-start;
      }

      #${PANEL_ID} .geo-risk-main,
      #${PANEL_ID} .geo-entity-main {
        flex: 1;
        min-width: 0;
        margin-left: 0;
      }

      #${PANEL_ID} .geo-risk-title,
      #${PANEL_ID} .geo-entity-title {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        font-weight: 600;
      }

      #${PANEL_ID} .geo-risk-link,
      #${PANEL_ID} .geo-entity-link {
        display: -webkit-box;
        overflow: hidden;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        word-break: break-word;
      }

      #${PANEL_ID} .geo-risk-score {
        color: #fca5a5;
        font-size: 12px;
        white-space: nowrap;
      }

      #${PANEL_ID} .geo-risk-domain,
      #${PANEL_ID} .geo-entity-meta {
        margin-top: 4px;
        color: #93a3b8;
        font-size: 12px;
        word-break: break-word;
        padding-left: 0;
      }

      #${PANEL_ID} .geo-risk-reason,
      #${PANEL_ID} .geo-entity-reason {
        margin-top: 8px;
        color: #f8fafc;
      }

      #${PANEL_ID} .geo-signals {
        margin-top: 8px;
        padding-left: 16px;
        color: #cbd5e1;
      }

      #${PANEL_ID} .geo-empty {
        padding: 14px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.03);
        color: #b8c6da;
      }

      #${PANEL_ID} .geo-governance,
      #${PANEL_ID} .geo-support {
        padding: 0;
      }

      #${PANEL_ID} .geo-actions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-top: 12px;
        align-items: stretch;
      }

      #${PANEL_ID} .geo-prompt {
        width: 100%;
        min-height: 110px;
        margin-top: 12px;
        padding: 10px 12px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.75);
        color: #e5edf7;
        resize: none;
        overflow-y: hidden;
        font: inherit;
      }

      #${PANEL_ID} .geo-mini {
        color: #9aa9bd;
        font-size: 12px;
      }

      #${PANEL_ID} .geo-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        color: #d9e5f3;
        font-size: 11px;
        white-space: nowrap;
      }

      #${PANEL_ID} .geo-badge-none {
        color: #9aa9bd;
      }

      #${PANEL_ID}[data-layout-size="medium"]:not(.is-collapsed) .geo-actions {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      #${PANEL_ID}[data-layout-size="narrow"]:not(.is-collapsed) .geo-actions {
        grid-template-columns: minmax(0, 1fr);
      }

      main[data-geo-sidebar-active="true"] {
        box-sizing: border-box;
      }
    `;

    document.head.appendChild(style);
  }

  function renderPanel() {
    ensureStyles();

    if (document.getElementById(PANEL_ID)) return;
    const sectionState = loadPanelSections();

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="geo-panel-header">
        <div>
          <div class="geo-panel-title">GEO Inspector</div>
          <div class="geo-panel-subtitle">DeepSeek 最近一次回复的信源风险扫描</div>
          <div class="geo-panel-hint">右侧侧边栏，可折叠收起</div>
        </div>
        <div class="geo-panel-actions">
          <button type="button" class="geo-btn" data-action="toggle-sidebar">收起</button>
          <button type="button" class="geo-btn" data-action="config-api">API</button>
          <button type="button" class="geo-btn geo-btn-primary" data-action="scan-all">扫描</button>
        </div>
      </div>
      <div class="geo-status" data-role="status">等待发现信源...</div>
      <div class="geo-panel-body">
        <details data-role="risk-section" ${sectionState.riskGovernanceOpen ? "open" : ""}>
          <summary>
            <span>Risk Source Governance</span>
            <span class="geo-summary-meta" data-role="risk-governance-meta">0 个高风险 · 已选 0 个</span>
          </summary>
          <div class="geo-module-content">
            <div class="geo-module-section">
              <div class="geo-section-title">高风险信源</div>
              <div class="geo-mini">识别最近一次回复中的高风险信源，并给出关键词规则判断理由。</div>
              <div class="geo-risk-list" data-role="risk-list"></div>
            </div>
            <div class="geo-module-section geo-governance">
              <div class="geo-section-title">治理提示词</div>
              <div class="geo-mini">勾选高风险信源后，生成排除型治理提示词并插入聊天框或复制。</div>
              <textarea class="geo-prompt" data-role="prompt-box" placeholder="这里会生成治理提示词。"></textarea>
              <div class="geo-actions">
                <button type="button" class="geo-btn" data-action="generate-prompt">生成提示词</button>
                <button type="button" class="geo-btn" data-action="insert-prompt">插入聊天框</button>
                <button type="button" class="geo-btn" data-action="copy-prompt">复制提示词</button>
              </div>
            </div>
          </div>
        </details>
        <details data-role="trusted-section" ${sectionState.trustedSupportOpen ? "open" : ""}>
          <summary>
            <span>Trusted Source Support</span>
            <span class="geo-summary-meta" data-role="entity-selection-count">已选 0 个</span>
          </summary>
          <div class="geo-module-content geo-support">
            <div class="geo-module-section">
              <div class="geo-section-title">可信补源</div>
              <div class="geo-mini">识别最后一次回复中提到的产品/品牌，并补充官网 / Wikipedia / 百度百科链接。</div>
              <div class="geo-entity-list" data-role="entity-list"></div>
            </div>
            <div class="geo-module-section">
              <div class="geo-section-title">补源提示词</div>
              <textarea class="geo-prompt" data-role="support-prompt-box" placeholder="这里会生成补源提示词。"></textarea>
              <div class="geo-actions">
                <button type="button" class="geo-btn" data-action="generate-support-prompt">生成补源提示词</button>
                <button type="button" class="geo-btn" data-action="insert-support-prompt">插入聊天框</button>
                <button type="button" class="geo-btn" data-action="copy-support-prompt">复制提示词</button>
              </div>
            </div>
          </div>
        </details>
      </div>
    `;

    document.body.appendChild(panel);
    state.panel = panel;
    state.elements.status = panel.querySelector('[data-role="status"]');
    state.elements.riskList = panel.querySelector('[data-role="risk-list"]');
    state.elements.riskGovernanceMeta = panel.querySelector('[data-role="risk-governance-meta"]');
    state.elements.promptBox = panel.querySelector('[data-role="prompt-box"]');
    state.elements.entityList = panel.querySelector('[data-role="entity-list"]');
    state.elements.entitySelectionCount = panel.querySelector('[data-role="entity-selection-count"]');
    state.elements.supportPromptBox = panel.querySelector('[data-role="support-prompt-box"]');
    state.elements.riskSection = panel.querySelector('[data-role="risk-section"]');
    state.elements.trustedSection = panel.querySelector('[data-role="trusted-section"]');
    state.elements.collapseButton = panel.querySelector('[data-action="toggle-sidebar"]');

    bindPromptTextarea(state.elements.promptBox);
    bindPromptTextarea(state.elements.supportPromptBox);
    applySidebarState();
    panel.addEventListener("wheel", (event) => {
      event.stopPropagation();
    }, { passive: true });

    panel.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;

      const action = button.getAttribute("data-action");
      if (action === "toggle-sidebar") {
        toggleSidebarCollapsed();
        return;
      }
      if (action === "config-api") {
        promptForApiKey();
        return;
      }
      if (action === "scan-all") {
        scanAll({ force: true });
        return;
      }
      if (action === "generate-prompt") {
        generateGovernancePrompt();
        return;
      }
      if (action === "insert-prompt") {
        insertPromptIntoChat();
        return;
      }
      if (action === "copy-prompt") {
        copyPromptToClipboard();
        return;
      }
      if (action === "generate-support-prompt") {
        generateSupportPrompt();
        return;
      }
      if (action === "insert-support-prompt") {
        insertSupportPromptIntoChat();
        return;
      }
      if (action === "copy-support-prompt") {
        copySupportPromptToClipboard();
      }
    });

    panel.addEventListener("change", (event) => {
      const riskCheckbox = event.target.closest("input[data-role='risk-select']");
      if (riskCheckbox) {
        if (riskCheckbox.checked) {
          state.selectedRiskUrls.add(riskCheckbox.value);
        } else {
          state.selectedRiskUrls.delete(riskCheckbox.value);
        }
        updateSelectionSummary();
        return;
      }

      const entityCheckbox = event.target.closest("input[data-role='entity-select']");
      if (entityCheckbox) {
        if (entityCheckbox.checked) {
          state.selectedEntityLinks.add(entityCheckbox.value);
        } else {
          state.selectedEntityLinks.delete(entityCheckbox.value);
        }
        updateEntitySelectionSummary();
      }
    });

    state.elements.riskSection?.addEventListener("toggle", savePanelSections);
    state.elements.trustedSection?.addEventListener("toggle", savePanelSections);

    if (!state.viewportHandlerBound) {
      const handleViewportChange = () => {
        applySidebarState();
      };
      window.addEventListener("resize", handleViewportChange);
      window.addEventListener("orientationchange", handleViewportChange);
      state.viewportHandlerBound = true;
    }
  }

  function updateStatus(message) {
    if (!state.elements.status) return;
    state.elements.status.textContent = message;
  }

  function getSortedHighRiskItems() {
    return state.sourceItems
      .filter((item) => item.analysis && item.analysis.riskScore >= HIGH_RISK_THRESHOLD)
      .sort((a, b) => {
        const aIndex = Number.isFinite(a.citationIndex) ? a.citationIndex : Number.MAX_SAFE_INTEGER;
        const bIndex = Number.isFinite(b.citationIndex) ? b.citationIndex : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return a.url.localeCompare(b.url);
      });
  }

  function syncSelectedRiskUrls(highRiskItems) {
    const available = new Set(highRiskItems.map((item) => item.url));

    if (state.selectedRiskUrls.size === 0 && highRiskItems.length > 0) {
      highRiskItems.forEach((item) => state.selectedRiskUrls.add(item.url));
      return;
    }

    Array.from(state.selectedRiskUrls).forEach((url) => {
      if (!available.has(url)) {
        state.selectedRiskUrls.delete(url);
      }
    });
  }

  function updateSelectionSummary() {
    if (!state.elements.riskGovernanceMeta) return;
    const highRiskCount = getSortedHighRiskItems().length;
    state.elements.riskGovernanceMeta.textContent = `${highRiskCount} 个高风险 · 已选 ${state.selectedRiskUrls.size} 个`;
  }

  function renderHighRiskList() {
    const list = state.elements.riskList;
    if (!list) return;

    list.innerHTML = "";
    const highRiskItems = getSortedHighRiskItems();
    syncSelectedRiskUrls(highRiskItems);
    updateSelectionSummary();

    if (highRiskItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "geo-empty";
      empty.textContent = state.sourceItems.length
        ? "当前没有被判为高风险的信源。"
        : "还没有发现可分析的信源链接。";
      list.appendChild(empty);
      refreshPromptTextareaHeights();
      return;
    }

    highRiskItems.forEach((item) => {
      const container = document.createElement("div");
      container.className = "geo-risk-item";

      const topLine = document.createElement("div");
      topLine.className = "geo-risk-topline";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "geo-select";
      checkbox.value = item.url;
      checkbox.checked = state.selectedRiskUrls.has(item.url);
      checkbox.setAttribute("data-role", "risk-select");

      const main = document.createElement("div");
      main.className = "geo-risk-main";

      const titleRow = document.createElement("div");
      titleRow.className = "geo-risk-title";

      const link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.className = "geo-risk-link";
      const preferredTitle = safeText(item.analysis.sourceTitle);
      link.textContent =
        preferredTitle && !/^信源\s+\d+\s+[·.]?\s*/.test(preferredTitle)
          ? preferredTitle
          : item.label;

      const score = document.createElement("span");
      score.className = "geo-risk-score";
      score.textContent = `风险分 ${item.analysis.riskScore}`;

      titleRow.appendChild(link);
      titleRow.appendChild(score);

      const domain = document.createElement("div");
      domain.className = "geo-risk-domain";
      domain.textContent = `信源 ${item.citationIndex || "?"} · ${item.domain}`;

      const reason = document.createElement("div");
      reason.className = "geo-risk-reason";
      reason.textContent = item.analysis.summary;

      main.appendChild(titleRow);
      main.appendChild(domain);
      main.appendChild(reason);

      if (Array.isArray(item.analysis.signals) && item.analysis.signals.length > 0) {
        const signalList = document.createElement("ul");
        signalList.className = "geo-signals";

        item.analysis.signals.slice(0, 4).forEach((signal) => {
          const signalItem = document.createElement("li");
          signalItem.textContent = signal;
          signalList.appendChild(signalItem);
        });

        main.appendChild(signalList);
      }

      topLine.appendChild(checkbox);
      topLine.appendChild(main);
      container.appendChild(topLine);
      list.appendChild(container);
    });

    refreshPromptTextareaHeights();
  }

  function pickMeta(doc, selectors) {
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const value = safeText(node?.getAttribute("content"));
      if (value) return value;
    }

    return "";
  }

  function pickFirstText(doc, selectors) {
    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      const value = safeText(node?.textContent);
      if (value) return value;
    }

    return "";
  }

  async function fetchSourceSnapshot(source) {
    try {
      const html = await requestText(source.url, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
        },
      });

      const doc = new DOMParser().parseFromString(html, "text/html");
      const sourceTitle =
        safeText(doc.title) ||
        pickMeta(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
        pickMeta(doc, ['meta[name="apple-mobile-web-app-title"]']) ||
        pickFirstText(doc, ["article h1", "main h1", "h1", ".title", "[class*='title'] h1"]) ||
        source.label;
      const description = pickMeta(doc, [
        'meta[name="description"]',
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
      ]);

      return {
        ok: true,
        sourceTitle,
        description,
      };
    } catch (error) {
      log("Failed to fetch source", source.url, error);
      return {
        ok: false,
        sourceTitle: source.label,
        description: "",
        error: error?.message || String(error),
      };
    }
  }

  function getKeywordMatchesByField(source, snapshot) {
    const fields = {
      title: safeText(snapshot?.sourceTitle),
      url: safeText(source.url),
      description: safeText(snapshot?.description),
    };

    return Object.entries(fields).flatMap(([field, value]) => {
      if (!value) return [];

      return KEYWORD_RULES
        .filter((rule) => rule.pattern.test(value))
        .map((rule) => ({
          field,
          fieldLabel: field === "title" ? "标题" : field === "url" ? "URL" : "描述",
          keyword: rule.label,
          score: rule.score + FIELD_WEIGHTS[field],
          reason: `${field === "title" ? "标题" : field === "url" ? "URL" : "描述"}${rule.reason}`,
        }));
    });
  }

  function analyzeSourceWithRules(source, snapshot) {
    const matches = getKeywordMatchesByField(source, snapshot);
    const strongestMatches = matches.sort((a, b) => b.score - a.score).slice(0, 4);
    const uniqueReasons = [...new Set(strongestMatches.map((item) => item.reason))];
    const rawScore = strongestMatches.reduce((sum, item) => sum + item.score, 0);
    const riskScore = Math.max(0, Math.min(100, rawScore));
    const riskLevel =
      riskScore >= HIGH_RISK_THRESHOLD ? "high" : riskScore >= 35 ? "medium" : "low";

    return {
      riskLevel,
      riskScore,
      summary:
        uniqueReasons.length > 0
          ? `依据关键词规则判定：${uniqueReasons.slice(0, 2).join("，")}。`
          : "标题、URL、描述中未命中高风险关键词。",
      signals:
        strongestMatches.length > 0
          ? strongestMatches.map((item) => `${item.fieldLabel}命中“${item.keyword}”`)
          : ["未命中预设的高风险关键词"],
      sourceTitle: snapshot.sourceTitle || source.label,
      confidence: strongestMatches.length > 0 ? "high" : "medium",
    };
  }

  async function analyzeSingleSource(source, { force = false } = {}) {
    const cached = !force ? state.resultCache.get(source.url) : null;
    if (cached) return cached;

    const snapshot = await fetchSourceSnapshot(source);
    const analysis = analyzeSourceWithRules(source, snapshot);
    const result = {
      ...source,
      analysis,
    };

    state.resultCache.set(source.url, result);
    return result;
  }

  function buildSourceSignature(items) {
    return items.map((item) => `${item.citationIndex}:${item.url}`).join("\n");
  }

  async function runWithConcurrency(items, concurrency, worker) {
    const queue = [...items];

    async function consume() {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) return;
        await worker(item);
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => consume()
    );

    await Promise.all(workers);
  }

  function renderDiscoverySummary() {
    const highRiskCount = getSortedHighRiskItems().length;
    if (state.scanningSources) return;

    if (state.sourceItems.length === 0) {
      updateStatus("当前页面还没有发现可分析的外部信源。");
      return;
    }

    updateStatus(`已发现 ${state.sourceItems.length} 个信源，高风险 ${highRiskCount} 个。`);
  }

  async function scanSources({ force = false } = {}) {
    if (state.scanningSources) return;

    const sources = collectSources();
    const signature = buildSourceSignature(sources);
    if (!force && signature === state.lastSourceSignature && state.sourceItems.length > 0) {
      renderDiscoverySummary();
      renderHighRiskList();
      return;
    }

    state.lastSourceSignature = signature;
    if (force) {
      sources.forEach((source) => state.resultCache.delete(source.url));
    }

    state.sourceItems = sources.map((source) => state.resultCache.get(source.url) || source);
    renderHighRiskList();

    if (sources.length === 0) {
      updateStatus("当前页面还没有发现最近一次回复的信源。");
      return;
    }

    state.scanningSources = true;

    try {
      let finished = 0;
      await runWithConcurrency(sources, SCAN_CONCURRENCY, async (source) => {
        const index = sources.findIndex((item) => item.url === source.url);
        updateStatus(`正在分析 ${finished + 1}/${sources.length}: 信源 ${source.citationIndex || "?"}`);

        try {
          state.sourceItems[index] = await analyzeSingleSource(source, { force });
        } catch (error) {
          state.sourceItems[index] = {
            ...source,
            analysis: {
              riskLevel: "medium",
              riskScore: 35,
              summary: `规则分析失败：${error?.message || String(error)}`,
              signals: ["网页抓取失败，无法完成标题/描述关键词分析"],
              sourceTitle: source.label,
              confidence: "low",
            },
          };
        }

        finished += 1;
        renderHighRiskList();
        updateStatus(`已完成 ${finished}/${sources.length} 个信源分析...`);
      });
    } finally {
      state.scanningSources = false;
      renderDiscoverySummary();
    }
  }

  function extractJsonObject(text) {
    if (!text) return null;

    const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (error) {
      return null;
    }
  }

  async function extractEntitiesFromLatestAnswer(text) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw createEntityError("missing_api_key", "未配置 API key");
    }

    let response;
    try {
      response = await gmRequest({
        method: "POST",
        url: "https://api.deepseek.com/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        data: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "你是一个信息抽取器。只从给定文本中提取明确提到的产品或品牌实体。产品优先于品牌；如果已经有具体产品，不要再单独返回对应品牌。不要返回泛称如智能手环、手表、设备。按首次出现顺序输出，去重。只返回 JSON。",
            },
            {
              role: "user",
              content: [
                '请提取文本中的实体并返回 JSON，schema 为 {"entities":[{"name":"实体名","type":"product|brand","mentionText":"原文片段"}]}。',
                "",
                text,
              ].join("\n"),
            },
          ],
        }),
      });
    } catch (error) {
      throw createEntityError("api_request_failed", error?.message || String(error));
    }

    const payload = safeJsonParse(response.responseText || "{}");
    if (!payload) {
      throw createEntityError("api_response_invalid", "响应不是合法 JSON");
    }

    if (response.status === 401 || response.status === 403) {
      const detail = safeText(payload?.error?.message || payload?.message || "");
      throw createEntityError("api_auth_failed", detail || `HTTP ${response.status}`);
    }
    if (response.status === 429) {
      const detail = safeText(payload?.error?.message || payload?.message || "");
      throw createEntityError("api_rate_limited", detail || "HTTP 429");
    }
    if (typeof response.status === "number" && response.status >= 400) {
      const detail = safeText(payload?.error?.message || payload?.message || "");
      throw createEntityError("api_http_error", detail || `HTTP ${response.status}`);
    }

    const content = payload?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(content);
    if (!parsed) {
      throw createEntityError("api_entity_json_invalid", "DeepSeek 返回了不可解析的实体 JSON");
    }

    const entities = normalizeExtractedEntities(parsed.entities || []);
    if (entities.length === 0) {
      throw createEntityError("entity_empty", "没有识别到产品/品牌");
    }

    return entities;
  }

  function normalizeExtractedEntities(items) {
    const normalized = [];
    const byName = new Map();

    items.forEach((item, index) => {
      const name = safeText(item?.name);
      const type = item?.type === "brand" ? "brand" : "product";
      const mentionText = safeText(item?.mentionText || name);
      if (!name) return;
      if (/^(智能手环|手环|手表|设备|穿戴设备|产品)$/i.test(name)) return;

      const existing = byName.get(name);
      if (!existing) {
        const entity = {
          entityName: name,
          entityType: type,
          mentionText,
          order: index + 1,
        };
        normalized.push(entity);
        byName.set(name, entity);
        return;
      }

      if (existing.entityType === "brand" && type === "product") {
        existing.entityType = "product";
        existing.mentionText = mentionText || existing.mentionText;
      }
    });

    const productNames = new Set(
      normalized.filter((item) => item.entityType === "product").map((item) => item.entityName.toLowerCase())
    );

    return normalized
      .filter((item) => {
        if (item.entityType !== "brand") return true;
        return !Array.from(productNames).some((product) => product.includes(item.entityName.toLowerCase()));
      })
      .slice(0, MAX_ENTITIES_PER_SCAN);
  }

  function buildEntitySignature(text) {
    return text.slice(0, 6000);
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function getHostname(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (error) {
      return "";
    }
  }

  function normalizeEntityNameForCompare(value) {
    return safeText(value)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function looksLikeOfficialCandidate(entity, candidate) {
    const hostname = getHostname(candidate.url);
    if (!hostname) return false;
    if (REJECT_OFFICIAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) return false;

    const haystack = `${candidate.title} ${candidate.snippet} ${hostname}`;
    const normalizedEntity = normalizeEntityNameForCompare(entity.entityName);
    const normalizedHaystack = normalizeEntityNameForCompare(haystack);
    const hasEntityMatch = normalizedEntity && normalizedHaystack.includes(normalizedEntity);
    const hasOfficialHint = OFFICIAL_HINT_PATTERNS.some((pattern) => pattern.test(haystack));
    const hasBrandishDomain = normalizedEntity && hostname.replace(/[.\-]/g, "").includes(normalizedEntity);

    return (hasEntityMatch && hasOfficialHint) || hasBrandishDomain;
  }

  async function searchBing(query) {
    const html = await requestText(`https://www.bing.com/search?q=${encodeURIComponent(query)}`);
    const doc = parseHtml(html);
    return Array.from(doc.querySelectorAll("li.b_algo")).map((node) => {
      const link = node.querySelector("h2 a");
      const title = safeText(link?.textContent);
      const url = normalizeUrl(link?.href || "");
      const snippet = safeText(node.querySelector(".b_caption")?.textContent);
      return { title, url, snippet };
    }).filter((item) => item.url);
  }

  async function resolveOfficialLink(entity) {
    const queries = [`${entity.entityName} 官网`, `${entity.entityName} official site`];

    for (const query of queries) {
      try {
        const candidates = await searchBing(query);
        const match = candidates.find((candidate) => looksLikeOfficialCandidate(entity, candidate));
        if (match) {
          return {
            entityName: entity.entityName,
            entityType: entity.entityType,
            sourceType: "official",
            url: match.url,
            title: match.title || entity.entityName,
            order: entity.order,
            mentionText: entity.mentionText,
          };
        }
      } catch (error) {
        log("Official search failed", entity.entityName, query, error);
      }
    }

    return null;
  }

  async function resolveWikipediaLink(entity) {
    const endpoints = [
      `https://zh.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(entity.entityName)}&limit=1&namespace=0&format=json`,
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(entity.entityName)}&limit=1&namespace=0&format=json`,
    ];

    for (const endpoint of endpoints) {
      try {
        const payload = await requestJson(endpoint);
        const titles = Array.isArray(payload?.[1]) ? payload[1] : [];
        const urls = Array.isArray(payload?.[3]) ? payload[3] : [];
        if (titles[0] && urls[0]) {
          return {
            entityName: entity.entityName,
            entityType: entity.entityType,
            sourceType: "wikipedia",
            url: normalizeUrl(urls[0]),
            title: titles[0],
            order: entity.order,
            mentionText: entity.mentionText,
          };
        }
      } catch (error) {
        log("Wikipedia search failed", entity.entityName, endpoint, error);
      }
    }

    return null;
  }

  async function resolveBaikeLink(entity) {
    try {
      const url = `https://baike.baidu.com/search/word?word=${encodeURIComponent(entity.entityName)}`;
      const response = await gmRequest({ method: "GET", url });
      const finalUrl = normalizeUrl(response.finalUrl || "");
      if (finalUrl.includes("baike.baidu.com/item/")) {
        const doc = parseHtml(response.responseText || "");
        const title =
          safeText(doc.title).replace(/_百度百科.*$/, "") ||
          safeText(doc.querySelector("dd.lemmaWgt-lemmaTitle-title h1")?.textContent) ||
          entity.entityName;
        return {
          entityName: entity.entityName,
          entityType: entity.entityType,
          sourceType: "baike",
          url: finalUrl,
          title,
          order: entity.order,
          mentionText: entity.mentionText,
        };
      }

      const doc = parseHtml(response.responseText || "");
      const link = doc.querySelector('a[href*="baike.baidu.com/item/"]');
      const itemUrl = normalizeUrl(link?.href || "");
      if (itemUrl) {
        return {
          entityName: entity.entityName,
          entityType: entity.entityType,
          sourceType: "baike",
          url: itemUrl,
          title: safeText(link.textContent) || entity.entityName,
          order: entity.order,
          mentionText: entity.mentionText,
        };
      }
    } catch (error) {
      log("Baike search failed", entity.entityName, error);
    }

    return null;
  }

  async function resolveEntityLink(entity) {
    const cacheKey = `${entity.entityType}:${entity.entityName}`;
    const cached = state.entityLinkCache.get(cacheKey);
    if (cached) {
      return { ...cached, order: entity.order, mentionText: entity.mentionText };
    }

    const official = await resolveOfficialLink(entity);
    if (official) {
      state.entityLinkCache.set(cacheKey, official);
      return official;
    }

    const wikipedia = await resolveWikipediaLink(entity);
    if (wikipedia) {
      state.entityLinkCache.set(cacheKey, wikipedia);
      return wikipedia;
    }

    const baike = await resolveBaikeLink(entity);
    if (baike) {
      state.entityLinkCache.set(cacheKey, baike);
      return baike;
    }

    const none = {
      entityName: entity.entityName,
      entityType: entity.entityType,
      sourceType: "none",
      url: "",
      title: "",
      order: entity.order,
      mentionText: entity.mentionText,
    };
    state.entityLinkCache.set(cacheKey, none);
    return none;
  }

  function renderEntitySupportList() {
    const list = state.elements.entityList;
    if (!list) return;

    list.innerHTML = "";
    updateEntitySelectionSummary();

    if (state.entityItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "geo-empty";
      empty.textContent = state.entityStatus;
      list.appendChild(empty);
      refreshPromptTextareaHeights();
      return;
    }

    state.entityItems
      .slice()
      .sort((a, b) => a.order - b.order)
      .forEach((item) => {
        const container = document.createElement("div");
        container.className = "geo-entity-item";

        const topLine = document.createElement("div");
        topLine.className = "geo-entity-topline";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "geo-select";
        checkbox.value = item.url;
        checkbox.setAttribute("data-role", "entity-select");
        checkbox.disabled = item.sourceType === "none" || !item.url;
        checkbox.checked = !checkbox.disabled && state.selectedEntityLinks.has(item.url);

        const main = document.createElement("div");
        main.className = "geo-entity-main";

        const titleRow = document.createElement("div");
        titleRow.className = "geo-entity-title";

        const titleLink = document.createElement(item.url ? "a" : "span");
        titleLink.className = "geo-entity-link";
        titleLink.textContent = item.entityName;
        if (item.url) {
          titleLink.href = item.url;
          titleLink.target = "_blank";
          titleLink.rel = "noreferrer noopener";
        }

        const badge = document.createElement("span");
        badge.className = `geo-badge ${item.sourceType === "none" ? "geo-badge-none" : ""}`;
        badge.textContent =
          item.sourceType === "official"
            ? "官网"
            : item.sourceType === "wikipedia"
              ? "Wikipedia"
              : item.sourceType === "baike"
                ? "百度百科"
                : "未找到";

        titleRow.appendChild(titleLink);
        titleRow.appendChild(badge);

        const meta = document.createElement("div");
        meta.className = "geo-entity-meta";
        meta.textContent = `${item.entityType === "product" ? "产品" : "品牌"} · 顺序 ${item.order}`;

        const reason = document.createElement("div");
        reason.className = "geo-entity-reason";
        reason.textContent =
          item.sourceType === "none"
            ? "未找到官网 / Wikipedia / 百度百科链接。"
            : `${item.title || item.entityName}${item.url ? ` · ${item.url}` : ""}`;

        main.appendChild(titleRow);
        main.appendChild(meta);
        main.appendChild(reason);
        topLine.appendChild(checkbox);
        topLine.appendChild(main);
        container.appendChild(topLine);
        list.appendChild(container);
      });

    refreshPromptTextareaHeights();
  }

  function syncSelectedEntityLinks() {
    const available = new Set(
      state.entityItems.filter((item) => item.sourceType !== "none" && item.url).map((item) => item.url)
    );

    if (state.selectedEntityLinks.size === 0) {
      state.entityItems.forEach((item) => {
        if (item.sourceType !== "none" && item.url) {
          state.selectedEntityLinks.add(item.url);
        }
      });
      return;
    }

    Array.from(state.selectedEntityLinks).forEach((url) => {
      if (!available.has(url)) {
        state.selectedEntityLinks.delete(url);
      }
    });
  }

  function updateEntitySelectionSummary() {
    if (!state.elements.entitySelectionCount) return;
    syncSelectedEntityLinks();
    state.elements.entitySelectionCount.textContent = `已选 ${state.selectedEntityLinks.size} 个`;
  }

  async function scanEntitySupport({ force = false } = {}) {
    if (state.scanningEntities) return;

    const text = getLatestAssistantAnswerText();
    const signature = buildEntitySignature(text);
    if (!text) {
      state.entityItems = [];
      state.entityStatus = "最近一次回复为空，无法识别实体。";
      renderEntitySupportList();
      return;
    }

    if (!force && signature === state.lastEntitySignature && state.entityItems.length > 0) {
      renderEntitySupportList();
      return;
    }

    state.lastEntitySignature = signature;
    state.scanningEntities = true;
    state.entityStatus = "正在识别最后一次回复中的产品/品牌...";
    renderEntitySupportList();

    try {
      const apiKey = getApiKey();
      if (!apiKey) {
        state.entityItems = [];
        state.entityStatus = describeEntityError(createEntityError("missing_api_key", "未配置 API key"));
        renderEntitySupportList();
        return;
      }

      updateStatus("正在识别最后一次回复中的产品/品牌...");
      const entities = await extractEntitiesFromLatestAnswer(text);

      updateStatus(`已识别 ${entities.length} 个实体，正在补充官网 / Wikipedia / 百度百科链接...`);

      const resolved = new Array(entities.length);
      let resolvedWithLinkCount = 0;
      let finished = 0;
      await runWithConcurrency(entities, SCAN_CONCURRENCY, async (entity) => {
        const result = await resolveEntityLink(entity);
        const index = entities.findIndex((item) => item.entityName === entity.entityName);
        resolved[index] = result;
        if (result.sourceType !== "none" && result.url) {
          resolvedWithLinkCount += 1;
        }
        finished += 1;
        state.entityItems = resolved.filter(Boolean);
        renderEntitySupportList();
        updateStatus(`实体补源完成 ${finished}/${entities.length} 个...`);
      });

      state.entityItems = resolved.filter(Boolean);
      if (state.entityItems.length === 0) {
        state.entityStatus = "实体识别成功，但没有可展示的补源结果。";
      } else if (resolvedWithLinkCount === 0) {
        state.entityStatus = describeEntityError(createEntityError("entity_support_none", "无可用链接"));
      } else if (resolvedWithLinkCount < state.entityItems.length) {
        state.entityStatus = describeEntityError(
          createEntityError(
            "entity_support_partial",
            `${resolvedWithLinkCount}/${state.entityItems.length} 个实体找到补充链接`
          )
        );
      } else {
        state.entityStatus = `实体补源已完成：${resolvedWithLinkCount}/${state.entityItems.length} 个实体已找到补充链接。`;
      }
      renderEntitySupportList();
    } catch (error) {
      state.entityItems = [];
      state.entityStatus = describeEntityError(error);
      renderEntitySupportList();
      updateStatus(state.entityStatus);
    } finally {
      state.scanningEntities = false;
    }
  }

  function generateGovernancePrompt() {
    const selected = getSortedHighRiskItems().filter((item) => state.selectedRiskUrls.has(item.url));
    if (selected.length === 0) {
      state.generatedPrompt = "";
      if (state.elements.promptBox) {
        state.elements.promptBox.value = "";
        autoResizeTextarea(state.elements.promptBox);
      }
      updateStatus("请先勾选至少一个高风险信源。");
      return "";
    }

    const sourceLines = selected.map((item) => {
      const title = safeText(item.analysis?.sourceTitle) || item.label;
      return `- 信源 ${item.citationIndex || "?"}: ${title} (${item.url})`;
    });

    const prompt = [
      "请不要参考以下高风险网页，并重新搜索更高质量的资料后再回答：",
      ...sourceLines,
      "",
      "请优先使用官网、权威媒体、原始资料或专业机构来源，并在新的回答中替换这些网页。",
    ].join("\n");

    state.generatedPrompt = prompt;
    if (state.elements.promptBox) {
      state.elements.promptBox.value = prompt;
      autoResizeTextarea(state.elements.promptBox);
    }
    updateStatus(`已为 ${selected.length} 个高风险信源生成治理提示词。`);
    return prompt;
  }

  function generateSupportPrompt() {
    const selected = state.entityItems
      .filter((item) => item.sourceType !== "none" && item.url && state.selectedEntityLinks.has(item.url))
      .sort((a, b) => a.order - b.order);

    if (selected.length === 0) {
      state.generatedSupportPrompt = "";
      if (state.elements.supportPromptBox) {
        state.elements.supportPromptBox.value = "";
        autoResizeTextarea(state.elements.supportPromptBox);
      }
      updateStatus("请先勾选至少一个补源链接。");
      return "";
    }

    const lines = selected.map((item) => `- ${item.entityName}：${item.url}`);
    const prompt = [
      "请在下一次回答中优先参考以下高质量资料，并据此重新组织答案：",
      "",
      ...lines,
      "",
      "这些链接可作为优先参考来源；如果仍需扩展资料，请继续检索其他高质量来源，但避免低质量营销页或不可靠导购页。",
    ].join("\n");

    state.generatedSupportPrompt = prompt;
    if (state.elements.supportPromptBox) {
      state.elements.supportPromptBox.value = prompt;
      autoResizeTextarea(state.elements.supportPromptBox);
    }
    updateStatus(`已为 ${selected.length} 个实体生成补源提示词。`);
    return prompt;
  }

  function findChatTextarea() {
    return (
      document.querySelector("textarea[placeholder*='DeepSeek']") ||
      document.querySelector("textarea._27c9245") ||
      document.querySelector("textarea")
    );
  }

  function insertTextIntoTextarea(textarea, value) {
    const prototype = Object.getPrototypeOf(textarea);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(textarea, value);
    } else {
      textarea.value = value;
    }

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function insertPromptIntoChat() {
    const prompt = state.elements.promptBox?.value.trim() || generateGovernancePrompt();
    if (!prompt) return;

    const textarea = findChatTextarea();
    if (!textarea) {
      updateStatus("没有找到 DeepSeek 聊天输入框。");
      return;
    }

    const existing = textarea.value?.trim();
    const nextValue = existing ? `${existing}\n\n${prompt}` : prompt;
    insertTextIntoTextarea(textarea, nextValue);
    textarea.focus();
    updateStatus("治理提示词已插入聊天框。");
  }

  function insertSupportPromptIntoChat() {
    const prompt = state.elements.supportPromptBox?.value.trim() || generateSupportPrompt();
    if (!prompt) return;

    const textarea = findChatTextarea();
    if (!textarea) {
      updateStatus("没有找到 DeepSeek 聊天输入框。");
      return;
    }

    const existing = textarea.value?.trim();
    const nextValue = existing ? `${existing}\n\n${prompt}` : prompt;
    insertTextIntoTextarea(textarea, nextValue);
    textarea.focus();
    updateStatus("补源提示词已插入聊天框。");
  }

  async function copyPromptToClipboard() {
    const prompt = state.elements.promptBox?.value.trim() || generateGovernancePrompt();
    if (!prompt) return;

    try {
      await navigator.clipboard.writeText(prompt);
      updateStatus("治理提示词已复制到剪贴板。");
    } catch (error) {
      updateStatus("复制失败，请改用手动复制。");
    }
  }

  async function copySupportPromptToClipboard() {
    const prompt = state.elements.supportPromptBox?.value.trim() || generateSupportPrompt();
    if (!prompt) return;

    try {
      await navigator.clipboard.writeText(prompt);
      updateStatus("补源提示词已复制到剪贴板。");
    } catch (error) {
      updateStatus("复制失败，请改用手动复制。");
    }
  }

  async function scanAll({ force = false } = {}) {
    await scanSources({ force });
    await scanEntitySupport({ force });
  }

  function scheduleScan() {
    if (state.scanTimer) {
      window.clearTimeout(state.scanTimer);
    }

    state.scanTimer = window.setTimeout(() => {
      scanAll({ force: false });
    }, SCAN_DEBOUNCE_MS);
  }

  function observeConversation() {
    const root = getRootContainer();
    if (!root) return;

    const observer = new MutationObserver(() => {
      scheduleScan();
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== "function") return;

    GM_registerMenuCommand("配置 DeepSeek API Key", () => {
      promptForApiKey();
    });

    GM_registerMenuCommand("重新扫描最近一次回复", () => {
      scanAll({ force: true });
    });

    GM_registerMenuCommand("生成 GEO 治理提示词", () => {
      generateGovernancePrompt();
    });

    GM_registerMenuCommand("生成补源提示词", () => {
      generateSupportPrompt();
    });

    GM_registerMenuCommand("重置 GEO 侧边栏状态", () => {
      resetSidebarState();
    });
  }

  async function main() {
    renderPanel();
    registerMenuCommands();
    updateStatus("正在发现最近一次回复中的信源...");
    renderHighRiskList();
    renderEntitySupportList();
    observeConversation();
    scheduleScan();
    log("Script ready.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main, { once: true });
  } else {
    main();
  }
})();
