#!/usr/bin/env node
/**
 * Render smoke test: loads the desk in headless Chromium at desktop and mobile
 * widths, screenshots both, and fails on console errors or an empty body.
 *
 *   npm run smoke -- http://127.0.0.1:8080/
 */
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const CHROME = process.env.CHROME_PATH || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find((p) => existsSync(p));

const url = process.argv[2] || "http://127.0.0.1:8080/";
const outDir = process.argv[3] || "screenshots";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
let failed = false;
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(1500);
    const text = (await page.textContent("body"))?.replace(/\s+/g, " ").trim() ?? "";
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const file = `${outDir}/smoke-${name}.png`;
    await page.screenshot({ path: file, fullPage: false });
    const verdict = {
      name,
      status: res?.status() ?? 0,
      bodyTextLen: text.length,
      bodyTextPrefix: text.slice(0, 80),
      horizontalOverflow: overflow,
      consoleErrors: errors,
      screenshot: file,
    };
    console.log(JSON.stringify(verdict, null, 2));
    if (verdict.status !== 200 || text.length < 40 || errors.length || overflow) failed = true;
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
