/**
 * Export Similarweb organic landing-page details from an already authorized
 * Chrome tab. It preserves the site's normal, page-by-page workflow and
 * captures the JSON responses returned to that tab.
 *
 * Prerequisite: Chrome must be running with --remote-debugging-port=9222 and
 * the Similarweb landing-pages report must be open and authorized.
 *
 * Usage:
 *   node scripts/export-similarweb-landing-pages.mjs
 *   node scripts/export-similarweb-landing-pages.mjs --pages 1,2,3 --out exports
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};
const pages = option("--pages", "1,2,3")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value > 0);
const outputDirectory = resolve(option("--out", "exports"));
if (!pages.length) throw new Error("--pages must contain one or more positive page numbers.");

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = targets.find(
  (item) =>
    item.type === "page" &&
    /organicsearch\/pageAnalysis\/landing-pages-v2/.test(item.url ?? ""),
);
if (!target?.webSocketDebuggerUrl) {
  throw new Error(
    "No Similarweb landing-pages tab was found. Open the report in the debug Chrome first.",
  );
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pendingCalls = new Map();
const landingResponses = new Map();

function call(method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      rejectCall(new Error(`Chrome DevTools timed out while calling ${method}.`));
    }, 15_000);
    pendingCalls.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolveCall(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        rejectCall(error);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function pageForUrl(url) {
  const page = new URL(url).searchParams.get("page");
  return page ? Number.parseInt(page, 10) : 1;
}

function isLandingPageRequest(url) {
  return /\/websiteOrganicLandingPagesV2\?/.test(url) && !/GetTableDrillDownTrend/.test(url);
}

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const pending = pendingCalls.get(message.id);
    if (!pending) return;
    pendingCalls.delete(message.id);
    message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    return;
  }

  if (message.method === "Network.responseReceived") {
    const { requestId, response } = message.params;
    if (!isLandingPageRequest(response.url)) return;
    landingResponses.set(requestId, {
      requestId,
      page: pageForUrl(response.url),
      url: response.url,
      status: response.status,
      completed: false,
    });
  }

  if (message.method === "Network.loadingFinished") {
    const response = landingResponses.get(message.params.requestId);
    if (response) response.completed = true;
  }
});

await new Promise((resolveOpen, rejectOpen) => {
  const timer = setTimeout(() => {
    rejectOpen(new Error("Timed out connecting to Chrome DevTools."));
  }, 10_000);
  ws.addEventListener(
    "open",
    () => {
      clearTimeout(timer);
      resolveOpen();
    },
    { once: true },
  );
  ws.addEventListener(
    "error",
    (error) => {
      clearTimeout(timer);
      rejectOpen(error);
    },
    { once: true },
  );
});

async function evaluate(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function goToPage(page) {
  // React stores the typed value asynchronously. Change it first, then obtain
  // the freshly rendered handler before simulating the input's Enter action.
  await evaluate(`(() => {
    const input = [...document.querySelectorAll('input[pattern="[0-9]*"]')]
      .find((element) => /out of \\d+/.test(element.parentElement?.textContent ?? ""));
    if (!input) throw new Error("Pagination input was not found. Check that the report is loaded and authorized.");
    const props = input[Object.keys(input).find((key) => key.startsWith("__reactProps"))];
    if (!props?.onChange) throw new Error("Could not access the report pagination control.");
    props.onChange({ target: { value: ${JSON.stringify(String(page))} } });
    return true;
  })()`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  await evaluate(`(() => {
    const input = [...document.querySelectorAll('input[pattern="[0-9]*"]')]
      .find((element) => /out of \\d+/.test(element.parentElement?.textContent ?? ""));
    const props = input?.[Object.keys(input).find((key) => key.startsWith("__reactProps"))];
    if (!props?.onKeyPress) throw new Error("Could not submit the report page number.");
    props.onKeyPress({ nativeEvent: { which: 13 }, preventDefault() {} });
    return true;
  })()`);
}

async function waitForResponse(page, previousRequestIds) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = [...landingResponses.values()].find(
      (item) => item.page === page && item.completed && !previousRequestIds.has(item.requestId),
    );
    if (match) return match;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for Similarweb page ${page}.`);
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

try {
  await call("Network.enable", {
    maxResourceBufferSize: 20_000_000,
    maxTotalBufferSize: 50_000_000,
  });

  const pageData = [];
  for (const page of pages) {
    const previousRequestIds = new Set(landingResponses.keys());
    if (page === 1) {
      // The report initially opens on page 1. Re-entering "1" may not cause
      // React to fetch again, so refresh the report to obtain its response.
      await call("Page.reload", { ignoreCache: false });
    } else {
      await goToPage(page);
    }
    const response = await waitForResponse(page, previousRequestIds);
    const body = await call("Network.getResponseBody", { requestId: response.requestId });
    if (response.status !== 200) {
      throw new Error(`Similarweb returned HTTP ${response.status} for page ${page}.`);
    }
    let parsed;
    try {
      parsed = JSON.parse(body.body);
    } catch {
      throw new Error(`Similarweb returned a non-JSON response for page ${page}. Check the account/session status.`);
    }
    if (!Array.isArray(parsed.Data)) {
      throw new Error(`Page ${page} contains no Data array. Check the account/session status.`);
    }
    pageData.push({ page, totalCount: parsed.TotalCount, rows: parsed.Data });
    console.log(`Captured page ${page}: ${parsed.Data.length} rows.`);
  }

  const rows = pageData.flatMap(({ page, rows: dataRows }) =>
    dataRows.map((row) => ({ Page: page, ...row })),
  );
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  await mkdir(outputDirectory, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const jsonPath = resolve(outputDirectory, `similarweb-landing-pages-${stamp}.json`);
  const csvPath = resolve(outputDirectory, `similarweb-landing-pages-${stamp}.csv`);
  await writeFile(jsonPath, JSON.stringify({ sourceUrl: target.url, pages: pageData }, null, 2), "utf8");
  await writeFile(
    csvPath,
    [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\n"),
    "utf8",
  );
  console.log(`Done: ${rows.length} rows.\nJSON: ${jsonPath}\nCSV: ${csvPath}`);
} finally {
  ws.close();
}
