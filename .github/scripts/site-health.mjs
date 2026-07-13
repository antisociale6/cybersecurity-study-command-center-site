import { createHash } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GUMROAD_PRODUCT_PATTERN = /^https:\/\/[a-z0-9-]+\.gumroad\.com\/l\/[A-Za-z0-9_-]+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODES = new Set(["quick", "deep"]);
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

export async function runHealthCheck({
  mode = "quick",
  siteUrl,
  checkoutUrl,
  leadMagnetUrl,
  repositoryRoot = process.cwd(),
  fetchImpl = fetch,
  sleepImpl = sleep,
  retries = DEFAULT_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requireCommerceReady = false,
} = {}) {
  if (!MODES.has(mode)) throw new Error("Health mode must be quick or deep.");
  const site = cleanSiteUrl(siteUrl);
  const checkout = cleanProductUrl(checkoutUrl, "checkout URL");
  const leadMagnet = cleanProductUrl(leadMagnetUrl, "lead-magnet URL");
  const localManifest = readLocalManifest(repositoryRoot, checkout, leadMagnet);

  const liveManifestUrl = new URL("publish-manifest.json", site);
  liveManifestUrl.searchParams.set("guardian", localManifest.site_hash);
  const liveManifest = await fetchJson(liveManifestUrl, {
    fetchImpl,
    sleepImpl,
    retries,
    timeoutMs,
  });
  if (canonicalJson(liveManifest) !== canonicalJson(localManifest)) {
    throw new Error("The live publish manifest does not match the default branch.");
  }

  const liveConfig = await fetchJson(new URL("site-config.json", site), {
    fetchImpl,
    sleepImpl,
    retries,
    timeoutMs,
  });
  if (
    liveConfig?.schema_version !== 1 ||
    liveConfig.checkout_url !== checkout ||
    liveConfig.lead_magnet_url !== leadMagnet
  ) {
    throw new Error("The live site configuration does not contain both approved product URLs.");
  }

  const homepage = await fetchText(site, {
    fetchImpl,
    sleepImpl,
    retries,
    timeoutMs,
  });
  if (
    !homepage.includes('data-funnel-link="checkout"') ||
    !homepage.includes('data-funnel-link="lead_magnet"') ||
    !homepage.includes('href="downloads/authorized-security-lab-command-checklist.zip" download')
  ) {
    throw new Error("The live homepage does not contain the checkout, lead, and fallback controls.");
  }

  const [paidHtml, freeHtml] = await Promise.all([
    fetchText(checkout, { fetchImpl, sleepImpl, retries, timeoutMs }),
    fetchText(leadMagnet, { fetchImpl, sleepImpl, retries, timeoutMs }),
  ]);
  const paidState = detectGumroadPublication(paidHtml);
  const freeState = detectGumroadPublication(freeHtml);
  const commerceReady = paidState === "published" && freeState === "published";

  let deepVerification = null;
  if (mode === "deep") {
    deepVerification = await verifyPublishedFiles({
      siteUrl: site.href,
      manifest: localManifest,
      fetchImpl,
      sleepImpl,
      retries,
      timeoutMs,
    });
  }

  return {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    mode,
    operational_ok: true,
    commerce_ready: commerceReady,
    commerce_required: requireCommerceReady === true,
    products: {
      paid: { publication_state: paidState },
      free: { publication_state: freeState },
    },
    site: {
      source_build_id: localManifest.source_build_id,
      site_hash: localManifest.site_hash,
      published_file_count: localManifest.published_files.length,
      cloud_bundle_sha256: localManifest.cloud_automation.bundle_sha256,
    },
    deep_verification: deepVerification,
  };
}

export function detectGumroadPublication(html) {
  if (typeof html !== "string") return "unknown";
  const normalized = html
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#x22;", '"')
    .replaceAll("\\u0022", '"');
  const matches = [
    ...normalized.matchAll(/\\?"is_published\\?"\s*:\s*(true|false)/gi),
  ].map((match) => match[1].toLowerCase());
  const states = new Set(matches);
  if (states.size !== 1) return "unknown";
  return states.has("true") ? "published" : "draft";
}

export async function verifyPublishedFiles({
  siteUrl,
  manifest,
  fetchImpl = fetch,
  sleepImpl = sleep,
  retries = DEFAULT_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const site = cleanSiteUrl(siteUrl);
  let verifiedBytes = 0;
  for (const file of manifest.published_files) {
    const fileUrl = new URL(file.path, site);
    fileUrl.searchParams.set("guardian", manifest.site_hash);
    const bytes = await fetchBytes(fileUrl, {
      fetchImpl,
      sleepImpl,
      retries,
      timeoutMs,
    });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256) {
      throw new Error(`Published file hash mismatch: ${file.path}`);
    }
    verifiedBytes += bytes.length;
  }
  return {
    verified_file_count: manifest.published_files.length,
    verified_bytes: verifiedBytes,
  };
}

export async function requestPagesRebuild({
  repository,
  token,
  fetchImpl = fetch,
} = {}) {
  if (!REPOSITORY_PATTERN.test(repository ?? "")) {
    throw new Error("GITHUB_REPOSITORY is invalid.");
  }
  if (typeof token !== "string" || token.length < 20) {
    throw new Error("GITHUB_TOKEN is unavailable.");
  }
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/pages/builds`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "openclaw-revenue-loop-guardian",
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    },
  );
  if (response.status !== 201) {
    throw new Error(`GitHub Pages rebuild request returned HTTP ${response.status}.`);
  }
  return { requested: true, status: response.status };
}

export function heartbeatCommitMessage({ now = new Date() } = {}) {
  const month = now.toISOString().slice(0, 7);
  return `Maintain cloud guardian schedule ${month} [skip ci]`;
}

function readLocalManifest(repositoryRoot, checkoutUrl, leadMagnetUrl) {
  const root = path.resolve(repositoryRoot);
  const manifestPath = path.join(root, "publish-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("The checked-out publish manifest is missing or invalid.");
  }
  if (
    manifest?.schema_version !== 2 ||
    !SHA256_PATTERN.test(manifest.source_build_id ?? "") ||
    !SHA256_PATTERN.test(manifest.site_hash ?? "") ||
    manifest.checkout_url !== checkoutUrl ||
    manifest.lead_magnet_url !== leadMagnetUrl ||
    !Array.isArray(manifest.published_files) ||
    !validCloudAutomation(manifest.cloud_automation)
  ) {
    throw new Error("The checked-out publish manifest failed the guardian contract.");
  }
  for (const file of manifest.published_files) {
    if (
      typeof file?.path !== "string" ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      !SHA256_PATTERN.test(file.sha256 ?? "")
    ) {
      throw new Error("The publish manifest contains unsafe file metadata.");
    }
  }
  return manifest;
}

function validCloudAutomation(value) {
  return (
    value?.schema_version === 1 &&
    SHA256_PATTERN.test(value.bundle_sha256 ?? "") &&
    Array.isArray(value.files) &&
    value.files.length === 3 &&
    value.files.every((file) =>
      typeof file?.path === "string" &&
      (file.path === ".gitattributes" || file.path.startsWith(".github/")) &&
      Number.isInteger(file.bytes) &&
      file.bytes > 0 &&
      SHA256_PATTERN.test(file.sha256 ?? "")
    )
  );
}

function cleanSiteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SITE_URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("SITE_URL must be one clean HTTPS directory URL.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function cleanProductUrl(value, label) {
  if (!GUMROAD_PRODUCT_PATTERN.test(value ?? "")) {
    throw new Error(`${label} must be one clean Gumroad product URL.`);
  }
  return value;
}

async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Remote JSON was invalid: ${url.origin}${url.pathname}`);
  }
}

async function fetchText(url, options) {
  const bytes = await fetchBytes(url, options);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function fetchBytes(
  url,
  {
    fetchImpl,
    sleepImpl,
    retries,
    timeoutMs,
  },
) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "*/*", "User-Agent": "openclaw-revenue-loop-guardian" },
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleepImpl(attempt * 1_000);
    }
  }
  const cleanUrl = new URL(url);
  throw new Error(
    `Fetch failed after ${retries} attempts: ${cleanUrl.origin}${cleanUrl.pathname} (${safeMessage(lastError)})`,
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 160);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArguments(argv) {
  const result = { mode: "quick", output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      result.mode = argv[++index];
    } else if (argument === "--output") {
      result.output = argv[++index];
    } else if (argument === "--request-pages-rebuild") {
      result.requestPagesRebuild = true;
    } else if (argument === "--heartbeat-message") {
      result.heartbeatMessage = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (result.output && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(result.output)) {
    throw new Error("Output must be one JSON filename in the repository root.");
  }
  return result;
}

function writeResult(result, outputName) {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (outputName) writeFileSync(path.resolve(outputName), text, "utf8");
  process.stdout.write(text);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `operational_ok=${result.operational_ok === true}\n` +
        `commerce_ready=${result.commerce_ready === true}\n`,
      "utf8",
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## Revenue loop cloud guardian",
        "",
        `- Operational: ${result.operational_ok === true ? "healthy" : "failed"}`,
        `- Commerce ready: ${result.commerce_ready === true ? "yes" : "no"}`,
        `- Verification: ${result.mode ?? "recovery"}`,
        `- Paid product: ${result.products?.paid?.publication_state ?? "not checked"}`,
        `- Free product: ${result.products?.free?.publication_state ?? "not checked"}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.requestPagesRebuild) {
    const result = await requestPagesRebuild({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args.heartbeatMessage) {
    process.stdout.write(`${heartbeatCommitMessage()}\n`);
    return;
  }

  try {
    const result = await runHealthCheck({
      mode: args.mode,
      siteUrl: process.env.SITE_URL,
      checkoutUrl: process.env.CHECKOUT_URL,
      leadMagnetUrl: process.env.LEAD_MAGNET_URL,
      requireCommerceReady: process.env.REQUIRE_COMMERCE_READY === "true",
    });
    writeResult(result, args.output);
    if (result.commerce_required && !result.commerce_ready) {
      process.exitCode = 2;
    }
  } catch (error) {
    const result = {
      schema_version: 1,
      checked_at: new Date().toISOString(),
      mode: args.mode,
      operational_ok: false,
      commerce_ready: false,
      error: safeMessage(error),
    };
    writeResult(result, args.output);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
