import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

interface SdkProductSpec {
  packageName: string;
  product: string;
  version: string;
  endpointTpl: string;
  endpointMap: string | null;
  summaryKeywords: string;
}

interface LoadedAction {
  product: string;
  action: string;
  version: string;
  method: string;
  style: string;
  required: string[];
  danger: 'safe' | 'write' | 'dangerous';
  dangerSource: string;
  summary: string;
  paramsBlob: string;
  deprecated: boolean;
  replacedBy: string | null;
  keywords: string;
  deprecationSource: 'sdk' | 'snapshot';
}

interface CatalogMetaSnapshot {
  actions?: Record<string, CatalogMetaSnapshotAction>;
}

interface CatalogMetaSnapshotAction {
  required?: unknown;
  deprecated?: unknown;
  replacedBy?: unknown;
  summary?: unknown;
}

type DangerRule = {
  id: string;
  level: 'safe' | 'write' | 'dangerous';
  product?: string;
  action: RegExp;
  source: string;
};

const DANGER_RULES: DangerRule[] = [
  {
    id: 'official-read-action-names',
    level: 'safe',
    action: /^(Describe|Query|List|Get|Check|Verify|Recognize|Validate|Search|Preview)/,
    source: 'loader-rule:read-only-openapi-prefixes'
  },
  {
    id: 'security-control-plane',
    level: 'dangerous',
    action: /(SecurityGroup|Firewall|RamRole|KeyPair|Command|Route|Permission|Policy|Acl)/,
    source: 'loader-rule:security-control-plane'
  },
  {
    id: 'destructive-action-names',
    level: 'dangerous',
    action: /^(Delete|Remove|Revoke|Stop|Reboot|Release|Terminate|Detach|Unassociate|Cancel|Disable|Drop|Destroy)/,
    source: 'loader-rule:destructive-openapi-prefixes'
  },
  {
    id: 'mutating-action-names',
    level: 'write',
    action: /^(Create|Add|Set|Update|Modify|Put|Enable|Start|Run|Attach|Associate|Grant|Apply|Install|Bind|Unbind|Open|Close|Renew|Allocate)/,
    source: 'loader-rule:mutating-openapi-prefixes'
  }
];

const KEYWORD_OVERRIDES: Record<string, string> = {
  alb: 'alb application load balancer 负载均衡 应用型负载均衡 listener server group',
  alidns: 'dns domain record 云解析 域名 解析 记录',
  cas: 'ssl certificate cas 证书 ssl https',
  cdn: 'cdn domain cache refresh preload 内容分发 刷新 预热',
  dysmsapi: '短信 sms template sign 模板 签名 发送',
  ecs: 'ecs instance security group disk image 云服务器 实例 安全组 磁盘 镜像',
  'r-kvstore': 'redis kvstore tair 缓存 内存数据库 实例 云数据库redis版',
  slb: 'slb load balancer 负载均衡 传统型负载均衡',
  vpc: 'vpc vswitch route eip nat 专有网络 交换机 路由'
};

const ACTION_SUMMARY_OVERRIDES: Record<string, Record<string, string>> = {
  cas: {
    CreateDeploymentJob: 'Creates a certificate deployment job for cloud resources. CAS 证书部署 HTTPS 绑定 OSS ALB CDN ResourceIds ContactIds',
    ListCloudResources: 'Lists cloud resources that can receive certificate deployment. CAS 查询可部署云资源 OSS bucket 自定义域名 ResourceIds',
    ListContact: 'Lists certificate deployment contacts. CAS 查询联系人 ContactIds 证书部署',
    ListDeploymentJobCert: 'Lists certificates attached to a certificate deployment job. CAS 查询部署任务证书 CertIds',
    ListDeploymentJobResource: 'Lists cloud resources attached to a certificate deployment job. CAS 查询部署任务资源 ResourceIds'
  }
};

const SNAPSHOT_ONLY_ACTION_ALLOWLIST: Record<string, Set<string>> = {
  oss: new Set(['*'])
};

const OSSUTIL_EXTRA_ACTIONS: Record<string, CatalogMetaSnapshotAction> = {
  DeleteMultipleObjects: {
    required: ['bucket'],
    summary: 'Deletes multiple objects from a bucket'
  },
  DoDataPipeLineAction: {
    required: [],
    summary: 'Use the generalization command to send data pipeline related requests'
  },
  DoMetaQueryAction: {
    required: [],
    summary: 'Use the generalization command to send dataset related requests'
  },
  InvokeOperation: {
    required: [],
    summary: 'Use the generalization command to send requests'
  },
  ListCloudBoxes: {
    required: [],
    summary: 'Queries all cloud boxes that are owned by a requester'
  }
};

const OSS_RAW_ACTION_OVERRIDES: Record<string, {
  required: string[];
  summary: string;
  raw: {
    method: string;
    pathname: string;
    style?: string;
    reqBodyType?: string;
    bodyType?: string;
  };
}> = {
  CreateCnameToken: {
    required: ['bucket', 'Domain'],
    summary: 'Creates a CNAME token to verify custom domain ownership for an OSS bucket. OSS 自定义域名 token 校验 绑定域名',
    raw: {
      method: 'POST',
      pathname: '/?cname&comp=token',
      style: 'ROA',
      reqBodyType: 'xml',
      bodyType: 'xml'
    }
  },
  DeleteCname: {
    required: ['bucket', 'Domain'],
    summary: 'Deletes a CNAME custom domain binding from an OSS bucket. OSS 删除自定义域名 解绑域名',
    raw: {
      method: 'POST',
      pathname: '/?cname&comp=delete',
      style: 'ROA',
      reqBodyType: 'xml',
      bodyType: 'xml'
    }
  },
  GetCnameToken: {
    required: ['bucket', 'cname'],
    summary: 'Queries the CNAME token for an OSS custom domain. OSS 查询自定义域名 token',
    raw: {
      method: 'GET',
      pathname: '/?comp=token&cname={cname}',
      style: 'ROA',
      reqBodyType: 'xml',
      bodyType: 'xml'
    }
  },
  ListCname: {
    required: ['bucket'],
    summary: 'Lists CNAME custom domains that are bound to an OSS bucket. OSS 查询自定义域名 绑定域名',
    raw: {
      method: 'GET',
      pathname: '/?cname',
      style: 'ROA',
      reqBodyType: 'xml',
      bodyType: 'xml'
    }
  },
  PutCname: {
    required: ['bucket', 'Domain'],
    summary: 'Maps a CNAME custom domain to an OSS bucket. OSS 绑定自定义域名 PutBucketCname BucketDomain',
    raw: {
      method: 'POST',
      pathname: '/?cname&comp=add',
      style: 'ROA',
      reqBodyType: 'xml',
      bodyType: 'xml'
    }
  }
};

export interface CatalogLoadResult {
  productCount: number;
  actionCount: number;
}

export function loadOfficialSdkCatalog(catalogDbPath: string): CatalogLoadResult {
  const db = new Database(catalogDbPath);
  try {
    const now = Date.now();
    const products = discoverInstalledSdkProducts();
    db.transaction(() => {
      db.prepare('DELETE FROM catalog_products').run();
      db.prepare('DELETE FROM catalog_actions').run();
      db.prepare('DELETE FROM catalog_overlay').run();
      db.prepare('DELETE FROM catalog_aliases').run();
      db.prepare('DELETE FROM catalog_fts').run();

      for (const productSpec of products) {
        const loaded = loadProduct(productSpec);
        insertProduct(db, productSpec, now);
        for (const action of loaded) {
          insertAction(db, action, now);
        }
      }

      db.prepare(
        `INSERT INTO catalog_aliases (alias, product, kind)
         VALUES ('dysms', 'dysmsapi', 'ram_code')`
      ).run();

      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('spec_snapshot_date', ?)").run(new Date().toISOString());
    })();

    const productCount = Number((db.prepare('SELECT COUNT(*) AS count FROM catalog_products').get() as { count: number }).count);
    const actionCount = Number((db.prepare('SELECT COUNT(*) AS count FROM catalog_actions').get() as { count: number }).count);
    return { productCount, actionCount };
  } finally {
    db.close();
  }
}

function loadProduct(productSpec: SdkProductSpec): LoadedAction[] {
  const clientEntry = require.resolve(productSpec.packageName);
  const packageRoot = dirname(dirname(clientEntry));
  const clientDts = readFileSync(join(packageRoot, 'dist/client.d.ts'), 'utf8');
  const modelsDir = join(packageRoot, 'dist/models');
  const snapshot = loadCatalogMetaSnapshot(productSpec.product);
  const clientModule = require(productSpec.packageName);
  const Client = clientModule.default ?? clientModule;
  const methods = Object.getOwnPropertyNames(Client.prototype)
    .filter((method) => method !== 'constructor' && method !== 'getEndpoint')
    .filter((method) => !method.endsWith('WithOptions'));

  const loaded = methods.map((method) => {
    const action = toActionName(method);
    const requestClass = `${action}Request`;
    const requestFile = join(modelsDir, `${requestClass}.d.ts`);
    const requestDts = existsSync(requestFile) ? readFileSync(requestFile, 'utf8') : '';
    const required = extractRequiredParams(requestDts);
    const params = extractParams(requestDts);
    const methodDoc = extractMethodDoc(clientDts, method);
    const deprecated = /@deprecated/i.test(methodDoc);
    const replacedBy = extractReplacement(methodDoc);
    const summary = extractSummary(methodDoc) || `${productSpec.product} ${action}`;
    const danger = resolveDanger(productSpec.product, action);
    const keywords = `${productSpec.summaryKeywords} ${action} ${summary}`;

    return applySnapshotOverrides({
      product: productSpec.product,
      action,
      version: productSpec.version,
      method: 'POST',
      style: 'RPC',
      required: applyRequiredOverrides(productSpec.product, action, required),
      danger: danger.level,
      dangerSource: danger.source,
      summary,
      paramsBlob: JSON.stringify({ requestClass, params, dangerSource: danger.source, dangerRuleId: danger.ruleId }, null, 2),
      deprecated,
      replacedBy,
      keywords,
      deprecationSource: 'sdk'
    }, findSnapshotAction(snapshot, action), productSpec.summaryKeywords);
  });
  return appendAllowedSnapshotOnlyActions(productSpec, snapshot, loaded);
}

function discoverInstalledSdkProducts(): SdkProductSpec[] {
  const scopeDir = join(process.cwd(), 'node_modules/@alicloud');
  if (!existsSync(scopeDir)) return [];

  return readdirSync(scopeDir)
    .map((entry) => packageToSpec(entry))
    .filter((spec): spec is SdkProductSpec => Boolean(spec))
    .sort((a, b) => a.product.localeCompare(b.product));
}

function packageToSpec(entry: string): SdkProductSpec | null {
  const match = /^(.+?)(\d{8})$/.exec(entry);
  if (!match) return null;
  const packageName = `@alicloud/${entry}`;
  let clientEntry: string;
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
    endpointMap,
    summaryKeywords: KEYWORD_OVERRIDES[product] ?? `${product} aliyun openapi`
  };
}

function extractProductId(clientJs: string): string | null {
  return /getEndpoint\("([^"]+)"/.exec(clientJs)?.[1] ?? null;
}

function extractEndpointRule(clientJs: string): string | null {
  return /this\._endpointRule\s*=\s*"([^"]+)"/.exec(clientJs)?.[1] ?? null;
}

function extractEndpointMap(clientJs: string): string | null {
  const body = /this\._endpointMap\s*=\s*\{([\s\S]*?)\};/.exec(clientJs)?.[1];
  if (!body) return null;

  const endpointMap: Record<string, string> = {};
  const pairRegex = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pairRegex.exec(body))) {
    endpointMap[match[1]] = match[2];
  }
  return Object.keys(endpointMap).length ? JSON.stringify(endpointMap) : null;
}

function insertProduct(db: Database.Database, productSpec: SdkProductSpec, now: number): void {
  db.prepare(
    `INSERT INTO catalog_products
      (product, endpoint_mode, endpoint_tpl, endpoint_map, default_version, source, updated_at)
     VALUES (?, ?, ?, ?, ?, 'spec', ?)`
  ).run(
    productSpec.product,
    productSpec.endpointTpl.includes('{region}') ? 'regional' : 'global',
    productSpec.endpointTpl,
    productSpec.endpointMap,
    productSpec.version,
    now
  );
}

function insertAction(db: Database.Database, action: LoadedAction, now: number): void {
  db.prepare(
    `INSERT INTO catalog_actions
      (product, action, version, method, style, required_json, danger, summary_cn, params_blob, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'spec', ?)`
  ).run(
    action.product,
    action.action,
    action.version,
    action.method,
    action.style,
    JSON.stringify(action.required),
    action.danger,
    action.summary,
    action.paramsBlob,
    now
  );

  if (action.deprecated || action.replacedBy) {
    const deprecatedNote = action.deprecationSource === 'snapshot'
      ? 'Deprecated by OpenAPI metadata snapshot.'
      : 'Deprecated by SDK docs.';
    db.prepare(
      `INSERT INTO catalog_overlay
        (product, action, deprecated, replaced_by, keywords, note, danger_source_url, maintainer, test_case_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'system-loader', ?, ?)`
    ).run(
      action.product,
      action.action,
      action.deprecated ? 1 : 0,
      action.replacedBy,
      action.keywords,
      action.replacedBy ? `${deprecatedNote} Use ${action.replacedBy}.` : deprecatedNote,
      `${action.product}:${action.action}:sdk-deprecated`,
      now
    );
  }

  db.prepare(
    `INSERT INTO catalog_fts (doc_id, product, action, summary_cn, keywords)
     VALUES (?, ?, ?, ?, ?)`
  ).run(`${action.product}:${action.action}:${action.version}`, action.product, action.action, action.summary, action.keywords);
}

function appendAllowedSnapshotOnlyActions(
  productSpec: SdkProductSpec,
  snapshot: CatalogMetaSnapshot | null,
  loaded: LoadedAction[]
): LoadedAction[] {
  const allowed = SNAPSHOT_ONLY_ACTION_ALLOWLIST[productSpec.product];
  if (!allowed?.size) return loaded;

  const existing = new Set(loaded.map((action) => action.action.toLowerCase()));
  const snapshotActions = {
    ...(snapshot?.actions ?? {}),
    ...(productSpec.product === 'oss' ? OSSUTIL_EXTRA_ACTIONS : {})
  };
  const allowAll = allowed.has('*');
  const extraActions = Object.entries(snapshotActions)
    .filter(([action]) => (allowAll || allowed.has(action)) && !existing.has(action.toLowerCase()))
    .map(([action, snapshotAction]) => createSnapshotOnlyAction(productSpec, action, snapshotAction));
  return [...loaded, ...extraActions];
}

function createSnapshotOnlyAction(
  productSpec: SdkProductSpec,
  action: string,
  snapshotAction: CatalogMetaSnapshotAction
): LoadedAction {
  const override = productSpec.product === 'oss' ? OSS_RAW_ACTION_OVERRIDES[action] : undefined;
  const danger = resolveDanger(productSpec.product, action);
  const required = applyRequiredOverrides(
    productSpec.product,
    action,
    override?.required ?? normalizeSnapshotRequired(snapshotAction.required) ?? []
  );
  const summary = override?.summary ?? normalizeSnapshotString(snapshotAction.summary) ?? `${productSpec.product} ${action}`;
  return {
    product: productSpec.product,
    action,
    version: productSpec.version,
    method: resolveSnapshotOnlyMethod(action),
    style: 'ROA',
    required,
    danger: danger.level,
    dangerSource: danger.source,
    summary,
    paramsBlob: JSON.stringify(
      {
        requestClass: `${action}Request`,
        params: required.map((name) => ({
          name,
          type: name === 'BlockPublicAccess' ? 'boolean' : 'string',
          required: true
        })),
        source: 'catalog-meta:snapshot-only-allowlist',
        raw: {
          method: override?.raw.method ?? resolveSnapshotOnlyMethod(action),
          pathname: override?.raw.pathname,
          style: override?.raw.style ?? 'ROA',
          reqBodyType: override?.raw.reqBodyType ?? 'xml',
          bodyType: override?.raw.bodyType ?? 'xml'
        },
        dangerSource: danger.source,
        dangerRuleId: danger.ruleId
      },
      null,
      2
    ),
    deprecated: normalizeSnapshotBoolean(snapshotAction.deprecated) ?? false,
    replacedBy: normalizeSnapshotNullableString(snapshotAction.replacedBy) ?? null,
    keywords: `${productSpec.summaryKeywords} ${action} ${summary} public access block 阻止公共访问 公共访问`,
    deprecationSource: 'snapshot'
  };
}

function resolveSnapshotOnlyMethod(action: string): string {
  if (action.startsWith('Get')) return 'GET';
  if (action.startsWith('Delete')) return 'DELETE';
  return 'PUT';
}

function toActionName(method: string): string {
  return method.charAt(0).toUpperCase() + method.slice(1);
}

function extractMethodDoc(clientDts: string, method: string): string {
  const regex = new RegExp(`/\\*\\*([\\s\\S]*?)\\*/\\s*${method}\\(`, 'm');
  return regex.exec(clientDts)?.[1] ?? '';
}

function extractSummary(methodDoc: string): string {
  return methodDoc
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('@'))
    .slice(0, 2)
    .join(' ')
    .slice(0, 500);
}

function extractReplacement(methodDoc: string): string | null {
  const match = /use\s+[A-Za-z]+::[0-9-]+::([A-Za-z0-9]+)\s+instead/i.exec(methodDoc);
  return match?.[1] ?? null;
}

function loadCatalogMetaSnapshot(product: string): CatalogMetaSnapshot | null {
  const snapshotDir = join(process.cwd(), 'catalog-meta');
  if (!existsSync(snapshotDir)) return null;

  const snapshotFile = join(snapshotDir, `${product}.json`);
  if (!existsSync(snapshotFile)) return null;

  try {
    const parsed = JSON.parse(readFileSync(snapshotFile, 'utf8')) as CatalogMetaSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function findSnapshotAction(snapshot: CatalogMetaSnapshot | null, action: string): CatalogMetaSnapshotAction | undefined {
  if (!snapshot?.actions || typeof snapshot.actions !== 'object') return undefined;
  return snapshot.actions[action] ?? snapshot.actions[toLowerCamelAction(action)] ?? findCaseInsensitiveSnapshotAction(snapshot.actions, action);
}

function toLowerCamelAction(action: string): string {
  return action.charAt(0).toLowerCase() + action.slice(1);
}

function findCaseInsensitiveSnapshotAction(actions: Record<string, CatalogMetaSnapshotAction>, action: string): CatalogMetaSnapshotAction | undefined {
  const lowerAction = action.toLowerCase();
  const match = Object.entries(actions).find(([candidate]) => candidate.toLowerCase() === lowerAction);
  return match?.[1];
}

function applySnapshotOverrides(action: LoadedAction, snapshotAction: CatalogMetaSnapshotAction | undefined, summaryKeywords: string): LoadedAction {
  if (!snapshotAction || typeof snapshotAction !== 'object') return applyActionSummaryOverride(action, summaryKeywords);

  const next: LoadedAction = { ...action };
  if (hasOwn(snapshotAction, 'required')) {
    const required = normalizeSnapshotRequired(snapshotAction.required);
    if (required) {
      next.required = required;
      next.paramsBlob = updateParamsBlobRequired(action.paramsBlob, required);
    }
  }

  if (hasOwn(snapshotAction, 'deprecated')) {
    const deprecated = normalizeSnapshotBoolean(snapshotAction.deprecated);
    if (deprecated !== null) {
      next.deprecated = deprecated;
      next.deprecationSource = 'snapshot';
    }
  }

  if (hasOwn(snapshotAction, 'replacedBy')) {
    const replacedBy = normalizeSnapshotNullableString(snapshotAction.replacedBy);
    if (replacedBy !== undefined) {
      next.replacedBy = replacedBy;
      next.deprecationSource = 'snapshot';
    }
  }

  if (hasOwn(snapshotAction, 'summary')) {
    const summary = normalizeSnapshotString(snapshotAction.summary);
    if (summary) {
      next.summary = summary;
      next.keywords = `${summaryKeywords} ${action.action} ${summary}`;
    }
  }

  return applyActionSummaryOverride(next, summaryKeywords);
}

function applyActionSummaryOverride(action: LoadedAction, summaryKeywords: string): LoadedAction {
  const summary = ACTION_SUMMARY_OVERRIDES[action.product]?.[action.action];
  if (!summary) return action;
  return {
    ...action,
    summary,
    keywords: `${summaryKeywords} ${action.action} ${summary}`
  };
}

function hasOwn<T extends object>(value: T, property: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function normalizeSnapshotRequired(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return unique(value.map((item) => normalizeSnapshotString(item)).filter((item): item is string => Boolean(item)));
}

function normalizeSnapshotBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  if (/^true$/i.test(value.trim())) return true;
  if (/^false$/i.test(value.trim())) return false;
  return null;
}

function normalizeSnapshotNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  const normalized = normalizeSnapshotString(value);
  return normalized === null ? undefined : normalized;
}

function normalizeSnapshotString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function updateParamsBlobRequired(paramsBlob: string, required: string[]): string {
  try {
    const parsed = JSON.parse(paramsBlob) as { params?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.params)) return paramsBlob;
    const requiredSet = new Set(required);
    const params = parsed.params.map((param) => {
      if (!param || typeof param !== 'object' || typeof (param as { name?: unknown }).name !== 'string') return param;
      return {
        ...param,
        required: requiredSet.has((param as { name: string }).name)
      };
    });
    return JSON.stringify({ ...parsed, params }, null, 2);
  } catch {
    return paramsBlob;
  }
}

function extractParams(requestDts: string): Array<{ name: string; type: string; required: boolean }> {
  if (!requestDts) return [];
  const required = new Set(extractRequiredPropertyNames(requestDts));
  const params: Array<{ name: string; type: string; required: boolean }> = [];
  const propertyRegex = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\?:\s*([^;]+);/gm;
  let match: RegExpExecArray | null;
  while ((match = propertyRegex.exec(requestDts))) {
    params.push({
      name: toApiParamName(match[1]),
      type: match[2].trim(),
      required: required.has(match[1])
    });
  }
  return params;
}

function extractRequiredParams(requestDts: string): string[] {
  return extractRequiredPropertyNames(requestDts).map(toApiParamName);
}

function extractRequiredPropertyNames(requestDts: string): string[] {
  const required: string[] = [];
  const propertyWithCommentRegex = /\/\*\*([\s\S]*?)\*\/\s*([a-zA-Z_][a-zA-Z0-9_]*)\?:/g;
  let match: RegExpExecArray | null;
  while ((match = propertyWithCommentRegex.exec(requestDts))) {
    if (hasRequiredMarker(match[1])) {
      required.push(match[2]);
    }
  }
  return required;
}

function hasRequiredMarker(comment: string): boolean {
  const lines = comment
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean);

  return lines.some((line) => {
    if (/^@required\b/i.test(line)) return true;
    if (/^required\s*:/i.test(line)) return true;
    return /(?:^|[.!?]\s+)this parameter is (?:required|mandatory)\.(?:\s|$)/i.test(line);
  });
}

function toApiParamName(propertyName: string): string {
  return propertyName.charAt(0).toUpperCase() + propertyName.slice(1);
}

function resolveDanger(product: string, action: string): { level: 'safe' | 'write' | 'dangerous'; source: string; ruleId: string } {
  const rule = DANGER_RULES.find((candidate) => {
    if (candidate.product && candidate.product !== product) return false;
    return candidate.action.test(action);
  });
  if (rule) {
    return { level: rule.level, source: rule.source, ruleId: rule.id };
  }
  return {
    level: 'write',
    source: 'loader-rule:default-unknown-actions-require-approval',
    ruleId: 'default-unknown-actions-require-approval'
  };
}

function applyRequiredOverrides(product: string, action: string, required: string[]): string[] {
  if (product === 'oss' && ['GetBucketPublicAccessBlock', 'DeleteBucketPublicAccessBlock'].includes(action)) {
    return unique([...required, 'bucket']);
  }
  if (product === 'oss' && action === 'PutBucketPublicAccessBlock') {
    return unique([...required, 'bucket', 'BlockPublicAccess']);
  }
  if (product === 'oss' && action === 'PutPublicAccessBlock') {
    return unique([...required, 'BlockPublicAccess']);
  }
  if (product === 'dysmsapi' && action === 'CreateSmsTemplate') {
    return unique(['TemplateContent', 'TemplateName', 'TemplateType', 'TemplateRule', 'RelatedSignName']);
  }
  return unique(required);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
