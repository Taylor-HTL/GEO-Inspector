// ==UserScript==
// @name         GEO Detection Support Starter
// @namespace    https://tampermonkey.net/
// @version      0.1.0
// @description  A starter template for Tampermonkey/Greasemonkey development.
// @author       huangtianle
// @match        https://example.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_NAME = "GEO Detection Support Starter";
  const DEBUG = true;
  const PROCESSED_ATTR = "data-geo-support-processed";

  function log(...args) {
    if (!DEBUG) return;
    console.log(`[${SCRIPT_NAME}]`, ...args);
  }

  function markProcessed(element) {
    if (!element) return;
    element.setAttribute(PROCESSED_ATTR, "true");
  }

  function isProcessed(element) {
    return element?.getAttribute(PROCESSED_ATTR) === "true";
  }

  function waitForElement(selector, { timeout = 10000, root = document } = {}) {
    return new Promise((resolve, reject) => {
      const existing = root.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      const timer = window.setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for selector: ${selector}`));
      }, timeout);

      const observer = new MutationObserver(() => {
        const node = root.querySelector(selector);
        if (!node) return;

        window.clearTimeout(timer);
        observer.disconnect();
        resolve(node);
      });

      observer.observe(root === document ? document.documentElement : root, {
        childList: true,
        subtree: true,
      });
    });
  }

  function injectBadge() {
    if (document.getElementById("geo-support-starter-badge")) return;

    const badge = document.createElement("div");
    badge.id = "geo-support-starter-badge";
    badge.textContent = "Userscript active";
    badge.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:999999",
      "padding:8px 12px",
      "border-radius:999px",
      "background:#111827",
      "color:#ffffff",
      "font:12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-shadow:0 8px 24px rgba(0,0,0,.2)",
    ].join(";");

    document.body.appendChild(badge);
  }

  function processCards() {
    const cards = document.querySelectorAll("article, .card, [data-card]");
    cards.forEach((card) => {
      if (isProcessed(card)) return;
      markProcessed(card);
      card.style.outline = "2px dashed #22c55e";
    });

    if (cards.length > 0) {
      log(`Processed ${cards.length} card(s).`);
    }
  }

  function observePageChanges() {
    const observer = new MutationObserver(() => {
      processCards();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  async function main() {
    log("Script booting...");

    injectBadge();

    try {
      await waitForElement("body");
      processCards();
      observePageChanges();
      log("Script ready.");
    } catch (error) {
      console.error(`[${SCRIPT_NAME}] Failed to initialize`, error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main, { once: true });
  } else {
    main();
  }
})();
