import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser } from "puppeteer";

const WINDOWS_BROWSER_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const LINUX_BROWSER_PATHS = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (process.platform === "win32") {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw fallbackError;
      }
    }
    throw error;
  }
}

async function localPlaywrightBrowsers(): Promise<string[]> {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return [];
  const root = join(process.env.LOCALAPPDATA, "ms-playwright");
  try {
    const directories = await readdir(root, { withFileTypes: true });
    return directories
      .filter(entry => entry.isDirectory() && entry.name.startsWith("chromium-"))
      .sort((left, right) => right.name.localeCompare(left.name))
      .flatMap(entry => [
        join(root, entry.name, "chrome-win64", "chrome.exe"),
        join(root, entry.name, "chrome-win", "chrome.exe"),
      ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function launchBrowser(): Promise<Browser> {
  const configured = process.env.PPTX_BROWSER_EXECUTABLE_PATH;
  const candidates = [
    ...(configured ? [configured] : []),
    ...(await localPlaywrightBrowsers()),
    ...(process.platform === "win32"
      ? WINDOWS_BROWSER_PATHS
      : LINUX_BROWSER_PATHS),
  ];
  const failures: string[] = [];
  for (const executablePath of [...new Set(candidates)]) {
    if (!(await exists(executablePath))) continue;
    try {
      return await puppeteer.launch({
        headless: true,
        executablePath,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
    } catch (error) {
      failures.push(
        `${executablePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    failures.length
      ? `No available Chromium browser could export the deck. ${failures.join(" | ")}`
      : "No Chromium browser was found. Configure PPTX_BROWSER_EXECUTABLE_PATH.",
  );
}

type BrowserExporter = {
  exportToPptx(
    slides: Element[],
    options: Record<string, unknown>,
  ): Promise<Blob>;
};

export async function exportHtmlToEditablePptx(
  html: string,
  title: string,
): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("about:")) {
        void request.continue();
      } else {
        void request.abort();
      }
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const packageEntry = fileURLToPath(import.meta.resolve("dom-to-pptx"));
    await page.addScriptTag({
      path: join(dirname(packageEntry), "dom-to-pptx.bundle.js"),
    });
    const dataUrl = await page.evaluate(async (deckTitle) => {
      const exporter = (globalThis as typeof globalThis & {
        domToPptx?: BrowserExporter;
      }).domToPptx;
      if (!exporter) {
        throw new Error("dom-to-pptx failed to load in the browser.");
      }
      const slides = Array.from(document.querySelectorAll(".slide"));
      if (slides.length === 0) {
        throw new Error("The HTML deck contains no .slide elements.");
      }
      const blob = await exporter.exportToPptx(slides, {
        skipDownload: true,
        title: deckTitle,
        author: "Presentation Agent",
        width: 13.333333,
        height: 7.5,
        includePseudoElements: true,
      });
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }, title);
    return Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
  } finally {
    await browser.close();
  }
}
