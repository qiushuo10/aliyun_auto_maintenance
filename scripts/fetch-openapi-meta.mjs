#!/usr/bin/env node

/*
已联网验证:
  - Product list endpoint:
    https://api.aliyun.com/meta/v1/products.json?language=EN_US
    returns an array whose `code` field is the case-sensitive ProductCode.
  - API docs endpoint:
    https://api.aliyun.com/meta/v1/products/{ProductCode}/versions/{version}/api-docs.json?language=EN_US
    returns a top-level `apis` object keyed by OpenAPI Action name.
  - Required parameters are `apis[Action].parameters[]` entries whose
    `parameter.schema.required === true`; top-level `parameter.required` is not
    used.
  - API summary comes from `apis[Action].title`, falling back to `.summary`.
    Deprecated status comes from `apis[Action].deprecated`; replacement actions
    are normally absent, so snapshots write `replacedBy: null`.
*/

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const CATALOG_META_DIR = join(process.cwd(), 'catalog-meta');
const RAW_CACHE_DIR = process.env.OPENAPI_META_CACHE_DIR || join(CATALOG_META_DIR, '.raw');
const PRODUCTS_ENDPOINT = 'https://api.aliyun.com/meta/v1/products.json?language=EN_US';
const OPENAPI_META_ENDPOINT = 'https://api.aliyun.com/meta/v1/products/{ProductCode}/versions/{version}/api-docs.json?language=EN_US';
const REQUEST_TIMEOUT_MS = Number(process.env.OPENAPI_META_TIMEOUT_MS ?? 30_000);
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || null;
const USER_AGENT = 'aliy-agent-openapi-meta-snapshot/1.0';

class HttpsProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super();
    this.proxy = new URL(proxyUrl);
    if (this.proxy.protocol !== 'http:' && this.proxy.protocol !== 'https:') {
      throw new Error(`Unsupported proxy protocol for HTTPS metadata fetch: ${this.proxy.protocol}`);
    }
  }

  createConnection(options, callback) {
    const targetHost = String(options.servername || options.host || options.hostname || '');
    const targetPort = Number(options.port || 443);
    const headers = {};
    if (this.proxy.username || this.proxy.password) {
      const credentials = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }

    const requester = this.proxy.protocol === 'https:' ? https : http;
    const req = requester.request({
      hostname: this.proxy.hostname,
      port: this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers
    });

    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      callback(error);
    };

    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode ?? 'unknown'}`));
        return;
      }
      if (head?.length) socket.unshift(head);
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
        if (settled) return;
        settled = true;
        callback(null, tlsSocket);
      });
      tlsSocket.once('error', fail);
    });
    req.once('error', fail);
    req.end();
  }
}

async function main() {
  const products = discoverInstalledSdkProducts();
  mkdirSync(CATALOG_META_DIR, { recursive: true });

  const productCodePlan = await resolveProductCodePlan(products);
  const succeeded = [];
  const failed = [];

  console.log('ProductCode mapping:');
  for (const productSpec of products) {
    const candidates = productCodePlan.get(productSpec.product) ?? fallbackProductCodeCandidates(productSpec.product);
    console.log(`- ${productSpec.product} -> ${candidates[0]} (${productSpec.version})`);
  }
  console.log('');

  for (const productSpec of products) {
    try {
      const candidates = productCodePlan.get(productSpec.product) ?? fallbackProductCodeCandidates(productSpec.product);
      const { raw, openApiProduct, sourceUrl, transport } = await fetchProductMetadata(productSpec, candidates);
      const snapshot = normalizeMetadataSnapshot(productSpec, openApiProduct, sourceUrl, raw);
      writeJsonAtomic(join(CATALOG_META_DIR, `${productSpec.product}.json`), snapshot);
      succeeded.push({
        product: productSpec.product,
        productCode: openApiProduct,
        version: productSpec.version,
        actionCount: Object.keys(snapshot.actions).length
      });
      console.log(`OK ${productSpec.product} -> ${openApiProduct} ${productSpec.version} ${Object.keys(snapshot.actions).length} actions via ${transport}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ product: productSpec.product, version: productSpec.version, error: message });
      console.error(`FAIL ${productSpec.product} ${productSpec.version}: ${message}`);
    }
  }

  console.log('');
  console.log(`OpenAPI metadata snapshots complete: ${succeeded.length} succeeded, ${failed.length} failed.`);
  if (failed.length) {
    console.log('Failed products:');
    for (const failure of failed) {
      console.log(`- ${failure.product} ${failure.version}: ${failure.error}`);
    }
  }

  if (!succeeded.length && failed.length) {
    process.exitCode = 1;
  }
}

function discoverInstalledSdkProducts() {
  const scopeDir = join(process.cwd(), 'node_modules/@alicloud');
  if (!existsSync(scopeDir)) return [];

  return readdirSync(scopeDir)
    .map((entry) => packageToSpec(entry))
    .filter(Boolean)
    .sort((a, b) => a.product.localeCompare(b.product));
}

function packageToSpec(entry) {
  const match = /^(.+?)(\d{8})$/.exec(entry);
  if (!match) return null;
  const packageName = `@alicloud/${entry}`;
  let clientEntry;
  try {
    clientEntry = require.resolve(packageName);
  } catch {
    return null;
  }

  const packageRoot = dirname(dirname(clientEntry));
  const clientJsPath = join(packageRoot, 'dist/client.js');
  const clientDtsPath = join(packageRoot, 'dist/client.d.ts');
  if (!existsSync(clientJsPath) || !existsSync(clientDtsPath)) return null;

  const productFallback = match[1].replace(/-/g, '');
  const clientJs = readFileSync(clientJsPath, 'utf8');
  const product = extractProductId(clientJs) ?? productFallback;
  const endpointRule = extractEndpointRule(clientJs);
  const endpointMap = extractEndpointMap(clientJs);
  const endpointTpl = endpointRule === 'central' ? `${product}.aliyuncs.com` : `${product}.{region}.aliyuncs.com`;

  return {
    packageName,
    product,
    version: `${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}`,
    endpointTpl,
    endpointMap
  };
}

function extractProductId(clientJs) {
  return /getEndpoint\("([^"]+)"/.exec(clientJs)?.[1] ?? null;
}

function extractEndpointRule(clientJs) {
  return /this\._endpointRule\s*=\s*"([^"]+)"/.exec(clientJs)?.[1] ?? null;
}

function extractEndpointMap(clientJs) {
  const body = /this\._endpointMap\s*=\s*\{([\s\S]*?)\};/.exec(clientJs)?.[1];
  if (!body) return null;

  const endpointMap = {};
  const pairRegex = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pairRegex.exec(body))) {
    endpointMap[match[1]] = match[2];
  }
  return Object.keys(endpointMap).length ? JSON.stringify(endpointMap) : null;
}

async function resolveProductCodePlan(productSpecs) {
  let productEntries = null;
  try {
    const raw = await requestJsonWithFallback(PRODUCTS_ENDPOINT);
    productEntries = parseProductList(raw.value);
  } catch (error) {
    try {
      productEntries = parseProductList(readJsonFile(productListCachePath()));
      console.warn(`WARN products.json network unavailable; loaded ProductCode list from ${productListCachePath()}: ${errorMessage(error)}`);
    } catch (cacheError) {
      console.warn(`WARN products.json unavailable; falling back to validated PascalCase candidates: ${errorMessage(error)}; cache failed: ${errorMessage(cacheError)}`);
    }
  }

  const plan = new Map();
  for (const productSpec of productSpecs) {
    const mapped = productEntries ? resolveProductCodeFromList(productSpec, productEntries) : null;
    plan.set(productSpec.product, unique([
      mapped,
      ...fallbackProductCodeCandidates(productSpec.product)
    ].filter(Boolean)));
  }
  return plan;
}

function parseProductList(raw) {
  if (Array.isArray(raw)) return raw.filter((entry) => entry && typeof entry === 'object');
  if (Array.isArray(raw?.products)) return raw.products.filter((entry) => entry && typeof entry === 'object');
  if (Array.isArray(raw?.data)) return raw.data.filter((entry) => entry && typeof entry === 'object');
  if (Array.isArray(raw?.data?.products)) return raw.data.products.filter((entry) => entry && typeof entry === 'object');
  throw new Error('products.json did not contain a product array');
}

function resolveProductCodeFromList(productSpec, productEntries) {
  const product = productSpec.product;
  const codeEntries = productEntries
    .map((entry) => ({
      code: firstString(entry.code, entry.ProductCode, entry.productCode),
      versions: Array.isArray(entry.versions) ? entry.versions.filter((version) => typeof version === 'string') : []
    }))
    .filter((entry) => entry.code);

  const exact = preferVersion(codeEntries.filter((entry) => entry.code === product), productSpec.version);
  if (exact) return exact.code;

  const caseInsensitive = preferVersion(
    codeEntries.filter((entry) => entry.code.toLowerCase() === product.toLowerCase()),
    productSpec.version
  );
  if (caseInsensitive) return caseInsensitive.code;

  const normalizedProduct = normalizeProductKey(product);
  const normalized = preferVersion(
    codeEntries.filter((entry) => normalizeProductKey(entry.code) === normalizedProduct),
    productSpec.version
  );
  return normalized?.code ?? null;
}

function preferVersion(entries, version) {
  if (!entries.length) return null;
  return entries.find((entry) => entry.versions.includes(version)) ?? entries[0];
}

function normalizeProductKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function fallbackProductCodeCandidates(product) {
  return unique([
    product,
    product
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('-'),
    product.toUpperCase()
  ]);
}

async function fetchProductMetadata(productSpec, candidates) {
  let lastError = null;

  for (const openApiProduct of candidates) {
    const sourceUrl = metadataUrl(openApiProduct, productSpec.version);
    try {
      const response = await requestJsonWithFallback(sourceUrl);
      return { raw: response.value, openApiProduct, sourceUrl, transport: response.transport };
    } catch (error) {
      try {
        return {
          raw: readJsonFile(apiDocsCachePath(productSpec, openApiProduct)),
          openApiProduct,
          sourceUrl,
          transport: 'raw-cache'
        };
      } catch {
        // Ignore cache misses so the final error reports the network failure.
      }
      lastError = error;
    }
  }

  throw lastError ?? new Error(`No OpenAPI ProductCode candidates for ${productSpec.product}`);
}

function metadataUrl(productCode, version) {
  return OPENAPI_META_ENDPOINT
    .replace('{ProductCode}', encodeURIComponent(productCode))
    .replace('{version}', encodeURIComponent(version));
}

async function requestJsonWithFallback(url) {
  try {
    return { value: await requestJson(url, null), transport: 'direct' };
  } catch (directError) {
    if (!PROXY_URL) {
      return requestJsonWithCurlFallback(url, directError, null);
    }
    try {
      return { value: await requestJson(url, PROXY_URL), transport: 'proxy' };
    } catch (proxyError) {
      return requestJsonWithCurlFallback(url, directError, proxyError);
    }
  }
}

async function requestJsonWithCurlFallback(url, directError, proxyError) {
  try {
    return { value: await requestJsonWithCurl(url), transport: 'curl' };
  } catch (curlError) {
    const proxyMessage = proxyError ? `; proxy failed: ${errorMessage(proxyError)}` : '';
    throw new Error(`direct failed: ${errorMessage(directError)}${proxyMessage}; curl failed: ${errorMessage(curlError)}`);
  }
}

function requestJson(url, proxyUrl, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      agent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT
      }
    }, (res) => {
      const statusCode = res.statusCode ?? 0;
      const location = res.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location && redirectsLeft > 0) {
        res.resume();
        const nextUrl = new URL(location, url).toString();
        resolve(requestJson(nextUrl, proxyUrl, redirectsLeft - 1));
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${errorMessage(error)}`));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.once('error', reject);
    req.end();
  });
}

async function requestJsonWithCurl(url) {
  const { stdout } = await execFileAsync('curl', [
    '-L',
    '--fail-with-body',
    '--max-time',
    String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
    '-sS',
    '-H',
    'Accept: application/json',
    '-H',
    `User-Agent: ${USER_AGENT}`,
    url
  ], {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024
  });

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid JSON response: ${errorMessage(error)}`);
  }
}

function normalizeMetadataSnapshot(productSpec, openApiProduct, sourceUrl, raw) {
  const apiEntries = extractApiEntries(raw);
  if (!apiEntries.length) {
    throw new Error('Metadata response did not contain a top-level apis map');
  }

  const actions = {};
  for (const [action, api] of apiEntries) {
    if (!api || typeof api !== 'object') continue;
    actions[action] = normalizeApiEntry(api);
  }

  if (!Object.keys(actions).length) {
    throw new Error('Metadata response did not contain usable API action entries');
  }

  return {
    snapshotVersion: 1,
    product: productSpec.product,
    openApiProduct,
    version: productSpec.version,
    source: sourceUrl,
    fetchedAt: new Date().toISOString(),
    actions
  };
}

function extractApiEntries(raw) {
  const apis = raw?.apis;
  if (!apis || typeof apis !== 'object' || Array.isArray(apis)) return [];
  return Object.entries(apis);
}

function normalizeApiEntry(api) {
  const summary = firstString(api.title, api.summary);
  return {
    required: extractRequiredParameters(api),
    deprecated: normalizeBoolean(api.deprecated) ?? false,
    replacedBy: extractReplacement(api),
    ...(summary ? { summary } : {})
  };
}

function extractRequiredParameters(api) {
  const parameters = Array.isArray(api.parameters) ? api.parameters : [];
  return unique(parameters
    .filter((parameter) => normalizeBoolean(parameter?.schema?.required) === true)
    .map((parameter) => firstString(parameter.name))
    .filter(Boolean));
}

function extractReplacement(api) {
  const keys = ['replacedBy', 'replaced_by', 'replacement', 'replacementApi', 'replacementAction'];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(api, key)) continue;
    const value = api[key];
    if (value === null) return null;
    if (typeof value === 'string') return normalizeText(value) || null;
    if (value && typeof value === 'object') {
      return firstString(value.name, value.apiName, value.action, value.actionName) ?? null;
    }
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  if (/^true$/i.test(value.trim())) return true;
  if (/^false$/i.test(value.trim())) return false;
  return null;
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function productListCachePath() {
  return join(RAW_CACHE_DIR, 'products.json');
}

function apiDocsCachePath(productSpec, productCode) {
  return join(RAW_CACHE_DIR, `${safeFilePart(productSpec.product)}-${productSpec.version}-${safeFilePart(productCode)}.json`);
}

function safeFilePart(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function unique(values) {
  return Array.from(new Set(values));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(`OpenAPI metadata snapshot failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
