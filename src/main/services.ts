import Database from 'better-sqlite3';
import { BrowserWindow, safeStorage } from 'electron';
import { Agent, OpenAIProvider, Runner, RunState, tool } from '@openai/agents';
import type { RunToolApprovalItem } from '@openai/agents';
import OpenAI from 'openai';
import OpenApiClient, {
  Config as OpenApiConfig,
  OpenApiRequest,
  Params as OpenApiParams
} from '@alicloud/openapi-client';
import OssClient, {
  CreateBucketConfiguration,
  ListBucketsHeaders,
  ListBucketsRequest,
  PutBucketAclHeaders,
  PutBucketHeaders,
  PutBucketPolicyRequest,
  PutBucketRequest
} from '@alicloud/oss20190517';
import * as OssSdk from '@alicloud/oss20190517';
import { RuntimeOptions } from '@alicloud/tea-util';
import chokidar, { type FSWatcher } from 'chokidar';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type {
  AgentSendMessageInput,
  AgentSendMessageResult,
  AgentRendererEvents,
  AuditRow,
  ApprovalRequest,
  BootstrapState,
  CatalogRefreshResult,
  CatalogStatus,
  CancelRunInput,
  CancelRunResult,
  CatalogFactPointer,
  ContextDocumentPointer,
  CreateSessionInput,
  DeleteSessionInput,
  DeleteSessionResult,
  DecideMemoryCandidateInput,
  DecideApprovalInput,
  InstallSkillsResult,
  LlmSettings,
  MemoryCandidate,
  Message,
  Profile,
  RunStep,
  SaveLlmSettingsInput,
  SaveSkillInput,
  SaveProfileInput,
  ScheduledTask,
  SelectSessionSkillInput,
  Session,
  SkillDetail,
  SkillSummary,
  SessionSkillPointer,
  TaskExecution,
  UpdateSessionTrustModeInput,
  Workspace
} from '../shared/types';
import { ensureCatalogDb, type DatabaseBundle } from './db';
import { loadOfficialSdkCatalog } from './catalogLoader';
import { buildWebsiteConfiguration, putBucketWebsiteWithRootXml } from './ossWebsite';
import { invokePublicAccessBlockAction, isPublicAccessBlockAction } from './ossPublicAccessBlock';

class RunCancelledError extends Error {
  constructor() {
    super('用户已取消本轮运行');
    this.name = 'RunCancelledError';
  }
}

type ActiveRunHandle = { controller: AbortController; cancelled: boolean };

type Row = Record<string, unknown>;
type ProfileCredentialRow = {
  akIdMasked: string | null;
  akIdEncrypted: string | null;
  akSecretEncrypted: string | null;
};
type AliyunCredentials = { akId: string; akSecret: string; akIdMasked: string | null };
type LlmRuntimeSettings = { model: string | null; baseUrl: string | null; apiKey: string | null };
type SchedulerLogEntry = { at: number; level: 'info' | 'warn' | 'error'; message: string; data?: unknown };
type SystemTaskAction = 'extract_memory_facts' | 'promote_error_skills';
type GatewayStatus =
  | 'SUCCESS'
  | 'REJECTED_BY_GATEWAY'
  | 'REJECTED_BY_USER'
  | 'AWAITING_APPROVAL'
  | 'FAILED_BY_ALIYUN'
  | 'SKIPPED_DRY_RUN';
type CatalogActionRow = {
  product: string;
  action: string;
  version: string;
  method: string;
  style: string;
  requiredJson: string;
  danger: 'safe' | 'write' | 'dangerous';
  summaryCn: string | null;
  paramsBlob: string | null;
  endpointTpl: string;
  endpointMap: string | null;
  defaultVersion: string | null;
  deprecated: number | null;
  replacedBy: string | null;
  aliasProduct?: string | null;
};
type CatalogLookup = { product: string; action: string; version: string };

function normalizeNullish(v: unknown): unknown {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === '' || t === 'null' || t === 'undefined' || t === 'none') return null;
  }
  return v;
}

function looseNumber() {
  return z.coerce.number();
}

function looseBool() {
  return z.preprocess((v) => {
    const n = normalizeNullish(v);
    if (n === null) return null;
    if (typeof n === 'boolean') return n;
    const s = String(n).trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    return n;
  }, z.boolean().nullable());
}

function looseNullableString() {
  return z.preprocess(normalizeNullish, z.string().nullable());
}

// Required string: strips nullish-looking values then validates non-null string
function looseString() {
  return z.preprocess(normalizeNullish, z.string());
}

function looseRecord() {
  return z.preprocess((v) => {
    const n = normalizeNullish(v);
    if (n === null) return null;
    if (typeof n === 'string') {
      try {
        const p = JSON.parse(n);
        if (p && typeof p === 'object' && !Array.isArray(p)) return p;
      } catch {}
      const text = n.trim();
      if (text.startsWith('{') && text.endsWith('}')) {
        const body = text.slice(1, -1).trim();
        if (!body) return {};
        const record: Record<string, unknown> = {};
        let parsed = true;
        for (const entry of body.split(',')) {
          const separator = entry.indexOf(':');
          if (separator <= 0) {
            parsed = false;
            break;
          }
          const key = entry.slice(0, separator).trim().replace(/^['"]|['"]$/g, '');
          const value = entry.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
          if (!key) {
            parsed = false;
            break;
          }
          record[key] = value;
        }
        if (parsed) return record;
      }
    }
    return n;
  }, z.record(z.string(), z.unknown()).nullable());
}

function normalizeVersion(v: string | undefined | null): string | undefined {
  const normalized = normalizeNullish(v);
  if (normalized === null || normalized === undefined) return undefined;
  const value = String(normalized).trim();
  if (!value) return undefined;
  return value;
}

type GatewayResult = {
  ok: boolean;
  status: GatewayStatus;
  product: string;
  action: string;
  version: string | null;
  danger: 'safe' | 'write' | 'dangerous' | null;
  resolvedEndpoint: string | null;
  required: string[];
  missing: string[];
  injectedParams: Record<string, string>;
  deprecated: boolean | null;
  replacedBy: string | null;
  requestId: string | null;
  response: unknown;
  errorCode: string | null;
  errorMessage: string | null;
};
type AliyunProviderInput = {
  sessionId?: string | null;
  runId?: string | null;
  profileId: string;
  profileName: string;
  product: string;
  action: string;
  version: string;
  regionId: string;
  endpoint: string;
  params: Record<string, unknown>;
  injectedParams?: Record<string, string>;
  catalogMethod?: string | null;
  catalogStyle?: string | null;
  catalogParamsBlob?: string | null;
};
type AliyunApiProvider = {
  name: string;
  invoke(input: AliyunProviderInput): Promise<unknown>;
};
type AgentRunCompletion = {
  output: string;
  interrupted: boolean;
  interruptionCount: number;
};
type AgentRuntimeBundle = {
  agent: Agent;
  runner: Runner;
};
type TraceEventInput = {
  sessionId?: string | null;
  runId?: string | null;
  event: string;
  target?: string | null;
  status?: string;
  durationMs?: number;
  meta?: unknown;
};
type TraceLevel = 'info' | 'warn' | 'error';
type TraceLine = {
  at: number;
  sessionId: string | null;
  runId: string | null;
  event: string;
  target: string | null;
  status: string;
  level: TraceLevel;
  durationMs: number | null;
  meta: unknown;
};
type TraceRunState = {
  sessionId: string | null;
  startedAt: number;
  endedAt: number;
  eventCounts: Record<string, number>;
  llmMs: number;
  cloudMs: number;
  llmRoundTrips: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokenUsageSeen: boolean;
  gatewayStatusCounts: Record<string, number>;
  gatewayErrorCodeCounts: Record<string, number>;
  toolCounts: Record<string, { success: number; failed: number }>;
};

const DEFAULT_OPENAPI_TIMEOUT_MS = 30_000;
const AGENT_MAX_TURNS = 200;
const AGENT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const TRACE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const TRACE_LOG_MAX_ARCHIVES = 3;
const WORKSPACE_MAX_FILE_BYTES = 1024 * 1024;
// profile 级账号参数 → 调用参数 的兜底映射。仅在 catalog 声明为必填、且模型未显式提供时，用 profile 配置兜底注入。
const PROFILE_PARAM_FALLBACKS: Record<string, (profile: Profile) => string | null | undefined> = {
  organizationId: (profile) => profile.rdcId
};
const WORKSPACE_INDEX_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.ini',
  '.conf',
  '.env',
  '.sql',
  '.xml'
]);
const WORKSPACE_SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.next', '.vite', 'coverage']);

const SYSTEM_TASK_PROMPTS: Record<SystemTaskAction, string> = {
  extract_memory_facts: [
    '你是 Aliy Agent 的后台记忆巩固 Agent。',
    '只从本地历史会话中提取长期有效的事实、偏好、约束或环境约定。',
    '不要把一次性的闲聊、临时任务、未确认猜测写入长期记忆。',
    '接口事实、产品名、Action 名和 endpoint 不能写进自由文本记忆；这类事实必须进入 catalog_overlay 或 catalog_aliases。',
    '输出必须可审计：每条事实要有来源时间、去重 hash，并能被用户删除或复核。'
  ].join('\n'),
  promote_error_skills: [
    '你是 Aliy Agent 的错误复盘与技能升格 Agent。',
    '只分析本地审计表 tool_invocations 中失败、拒绝或网关拦截的结构化错误。',
    '目标是找到可复用的错误模式，并整理成下一次 Agent 可加载的 Playbook 技能。',
    '不要编造接口事实；遇到别名、弃用 Action、缺失必填参数时，要求先查询 catalog.db。',
    '后台调度任务的 dangerous 操作不能因为来自调度器而免除首次授权确认。'
  ].join('\n')
};

class TraceLogger {
  readonly logPath: string;
  private readonly runStates = new Map<string, TraceRunState>();

  constructor(appDbPath: string) {
    const userDataDir = dirname(dirname(appDbPath));
    const logDir = join(userDataDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    this.logPath = join(logDir, 'run-trace.jsonl');
  }

  event(input: TraceEventInput): void {
    try {
      const status = input.status ?? 'info';
      const line: TraceLine = {
        at: Date.now(),
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        event: input.event,
        target: input.target ?? null,
        status,
        level: traceLevelForStatus(status),
        durationMs: input.durationMs ?? null,
        meta: sanitizeTraceMeta(input.meta)
      };
      try {
        this.accumulateRun(line);
      } catch {
        // Trace aggregation is diagnostic only.
      }
      try {
        this.rotateIfNeeded();
      } catch {
        // Rotation must never break append.
      }
      appendFileSync(this.logPath, `${JSON.stringify(line)}\n`, 'utf8');
    } catch {
      // Trace logging must never break the product path.
    }
  }

  finalizeRun(runId: string, finalStatus: string): void {
    try {
      const state = this.runStates.get(runId);
      const endedAt = Date.now();
      const startedAt = state?.startedAt ?? endedAt;
      const meta = {
        finalStatus,
        startedAt,
        endedAt,
        wallMs: Math.max(0, endedAt - startedAt),
        eventCounts: state?.eventCounts ?? {},
        llmMs: state?.llmMs ?? 0,
        cloudMs: state?.cloudMs ?? 0,
        llmRoundTrips: state?.llmRoundTrips ?? 0,
        tokens: {
          prompt: state?.promptTokens ?? 0,
          completion: state?.completionTokens ?? 0,
          total: state?.totalTokens ?? 0,
          seen: state?.tokenUsageSeen ?? false
        },
        gatewayStatusCounts: state?.gatewayStatusCounts ?? {},
        gatewayErrorCodeCounts: state?.gatewayErrorCodeCounts ?? {},
        toolCounts: state?.toolCounts ?? {}
      };
      this.event({
        sessionId: state?.sessionId ?? null,
        runId,
        event: 'run_digest',
        status: digestTraceStatus(finalStatus),
        durationMs: meta.wallMs,
        meta
      });
    } catch {
      // Digest logging must never break the product path.
    } finally {
      try {
        this.runStates.delete(runId);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  async measure<T>(
    input: Omit<TraceEventInput, 'event' | 'status' | 'durationMs'> & { event: string },
    fn: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    this.event({ ...input, event: `${input.event}_start`, status: 'start' });
    try {
      const result = await fn();
      this.event({
        ...input,
        event: `${input.event}_end`,
        status: 'success',
        durationMs: Date.now() - startedAt,
        meta: summarizeTraceResult(input.meta, result)
      });
      return result;
    } catch (error) {
      this.event({
        ...input,
        event: `${input.event}_end`,
        status: 'error',
        durationMs: Date.now() - startedAt,
        meta: {
          request: sanitizeTraceMeta(input.meta),
          error: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }
  }

  private accumulateRun(line: TraceLine): void {
    if (!line.runId || line.event === 'run_digest') return;
    const state = this.getRunState(line);
    state.endedAt = Math.max(state.endedAt, line.at);
    if (!state.sessionId && line.sessionId) state.sessionId = line.sessionId;
    incrementCounter(state.eventCounts, line.event);

    if (line.event === 'llm_http_request') {
      state.llmRoundTrips += 1;
      return;
    }
    if (line.event === 'llm_http_response') {
      state.llmMs += line.durationMs ?? 0;
      this.accumulateTokenUsage(state, line.meta);
      return;
    }
    if (line.event === 'aliyun_sdk_end' || line.event === 'aliyun_cli_end') {
      state.cloudMs += line.durationMs ?? 0;
      return;
    }
    if (line.event === 'gateway_end') {
      const meta = traceMetaRecord(line.meta);
      const gatewayStatus = stringTraceValue(meta?.gatewayStatus) ?? line.status;
      incrementCounter(state.gatewayStatusCounts, gatewayStatus);
      const errorCode = stringTraceValue(meta?.errorCode);
      if (errorCode) incrementCounter(state.gatewayErrorCodeCounts, errorCode);
      return;
    }
    if (line.event === 'tool_end') {
      const target = line.target ?? '(unknown)';
      const counts = state.toolCounts[target] ?? { success: 0, failed: 0 };
      if (isTraceSuccessStatus(line.status)) {
        counts.success += 1;
      } else {
        counts.failed += 1;
      }
      state.toolCounts[target] = counts;
    }
  }

  private getRunState(line: TraceLine): TraceRunState {
    const existing = line.runId ? this.runStates.get(line.runId) : undefined;
    if (existing) return existing;
    const state: TraceRunState = {
      sessionId: line.sessionId,
      startedAt: line.at,
      endedAt: line.at,
      eventCounts: {},
      llmMs: 0,
      cloudMs: 0,
      llmRoundTrips: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokenUsageSeen: false,
      gatewayStatusCounts: {},
      gatewayErrorCodeCounts: {},
      toolCounts: {}
    };
    if (line.runId) this.runStates.set(line.runId, state);
    return state;
  }

  private accumulateTokenUsage(state: TraceRunState, meta: unknown): void {
    const usage = traceMetaRecord(traceMetaRecord(meta)?.usage);
    if (!usage) return;
    const promptTokens = numberTraceValue(usage.prompt_tokens);
    const completionTokens = numberTraceValue(usage.completion_tokens);
    const totalTokens = numberTraceValue(usage.total_tokens);
    if (promptTokens !== null) {
      state.promptTokens += promptTokens;
      state.totalTokens += promptTokens;
      state.tokenUsageSeen = true;
    }
    if (completionTokens !== null) {
      state.completionTokens += completionTokens;
      state.totalTokens += completionTokens;
      state.tokenUsageSeen = true;
    }
    if (promptTokens === null && completionTokens === null && totalTokens !== null) {
      state.totalTokens += totalTokens;
      state.tokenUsageSeen = true;
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logPath)) return;
      const stats = statSync(this.logPath);
      if (!stats.isFile() || stats.size <= TRACE_LOG_MAX_BYTES) return;
      const archivePath = join(dirname(this.logPath), `run-trace.${formatTraceArchiveTimestamp(Date.now())}.jsonl`);
      renameSync(this.logPath, archivePath);
      this.pruneArchives();
    } catch {
      // Trace rotation is best-effort only.
    }
  }

  private pruneArchives(): void {
    try {
      const logDir = dirname(this.logPath);
      const archives = readdirSync(logDir)
        .filter((name) => /^run-trace\..+\.jsonl$/.test(name))
        .map((name) => {
          const path = join(logDir, name);
          return { path, mtimeMs: statSync(path).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const archive of archives.slice(TRACE_LOG_MAX_ARCHIVES)) {
        try {
          unlinkSync(archive.path);
        } catch {
          // Best-effort cleanup.
        }
      }
    } catch {
      // Trace rotation cleanup is best-effort only.
    }
  }
}

function traceLevelForStatus(status: string): TraceLevel {
  const normalized = status.toLowerCase();
  if (normalized === 'error') return 'error';
  if (normalized.includes('reject') || normalized.includes('awaiting')) return 'warn';
  return 'info';
}

function digestTraceStatus(finalStatus: string): string {
  const normalized = finalStatus.toLowerCase();
  if (normalized.includes('fail') || normalized === 'error') return 'error';
  if (normalized.includes('reject')) return 'REJECTED_BY_USER';
  if (normalized.includes('awaiting')) return 'AWAITING_APPROVAL';
  if (normalized.includes('complete') || normalized === 'success') return 'success';
  return finalStatus;
}

function incrementCounter(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function traceMetaRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringTraceValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function numberTraceValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isTraceSuccessStatus(status: string): boolean {
  return status === 'success' || status === 'ok' || status === 'SUCCESS';
}

function formatTraceArchiveTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

export class AppServices {
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private readonly runningTasks = new Set<string>();
  private readonly workspaceWatchers = new Map<string, FSWatcher>();
  private readonly workspaceReindexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private readonly trace: TraceLogger;

  constructor(private readonly dbs: DatabaseBundle) {
    this.trace = new TraceLogger(dbs.appDbPath);
  }

  startScheduler(): void {
    if (this.schedulerTimer) return;
    this.ensureSystemTasks();
    this.startWorkspaceWatchers();
    void this.tickScheduler();
    this.schedulerTimer = setInterval(() => void this.tickScheduler(), 60_000);
  }

  stopScheduler(): void {
    if (!this.schedulerTimer) return;
    clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    for (const timer of this.workspaceReindexTimers.values()) clearTimeout(timer);
    this.workspaceReindexTimers.clear();
    for (const watcher of this.workspaceWatchers.values()) void watcher.close();
    this.workspaceWatchers.clear();
  }

  bootstrap(): BootstrapState {
    this.ensureSystemTasks();
    return {
      status: {
        appDbPath: this.dbs.appDbPath,
        catalogDbPath: this.dbs.catalogDbPath,
        workspaceIndexReady: true,
        catalogAttached: existsSync(this.dbs.catalogDbPath)
      },
      llmSettings: this.getLlmSettings(),
      catalogStatus: this.getCatalogStatus(),
      workspaces: this.listWorkspaces(),
      profiles: this.listProfiles(),
      sessions: this.listSessions(),
      messages: this.listMessages(),
      runSteps: this.listRunSteps(),
      contextDocuments: this.listContextDocuments(),
      catalogFacts: this.listCatalogFacts(),
      skills: this.listSkills(),
      sessionSkills: this.listSessionSkills(),
      scheduledTasks: this.listScheduledTasks(),
      taskExecutions: this.listTaskExecutions(),
      memoryCandidates: this.listMemoryCandidates(),
      auditRows: this.listAuditRows(),
      approvalRequests: this.listApprovalRequests()
    };
  }

  refreshCatalog(): CatalogRefreshResult {
    ensureCatalogDb(this.dbs.catalogDbPath);
    const loaded = loadOfficialSdkCatalog(this.dbs.catalogDbPath);
    const status = this.inspectCatalogDb();
    const now = Date.now();
    const isLoaded = loaded.actionCount > 0;
    const refreshStatus = isLoaded ? 'success' : 'failed';
    const message = isLoaded
      ? `catalog.db 已从官方阿里云 SDK 刷新：${status.productCount} 个产品，${status.actionCount} 个 Action。`
      : 'catalog SDK loader 没有抽取到任何 Action，刷新失败。';

    this.dbs.appDb
      .prepare(
        `INSERT INTO catalog_refresh_state
          (id, status, message, product_count, action_count, refreshed_at)
         VALUES ('default', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          message = excluded.message,
          product_count = excluded.product_count,
          action_count = excluded.action_count,
          refreshed_at = excluded.refreshed_at`
      )
      .run(refreshStatus, message, status.productCount, status.actionCount, now);

    this.writeAuditEvent('catalog.refresh', {
      catalogDbPath: this.dbs.catalogDbPath,
      productCount: status.productCount,
      actionCount: status.actionCount,
      loaderConnected: true,
      refreshStatus
    });

    return { status: this.getCatalogStatus(), changed: true };
  }

  mountWorkspace(rootPath: string): Workspace {
    const now = Date.now();
    const workspace: Workspace = {
      id: randomUUID(),
      name: basename(rootPath) || rootPath,
      rootPath,
      activeProfileId: null,
      createdAt: now,
      updatedAt: now
    };

    this.dbs.appDb
      .prepare(
        `INSERT INTO workspaces (id, name, root_path, active_profile_id, created_at, updated_at)
         VALUES (@id, @name, @rootPath, @activeProfileId, @createdAt, @updatedAt)`
      )
      .run(workspace);
    indexWorkspaceRoot(this.dbs.appDb, workspace);
    this.startWorkspaceWatcher(workspace);
    this.ensureSystemTasks();
    return workspace;
  }

  saveProfile(input: SaveProfileInput): Profile {
    const now = Date.now();
    const id = input.id || randomUUID();
    const existing = this.dbs.appDb
      .prepare(
        `SELECT id, created_at AS createdAt, ak_id_masked AS akIdMasked,
                ak_id_encrypted AS akIdEncrypted, ak_secret_encrypted AS akSecretEncrypted
         FROM profiles WHERE id = ?`
      )
      .get(id) as (ProfileCredentialRow & { id: string; createdAt: number }) | undefined;
    const akIdInput = input.akId?.trim() ?? '';
    const secretInput = input.secret?.trim() ?? '';
    const hasCredentialInput = Boolean(akIdInput || secretInput);
    if (hasCredentialInput && (!akIdInput || !secretInput)) {
      throw new Error('保存阿里云凭证时，AccessKey ID 和 AccessKey Secret 必须同时填写。');
    }
    if (!existing && !hasCredentialInput) {
      throw new Error('新建 Profile 必须填写 AccessKey ID 和 AccessKey Secret。');
    }
    const akIdMasked = hasCredentialInput ? maskAk(akIdInput) : existing?.akIdMasked ?? null;
    const akIdEncrypted = hasCredentialInput
      ? encryptRequiredSecret(akIdInput, 'AccessKey ID')
      : existing?.akIdEncrypted ?? null;
    const akSecretEncrypted = hasCredentialInput
      ? encryptRequiredSecret(secretInput, 'AccessKey Secret')
      : existing?.akSecretEncrypted ?? null;
    const profile: Profile = {
      id,
      name: input.name.trim(),
      akIdMasked,
      rdcId: normalizeNullable(input.rdcId),
      defaultRegion: normalizeNullable(input.defaultRegion),
      createdAt: now,
      updatedAt: now
    };

    if (existing) {
      profile.createdAt = Number(existing.createdAt);
      this.dbs.appDb
        .prepare(
          `UPDATE profiles
           SET name = @name,
               ak_id_encrypted = @akIdEncrypted,
               ak_secret_encrypted = @akSecretEncrypted,
               ak_id_masked = @akIdMasked,
               rdc_id = @rdcId,
               default_region = @defaultRegion, updated_at = @updatedAt
           WHERE id = @id`
        )
        .run({ ...profile, akIdEncrypted, akSecretEncrypted });
    } else {
      this.dbs.appDb
        .prepare(
          `INSERT INTO profiles
            (id, name, ak_id_encrypted, ak_secret_encrypted, ak_id_masked, rdc_id, default_region, created_at, updated_at)
           VALUES
            (@id, @name, @akIdEncrypted, @akSecretEncrypted, @akIdMasked, @rdcId, @defaultRegion, @createdAt, @updatedAt)`
        )
        .run({ ...profile, akIdEncrypted, akSecretEncrypted });
    }

    this.writeAuditEvent('profile.saved', {
      profileId: id,
      hasSecretInput: hasCredentialInput,
      secretPersisted: Boolean(akIdEncrypted && akSecretEncrypted)
    });
    this.ensureSystemTasks();
    return profile;
  }

  saveLlmSettings(input: SaveLlmSettingsInput): LlmSettings {
    const now = Date.now();
    const provider = normalizeNullable(input.provider);
    const model = normalizeNullable(input.model);
    const baseUrl = normalizeNullable(input.baseUrl);
    const apiKeyMasked = input.apiKey ? maskSecret(input.apiKey) : this.getLlmSettings().apiKeyMasked;
    const encrypted = input.apiKey ? encryptSecret(input.apiKey) : this.getExistingEncryptedLlmKey();

    this.dbs.appDb
      .prepare(
        `INSERT INTO llm_settings
          (id, provider, model, base_url, api_key_encrypted, api_key_masked, created_at, updated_at)
         VALUES ('default', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          base_url = excluded.base_url,
          api_key_encrypted = excluded.api_key_encrypted,
          api_key_masked = excluded.api_key_masked,
          updated_at = excluded.updated_at`
      )
      .run(provider, model, baseUrl, encrypted, apiKeyMasked, now, now);

    this.writeAuditEvent('llm_settings.saved', {
      provider,
      model,
      baseUrl,
      hasApiKeyInput: Boolean(input.apiKey),
      apiKeyPersistedEncrypted: Boolean(encrypted)
    });
    return this.getLlmSettings();
  }

  installSkillsFromDirectory(rootPath: string | null): InstallSkillsResult {
    if (!rootPath) return { installed: [], skipped: [], rootPath: null };

    const skillDirs = findSkillDirectories(rootPath);
    const installed: SkillSummary[] = [];
    const skipped: string[] = [];

    for (const skillDir of skillDirs) {
      try {
        const skill = this.saveSkill(parseSkillDirectory(skillDir));
        installed.push({ id: skill.id, title: skill.title, description: skill.description });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push(`${skillDir}: ${reason}`);
      }
    }

    this.writeAuditEvent('skill.install_directory', {
      rootPath,
      installedCount: installed.length,
      skippedCount: skipped.length
    });

    return { installed, skipped, rootPath };
  }

  saveSkill(input: SaveSkillInput): SkillDetail {
    const title = input.title.trim();
    const description = input.description.trim();
    const body = input.body.trim();
    if (!title || !description || !body) {
      throw new Error('技能标题、描述和正文不能为空。');
    }

    const now = Date.now();
    const id = input.id?.trim() || slugifySkillId(title);
    const existing = this.dbs.appDb.prepare('SELECT created_at FROM skills WHERE id = ?').get(id) as Row | undefined;
    const skill: SkillDetail = {
      id,
      title,
      description,
      body,
      keywords: normalizeNullable(input.keywords),
      sourcePath: normalizeNullable(input.sourcePath),
      createdAt: existing ? Number(existing.created_at) : now,
      updatedAt: now
    };

    this.dbs.appDb
      .prepare(
        `INSERT INTO skills (id, title, description, body, keywords, source_path, created_at, updated_at)
         VALUES (@id, @title, @description, @body, @keywords, @sourcePath, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          body = excluded.body,
          keywords = excluded.keywords,
          source_path = excluded.source_path,
          updated_at = excluded.updated_at`
      )
      .run(skill);

    this.writeAuditEvent('skill.saved', {
      skillId: id,
      title,
      hasKeywords: Boolean(skill.keywords)
    });

    return this.loadSkill(id);
  }

  selectSessionSkill(input: SelectSessionSkillInput): SessionSkillPointer {
    const now = Date.now();
    this.dbs.appDb
      .prepare(
        `INSERT INTO session_skills (session_id, skill_id, selected_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id, skill_id) DO UPDATE SET selected_at = excluded.selected_at`
      )
      .run(input.sessionId, input.skillId, now);

    this.writeAuditEvent('session_skill.selected', {
      sessionId: input.sessionId,
      skillId: input.skillId
    });

    const row = this.dbs.appDb
      .prepare(
        `SELECT ss.session_id AS sessionId, s.id, s.title, s.description, ss.selected_at AS selectedAt
         FROM session_skills ss
         JOIN skills s ON s.id = ss.skill_id
         WHERE ss.session_id = ? AND ss.skill_id = ?`
      )
      .get(input.sessionId, input.skillId) as SessionSkillPointer | undefined;
    if (!row) throw new Error(`技能不存在：${input.skillId}`);
    return row;
  }

  removeSessionSkill(input: SelectSessionSkillInput): void {
    this.dbs.appDb.prepare('DELETE FROM session_skills WHERE session_id = ? AND skill_id = ?').run(input.sessionId, input.skillId);
    this.writeAuditEvent('session_skill.removed', {
      sessionId: input.sessionId,
      skillId: input.skillId
    });
  }

  createSession(input: CreateSessionInput): Session {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      title: input.title?.trim() || '未命名会话',
      trustMode: 'strict',
      status: 'active',
      createdAt: now,
      updatedAt: now
    };

    this.dbs.appDb
      .prepare(
        `INSERT INTO sessions (id, workspace_id, profile_id, title, trust_mode, status, created_at, updated_at)
         VALUES (@id, @workspaceId, @profileId, @title, @trustMode, @status, @createdAt, @updatedAt)`
      )
      .run(session);
    this.ensureSystemTasks();
    return session;
  }

  async updateSessionTrustMode(input: UpdateSessionTrustModeInput): Promise<Session> {
    const now = Date.now();
    this.dbs.appDb
      .prepare('UPDATE sessions SET trust_mode = ?, updated_at = ? WHERE id = ?')
      .run(input.trustMode, now, input.sessionId);
    this.writeAuditEvent('session.trust_mode_updated', {
      sessionId: input.sessionId,
      trustMode: input.trustMode
    });

    const row = this.dbs.appDb
      .prepare(
        `SELECT id, workspace_id AS workspaceId, profile_id AS profileId, title,
                trust_mode AS trustMode, status, created_at AS createdAt, updated_at AS updatedAt
	         FROM sessions WHERE id = ?`
	      )
	      .get(input.sessionId) as Session | undefined;
    if (!row) throw new Error(`会话不存在：${input.sessionId}`);
    if (row.trustMode === 'autopilot') {
      await this.autoApprovePendingApprovalsForTrustedSession(row.id, '已切换到信任执行，自动放行当前会话待审批请求。');
    }
    return row;
  }

  cancelRun(input: CancelRunInput): CancelRunResult {
    const handle = this.activeRuns.get(input.sessionId);
    if (!handle) return { ok: true, cancelled: false };
    handle.cancelled = true;
    handle.controller.abort(new RunCancelledError());
    this.writeAuditEvent('run.cancelled', { sessionId: input.sessionId });
    return { ok: true, cancelled: true };
  }

  deleteSession(input: DeleteSessionInput): DeleteSessionResult {
    // 取消该会话正在进行的运行，避免后台任务继续写入已删除会话。
    this.cancelRun({ sessionId: input.sessionId });

    const db = this.dbs.appDb;
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(input.sessionId);
      db.prepare('DELETE FROM run_steps WHERE session_id = ?').run(input.sessionId);
      db.prepare('DELETE FROM approval_requests WHERE session_id = ?').run(input.sessionId);
      db.prepare('DELETE FROM session_context_items WHERE session_id = ?').run(input.sessionId);
      db.prepare('DELETE FROM catalog_fact_pointers WHERE session_id = ?').run(input.sessionId);
      db.prepare('DELETE FROM session_skills WHERE session_id = ?').run(input.sessionId);
      db.prepare('DELETE FROM tool_invocations WHERE session_id = ?').run(input.sessionId);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(input.sessionId);
    })();

    this.writeAuditEvent('session.deleted', { sessionId: input.sessionId });
    return { ok: true, sessionId: input.sessionId };
  }

  async acceptMessage(input: AgentSendMessageInput): Promise<AgentSendMessageResult> {
    const runId = randomUUID();
    const now = Date.now();
    const userMessage: Message = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: 'user',
      content: input.content,
      runId,
      createdAt: now
    };
    this.dbs.appDb
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, run_id, created_at)
         VALUES (?, ?, 'user', ?, ?, ?)`
      )
      .run(userMessage.id, userMessage.sessionId, userMessage.content, userMessage.runId, userMessage.createdAt);
    this.touchSession(input.sessionId, now);
    this.maybeAutoTitleSession(input.sessionId, input.content);
    this.emitRendererEvent('agent:message-added', userMessage);

    let modelStepId: string | null = null;
    let finalStatus: AgentRendererEvents['agent:run-completed']['status'] = 'failed';
    try {
      const settings = this.getLlmRuntimeSettings();
      const selectedSkills = this.listSessionSkillDetails(input.sessionId);
      const recentMessages = this.listRecentSessionMessages(input.sessionId, 12);
      this.writeRunStep(input.sessionId, runId, 'reasoning_summary', '整理本轮上下文', 'completed', {
        note: '可见推理摘要，不展示模型隐藏思维链。',
        selectedSkillCount: selectedSkills.length,
        selectedSkills: selectedSkills.map((skill) => skill.title),
        recentMessageCount: recentMessages.length
      });
      this.writeRunStep(input.sessionId, runId, 'visible_plan', '生成可审计执行计划', 'completed', {
        goal: input.content,
        policy: '主 Agent 只负责运维问答与执行；接口事实先接地；业务参数从工作区/记忆/技能工具接地；阿里云调用只走 call_openapi；严控核签拦截 write/dangerous，信任执行自动放行 safe/write/dangerous 并记录审计。',
        expectedTools: [
          'discover_api',
          'get_api_params',
          'list_workspace',
          'search_workspace',
          'read_workspace_file',
          'search_memory',
          'search_skills',
          'load_skill',
          'call_openapi'
        ]
      });
      modelStepId = this.writeRunStep(input.sessionId, runId, 'agent_runtime', '调用模型生成回答', 'running', {
        provider: 'openai_agents',
        model: settings.model,
        baseUrl: redactBaseUrl(settings.baseUrl),
        maxTurns: AGENT_MAX_TURNS,
        timeoutMs: AGENT_RUN_TIMEOUT_MS,
        tools: [
          'discover_api',
          'get_api_params',
          'list_workspace',
          'search_workspace',
          'read_workspace_file',
          'search_memory',
          'search_skills',
          'load_skill',
          'call_openapi'
        ]
      });

      const completion = await this.runAgent(
        input.sessionId,
        runId,
        input.content,
        settings,
        selectedSkills,
        recentMessages
      );
      const output = completion.output;
      const assistantMessage: Message = {
        id: randomUUID(),
        sessionId: input.sessionId,
        role: 'assistant',
        content: output,
        runId,
        createdAt: Date.now()
      };
      this.dbs.appDb
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, run_id, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?)`
        )
        .run(
          assistantMessage.id,
          assistantMessage.sessionId,
          assistantMessage.content,
          assistantMessage.runId,
          assistantMessage.createdAt
        );
      this.touchSession(input.sessionId, assistantMessage.createdAt);
      this.emitRendererEvent('agent:message-added', assistantMessage);
      this.dbs.appDb
        .prepare(
          `UPDATE run_steps
           SET status = 'completed', payload_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          JSON.stringify({
            provider: 'openai_agents',
            finalOutputLength: output.length,
            interrupted: completion.interrupted,
            interruptionCount: completion.interruptionCount
          }),
          Date.now(),
          modelStepId
        );
      finalStatus = completion.interrupted ? 'awaiting_approval' : 'completed';
      this.emitRunCompleted(input.sessionId, runId, finalStatus, modelStepId);
    } catch (error) {
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      const stepStatus = cancelled ? 'cancelled' : 'failed';
      modelStepId ??= this.writeRunStep(input.sessionId, runId, 'agent_runtime', '调用模型生成回答', stepStatus, {
        provider: 'openai_agents',
        ...(cancelled ? { cancelled: true } : { error: message })
      });
      const assistantMessage: Message = {
        id: randomUUID(),
        sessionId: input.sessionId,
        role: 'assistant',
        content: cancelled ? '已按你的要求取消本轮运行。' : `暂时无法完成问答：${message}`,
        runId,
        createdAt: Date.now()
      };
      this.dbs.appDb
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, run_id, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?)`
        )
        .run(
          assistantMessage.id,
          assistantMessage.sessionId,
          assistantMessage.content,
          assistantMessage.runId,
          assistantMessage.createdAt
        );
      this.touchSession(input.sessionId, assistantMessage.createdAt);
      this.emitRendererEvent('agent:message-added', assistantMessage);
      this.dbs.appDb
        .prepare(
          `UPDATE run_steps
           SET status = ?, payload_json = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          stepStatus,
          JSON.stringify({ provider: 'openai_agents', ...(cancelled ? { cancelled: true } : { error: message }) }),
          Date.now(),
          modelStepId
        );
      finalStatus = cancelled ? 'cancelled' : 'failed';
      this.emitRunCompleted(input.sessionId, runId, finalStatus, modelStepId);
    } finally {
      this.trace.finalizeRun(runId, finalStatus);
    }

    return { runId, accepted: true };
  }

  async decideApproval(input: DecideApprovalInput): Promise<{ ok: boolean; approval?: ApprovalRequest; error?: string }> {
      const row = this.dbs.appDb
      .prepare(
        `SELECT id, session_id AS sessionId, run_id AS runId, tool_call_id AS toolCallId,
                status, reason, danger, summary, params_json AS paramsJson,
                provenance_json AS provenanceJson, run_state_json AS runStateJson,
                context_hash AS contextHash, created_at AS createdAt, decided_at AS decidedAt
         FROM approval_requests WHERE id = ?`
      )
      .get(input.approvalId) as (ApprovalRequest & { runStateJson: string; contextHash: string }) | undefined;
    if (!row) return { ok: false, error: `审批请求不存在：${input.approvalId}` };
    if (row.status !== 'pending') return { ok: false, approval: row, error: `审批请求不是 pending 状态：${row.status}` };

    const now = Date.now();
    if (input.decision === 'reject') {
      this.dbs.appDb
        .prepare('UPDATE approval_requests SET status = ?, decided_at = ? WHERE id = ?')
        .run('rejected', now, input.approvalId);
      this.writeRejectedApprovalInvocation(row, input.reason ?? null);
      this.writeAuditEvent('approval.rejected', { approvalId: input.approvalId, reason: input.reason ?? null });
      await this.resumeApprovedRun(row, 'reject');
      return { ok: true, approval: { ...row, status: 'rejected', decidedAt: now } };
	  }

    try {
      await this.resumeApprovedRun(row, 'approve');
      this.dbs.appDb
        .prepare('UPDATE approval_requests SET status = ?, decided_at = ? WHERE id = ?')
        .run('applied', now, input.approvalId);
      this.writeAuditEvent('approval.applied', { approvalId: input.approvalId, reason: input.reason ?? null });
      return { ok: true, approval: { ...row, status: 'applied', decidedAt: now } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dbs.appDb
        .prepare('UPDATE approval_requests SET status = ?, decided_at = ? WHERE id = ?')
        .run('failed', now, input.approvalId);
      this.writeAuditEvent('approval.failed', { approvalId: input.approvalId, error: message });
      return { ok: false, approval: { ...row, status: 'failed', decidedAt: now }, error: message };
    }
  }

  private listPendingApprovalRows(sessionId: string): Array<ApprovalRequest & { runStateJson: string; contextHash: string }> {
    return this.dbs.appDb
      .prepare(
        `SELECT id, session_id AS sessionId, run_id AS runId, tool_call_id AS toolCallId,
                status, reason, danger, summary, params_json AS paramsJson,
                provenance_json AS provenanceJson, run_state_json AS runStateJson,
                context_hash AS contextHash, created_at AS createdAt, decided_at AS decidedAt
         FROM approval_requests
         WHERE session_id = ? AND status = 'pending'
         ORDER BY created_at ASC`
      )
      .all(sessionId) as Array<ApprovalRequest & { runStateJson: string; contextHash: string }>;
  }

  private async autoApprovePendingApprovalsForTrustedSession(sessionId: string, reason: string): Promise<void> {
    const session = this.getSessionById(sessionId);
    if (session.trustMode !== 'autopilot') return;

    const approvals = this.listPendingApprovalRows(sessionId);
    for (const approval of approvals) {
      const latest = this.getApprovalRequestById(approval.id);
      if (!latest || latest.status !== 'pending') continue;
      const decidedAt = Date.now();
      try {
        await this.resumeApprovedRun(approval, 'approve');
        this.dbs.appDb
          .prepare('UPDATE approval_requests SET status = ?, decided_at = ? WHERE id = ? AND status = ?')
          .run('applied', decidedAt, approval.id, 'pending');
        this.writeAuditEvent('approval.auto_applied', {
          approvalId: approval.id,
          sessionId,
          trustMode: session.trustMode,
          reason
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.dbs.appDb
          .prepare('UPDATE approval_requests SET status = ?, decided_at = ? WHERE id = ? AND status = ?')
          .run('failed', decidedAt, approval.id, 'pending');
        this.writeAuditEvent('approval.auto_apply_failed', { approvalId: approval.id, sessionId, error: message });
      }
    }
  }

  decideMemoryCandidate(input: DecideMemoryCandidateInput): { ok: boolean; candidate?: MemoryCandidate; error?: string } {
    const row = this.dbs.appDb
      .prepare(
        `SELECT id, workspace_id AS workspaceId, profile_id AS profileId, fact,
                source_message_at AS sourceMessageAt, fact_hash AS factHash,
                status, created_at AS createdAt, decided_at AS decidedAt
         FROM memory_candidates WHERE id = ?`
      )
      .get(input.candidateId) as MemoryCandidate | undefined;
    if (!row) return { ok: false, error: `记忆候选不存在：${input.candidateId}` };
    if (row.status !== 'pending') return { ok: false, candidate: row, error: `记忆候选不是 pending 状态：${row.status}` };

    const now = Date.now();
    if (input.decision === 'reject') {
      this.dbs.appDb
        .prepare('UPDATE memory_candidates SET status = ?, decided_at = ? WHERE id = ?')
        .run('rejected', now, input.candidateId);
      this.writeAuditEvent('memory_candidate.rejected', { candidateId: input.candidateId, factHash: row.factHash });
      return { ok: true, candidate: { ...row, status: 'rejected', decidedAt: now } };
    }

    try {
      this.applyMemoryCandidate(row);
      this.dbs.appDb
        .prepare('UPDATE memory_candidates SET status = ?, decided_at = ? WHERE id = ?')
        .run('approved', now, input.candidateId);
      this.writeAuditEvent('memory_candidate.approved', { candidateId: input.candidateId, factHash: row.factHash });
      return { ok: true, candidate: { ...row, status: 'approved', decidedAt: now } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeAuditEvent('memory_candidate.failed', { candidateId: input.candidateId, error: message });
      return { ok: false, candidate: row, error: message };
    }
  }

  private async runAgent(
    sessionId: string,
    runId: string,
    userInput: string,
    settings: LlmRuntimeSettings,
    selectedSkills: SkillDetail[],
    recentSessionMessages: Message[]
  ): Promise<AgentRunCompletion> {
    const { agent, runner } = this.createAgentRuntime(sessionId, runId, settings, selectedSkills, recentSessionMessages);
    const abortController = new AbortController();
    const runHandle: ActiveRunHandle = { controller: abortController, cancelled: false };
    this.activeRuns.set(sessionId, runHandle);
    const timeout = setTimeout(() => abortController.abort(new Error(`Agent run timed out after ${AGENT_RUN_TIMEOUT_MS}ms`)), AGENT_RUN_TIMEOUT_MS);
    try {
      const result = await this.trace.measure(
        {
          sessionId,
          runId,
          event: 'model_run',
          target: settings.model,
          meta: {
            baseUrl: redactBaseUrl(settings.baseUrl),
            maxTurns: AGENT_MAX_TURNS,
            userInputLength: userInput.length,
            selectedSkillCount: selectedSkills.length,
            recentMessageCount: recentSessionMessages.length
          }
        },
        () => runner.run(agent, userInput, { maxTurns: AGENT_MAX_TURNS, signal: abortController.signal, stream: true })
      );
      for await (const event of result) {
        if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
          this.emitMessageDelta(sessionId, runId, event.data.delta);
        } else {
          this.handleStreamEventForActivity(sessionId, runId, event);
        }
      }
      await result.completed;
      const interruptions = result.interruptions ?? [];
      if (interruptions.length > 0) {
        this.createSdkApprovalRequests(sessionId, runId, result.state.toString(), interruptions);
        return {
          output: `已暂停，等待你确认 ${interruptions.length} 个需要人工审批的工具调用。`,
          interrupted: true,
          interruptionCount: interruptions.length
        };
      }

      return {
        output: String(result.finalOutput ?? '').trim() || '模型没有返回可展示的文本。',
        interrupted: false,
        interruptionCount: 0
      };
    } catch (error) {
      if (runHandle.cancelled) throw new RunCancelledError();
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeRuns.delete(sessionId);
    }
  }

  private createAgentRuntime(
    sessionId: string,
    runId: string,
    settings: LlmRuntimeSettings,
    selectedSkills: SkillDetail[],
    recentSessionMessages: Message[]
  ): AgentRuntimeBundle {
    if (!settings.model) {
      throw new Error('请先在“配置大模型”里填写 Model。');
    }
    if (!settings.apiKey) {
      throw new Error('请先在“配置大模型”里填写 API Key；当前没有可解密的密钥。');
    }
    const skillContext = selectedSkills.length
      ? selectedSkills
          .map((skill) => `${skill.id} · ${skill.title}：${skill.description}`)
          .join('\n')
      : '当前会话没有选入技能。';
    const recentMessages = recentSessionMessages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');
    const session = this.getSessionById(sessionId);
    const profile = this.getProfileById(session.profileId);
    const workspace = this.getWorkspaceById(session.workspaceId);
    const workspaceOutline = this.listWorkspaceEntries(workspace, '.', 40)
      .map((entry) => `${entry.kind === 'dir' ? '[dir]' : '[file]'} ${entry.path}`)
      .join('\n');
    const memoryIndex = this.listProfileMemoryIndex(workspace, profile.id);
    const tools = this.createOpenApiTools(sessionId, runId, profile);

    const openAIClient = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl ?? undefined,
      fetch: this.createLlmTraceFetch(sessionId, runId)
    });
    const provider = new OpenAIProvider({
      openAIClient,
      useResponses: false
    });
    const runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
      workflowName: 'Aliy Agent Chat'
    });
    const agent = new Agent({
      name: 'Aliy Agent',
      model: settings.model,
      instructions: this.buildOpsManagerInstructions({
        session,
        profile,
        workspace,
        workspaceOutline,
        memoryIndex,
        skillContext,
        recentMessages
      }),
      tools
    });

    return { agent, runner };
  }

  private createLlmTraceFetch(sessionId: string, runId: string): typeof fetch {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    return async (input, init) => {
      const startedAt = Date.now();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const requestBody = requestBodyToString(init?.body);
      this.trace.event({
        sessionId,
        runId,
        event: 'llm_http_request',
        target: url,
        status: 'info',
        meta: summarizeLlmRequestPayload(requestBody)
      });

      const response = await nativeFetch(input, init);
      const responseBody = await response
        .clone()
        .text()
        .catch(() => null);
      const responseContentType = response.headers.get('content-type');
      this.trace.event({
        sessionId,
        runId,
        event: 'llm_http_response',
        target: url,
        status: response.ok ? 'success' : 'error',
        durationMs: Date.now() - startedAt,
        meta: summarizeLlmResponsePayload(response.status, responseBody, responseContentType)
      });
      return response;
    };
  }

  private buildOpsManagerInstructions(input: {
    session: Session;
    profile: Profile;
    workspace: Workspace;
    workspaceOutline: string;
    memoryIndex: string;
    skillContext: string;
    recentMessages: string;
  }): string {
    const defaultRegion = input.profile.defaultRegion || 'cn-hangzhou';
    const rdcId = (input.profile.rdcId ?? '').trim();
    const akIdMasked = input.profile.akIdMasked || 'AK 未配置';
    return [
      '你是 Aliy Agent，一个本地优先的阿里云运维助手。你帮用户查询、诊断、准备变更、确认执行并解释结果。',
      '',
      '# 核心原则',
      '',
      '1. 先想清楚用户真正要解决的运维问题，再决定动作；不要为了走流程而机械调工具。',
      '2. 事实只能来自真实来源：本地 catalog、workspace、memory、skill、audit，或工具的真实返回。模型负责理解意图、规划、解释，不负责编造事实。',
      '3. 绝不凭记忆拼 product/action/version/endpoint/必填参数。需要这些就先用 catalog 工具接地；接不到就向用户确认，不要为了流畅而补全未知。',
      '4. 所有阿里云调用只能通过 call_openapi，由 Gateway 解析 endpoint 并执行。你不能自造 endpoint，也不能声称用别的方式执行了云端操作。',
      '5. 不要输出或传递 AccessKey Secret、API Key、Token、Password；不要把完整数据库、审计或无关文件全文放进上下文。',
      '6. 用中文回答，先给结论，可执行、可审计。',
      '7. 【新增】严格区分「API 调用成功」与「运维目标达成」：接口返回成功只代表命令被接受，不代表用户的问题被解决。结论必须落在业务目标上。',
      '',
      '# 当前运行上下文',
      '',
      `当前 Profile：${input.profile.name}`,
      `当前 Profile AK 脱敏标识：${akIdMasked}`,
      `当前默认 Region：${defaultRegion}`,
      `当前云效组织 ID：${rdcId ? `已配置（${rdcId}），调用云效/DevOps 接口时网关会自动注入 organizationId，你无需手填` : '未配置——若用户要做云效/DevOps 操作（流水线、代码库等），先提示其在 Profile 配置云效组织 ID'}`,
      `当前 Workspace：${input.workspace.rootPath}`,
      `当前 Session：${input.session.id}`,
      `当前信任模式：${input.session.trustMode}`,
      '',
      '# 工具',
      '',
      '- discover_api / get_api_params：按自然语言找候选 product/action，并读取必填参数、danger、endpoint 模板。调用云接口前先用它们接地；同一 action 一旦接地成功就直接调用，不要反复 discover/get_params。连续两次 ACTION_NOT_FOUND 就停下，向用户说明缺什么、给下一步，不要空耗轮次。',
      '- call_openapi：执行阿里云 OpenAPI。product/action/version 必须来自接地结果，必填参数齐全，不传 endpoint 和任何密钥。catalog 返回 alias/deprecated/replaced_by 时接受纠正，不要坚持旧名。',
      '- list_workspace / search_workspace / read_workspace_file：获取业务参数、命名规则、模板、项目约定等。先 search/list 再 read，只用与本任务相关的片段，用到就标注来源；workspace 没有就向用户确认，不要编造业务参数。',
      '- search_memory：读取用户偏好与长期约定，仅作辅助，不能作为接口事实来源；你不能写记忆。与 workspace 冲突时以 workspace 为准并提示冲突。',
      '- search_skills / load_skill：任务像可复用流程或已知 playbook 时，先搜技能再加载，按其流程执行；技能是流程参考，不是接口事实库。',
      '',
      '# 如何推进任务',
      '',
      '1. 先归类：查询/盘点、诊断、变更准备、变更执行；复杂任务先给一句话计划。',
      '2. 按“定位对象 → 接地获取事实 → 执行 → 验证业务目标 → 给结论和下一步”推进，不要停在接口说明、也不要只给泛泛建议。',
      '3. 要拿真实数据就真的调用 call_openapi，不要用反复读 workspace/memory 代替执行，也不要让用户自己去控制台刷新。',
      '4. 【关键】该执行就直接发起 call_openapi。不要用“我接下来会执行…”这类文字描述来代替真正的工具调用——叙述不等于行动。',
      '5. 【边做边说】每次调用工具前，先用一句很短的话说明你这一步要做什么（例如“先查一下实例列表”“执行 docker ps 看容器”）。这句话是给用户看的进度提示，要简短、口语化。',
      '',
      '   注意：这句进度提示**不是**你的推理。诊断/排障类任务中，每拿到一个真实返回后，要先在心里完成一步真正的推理——“这个结果说明了什么、支持还是排除了哪个假设、因此下一步该查什么”——再决定下一个动作；不要观察完就直接跳到动作，也不要用进度短句敷衍掉推理。',
      '6. 【不重复接地】同一个 action 一旦 discover_api / get_api_params 接地成功，就直接 call_openapi，不要再对它重复 discover/get_params；本轮已经查到的事实不要重复查。',
      '7. 【验证真实结果】命令型/异步操作（如 ECS 云助手执行命令）：发起后必须再调用对应的结果/invocation 接口确认真实结果，不能假设成功。',
      '8. 【验证业务目标，不止接口成功】对恢复类、变更类任务，call_openapi 返回 SUCCESS 后，必须再调用一次接口验证**业务目标本身**：相关指标是否回落、告警是否消除、健康检查是否通过、资源是否进入期望状态。据此判定“真正解决 / 未解决”，再下结论。绝不因为 OpenAPI 返回成功就宣布问题已恢复。',
      '9. 缺关键参数时，只问一个最小澄清问题，并说明你已经查过哪些来源。',
      '',
      '# 关键决策点：先比较再动手（多方案权衡）',
      '',
      '当一个目标存在**多个可行且代价/风险不同**的处置路径时（例如服务过载可选「扩容 / 限流 / 重启实例」，磁盘满可选「清日志 / 扩盘 / 迁移数据」），不要抓到第一个想到的方案就执行：',
      '',
      '1. 先列出 2–3 个候选方案，每个用一句话说明思路。',
      '2. 对每个候选给一句利弊评估：见效速度、影响面、可逆性/风险。',
      '3. 选出最优方案（或「快方案先顶住 + 稳方案补长期」并行），并说明为什么选它。',
      '4. 然后再对选定方案发起 call_openapi，由系统按风险决定是否需要审批。',
      '',
      '这一步是为了让选择有依据、可审计；对只有单一明显动作的任务（如单纯查询、一个确定的重启）不必如此，直接推进即可。',
      '',
      '# 失败后的处理：反思一次再重试（会话内）',
      '',
      '当“验证业务目标”判定为**未解决**，或工具返回 FAILED 时，不要原样重发、也不要立刻放弃：',
      '',
      '1. 先用一句话反思：这次为什么没解决 / 为什么失败，下一步应当改成**什么不同的动作**（要具体到动作，不是“再试一次”“更小心”）。',
      '2. 基于反思发起一个**与上次不同**的新尝试。',
      '3. 同一恢复目标连续无效不超过 2 次后停下，向用户说明已尝试什么、各自结果、以及建议的人工介入方向。',
      '',
      '说明：以上反思只用于当前会话内的下一步决策，依赖当前上下文即可，不写入长期记忆（你不能写记忆）。',
      '',
      '# 安全与审批（由系统把守，不用你判断）',
      '',
      '1. 安全拦截是系统的确定性职责。不论风险高低，你都照常发起 call_openapi；严控核签模式会拦截 write/dangerous，信任执行模式会自动执行 safe/write/dangerous 并记录审计。',
      '2. 因此不要因为某个操作危险就停下来只做口头说明，更不要用文字“请你确认”来代替审批——发起调用，让系统决定是否需要审批。',
      '3. 【收到审批拦截就停】当 call_openapi 返回 AWAITING_APPROVAL 或 APPROVAL_REQUIRED 时，立即停止本轮：只回一句“已生成审批卡，请确认后我会继续”，不要再调用任何工具、不要继续轮询或自行往下推进。用户确认后系统会自动续跑，由那一轮去拿结果。',
      '4. 在工具真实返回成功之前，绝不说“已创建/已删除/已修改/已完成”。',
      '5. 用户拒绝审批后，尊重结果，给中止说明和替代方案，不要重发同一操作。',
      '6. 【反思重试不绕过审批】上一节的“反思后重试”同样要走 call_openapi 的正常审批通道；不得为了完成任务而把被拦截或被拒绝的危险操作改头换面重发。',
      '7. 工具返回处理：REJECTED_BY_GATEWAY → 按结构化错误修正（补参数、改用 replaced_by、重新接地）；FAILED_BY_ALIYUN → 引用 errorCode/errorMessage/RequestId 给排查建议；SUCCESS → 给关键结果摘要，有 RequestId 就附上，并按第 8 条验证业务目标。',
      '',
      '# 复杂多步变更：先列计划再逐步执行',
      '',
      '仅当任务涉及**3 步以上、彼此依赖**的变更时，采用“先规划后执行”：',
      '',
      '1. 先输出一份编号计划（每步只说做什么、为什么，便于审计），不在这一步执行。',
      '2. 再按计划逐步执行，每步前照常用一句进度提示，执行后按需验证。',
      '3. 若某步的真实结果偏离预期，显式说明并调整剩余计划，而不是机械按原计划走完。',
      '',
      '查询、诊断、单步变更不必如此，保持轻量推进即可——不要让“列计划”退化成只说不做。',
      '',
      '# 回答',
      '',
      '简洁中文，先结论后细节。用到 workspace/memory/skill 时标注来源；有 RequestId 时展示。缺信息时明确说缺什么、已查过什么，用一个问题向用户确认。结论要落在业务目标（问题是否解决）上，而不仅是“接口调用成功”。',
      '',
      '# 动态上下文',
      '',
      '## 工作区目录概览',
      '',
      input.workspaceOutline || '未索引到可读文件。',
      '',
      '## Profile 记忆索引',
      '',
      input.memoryIndex || '暂无长期记忆索引。',
      '',
      '## 当前会话已选技能',
      '',
      input.skillContext,
      '',
      '## 最近会话消息摘要',
      '',
      input.recentMessages || '无'
    ].join('\n');
  }

  private createOpenApiTools(sessionId: string, runId: string, profile: Profile): ReturnType<typeof tool>[] {
    return [
      tool({
        name: 'discover_api',
        description: 'Search catalog.db for Alibaba Cloud OpenAPI products and actions before choosing an API. 后续调用 get_api_params / call_openapi 时必须原样使用 result.lookup 中的 product/action/version,不得自行改写或猜别名。',
        parameters: z.object({
          query: looseString().describe('Natural language or keyword query, for example "ECS 实例列表" or "创建短信模板".'),
          limit: looseNumber().int().min(1).max(10).nullable().describe('Maximum result count. Use null for the default.')
        }),
        execute: async ({ query, limit }) => this.trace.measure({ sessionId, runId, event: 'tool', target: 'discover_api', meta: { query, limit } }, async () => {
          const rows = this.discoverApi(query, limit ?? 5);
          for (const row of rows) {
            this.upsertCatalogFactPointer(sessionId, runId, row);
          }
          this.writeRunStep(sessionId, runId, 'tool_call', 'discover_api', 'completed', {
            query,
            resultCount: rows.length,
            results: rows
          });
          this.writeToolMessage(sessionId, runId, `discover_api(${JSON.stringify({ query, limit })}) -> 命中 ${rows.length} 个候选接口`);
          return JSON.stringify({ ok: true, results: rows });
        })
      }),
      tool({
        name: 'get_api_params',
        description: 'Get required parameters, danger level, endpoint, and metadata for one Alibaba Cloud OpenAPI action.',
        parameters: z.object({
          product: looseString().describe('Alibaba Cloud OpenAPI product code, for example ecs or dysmsapi.'),
          action: looseString().describe('OpenAPI action, for example DescribeInstances.'),
          version: looseNullableString().nullable().describe('API version. Use null to use catalog default.')
        }),
        execute: async ({ product, action, version }) => this.trace.measure({ sessionId, runId, event: 'tool', target: 'get_api_params', meta: { product, action, version } }, async () => {
          const normalizedVersion = normalizeVersion(version);
          const resolved = this.resolveCatalogAction(product, action, normalizedVersion);
          if (resolved.ok) {
            this.upsertCatalogFactPointer(sessionId, runId, resolved);
          }
          this.writeRunStep(sessionId, runId, 'tool_call', 'get_api_params', resolved.ok ? 'completed' : 'failed', {
            product,
            action,
            version,
            result: resolved
          });
          this.writeToolMessage(sessionId, runId, `get_api_params(${JSON.stringify({ product, action, version })}) -> ${summarizeToolResult(resolved)}`);
          return JSON.stringify(resolved);
        })
      }),
      tool({
        name: 'list_workspace',
        description: 'List files and directories in the mounted business knowledge workspace.',
        parameters: z.object({
          path: looseNullableString().nullable().describe('Workspace-relative directory path. Use null or "." for the root.'),
          limit: looseNumber().int().min(1).max(100).nullable().describe('Maximum entries to return. Use null for the default.')
        }),
        execute: async ({ path, limit }) => this.trace.measure({ sessionId, runId, event: 'tool', target: 'list_workspace', meta: { path, limit } }, async () => {
          const session = this.getSessionById(sessionId);
          const workspace = this.getWorkspaceById(session.workspaceId);
          const entries = this.listWorkspaceEntries(workspace, path ?? '.', limit ?? 50);
          this.writeRunStep(sessionId, runId, 'tool_call', 'list_workspace', 'completed', {
            path: path ?? '.',
            resultCount: entries.length
          });
          this.writeToolMessage(sessionId, runId, `list_workspace(${JSON.stringify({ path, limit })}) -> ${entries.length} 项`);
          return JSON.stringify({ ok: true, results: entries });
        })
      }),
      tool({
        name: 'search_workspace',
        description: 'Search business knowledge files in the workspace. Returns paths and snippets; read a selected file for full content.',
        parameters: z.object({
          query: looseString().describe('Keyword or phrase to search in workspace files and paths.'),
          limit: looseNumber().int().min(1).max(20).nullable().describe('Maximum result count. Use null for the default.')
        }),
        execute: async ({ query, limit }) => this.trace.measure({ sessionId, runId, event: 'tool', target: 'search_workspace', meta: { query, limit } }, async () => {
          const session = this.getSessionById(sessionId);
          const workspace = this.getWorkspaceById(session.workspaceId);
          const rows = this.searchWorkspace(workspace, query, { limit: limit ?? 8, memoryOnly: false });
          this.writeRunStep(sessionId, runId, 'tool_call', 'search_workspace', 'completed', {
            query,
            resultCount: rows.length
          });
          this.writeToolMessage(sessionId, runId, `search_workspace(${JSON.stringify({ query, limit })}) -> 命中 ${rows.length} 个文件`);
          return JSON.stringify({ ok: true, results: rows });
        })
      }),
      tool({
        name: 'read_workspace_file',
        description: 'Read a workspace-relative text file. Use after list_workspace or search_workspace.',
        parameters: z.object({
          path: looseString().describe('Workspace-relative file path returned by list_workspace/search_workspace.')
        }),
        execute: async ({ path }) => this.trace.measure({ sessionId, runId, event: 'tool', target: 'read_workspace_file', meta: { path } }, async () => {
          const session = this.getSessionById(sessionId);
          const workspace = this.getWorkspaceById(session.workspaceId);
          const result = this.readWorkspaceFile(workspace, path);
          if (result.ok && result.path && result.content) {
            this.upsertContextDocumentPointer(sessionId, runId, workspace, result.path, result.content);
          }
          this.writeRunStep(sessionId, runId, 'tool_call', 'read_workspace_file', result.ok ? 'completed' : 'failed', {
            path,
            ok: result.ok,
            error: result.error ?? null
          });
          this.writeToolMessage(sessionId, runId, `read_workspace_file(${JSON.stringify({ path })}) -> ${summarizeToolResult(result)}`);
          return JSON.stringify(result);
        })
      }),
      tool({
        name: 'search_memory',
        description: 'Search long-term profile memory stored under .agent-memory for this workspace/profile.',
        parameters: z.object({
          query: looseString().describe('Keyword or phrase to search in long-term memory.'),
          limit: looseNumber().int().min(1).max(20).nullable().describe('Maximum result count. Use null for the default.')
        }),
        execute: async ({ query, limit }) => this.trace.measure({ sessionId, runId, event: 'tool', target: 'search_memory', meta: { query, limit } }, async () => {
          const session = this.getSessionById(sessionId);
          const workspace = this.getWorkspaceById(session.workspaceId);
          const rows = this.searchWorkspace(workspace, query, {
            limit: limit ?? 8,
            memoryOnly: true,
            profileId: profile.id
          });
          this.writeRunStep(sessionId, runId, 'tool_call', 'search_memory', 'completed', {
            query,
            resultCount: rows.length
          });
          this.writeToolMessage(sessionId, runId, `search_memory(${JSON.stringify({ query, limit })}) -> 命中 ${rows.length} 条记忆`);
          return JSON.stringify({ ok: true, results: rows });
        })
      }),
      tool({
        name: 'search_skills',
        description: 'Search reusable playbook skills before solving workflows or recurring errors.',
        parameters: z.object({
          query: looseString().describe('Intent, workflow, or error keyword to search skills.'),
          limit: looseNumber().int().min(1).max(10).nullable().describe('Maximum result count. Use null for the default.')
        }),
        execute: async ({ query, limit }) => this.trace.measure({ sessionId, runId, event: 'tool', target: 'search_skills', meta: { query, limit } }, async () => {
          const rows = this.searchSkills(query, limit ?? 5);
          this.writeRunStep(sessionId, runId, 'tool_call', 'search_skills', 'completed', {
            query,
            resultCount: rows.length
          });
          this.writeToolMessage(sessionId, runId, `search_skills(${JSON.stringify({ query, limit })}) -> 命中 ${rows.length} 个技能`);
          return JSON.stringify({ ok: true, results: rows });
        })
      }),
      tool({
        name: 'load_skill',
        description: 'Load the full body of a reusable playbook skill by id.',
        parameters: z.object({
          id: looseString().describe('Skill id returned by search_skills or shown in the selected skills list.')
        }),
        execute: async ({ id }) => this.trace.measure({ sessionId, runId, event: 'tool', target: 'load_skill', meta: { id } }, async () => {
          try {
            const skill = this.loadSkill(id);
            this.writeRunStep(sessionId, runId, 'tool_call', 'load_skill', 'completed', {
              id,
              title: skill.title
            });
            this.writeToolMessage(sessionId, runId, `load_skill(${JSON.stringify({ id })}) -> ${skill.title}`);
            return JSON.stringify({ ok: true, skill });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeRunStep(sessionId, runId, 'tool_call', 'load_skill', 'failed', { id, error: message });
            return JSON.stringify({ ok: false, error: message });
          }
        })
      }),
      tool({
        name: 'call_openapi',
        description: 'Invoke an Alibaba Cloud OpenAPI action through OpenApiGateway. Safe read-only calls execute automatically. In strict mode write/dangerous calls require approval; in autopilot mode safe/write/dangerous calls execute automatically and are audited.',
        parameters: z.object({
          product: looseString().describe('Alibaba Cloud OpenAPI product code, for example ecs or dysmsapi.'),
          action: looseString().describe('OpenAPI action, for example DescribeInstances.'),
          version: looseNullableString().nullable().describe('API version. Use null to use catalog default.'),
          region_id: looseNullableString().nullable().describe('Alibaba Cloud region id, for example cn-hangzhou. Use null for profile default.'),
          /*
           * Inline validation smoke-test:
           * {product:'r-kvstore', action:'CreateTairInstance', version:'null', region_id:'cn-hangzhou', params:'{RegionId:cn-hangzhou}', dry_run:'True'}
           * Expected: version→null, params→{RegionId:'cn-hangzhou'}, dry_run→true
           * params:'None'→null, limit:'5'→5, dry_run:'False'→false
           */
          params: looseRecord().nullable().describe('OpenAPI request parameters. Use null for no extra params. Do not include AccessKey secrets.'),
          dry_run: looseBool().nullable().describe('When true, validate and audit without invoking Aliyun. Use null for false.')
	        }),
        needsApproval: async (_runContext, { product, action, version, dry_run }) => {
          if (dry_run) return false;
          return this.needsOpenApiSdkApproval(sessionId, product, action, normalizeVersion(version));
        },
        execute: async ({ product, action, version, region_id, params, dry_run }, context, details) => {
          const normalizedRegionId = region_id ?? undefined;
          return this.trace.measure(
            {
              sessionId,
              runId,
              event: 'tool',
              target: 'call_openapi',
              meta: { product, action, version, regionId: normalizedRegionId, dryRun: dry_run, paramKeys: params ? Object.keys(params) : [] }
            },
            async () => {
              const toolCallId = details?.toolCall?.callId;
              const sdkApproved =
                toolCallId && context
                  ? context.isToolApproved({ toolName: 'call_openapi', callId: toolCallId }) === true
                  : false;
              const result = await this.invokeOpenApiGateway({
                sessionId,
                runId,
                profile,
                product,
                action,
                version: normalizeVersion(version),
                regionId: normalizedRegionId,
                params: params ?? {},
                dryRun: Boolean(dry_run),
                sdkApproved
              });
              this.writeRunStep(sessionId, runId, 'tool_call', 'call_openapi', result.ok ? 'completed' : 'failed', {
                product,
                action,
                version,
                regionId: normalizedRegionId,
                dryRun: Boolean(dry_run),
                status: result.status,
                errorCode: result.errorCode,
                errorMessage: result.errorMessage
              });
              this.writeToolMessage(sessionId, runId, `call_openapi(${JSON.stringify({ product, action, version, region_id, params: sanitizeParams(params ?? {}), dry_run })}) -> ${summarizeToolResult(result)}`);
              return JSON.stringify(result);
            }
          );
        }
	      })
    ];
  }

  private discoverApi(query: string, limit: number): Array<Record<string, unknown>> {
    if (!existsSync(this.dbs.catalogDbPath)) return [];
    const catalogDb = new Database(this.dbs.catalogDbPath, { readonly: true, fileMustExist: true });
    try {
      const normalizedQuery = query.trim();
      const rows = catalogDb
        .prepare(
          `SELECT ca.product, ca.action, ca.version, ca.danger, ca.summary_cn AS summaryCn,
                  ca.required_json AS requiredJson, cp.default_version AS defaultVersion,
                  co.deprecated, co.replaced_by AS replacedBy
           FROM catalog_fts f
           JOIN catalog_actions ca
             ON f.product = ca.product AND f.action = ca.action
           JOIN catalog_products cp
             ON cp.product = ca.product
           LEFT JOIN catalog_overlay co
             ON co.product = ca.product AND co.action = ca.action
           WHERE catalog_fts MATCH ?
           LIMIT ?`
        )
        .all(normalizedQuery || '*', limit) as Row[];
      const effectiveRows = rows.length > 0 ? rows : discoverApiFallbackRows(catalogDb, normalizedQuery, limit);
      return mapCatalogDiscoveryRows(effectiveRows);
    } catch {
      return mapCatalogDiscoveryRows(discoverApiFallbackRows(catalogDb, query.trim(), limit));
    } finally {
      catalogDb.close();
    }
  }

  private resolveCatalogAction(product: string, action: string, version?: string): Record<string, unknown> {
    const normalizedVersion = normalizeVersion(version);
    if (!existsSync(this.dbs.catalogDbPath)) {
      return {
        ok: false,
        status: 'REJECTED_BY_GATEWAY',
        errorCode: 'CATALOG_NOT_READY',
        errorMessage: 'catalog.db 不存在，请先刷新 Catalog。'
      };
    }
    const catalogDb = new Database(this.dbs.catalogDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = this.findCatalogAction(catalogDb, product, action, normalizedVersion);
      if (!row) {
        return {
          ok: false,
          status: 'REJECTED_BY_GATEWAY',
          errorCode: 'ACTION_NOT_FOUND',
          errorMessage: `catalog.db 中不存在 ${product}/${action}${normalizedVersion ? `/${normalizedVersion}` : ''}。请先用 discover_api 搜索正确产品和 Action。`
        };
      }
      const required = normalizeRequiredParams(row.product, row.action, parseJsonArray(row.requiredJson));
      return {
        ok: true,
        status: 'RESOLVED',
        product: row.product,
        requestedProduct: product,
        aliasProduct: row.aliasProduct ?? null,
        action: row.action,
        version: row.version,
        danger: row.danger,
        endpointTemplate: row.endpointTpl,
        endpointMap: parseEndpointMap(row.endpointMap),
        required,
        params: summarizeParamsMetadata(row.product, row.action, parseJsonValue(row.paramsBlob), required),
        summary: row.summaryCn,
        deprecated: isCatalogDeprecated(row.product, row.action, row.deprecated, row.replacedBy),
        replacedBy: row.replacedBy ?? null
      };
    } finally {
      catalogDb.close();
    }
  }

  private needsOpenApiSdkApproval(sessionId: string, product: string, action: string, version?: string): boolean {
    if (!existsSync(this.dbs.catalogDbPath)) return false;
    const session = this.getSessionById(sessionId);
    const catalogDb = new Database(this.dbs.catalogDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = this.findCatalogAction(catalogDb, product, action, version);
      if (!row) return false;
      return session.trustMode !== 'autopilot' && (row.danger === 'write' || row.danger === 'dangerous');
    } finally {
      catalogDb.close();
    }
  }

  private createSdkApprovalRequests(
    sessionId: string,
    runId: string,
    runStateJson: string,
    interruptions: RunToolApprovalItem[]
  ): void {
    for (const interruption of interruptions) {
      const rawItem = interruption.rawItem;
      if (rawItem.type !== 'function_call' || rawItem.name !== 'call_openapi') continue;

      const args = parseJsonValue(rawItem.arguments) as Record<string, unknown> | null;
      if (!args || typeof args.product !== 'string' || typeof args.action !== 'string') continue;

      const product = args.product;
      const action = args.action;
      const version = typeof args.version === 'string' ? args.version : undefined;
      const regionId = typeof args.region_id === 'string' ? args.region_id : undefined;
      const requestedParams =
        args.params && typeof args.params === 'object' && !Array.isArray(args.params)
          ? sanitizeParams(args.params as Record<string, unknown>)
          : {};
      const resolved = this.resolveCatalogAction(product, action, version);
      const danger = resolved.ok && typeof resolved.danger === 'string' ? resolved.danger : 'write';
      const endpointTemplate = resolved.ok && typeof resolved.endpointTemplate === 'string' ? resolved.endpointTemplate : null;
      const endpointMap = resolved.ok ? JSON.stringify(resolved.endpointMap ?? null) : null;
      const session = this.getSessionById(sessionId);
      const profile = this.getProfileById(session.profileId);
      const finalRegionId = regionId || profile.defaultRegion || 'cn-hangzhou';
      const endpoint = endpointTemplate ? resolveEndpoint(endpointTemplate, endpointMap, finalRegionId) : null;
      const approvalId = randomUUID();
      const summary = `确认执行 ${danger} OpenAPI：${resolved.ok ? resolved.product : product}/${resolved.ok ? resolved.action : action}`;
      const reason = `严控核签模式下 ${danger} 操作需要人工确认。`;
      const params = {
        kind: 'openapi_call',
        profileId: profile.id,
        profileName: profile.name,
        product: resolved.ok && typeof resolved.product === 'string' ? resolved.product : product,
        action: resolved.ok && typeof resolved.action === 'string' ? resolved.action : action,
        version: resolved.ok && typeof resolved.version === 'string' ? resolved.version : version ?? null,
        regionId: finalRegionId,
        endpoint,
        params: requestedParams
      };
      const contextHash = sha256(JSON.stringify(params));
      const existing = this.dbs.appDb
        .prepare('SELECT id FROM approval_requests WHERE run_id = ? AND tool_call_id = ? AND status = ?')
        .get(runId, rawItem.callId, 'pending') as { id: string } | undefined;

      if (existing) {
        this.dbs.appDb
          .prepare('UPDATE approval_requests SET run_state_json = ?, context_hash = ? WHERE id = ?')
          .run(runStateJson, contextHash, existing.id);
        continue;
      }

      this.dbs.appDb
        .prepare(
          `INSERT INTO approval_requests
            (id, session_id, run_id, tool_call_id, status, reason, danger, summary,
             params_json, provenance_json, run_state_json, context_hash, created_at, decided_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          approvalId,
          sessionId,
          runId,
          rawItem.callId,
          reason,
          danger,
          summary,
          JSON.stringify(params),
          JSON.stringify({
            toolName: 'call_openapi',
            rawToolCall: rawItem,
            akIdMasked: profile.akIdMasked
          }),
          runStateJson,
          contextHash,
          Date.now()
        );
      this.emitApprovalRequested(approvalId);

      this.writeRunStep(sessionId, runId, 'awaiting_approval', '等待人工审批', 'awaiting_approval', {
        approvalId,
        toolCallId: rawItem.callId,
        product: params.product,
        action: params.action,
        danger
      });
      this.writeToolInvocation({
        sessionId,
        toolName: 'call_openapi',
        product: String(params.product),
        action: String(params.action),
        version: typeof params.version === 'string' ? params.version : null,
        danger,
        resolvedEndpoint: endpoint,
        requestParams: requestedParams,
        provenance: {
          approvalId,
          source: 'openai_agents_sdk_interruption',
          regionId: finalRegionId,
          profileName: profile.name
        },
        status: 'AWAITING_APPROVAL',
        errorCode: 'APPROVAL_REQUIRED',
        errorMessage: summary,
        requestId: null,
        akIdMasked: profile.akIdMasked
      });
      this.writeAuditEvent('approval.requested', { approvalId, summary, product: params.product, action: params.action });
    }
  }

  private async resumeApprovedRun(
    approval: ApprovalRequest & { runStateJson: string; contextHash: string },
    decision: 'approve' | 'reject'
  ): Promise<void> {
    let finalStatus: AgentRendererEvents['agent:run-completed']['status'] = 'failed';
    try {
    if (!approval.runStateJson || approval.runStateJson === JSON.stringify({ kind: 'deferred_openapi_call' })) {
      finalStatus = await this.resumeDeferredApproval(approval, decision);
      return;
    }

    const settings = this.getLlmRuntimeSettings();
    const selectedSkills = this.listSessionSkillDetails(approval.sessionId);
    const recentMessages = this.listRecentSessionMessages(approval.sessionId, 12);
    const { agent, runner } = this.createAgentRuntime(approval.sessionId, approval.runId, settings, selectedSkills, recentMessages);
    const state = await RunState.fromString(agent, approval.runStateJson);
    const approvalItem = (state.getInterruptions() as RunToolApprovalItem[]).find((item) => {
      return item.rawItem.type === 'function_call' && item.rawItem.callId === approval.toolCallId;
    });
    if (!approvalItem) {
      throw new Error(`RunState 中找不到审批工具调用：${approval.toolCallId}`);
    }

    if (decision === 'approve') {
      state.approve(approvalItem);
    } else {
      state.reject(approvalItem);
    }

    this.writeRunStep(approval.sessionId, approval.runId, 'approval_resume', '恢复 SDK RunState', 'running', {
      approvalId: approval.id,
      decision,
      toolCallId: approval.toolCallId
    });

    const abortController = new AbortController();
    this.activeRuns.set(approval.sessionId, { controller: abortController, cancelled: false });
    const timeout = setTimeout(() => abortController.abort(new Error(`Agent run timed out after ${AGENT_RUN_TIMEOUT_MS}ms`)), AGENT_RUN_TIMEOUT_MS);
    const result = await this.trace.measure(
      {
        sessionId: approval.sessionId,
        runId: approval.runId,
        event: 'model_run',
        target: 'approval_resume',
        meta: {
          approvalId: approval.id,
          decision,
          toolCallId: approval.toolCallId,
          maxTurns: AGENT_MAX_TURNS
        }
      },
      () => runner.run(agent, state, { maxTurns: AGENT_MAX_TURNS, signal: abortController.signal, stream: true })
    ).finally(() => {
      clearTimeout(timeout);
    });
    for await (const event of result) {
      if (event.type === 'raw_model_stream_event' && event.data.type === 'output_text_delta') {
        this.emitMessageDelta(approval.sessionId, approval.runId, event.data.delta);
      } else {
        this.handleStreamEventForActivity(approval.sessionId, approval.runId, event);
      }
    }
    await result.completed;
    const interruptions = result.interruptions ?? [];
    if (interruptions.length > 0) {
      this.createSdkApprovalRequests(approval.sessionId, approval.runId, result.state.toString(), interruptions);
      const awaitingStepId = this.writeRunStep(approval.sessionId, approval.runId, 'approval_resume', '恢复后再次等待审批', 'awaiting_approval', {
        approvalId: approval.id,
        interruptionCount: interruptions.length
      });
      finalStatus = 'awaiting_approval';
      this.emitRunCompleted(approval.sessionId, approval.runId, 'awaiting_approval', awaitingStepId);
      return;
    }

    const output = String(result.finalOutput ?? '').trim() || '审批后的运行已结束，但模型没有返回可展示的文本。';
    const assistantMessage: Message = {
      id: randomUUID(),
      sessionId: approval.sessionId,
      role: 'assistant',
      content: output,
      runId: approval.runId,
      createdAt: Date.now()
    };
    this.dbs.appDb
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, run_id, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?)`
      )
      .run(
        assistantMessage.id,
        assistantMessage.sessionId,
        assistantMessage.content,
        assistantMessage.runId,
        assistantMessage.createdAt
      );
    this.touchSession(approval.sessionId, assistantMessage.createdAt);
    this.emitRendererEvent('agent:message-added', assistantMessage);
    const completedStepId = this.writeRunStep(approval.sessionId, approval.runId, 'approval_resume', '审批后运行完成', 'completed', {
      approvalId: approval.id,
      decision,
      finalOutputLength: output.length
    });
    finalStatus = 'completed';
    this.emitRunCompleted(approval.sessionId, approval.runId, 'completed', completedStepId);
    } finally {
      this.activeRuns.delete(approval.sessionId);
      this.trace.finalizeRun(approval.runId, finalStatus);
    }
  }

  // gateway 审批卡（无 SDK RunState）的恢复：执行已审批调用，并续跑 agent loop，
  // 让结果回灌给模型、异步操作继续轮询，最终把答案返回给用户。
  private async resumeDeferredApproval(
    approval: ApprovalRequest & { runStateJson: string; contextHash: string },
    decision: 'approve' | 'reject'
  ): Promise<AgentRendererEvents['agent:run-completed']['status']> {
    const params = parseJsonValue(approval.paramsJson) as Record<string, unknown> | null;

    if (decision === 'reject') {
      return this.finalizeDeferredRun(approval, '操作已被你拒绝，未执行。如需其它处理方式请告诉我。', 'completed');
    }

    // 非 OpenAPI（如工作区写入）：执行即完成，无需续跑模型。
    if (params?.kind !== 'openapi_call') {
      try {
        await this.applyApprovedRequest(approval);
        return this.finalizeDeferredRun(approval, '已按审批执行完成。', 'completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.finalizeDeferredRun(approval, `审批执行失败：${message}`, 'failed');
      }
    }

    // OpenAPI：执行已审批调用，拿到真实结果摘要。
    let execSummary: string;
    try {
      const exec = await this.applyApprovedOpenApi(approval, params);
      execSummary = exec.summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.finalizeDeferredRun(approval, `审批执行失败：${message}`, 'failed');
    }

    // 续跑 agent loop：把结果回灌，让模型继续完成任务（异步则轮询）并用中文作答。
    const product = String(params.product ?? '');
    const action = String(params.action ?? '');
    const settings = this.getLlmRuntimeSettings();
    const selectedSkills = this.listSessionSkillDetails(approval.sessionId);
    const recentMessages = this.listRecentSessionMessages(approval.sessionId, 12);
    const continuationInput =
      `[系统] 用户已审批并执行写/危险操作 ${product}/${action}，执行结果：\n${execSummary}\n` +
      `请基于该结果继续完成用户的原始请求：若为异步操作（例如 ECS RunCommand 返回 InvokeId），` +
      `请调用对应的结果查询接口（如 ecs DescribeInvocationResults，属 safe 可直接执行）轮询获取最终输出后再回答；` +
      `不要重复执行该写/危险操作；最后用中文给出清晰结论。`;
    const completion = await this.runAgent(
      approval.sessionId,
      approval.runId,
      continuationInput,
      settings,
      selectedSkills,
      recentMessages
    );
    return this.finalizeDeferredRun(
      approval,
      completion.output,
      completion.interrupted ? 'awaiting_approval' : 'completed'
    );
  }

  private finalizeDeferredRun(
    approval: ApprovalRequest,
    output: string,
    status: AgentRendererEvents['agent:run-completed']['status']
  ): AgentRendererEvents['agent:run-completed']['status'] {
    const assistantMessage: Message = {
      id: randomUUID(),
      sessionId: approval.sessionId,
      role: 'assistant',
      content: output || '审批后的运行已结束，但模型没有返回可展示的文本。',
      runId: approval.runId,
      createdAt: Date.now()
    };
    this.dbs.appDb
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, run_id, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?)`
      )
      .run(
        assistantMessage.id,
        assistantMessage.sessionId,
        assistantMessage.content,
        assistantMessage.runId,
        assistantMessage.createdAt
      );
    this.touchSession(approval.sessionId, assistantMessage.createdAt);
    this.emitRendererEvent('agent:message-added', assistantMessage);
    const stepId = this.writeRunStep(
      approval.sessionId,
      approval.runId,
      'approval_resume',
      '审批后运行完成',
      status === 'failed' ? 'failed' : 'completed',
      { approvalId: approval.id, finalOutputLength: assistantMessage.content.length }
    );
    this.emitRunCompleted(approval.sessionId, approval.runId, status, stepId);
    return status;
  }

  private async invokeOpenApiGateway(input: {
    sessionId: string;
    runId: string;
    profile: Profile;
    product: string;
    action: string;
    version?: string;
    regionId?: string;
    params: Record<string, unknown>;
    dryRun: boolean;
    sdkApproved?: boolean;
  }): Promise<GatewayResult> {
    // 真实请求参数不脱敏：AccountPassword 等含敏感词的必填参数必须原样进入校验与实际调用。
    // 脱敏只在写入日志/trace/持久化快照时进行（见下方 writeToolInvocation 与 writeToolMessage）。
    const requestedParams: Record<string, unknown> = { ...input.params };
    let result: GatewayResult = {
      ok: false,
      status: 'REJECTED_BY_GATEWAY',
      product: input.product,
      action: input.action,
      version: input.version ?? null,
      danger: null,
      resolvedEndpoint: null,
      required: [],
      missing: [],
      injectedParams: {} as Record<string, string>,
      deprecated: null,
      replacedBy: null,
      requestId: null,
      response: null,
      errorCode: null,
      errorMessage: null
    };
    const traceStartedAt = Date.now();
    this.trace.event({
      sessionId: input.sessionId,
      runId: input.runId,
      event: 'gateway_start',
      target: `${input.product}/${input.action}`,
      status: 'start',
      meta: {
        product: input.product,
        action: input.action,
        version: input.version ?? null,
        regionId: input.regionId ?? null,
        dryRun: input.dryRun,
        paramKeys: Object.keys(requestedParams)
      }
    });

    try {
      if (!existsSync(this.dbs.catalogDbPath)) {
        throw gatewayError('CATALOG_NOT_READY', 'catalog.db 不存在，请先刷新 Catalog。');
      }
      const catalogDb = new Database(this.dbs.catalogDbPath, { readonly: true, fileMustExist: true });
      let row: CatalogActionRow | null = null;
      try {
        row = this.findCatalogAction(catalogDb, input.product, input.action, input.version);
      } finally {
        catalogDb.close();
      }
      if (!row) {
        throw gatewayError(
          'ACTION_NOT_FOUND',
          `catalog.db 中不存在 ${input.product}/${input.action}${input.version ? `/${input.version}` : ''}。请先用 discover_api 搜索正确产品和 Action。`
        );
      }
      const regionId = input.regionId || input.profile.defaultRegion || 'cn-hangzhou';
      let resolvedEndpoint = resolveEndpoint(row.endpointTpl, row.endpointMap, regionId);
      if (row.product.toLowerCase() === 'oss') {
        resolvedEndpoint = normalizeOssEndpoint(resolvedEndpoint, regionId);
      }
      const required = normalizeRequiredParams(row.product, row.action, parseJsonArray(row.requiredJson));
      const injectedParams: Record<string, string> = {};
      for (const key of required) {
        const current = requestedParams[key];
        const isEmpty = current === undefined || current === null || current === '';
        if (!isEmpty) continue;
        const fallback = PROFILE_PARAM_FALLBACKS[key];
        if (!fallback) continue;
        const value = fallback(input.profile);
        if (value === undefined || value === null || String(value).trim() === '') continue;
        requestedParams[key] = String(value).trim();
        injectedParams[key] = String(value).trim();
      }
      result = { ...result, injectedParams };
      const paramsForValidation: Record<string, unknown> = { RegionId: regionId, ...requestedParams };
      const missing = required.filter(
        (key) => paramsForValidation[key] === undefined || paramsForValidation[key] === null || paramsForValidation[key] === ''
      );
      const deprecated = isCatalogDeprecated(row.product, row.action, row.deprecated, row.replacedBy);
      result = {
        ...result,
        product: row.product,
        action: row.action,
        version: row.version,
        danger: row.danger,
        resolvedEndpoint,
        required,
        missing,
        deprecated,
        replacedBy: row.replacedBy ?? null
      };
      if (deprecated) {
        throw gatewayError('ACTION_DEPRECATED', `${row.product}/${row.action} 已弃用，请改用 ${row.replacedBy}。`);
      }

      this.upsertCatalogFactPointer(input.sessionId, input.runId, {
        product: row.product,
        action: row.action,
        version: row.version,
        danger: row.danger,
        required,
        replacedBy: row.replacedBy ?? null
      });

      if (missing.length) {
        throw gatewayError('MISSING_REQUIRED_PARAMS', `缺少必填参数：${missing.join(', ')}`);
      }

      if (input.dryRun) {
        result = {
          ...result,
          ok: true,
          status: 'SKIPPED_DRY_RUN',
          response: { dryRun: true, message: 'Gateway 校验通过，未发起 OpenAPI 调用。' }
        };
        return result;
      }

      const session = this.getSessionById(input.sessionId);
      const needsApproval =
        !input.sdkApproved && session.trustMode !== 'autopilot' && (row.danger === 'write' || row.danger === 'dangerous');
      if (needsApproval) {
        // 确定性审批闸门：gateway 每次执行都用权威 catalog danger 判定，按会话信任模式拦截。
        //（SDK needsApproval 仅作为更早的可选拦截，实测对部分 action 不触发，不能独依赖）。
        // 在此生成审批卡；用户确认后由 resumeApprovedRun 的 deferred 分支执行调用，并续跑 agent loop
        // 让结果回灌、异步操作继续轮询，最终给用户答案。
        const approvalDanger = row.danger === 'dangerous' ? 'dangerous' : 'write';
        const approval = this.createOpenApiApproval({
          sessionId: input.sessionId,
          runId: input.runId,
          profile: input.profile,
          product: row.product,
          action: row.action,
          version: row.version,
          danger: approvalDanger,
          regionId,
          endpoint: resolvedEndpoint,
          params: requestedParams,
          catalogMethod: row.method,
          catalogStyle: row.style,
          catalogParamsBlob: row.paramsBlob
        });
        result = {
          ...result,
          ok: false,
          status: 'AWAITING_APPROVAL',
          errorCode: 'APPROVAL_REQUIRED',
          errorMessage: `${row.product}/${row.action} 是 ${row.danger} 操作，已生成审批卡：${approval.approvalId}，等待用户确认。`
        };
        return result;
      }

      const response = await this.invokeAliyunSdk({
        sessionId: input.sessionId,
        runId: input.runId,
        profileId: input.profile.id,
        profileName: input.profile.name,
        product: row.product,
        action: row.action,
        version: row.version,
        regionId,
        endpoint: resolvedEndpoint,
        params: requestedParams,
        injectedParams,
        catalogMethod: row.method,
        catalogStyle: row.style,
        catalogParamsBlob: row.paramsBlob
      });
      result = {
        ...result,
        ok: true,
        status: 'SUCCESS',
        requestId: extractRequestId(response),
        response
      };
      return result;
    } catch (error) {
      const rawCode = error instanceof Error && 'code' in error ? (error as Error & { code?: unknown }).code : null;
      const code = typeof rawCode === 'string' && rawCode.trim() && !/^\d+$/.test(rawCode.trim()) ? rawCode.trim() : 'GATEWAY_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      result = {
        ...result,
        ok: false,
        status: code === 'ALIYUN_SDK_FAILED' ? 'FAILED_BY_ALIYUN' : 'REJECTED_BY_GATEWAY',
        errorCode: code,
        errorMessage: message
      };
      return result;
    } finally {
      this.trace.event({
        sessionId: input.sessionId,
        runId: input.runId,
        event: 'gateway_end',
        target: `${result.product}/${result.action}`,
        status: result.status,
        durationMs: Date.now() - traceStartedAt,
        meta: {
          gatewayStatus: result.status,
          errorCode: result.errorCode,
          requestId: result.requestId,
          product: result.product,
          action: result.action,
          version: result.version,
          danger: result.danger,
          required: result.required,
          missing: result.missing,
          deprecated: result.deprecated,
          replacedBy: result.replacedBy
        }
      });
      this.writeToolInvocation({
        sessionId: input.sessionId,
        toolName: 'call_openapi',
        product: result.product,
        action: result.action,
        version: result.version,
        danger: result.danger,
        resolvedEndpoint: result.resolvedEndpoint,
        requestParams: sanitizeParams(requestedParams),
        provenance: {
          requestedProduct: input.product,
          requestedAction: input.action,
          regionId: input.regionId,
          profileName: input.profile.name,
          trustMode: this.getSessionById(input.sessionId).trustMode,
          dryRun: input.dryRun
        },
        status: result.status,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        requestId: result.requestId,
        akIdMasked: input.profile.akIdMasked
      });
    }
  }

  private findCatalogAction(catalogDb: Database.Database, product: string, action: string, version?: string): CatalogActionRow | null {
    const normalizedProduct = product.trim().toLowerCase();
    const normalizedAction = action.trim();
    const normalizedVersion = normalizeVersion(version);
    const alias = catalogDb
      .prepare('SELECT product FROM catalog_aliases WHERE lower(alias) = lower(?)')
      .get(normalizedProduct) as { product: string } | undefined;
    const resolvedProduct = alias?.product ?? normalizedProduct;
    const versionClause = normalizedVersion ? 'AND lower(ca.version) = lower(@version)' : '';
    const row = catalogDb
      .prepare(
        `SELECT ca.product, ca.action, ca.version, ca.method, ca.style, ca.required_json AS requiredJson,
                ca.danger, ca.summary_cn AS summaryCn, ca.params_blob AS paramsBlob,
                cp.endpoint_tpl AS endpointTpl, cp.endpoint_map AS endpointMap,
                cp.default_version AS defaultVersion,
                co.deprecated, co.replaced_by AS replacedBy,
                @aliasProduct AS aliasProduct
         FROM catalog_actions ca
         JOIN catalog_products cp ON cp.product = ca.product
         LEFT JOIN catalog_overlay co ON co.product = ca.product AND co.action = ca.action
         WHERE lower(ca.product) = lower(@product)
           AND lower(ca.action) = lower(@action)
           ${versionClause}
         ORDER BY CASE WHEN ca.version = cp.default_version THEN 0 ELSE 1 END, ca.version DESC
         LIMIT 1`
      )
      .get({
        product: resolvedProduct,
        action: normalizedAction,
        version: normalizedVersion ?? null,
        aliasProduct: alias ? normalizedProduct : null
      }) as CatalogActionRow | undefined;
    return row ?? null;
  }

  private async invokeAliyunSdk(input: AliyunProviderInput): Promise<unknown> {
    const params = { ...input.params };
    if (input.product.toLowerCase() !== 'oss' && !Object.prototype.hasOwnProperty.call(params, 'RegionId')) {
      params.RegionId = input.regionId;
    }
    const provider = this.getAliyunApiProvider(input.product);
    return this.trace.measure(
      {
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        event: 'aliyun_sdk',
        target: `${input.product}/${input.action}`,
        meta: {
          provider: provider.name,
          product: input.product,
          action: input.action,
          version: input.version,
          regionId: input.regionId,
          endpoint: input.endpoint,
          profileName: input.profileName,
          paramKeys: Object.keys(params),
          injectedParamKeys: Object.keys(input.injectedParams ?? {})
        }
      },
      async () => {
        try {
          return await provider.invoke({ ...input, params });
        } catch (error) {
          if (isGatewayError(error)) throw error;
          throw gatewayError('ALIYUN_SDK_FAILED', formatAliyunSdkError(error));
        }
      }
    );
  }

  private getAliyunApiProvider(product: string): AliyunApiProvider {
    if (product.toLowerCase() === 'oss') {
      return {
        name: 'oss-roa-xml',
        invoke: (input) => this.invokeOssProvider(input)
      };
    }
    return {
      name: 'generic-rpc-json',
      invoke: (input) => this.invokeGenericOpenApiProvider(input)
    };
  }

  private async invokeGenericOpenApiProvider(input: AliyunProviderInput): Promise<unknown> {
    const credentials = this.getProfileCredentials(input.profileId);
    const query = normalizeOpenApiQuery(input.params);
    const client = new OpenApiClient(
      new OpenApiConfig({
        accessKeyId: credentials.akId,
        accessKeySecret: credentials.akSecret,
        endpoint: input.endpoint,
        regionId: input.regionId,
        readTimeout: DEFAULT_OPENAPI_TIMEOUT_MS,
        connectTimeout: 10_000
      })
    );
    const request = new OpenApiRequest({
      headers: {},
      query
    });
    const openApiParams = new OpenApiParams({
      action: input.action,
      version: input.version,
      protocol: 'HTTPS',
      pathname: '/',
      method: 'POST',
      authType: 'AK',
      style: 'RPC',
      reqBodyType: 'formData',
      bodyType: 'json'
    });
    return await client.doRequest(openApiParams, request, {
      autoretry: true,
      maxAttempts: 2,
      readTimeout: DEFAULT_OPENAPI_TIMEOUT_MS,
      connectTimeout: 10_000
    } as any);
  }

  private async invokeOssProvider(input: AliyunProviderInput): Promise<unknown> {
    const credentials = this.getProfileCredentials(input.profileId);
    const client = new OssClient(
      new OpenApiConfig({
        accessKeyId: credentials.akId,
        accessKeySecret: credentials.akSecret,
        endpoint: normalizeOssEndpoint(input.endpoint, input.regionId),
        regionId: input.regionId,
        readTimeout: DEFAULT_OPENAPI_TIMEOUT_MS,
        connectTimeout: 10_000
      })
    );
    const runtime = new RuntimeOptions({
      autoretry: true,
      maxAttempts: 2,
      readTimeout: DEFAULT_OPENAPI_TIMEOUT_MS,
      connectTimeout: 10_000
    });
    const action = input.action.trim();
    switch (action) {
      case 'ListBuckets': {
        const request = new ListBucketsRequest({
          marker: stringParam(input.params, ['Marker', 'marker']),
          maxKeys: numberParam(input.params, ['MaxKeys', 'maxKeys', 'max-keys']),
          prefix: stringParam(input.params, ['Prefix', 'prefix'])
        });
        const headers = new ListBucketsHeaders({});
        return toPlainAliyunResponse(await client.listBucketsWithOptions(request, headers, runtime));
      }
      case 'PutBucket': {
        const bucket = requireOssBucket(input.params);
        const request = new PutBucketRequest({
          createBucketConfiguration: buildCreateBucketConfiguration(input.params)
        });
        const headers = new PutBucketHeaders({
          acl: stringParam(input.params, ['ACL', 'Acl', 'acl']),
          xOssResourceGroupId: stringParam(input.params, ['ResourceGroupId', 'resourceGroupId', 'xOssResourceGroupId'])
        });
        return toPlainAliyunResponse(await client.putBucketWithOptions(bucket, request, headers, runtime));
      }
      case 'GetBucketInfo': {
        const bucket = requireOssBucket(input.params);
        return toPlainAliyunResponse(await client.getBucketInfoWithOptions(bucket, {}, runtime));
      }
      case 'PutBucketAcl': {
        const bucket = requireOssBucket(input.params);
        const headers = new PutBucketAclHeaders({
          acl: requireOssAcl(input.params)
        });
        return toPlainAliyunResponse(await client.putBucketAclWithOptions(bucket, headers, runtime));
      }
      case 'GetBucketAcl': {
        const bucket = requireOssBucket(input.params);
        return toPlainAliyunResponse(await client.getBucketAclWithOptions(bucket, {}, runtime));
      }
      case 'PutBucketPolicy': {
        const bucket = requireOssBucket(input.params);
        const request = new PutBucketPolicyRequest({
          policy: requireOssBucketPolicy(input.params)
        });
        return toPlainAliyunResponse(await client.putBucketPolicyWithOptions(bucket, request, {}, runtime));
      }
      case 'GetBucketPolicy': {
        const bucket = requireOssBucket(input.params);
        return toPlainAliyunResponse(await client.getBucketPolicyWithOptions(bucket, {}, runtime));
      }
      case 'DeleteBucketPolicy': {
        const bucket = requireOssBucket(input.params);
        return toPlainAliyunResponse(await client.deleteBucketPolicyWithOptions(bucket, {}, runtime));
      }
      case 'PutBucketWebsite': {
        const bucket = requireOssBucket(input.params);
        return toPlainAliyunResponse(await putBucketWebsiteWithRootXml(client, bucket, buildWebsiteConfiguration(input.params), runtime));
      }
      case 'GetBucketWebsite': {
        const bucket = requireOssBucket(input.params);
        return toPlainAliyunResponse(await client.getBucketWebsiteWithOptions(bucket, {}, runtime));
      }
      case 'DeleteBucketWebsite': {
        const bucket = requireOssBucket(input.params);
        return toPlainAliyunResponse(await client.deleteBucketWebsiteWithOptions(bucket, {}, runtime));
      }
      default: {
        if (isPublicAccessBlockAction(action)) {
          return toPlainAliyunResponse(await invokePublicAccessBlockAction(client, action, input.params, runtime));
        }
        const simpleBucketResponse = invokeSimpleOssBucketAction(client, action, input.params, runtime);
        if (simpleBucketResponse) return toPlainAliyunResponse(await simpleBucketResponse);
        const sdkResponse = invokeOssSdkAction(client, action, input.params, runtime);
        if (sdkResponse) return toPlainAliyunResponse(await sdkResponse);
        const rawResponse = invokeRawOssAction(client, input, runtime);
        if (rawResponse) return toPlainAliyunResponse(await rawResponse);
        throw gatewayError(
          'UNSUPPORTED_OSS_ACTION',
          `OSS provider 暂不支持 ${action}。当前 @alicloud/oss20190517 SDK 未提供该 action 的 WithOptions 方法；如需直接调用，请传 Method 与 Pathname 使用低层 ROA/XML execute。`
        );
      }
    }
  }

  private writeToolInvocation(input: {
    sessionId: string;
    toolName: string;
    product: string | null;
    action: string | null;
    version: string | null;
    danger: string | null;
    resolvedEndpoint: string | null;
    requestParams: unknown;
    provenance: unknown;
    status: GatewayStatus;
    errorCode: string | null;
    errorMessage: string | null;
    requestId: string | null;
    akIdMasked: string | null;
  }): void {
    this.dbs.appDb
      .prepare(
        `INSERT INTO tool_invocations
          (id, session_id, task_id, tool_name, product, action, version, danger,
           resolved_endpoint, request_params_json, provenance_json, status,
           error_code, error_message, http_status, request_id, ak_id_masked, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.sessionId,
        input.toolName,
        input.product,
        input.action,
        input.version,
        input.danger,
        input.resolvedEndpoint,
        JSON.stringify(input.requestParams),
        JSON.stringify(input.provenance),
        input.status,
        input.errorCode,
        input.errorMessage,
        input.requestId,
        input.akIdMasked,
        Date.now()
      );
  }

  private writeRejectedApprovalInvocation(approval: ApprovalRequest, reason: string | null): void {
    const params = parseJsonValue(approval.paramsJson) as Record<string, unknown> | null;
    if (!params || params.kind !== 'openapi_call') return;
    const requestParams = params.params && typeof params.params === 'object' && !Array.isArray(params.params)
      ? (params.params as Record<string, unknown>)
      : {};
    this.writeToolInvocation({
      sessionId: approval.sessionId,
      toolName: 'call_openapi.rejected',
      product: typeof params.product === 'string' ? params.product : null,
      action: typeof params.action === 'string' ? params.action : null,
      version: typeof params.version === 'string' ? params.version : null,
      danger: approval.danger,
      resolvedEndpoint: typeof params.endpoint === 'string' ? params.endpoint : null,
      requestParams,
      provenance: {
        approvalId: approval.id,
        rejectedAt: Date.now(),
        reason
      },
      status: 'REJECTED_BY_USER' as GatewayStatus,
      errorCode: 'REJECTED_BY_USER',
      errorMessage: reason ?? '用户拒绝执行审批请求。',
      requestId: null,
      akIdMasked: null
    });
  }

  private upsertCatalogFactPointer(sessionId: string, runId: string, fact: Record<string, unknown>): void {
    if (typeof fact.product !== 'string' || typeof fact.action !== 'string' || typeof fact.version !== 'string') return;
    const danger = typeof fact.danger === 'string' ? fact.danger : null;
    if (danger !== 'safe' && danger !== 'write' && danger !== 'dangerous') return;
    const required = Array.isArray(fact.required) ? fact.required.filter((item): item is string => typeof item === 'string') : [];
    const now = Date.now();
    this.dbs.appDb
      .prepare(
        `INSERT INTO catalog_fact_pointers
          (id, session_id, run_id, product, action, version, danger, required_json, replaced_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, run_id, product, action, version) DO UPDATE SET
          danger = excluded.danger,
          required_json = excluded.required_json,
          replaced_by = excluded.replaced_by,
          updated_at = excluded.updated_at`
      )
      .run(
        randomUUID(),
        sessionId,
        runId,
        fact.product,
        fact.action,
        fact.version,
        danger,
        JSON.stringify(required),
        typeof fact.replacedBy === 'string' ? fact.replacedBy : null,
        now,
        now
      );
    this.emitRendererEvent('agent:catalog-fact-added', {
      sessionId,
      runId,
      product: fact.product,
      action: fact.action,
      version: fact.version,
      danger,
      required,
      replacedBy: typeof fact.replacedBy === 'string' ? fact.replacedBy : null,
      updatedAt: now
    });
  }

  private upsertContextDocumentPointer(
    sessionId: string,
    runId: string,
    workspace: Workspace,
    path: string,
    content: string
  ): void {
    const now = Date.now();
    const sourceHash = sha256(content);
    const existing = this.dbs.appDb
      .prepare(
        `SELECT id FROM session_context_items
         WHERE session_id = ? AND run_id = ? AND source_type = 'workspace_file' AND source_ref = ?`
      )
      .get(sessionId, runId, path) as { id: string } | undefined;
    if (existing) {
      this.dbs.appDb
        .prepare(
          `UPDATE session_context_items
           SET source_hash = ?, status = 'loaded', created_at = ?
           WHERE id = ?`
        )
        .run(sourceHash, now, existing.id);
    } else {
      this.dbs.appDb
        .prepare(
          `INSERT INTO session_context_items
            (id, session_id, run_id, tool_call_id, source_type, source_ref, source_hash,
             resolved_endpoint, request_params_json, provenance_json, status,
             error_code, error_message, http_status, request_id, ak_id_masked, created_at)
           VALUES (?, ?, ?, NULL, 'workspace_file', ?, ?, NULL, NULL, NULL, 'loaded',
                   NULL, NULL, NULL, NULL, NULL, ?)`
        )
        .run(randomUUID(), sessionId, runId, path, sourceHash, now);
    }
    const indexed = this.dbs.appDb
      .prepare(
        `SELECT title, mtime, size
         FROM workspace_index
         WHERE workspace_id = ? AND path = ?`
      )
      .get(workspace.id, path) as { title: string | null; mtime: number; size: number } | undefined;
    this.emitRendererEvent('agent:context-document-added', {
      sessionId,
      runId,
      path,
      title: indexed?.title ?? basename(path),
      mtime: indexed?.mtime ?? now,
      size: indexed?.size ?? Buffer.byteLength(content, 'utf8'),
      usedAt: now
    });
  }

  private emitRendererEvent<K extends keyof AgentRendererEvents>(channel: K, payload: AgentRendererEvents[K]): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    }
  }

  private emitRunCompleted(
    sessionId: string,
    runId: string,
    status: AgentRendererEvents['agent:run-completed']['status'],
    runStepId: string | null
  ): void {
    this.emitRendererEvent('agent:run-completed', {
      sessionId,
      runId,
      status,
      runStep: runStepId ? this.getRunStepById(runStepId) ?? undefined : undefined
    });
  }

  private emitApprovalRequested(approvalId: string): void {
    const approval = this.getApprovalRequestById(approvalId);
    if (approval) this.emitRendererEvent('agent:approval-requested', approval);
  }

  private emitMessageDelta(sessionId: string, runId: string, delta: string): void {
    if (!delta) return;
    this.emitRendererEvent('agent:message-delta', {
      sessionId,
      runId,
      delta,
      createdAt: Date.now()
    });
  }

  private emitActivity(sessionId: string, runId: string, label: string): void {
    if (!label) return;
    this.emitRendererEvent('agent:activity', {
      sessionId,
      runId,
      label,
      createdAt: Date.now()
    });
  }

  // 把 SDK 的流式事件翻译成"正在做什么"的人话标签，实时吐给前端，消除推理空档的静默感。
  private handleStreamEventForActivity(sessionId: string, runId: string, event: unknown): void {
    const evt = event as { type?: string; name?: string; item?: { rawItem?: Record<string, unknown> } };
    if (evt?.type !== 'run_item_stream_event') return;
    if (evt.name === 'reasoning_item_created') {
      this.emitActivity(sessionId, runId, '正在思考下一步…');
      return;
    }
    if (evt.name !== 'tool_called') return;
    const raw = evt.item?.rawItem;
    if (!raw || raw.type !== 'function_call' || typeof raw.name !== 'string') return;
    const args = parseJsonValue(typeof raw.arguments === 'string' ? raw.arguments : '') as Record<string, unknown> | null;
    this.emitActivity(sessionId, runId, describeToolActivity(raw.name, args));
  }

  private writeToolMessage(sessionId: string, runId: string, content: string): void {
    const message: Message = {
      id: randomUUID(),
      sessionId,
      role: 'tool',
      content,
      runId,
      createdAt: Date.now()
    };
    this.dbs.appDb
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, run_id, created_at)
         VALUES (?, ?, 'tool', ?, ?, ?)`
      )
      .run(message.id, message.sessionId, message.content, message.runId, message.createdAt);
    this.touchSession(sessionId, message.createdAt);
    this.emitRendererEvent('agent:message-added', message);
  }

  private touchSession(sessionId: string, updatedAt = Date.now()): void {
    this.dbs.appDb.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, sessionId);
  }

  /**
   * 会话仍为默认占位标题时，用首条用户消息内容推导出一个可读标题，
   * 以避免侧边栏全是「未命名会话」。
   */
  private maybeAutoTitleSession(sessionId: string, firstMessage: string): void {
    const row = this.dbs.appDb
      .prepare('SELECT title FROM sessions WHERE id = ?')
      .get(sessionId) as { title: string | null } | undefined;
    if (!row) return;
    const current = (row.title ?? '').trim();
    if (current && current !== '未命名会话' && current !== '新会话') return;

    const title = deriveSessionTitle(firstMessage);
    if (!title) return;
    this.dbs.appDb.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
    const updated = this.getSessionById(sessionId);
    this.emitRendererEvent('agent:session-updated', updated);
  }

  private getSessionById(sessionId: string): Session {
    const row = this.dbs.appDb
      .prepare(
        `SELECT id, workspace_id AS workspaceId, profile_id AS profileId, title,
                trust_mode AS trustMode, status, created_at AS createdAt, updated_at AS updatedAt
         FROM sessions WHERE id = ?`
      )
      .get(sessionId) as Session | undefined;
    if (!row) throw new Error(`会话不存在：${sessionId}`);
    return row;
  }

  private getProfileById(profileId: string): Profile {
    const row = this.dbs.appDb
      .prepare(
        `SELECT id, name, ak_id_masked AS akIdMasked, rdc_id AS rdcId,
                default_region AS defaultRegion, created_at AS createdAt, updated_at AS updatedAt
         FROM profiles WHERE id = ?`
      )
      .get(profileId) as Profile | undefined;
    if (!row) throw new Error(`Profile 不存在：${profileId}`);
    return row;
  }

  private getProfileCredentials(profileId: string): AliyunCredentials {
    const row = this.dbs.appDb
      .prepare(
        `SELECT ak_id_masked AS akIdMasked,
                ak_id_encrypted AS akIdEncrypted,
                ak_secret_encrypted AS akSecretEncrypted
         FROM profiles WHERE id = ?`
      )
      .get(profileId) as ProfileCredentialRow | undefined;
    if (!row) throw new Error(`Profile 不存在：${profileId}`);
    const akId = decryptSecret(row.akIdEncrypted);
    const akSecret = decryptSecret(row.akSecretEncrypted);
    if (!akId || !akSecret) {
      throw new Error('当前 Profile 没有可解密的阿里云 AK/SK，请重新保存 AccessKey ID 和 Secret。');
    }
    return { akId, akSecret, akIdMasked: row.akIdMasked };
  }

  private getWorkspaceById(workspaceId: string): Workspace {
    const row = this.dbs.appDb
      .prepare(
        `SELECT id, name, root_path AS rootPath, active_profile_id AS activeProfileId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM workspaces WHERE id = ?`
      )
      .get(workspaceId) as Workspace | undefined;
    if (!row) throw new Error(`工作空间不存在：${workspaceId}`);
    return row;
  }

  private writeRunStep(
    sessionId: string,
    runId: string,
    stepType: string,
    title: string,
    status: string,
    payload: unknown
  ): string {
    const id = randomUUID();
    const now = Date.now();
    this.dbs.appDb
      .prepare(
        `INSERT INTO run_steps (id, session_id, run_id, step_type, title, status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, sessionId, runId, stepType, title, status, JSON.stringify(payload), now, now);
    this.emitRendererEvent('agent:run-step-added', {
      id,
      sessionId,
      runId,
      stepType,
      title,
      status,
      payloadJson: JSON.stringify(payload),
      createdAt: now,
      updatedAt: now
    });
    return id;
  }

  private listWorkspaces(): Workspace[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, name, root_path AS rootPath, active_profile_id AS activeProfileId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM workspaces ORDER BY updated_at DESC`
      )
      .all() as Workspace[];
  }

  private listProfiles(): Profile[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, name, ak_id_masked AS akIdMasked, rdc_id AS rdcId,
                default_region AS defaultRegion, created_at AS createdAt, updated_at AS updatedAt
         FROM profiles ORDER BY updated_at DESC`
      )
      .all() as Profile[];
  }

  private listSessions(): Session[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, workspace_id AS workspaceId, profile_id AS profileId, title,
                trust_mode AS trustMode, status, created_at AS createdAt, updated_at AS updatedAt
         FROM sessions ORDER BY updated_at DESC`
      )
      .all() as Session[];
  }

  private listMessages(): Message[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, session_id AS sessionId, role, content, run_id AS runId, created_at AS createdAt
         FROM (
           SELECT id, session_id, role, content, run_id, created_at
           FROM messages
           ORDER BY created_at DESC
           LIMIT 1000
         )
         ORDER BY created_at ASC`
      )
      .all() as Message[];
  }

  private listRecentSessionMessages(sessionId: string, limit: number): Message[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, session_id AS sessionId, role, content, run_id AS runId, created_at AS createdAt
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(sessionId, limit)
      .reverse() as Message[];
  }

  private listRunSteps(): RunStep[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, session_id AS sessionId, run_id AS runId, step_type AS stepType,
                title, status, payload_json AS payloadJson, created_at AS createdAt, updated_at AS updatedAt
         FROM run_steps ORDER BY created_at ASC LIMIT 200`
      )
      .all() as RunStep[];
  }

  private getRunStepById(id: string): RunStep | null {
    return (
      (this.dbs.appDb
        .prepare(
          `SELECT id, session_id AS sessionId, run_id AS runId, step_type AS stepType,
                  title, status, payload_json AS payloadJson, created_at AS createdAt, updated_at AS updatedAt
           FROM run_steps WHERE id = ?`
        )
        .get(id) as RunStep | undefined) ?? null
    );
  }

  private listContextDocuments(): ContextDocumentPointer[] {
    return this.dbs.appDb
      .prepare(
        `SELECT sci.session_id AS sessionId, sci.run_id AS runId,
                sci.source_ref AS path,
                wi.title,
                COALESCE(wi.mtime, sci.created_at) AS mtime,
                COALESCE(wi.size, 0) AS size,
                sci.created_at AS usedAt
         FROM session_context_items sci
         JOIN sessions s ON s.id = sci.session_id
         LEFT JOIN workspace_index wi
           ON wi.workspace_id = s.workspace_id AND wi.path = sci.source_ref
         WHERE sci.source_type = 'workspace_file'
         ORDER BY sci.created_at DESC
         LIMIT 100`
      )
      .all() as ContextDocumentPointer[];
  }

  private listCatalogFacts(): CatalogFactPointer[] {
    return this.dbs.appDb
      .prepare(
        `SELECT session_id AS sessionId, run_id AS runId,
                product, action, version, danger, required_json AS requiredJson,
                replaced_by AS replacedBy, updated_at AS updatedAt
         FROM catalog_fact_pointers
         ORDER BY updated_at DESC
         LIMIT 100`
      )
      .all()
      .map((row) => {
        const typed = row as Row & { requiredJson: string };
        return {
          sessionId: String(typed.sessionId),
          runId: String(typed.runId),
          product: String(typed.product),
          action: String(typed.action),
          version: String(typed.version),
          danger: typed.danger as 'safe' | 'write' | 'dangerous',
          required: parseJsonArray(typed.requiredJson),
          replacedBy: typeof typed.replacedBy === 'string' ? typed.replacedBy : null,
          updatedAt: Number(typed.updatedAt)
        };
      });
  }

  private getCatalogStatus(): CatalogStatus {
    const inspected = this.inspectCatalogDb();
    const refresh = this.dbs.appDb
      .prepare(
        `SELECT status AS lastRefreshStatus, message AS lastRefreshMessage, refreshed_at AS refreshedAt
         FROM catalog_refresh_state WHERE id = 'default'`
      )
      .get() as Pick<CatalogStatus, 'lastRefreshStatus' | 'lastRefreshMessage' | 'refreshedAt'> | undefined;

    return {
      ...inspected,
      lastRefreshStatus: refresh?.lastRefreshStatus ?? null,
      lastRefreshMessage: refresh?.lastRefreshMessage ?? null,
      refreshedAt: refresh?.refreshedAt ?? null
    };
  }

  private inspectCatalogDb(): Omit<CatalogStatus, 'lastRefreshStatus' | 'lastRefreshMessage' | 'refreshedAt'> {
    if (!existsSync(this.dbs.catalogDbPath)) {
      return {
        exists: false,
        path: this.dbs.catalogDbPath,
        productCount: 0,
        actionCount: 0,
        schemaVersion: null,
        specSnapshotDate: null
      };
    }

    const catalogDb = new Database(this.dbs.catalogDbPath, { readonly: true, fileMustExist: true });
    try {
      const hasProducts = hasTable(catalogDb, 'catalog_products');
      const hasActions = hasTable(catalogDb, 'catalog_actions');
      const hasMeta = hasTable(catalogDb, 'meta');
      const productCount = hasProducts ? Number((catalogDb.prepare('SELECT COUNT(*) AS count FROM catalog_products').get() as Row).count) : 0;
      const actionCount = hasActions ? Number((catalogDb.prepare('SELECT COUNT(*) AS count FROM catalog_actions').get() as Row).count) : 0;
      const schemaVersion = hasMeta ? getMeta(catalogDb, 'schema_version') : null;
      const specSnapshotDate = hasMeta ? getMeta(catalogDb, 'spec_snapshot_date') : null;

      return {
        exists: true,
        path: this.dbs.catalogDbPath,
        productCount,
        actionCount,
        schemaVersion,
        specSnapshotDate
      };
    } finally {
      catalogDb.close();
    }
  }

  private listSkills(): SkillSummary[] {
    return this.dbs.appDb
      .prepare('SELECT id, title, description FROM skills ORDER BY updated_at DESC')
      .all() as SkillSummary[];
  }

  private searchSkills(query: string, limit: number): SkillSummary[] {
    const trimmed = query.trim();
    if (!trimmed) return this.listSkills().slice(0, limit);
    try {
      return this.dbs.appDb
        .prepare(
          `SELECT s.id, s.title, s.description
           FROM skills_fts f
           JOIN skills s ON s.id = f.doc_id
           WHERE skills_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(toFtsQuery(trimmed), limit) as SkillSummary[];
    } catch {
      const like = `%${trimmed}%`;
      return this.dbs.appDb
        .prepare(
          `SELECT id, title, description
           FROM skills
           WHERE title LIKE ? OR description LIKE ? OR keywords LIKE ? OR body LIKE ?
           ORDER BY updated_at DESC
           LIMIT ?`
        )
        .all(like, like, like, like, limit) as SkillSummary[];
    }
  }

  private listWorkspaceEntries(
    workspace: Workspace,
    requestedPath: string,
    limit: number
  ): Array<{ path: string; title: string | null; kind: 'file' | 'dir'; size: number; mtime: number }> {
    const base = resolve(workspace.rootPath);
    const relativePath = normalizeWorkspacePath(requestedPath);
    const target = resolveWorkspacePath(base, relativePath);
    if (!target) return [];
    if (!existsSync(target)) return [];

    const stats = statSync(target);
    if (!stats.isDirectory()) {
      return [
        {
          path: relativePath,
          title: basename(target),
          kind: 'file',
          size: stats.size,
          mtime: Math.trunc(stats.mtimeMs)
        }
      ];
    }

    const rows = readdirSync(target)
      .filter((entry) => !entry.startsWith('.') || entry === '.agent-memory')
      .map((entry) => {
        const absolute = resolve(target, entry);
        const entryStats = statSync(absolute);
        const path = toWorkspaceRelativePath(base, absolute);
        return {
          path,
          title: entry,
          kind: entryStats.isDirectory() ? ('dir' as const) : ('file' as const),
          size: entryStats.size,
          mtime: Math.trunc(entryStats.mtimeMs)
        };
      })
      .filter((entry) => entry.kind === 'dir' || shouldIndexWorkspacePath(entry.path, entry.size))
      .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? -1 : 1));
    return rows.slice(0, limit);
  }

  private searchWorkspace(
    workspace: Workspace,
    query: string,
    options: { limit: number; memoryOnly: boolean; profileId?: string }
  ): Array<{ path: string; title: string | null; snippet: string; score: number | null }> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const memoryPrefix = options.profileId ? `.agent-memory/${options.profileId}/` : '.agent-memory/';
    try {
      const rows = this.dbs.appDb
        .prepare(
          `SELECT path, title, snippet(workspace_fts, 3, '[', ']', '...', 18) AS snippet, rank AS score
           FROM workspace_fts
           WHERE workspace_id = ?
             AND workspace_fts MATCH ?
             AND (? = 0 OR path LIKE ?)
           ORDER BY rank
           LIMIT ?`
        )
        .all(workspace.id, toFtsQuery(trimmed), options.memoryOnly ? 1 : 0, `${memoryPrefix}%`, options.limit) as Array<{
        path: string;
        title: string | null;
        snippet: string;
        score: number | null;
      }>;
      if (rows.length > 0) return rows;
    } catch {
      // Fall through to LIKE scan when FTS cannot parse a query.
    }

    const like = `%${trimmed}%`;
    return this.dbs.appDb
      .prepare(
        `SELECT path, title,
                CASE
                  WHEN content LIKE ? THEN substr(content, max(1, instr(content, ?) - 80), 180)
                  ELSE title
                END AS snippet,
                NULL AS score
         FROM workspace_fts
         WHERE workspace_id = ?
           AND (? = 0 OR path LIKE ?)
           AND (path LIKE ? OR title LIKE ? OR content LIKE ?)
         LIMIT ?`
      )
      .all(like, trimmed, workspace.id, options.memoryOnly ? 1 : 0, `${memoryPrefix}%`, like, like, like, options.limit) as Array<{
      path: string;
      title: string | null;
      snippet: string;
      score: null;
    }>;
  }

  private readWorkspaceFile(workspace: Workspace, requestedPath: string): { ok: boolean; path?: string; content?: string; error?: string } {
    const base = resolve(workspace.rootPath);
    const relativePath = normalizeWorkspacePath(requestedPath);
    const absolute = resolveWorkspacePath(base, relativePath);
    if (!absolute) return { ok: false, error: '路径越界，必须读取当前工作空间内的相对路径。' };
    if (!existsSync(absolute)) return { ok: false, error: `文件不存在：${relativePath}` };
    const stats = statSync(absolute);
    if (!stats.isFile()) return { ok: false, error: `不是文件：${relativePath}` };
    if (!shouldIndexWorkspacePath(relativePath, stats.size)) return { ok: false, error: `文件类型或大小不适合读取：${relativePath}` };
    return { ok: true, path: relativePath, content: readFileSync(absolute, 'utf8') };
  }

  private listProfileMemoryIndex(workspace: Workspace, profileId: string): string {
    return this.listWorkspaceEntries(workspace, `.agent-memory/${profileId}`, 20)
      .filter((entry) => entry.kind === 'file')
      .map((entry) => `[memory] ${entry.path} · ${entry.title ?? basename(entry.path)}`)
      .join('\n');
  }

  private createOpenApiApproval(input: {
    sessionId: string;
    runId: string;
    profile: Profile;
    product: string;
    action: string;
    version: string;
    danger: 'write' | 'dangerous';
    regionId: string;
    endpoint: string;
    params: Record<string, unknown>;
    catalogMethod?: string | null;
    catalogStyle?: string | null;
    catalogParamsBlob?: string | null;
  }): { approvalId: string; summary: string } {
    const approvalId = randomUUID();
    const summary = `确认执行 ${input.danger} OpenAPI：${input.product}/${input.action}`;
    const params = {
      kind: 'openapi_call',
      profileId: input.profile.id,
      profileName: input.profile.name,
      product: input.product,
      action: input.action,
      version: input.version,
      regionId: input.regionId,
      endpoint: input.endpoint,
      params: input.params,
      catalogMethod: input.catalogMethod ?? null,
      catalogStyle: input.catalogStyle ?? null,
      catalogParamsBlob: input.catalogParamsBlob ?? null
    };
    this.dbs.appDb
      .prepare(
        `INSERT INTO approval_requests
          (id, session_id, run_id, tool_call_id, status, reason, danger, summary,
           params_json, provenance_json, run_state_json, context_hash, created_at, decided_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        approvalId,
        input.sessionId,
        input.runId,
        `call_openapi:${approvalId}`,
        `严控核签模式下 ${input.danger} 操作需要人工确认。`,
        input.danger,
        summary,
        JSON.stringify(params),
        JSON.stringify({
          toolName: 'call_openapi',
          resolvedEndpoint: input.endpoint,
          akIdMasked: input.profile.akIdMasked
        }),
        JSON.stringify({ kind: 'deferred_openapi_call' }),
        sha256(JSON.stringify(params)),
        Date.now()
      );
    this.emitApprovalRequested(approvalId);
    this.writeAuditEvent('approval.requested', { approvalId, summary, product: input.product, action: input.action });
    return { approvalId, summary };
  }

  private createWriteApproval(input: {
    sessionId: string;
    runId: string;
    workspace: Workspace;
    profileId: string;
    toolName: 'write_workspace_file' | 'write_memory';
    kind: 'workspace_file' | 'memory';
    path: string;
    content: string;
    reason: string;
  }): { approvalId: string; path: string; summary: string } {
    const base = resolve(input.workspace.rootPath);
    const relativePath = normalizeWorkspacePath(input.path);
    const absolute = resolveWorkspacePath(base, relativePath);
    if (!absolute) throw new Error('路径越界，必须写入当前工作空间内的相对路径。');
    if (!shouldIndexWorkspacePath(relativePath, Buffer.byteLength(input.content, 'utf8'))) {
      throw new Error(`文件类型或大小不适合写入：${relativePath}`);
    }
    if (input.kind === 'memory' && !relativePath.startsWith(`.agent-memory/${input.profileId}/`)) {
      throw new Error('记忆只能写入当前 Profile 的 .agent-memory 子目录。');
    }

    const approvalId = randomUUID();
    const toolCallId = `${input.toolName}:${approvalId}`;
    const params = {
      kind: input.kind,
      workspaceId: input.workspace.id,
      profileId: input.profileId,
      path: relativePath,
      content: input.content
    };
    const summary =
      input.kind === 'memory'
        ? `写入长期记忆：${relativePath}`
        : `写入工作空间文件：${relativePath}`;
    this.dbs.appDb
      .prepare(
        `INSERT INTO approval_requests
          (id, session_id, run_id, tool_call_id, status, reason, danger, summary,
           params_json, provenance_json, run_state_json, context_hash, created_at, decided_at)
         VALUES (?, ?, ?, ?, 'pending', ?, 'write', ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        approvalId,
        input.sessionId,
        input.runId,
        toolCallId,
        input.reason,
        summary,
        JSON.stringify(params),
        JSON.stringify({ toolName: input.toolName, workspaceRoot: input.workspace.rootPath }),
        JSON.stringify({ kind: 'deferred_write' }),
        sha256(JSON.stringify(params)),
        Date.now()
      );
    this.emitApprovalRequested(approvalId);
    this.writeAuditEvent('approval.requested', { approvalId, summary, reason: input.reason });
    return { approvalId, path: relativePath, summary };
  }

  private async applyApprovedRequest(approval: ApprovalRequest): Promise<void> {
    const params = parseJsonValue(approval.paramsJson) as Record<string, unknown> | null;
    if (params?.kind === 'openapi_call') {
      await this.applyApprovedOpenApi(approval, params);
      return;
    }
    this.applyApprovedWrite(approval, params);
  }

  private applyApprovedWrite(approval: ApprovalRequest, params: Record<string, unknown> | null): void {
    if (!params || typeof params.workspaceId !== 'string' || typeof params.path !== 'string' || typeof params.content !== 'string') {
      throw new Error('审批请求参数损坏，无法写入。');
    }
    const workspace = this.getWorkspaceById(params.workspaceId);
    const base = resolve(workspace.rootPath);
    const relativePath = normalizeWorkspacePath(params.path);
    const absolute = resolveWorkspacePath(base, relativePath);
    if (!absolute) throw new Error('路径越界，必须写入当前工作空间内的相对路径。');
    if (!shouldIndexWorkspacePath(relativePath, Buffer.byteLength(params.content, 'utf8'))) {
      throw new Error(`文件类型或大小不适合写入：${relativePath}`);
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, params.content, 'utf8');
    indexWorkspaceRoot(this.dbs.appDb, workspace);
  }

  private async applyApprovedOpenApi(approval: ApprovalRequest, params: Record<string, unknown>): Promise<{ ok: boolean; summary: string }> {
    const required = ['profileId', 'profileName', 'product', 'action', 'version', 'regionId', 'endpoint'] as const;
    for (const key of required) {
      if (typeof params[key] !== 'string' || !params[key]) {
        throw new Error(`OpenAPI 审批参数缺失：${key}`);
      }
    }
    const profileId = params.profileId as string;
    const profileName = params.profileName as string;
    const product = params.product as string;
    const action = params.action as string;
    const version = params.version as string;
    const regionId = params.regionId as string;
    const endpoint = params.endpoint as string;
    const profile = this.getProfileById(profileId);
    const requestParams = params.params && typeof params.params === 'object' && !Array.isArray(params.params)
      ? (params.params as Record<string, unknown>)
      : {};
    let status: GatewayStatus = 'SUCCESS';
    let response: unknown = null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let requestId: string | null = null;
    try {
      response = await this.invokeAliyunSdk({
        sessionId: approval.sessionId,
        runId: approval.runId,
        profileId,
        profileName,
        product,
        action,
        version,
        regionId,
        endpoint,
        params: requestParams,
        catalogMethod: typeof params.catalogMethod === 'string' ? params.catalogMethod : null,
        catalogStyle: typeof params.catalogStyle === 'string' ? params.catalogStyle : null,
        catalogParamsBlob: typeof params.catalogParamsBlob === 'string' ? params.catalogParamsBlob : null
      });
      requestId = extractRequestId(response);
    } catch (error) {
      status = 'FAILED_BY_ALIYUN';
      errorCode = error instanceof Error && 'code' in error ? String((error as Error & { code?: string }).code) : 'ALIYUN_SDK_FAILED';
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    this.writeToolInvocation({
      sessionId: approval.sessionId,
      toolName: 'call_openapi.approved',
      product,
      action,
      version,
      danger: approval.danger,
      resolvedEndpoint: endpoint,
      requestParams,
      provenance: {
        approvalId: approval.id,
        approvedAt: Date.now(),
        regionId,
        response
      },
      status,
      errorCode,
      errorMessage,
      requestId,
      akIdMasked: profile.akIdMasked
    });
    if (status === 'SUCCESS') {
      const body = response === null || response === undefined ? '' : JSON.stringify(response);
      const compact = body.length > 1500 ? `${body.slice(0, 1500)}…(已截断)` : body;
      return {
        ok: true,
        summary: `状态 SUCCESS${requestId ? ` RequestId=${requestId}` : ''}；返回：${compact || '(无返回体)'}`
      };
    }
    return {
      ok: false,
      summary: `状态 ${status}；错误 ${errorCode ?? ''}：${errorMessage ?? '审批后的 OpenAPI 调用失败。'}`
    };
  }

  private listSessionSkills(): SessionSkillPointer[] {
    return this.dbs.appDb
      .prepare(
        `SELECT ss.session_id AS sessionId, s.id, s.title, s.description, ss.selected_at AS selectedAt
         FROM session_skills ss
         JOIN skills s ON s.id = ss.skill_id
         ORDER BY ss.selected_at DESC`
      )
      .all() as SessionSkillPointer[];
  }

  private listSessionSkillDetails(sessionId: string): SkillDetail[] {
    return this.dbs.appDb
      .prepare(
        `SELECT s.id, s.title, s.description, s.body, s.keywords,
                s.source_path AS sourcePath,
                s.created_at AS createdAt, s.updated_at AS updatedAt
         FROM session_skills ss
         JOIN skills s ON s.id = ss.skill_id
         WHERE ss.session_id = ?
         ORDER BY ss.selected_at DESC`
      )
      .all(sessionId) as SkillDetail[];
  }

  loadSkill(id: string): SkillDetail {
    const row = this.dbs.appDb
      .prepare(
        `SELECT id, title, description, body, keywords,
                source_path AS sourcePath,
                created_at AS createdAt, updated_at AS updatedAt
         FROM skills WHERE id = ?`
      )
      .get(id) as SkillDetail | undefined;
    if (!row) throw new Error(`技能不存在：${id}`);
    return row;
  }

  private listScheduledTasks(): ScheduledTask[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, workspace_id AS workspaceId, profile_id AS profileId, name, category,
                cron_expr AS cronExpr, trust_mode AS trustMode, danger, status,
                first_sign_status AS firstSignStatus, script_body AS scriptBody, updated_at AS updatedAt
         FROM scheduled_tasks ORDER BY updated_at DESC`
      )
      .all() as ScheduledTask[];
  }

  private ensureSystemTasks(): void {
    const pairs = this.dbs.appDb
      .prepare(
        `SELECT DISTINCT workspace_id AS workspaceId, profile_id AS profileId
         FROM sessions
         UNION
         SELECT w.id AS workspaceId, p.id AS profileId
         FROM workspaces w
         CROSS JOIN profiles p
         WHERE NOT EXISTS (SELECT 1 FROM sessions)`
      )
      .all() as Array<{ workspaceId: string; profileId: string }>;

    for (const pair of pairs) {
      this.ensureSystemTask(pair.workspaceId, pair.profileId, {
        action: 'extract_memory_facts',
        name: '事实记忆：长期事实提取',
        cronExpr: '*/15 * * * *',
        description: '从会话中提取长期有效的偏好、约束和环境事实，写入工作空间 .agent-memory。'
      });
      this.ensureSystemTask(pair.workspaceId, pair.profileId, {
        action: 'promote_error_skills',
        name: '系统自愈：错误技能升格',
        cronExpr: '*/30 * * * *',
        description: '聚合审计中的失败调用，把重复错误模式整理为全局技能。'
      });
    }
  }

  private ensureSystemTask(
    workspaceId: string,
    profileId: string,
    task: { action: SystemTaskAction; name: string; cronExpr: string; description: string }
  ): void {
    const now = Date.now();
    const scriptBody = JSON.stringify(
      {
        kind: 'system_action_graph',
        version: 1,
        action: task.action,
        description: task.description,
        agentPrompt: SYSTEM_TASK_PROMPTS[task.action],
        evidence:
          task.action === 'extract_memory_facts'
            ? 'messages 表中同 workspace/profile 的最近 80 条 user/assistant 历史消息'
            : 'tool_invocations 表中失败或被拒绝的结构化调用记录'
      },
      null,
      2
    );
    const scriptHash = sha256(scriptBody);
    const existing = this.dbs.appDb
      .prepare(
        `SELECT id, name, script_body AS scriptBody
         FROM scheduled_tasks
         WHERE workspace_id = ? AND profile_id = ? AND category = 'system'`
      )
      .all(workspaceId, profileId)
      .find((row) => {
        const typed = row as { name: string; scriptBody: string };
        return typed.name === task.name || scriptActionOf(typed.scriptBody) === task.action;
      }) as { id: string; name: string; scriptBody: string } | undefined;
    if (existing) {
      if (existing.name !== task.name || !existing.scriptBody.includes('agentPrompt') || scriptActionOf(existing.scriptBody) !== task.action) {
        this.dbs.appDb
          .prepare('UPDATE scheduled_tasks SET name = ?, script_body = ?, script_hash = ?, updated_at = ? WHERE id = ?')
          .run(task.name, scriptBody, scriptHash, now, existing.id);
      }
      return;
    }

    this.dbs.appDb
      .prepare(
        `INSERT INTO scheduled_tasks
          (id, workspace_id, profile_id, name, category, cron_expr, trust_mode, danger,
           script_body, status, first_sign_status, script_hash, max_runtime_ms, max_retries,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'system', ?, 'strict', 'safe', ?, 'active', 'not_required', ?, 300000, 0, ?, ?)`
      )
      .run(randomUUID(), workspaceId, profileId, task.name, task.cronExpr, scriptBody, scriptHash, now, now);
  }

  private async tickScheduler(): Promise<void> {
    this.ensureSystemTasks();
    const now = new Date();
    const tasks = this.dbs.appDb
      .prepare(
        `SELECT id, workspace_id AS workspaceId, profile_id AS profileId, name, category,
                cron_expr AS cronExpr, danger, status, first_sign_status AS firstSignStatus,
                script_body AS scriptBody, script_hash AS scriptHash, max_runtime_ms AS maxRuntimeMs
         FROM scheduled_tasks
         WHERE status = 'active'
         ORDER BY updated_at ASC`
      )
      .all() as Array<
      ScheduledTask & {
        scriptBody: string;
        scriptHash: string;
        maxRuntimeMs: number;
      }
    >;

    for (const task of tasks) {
      if (!this.isTaskDue(task, now) || this.runningTasks.has(task.id)) continue;
      await this.runScheduledTask(task);
    }
  }

  private isTaskDue(task: ScheduledTask, now: Date): boolean {
    if (task.danger === 'dangerous' && task.firstSignStatus !== 'approved') return false;
    if (!cronMatches(task.cronExpr, now)) return false;

    const minuteStart = floorToMinute(now.getTime());
    const row = this.dbs.appDb
      .prepare('SELECT started_at AS startedAt FROM task_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(task.id) as { startedAt: number } | undefined;
    return !row || row.startedAt < minuteStart;
  }

  private async runScheduledTask(
    task: ScheduledTask & { scriptBody: string; scriptHash: string; maxRuntimeMs: number }
  ): Promise<void> {
    const executionId = randomUUID();
    const startedAt = Date.now();
    const logs: SchedulerLogEntry[] = [];
    const pushLog = (level: SchedulerLogEntry['level'], message: string, data?: unknown): void => {
      logs.push({ at: Date.now(), level, message, data });
    };

    this.runningTasks.add(task.id);
    this.dbs.appDb
      .prepare(
        `INSERT INTO task_executions (id, task_id, status, started_at, log_json, summary)
         VALUES (?, ?, 'running', ?, ?, NULL)`
      )
      .run(executionId, task.id, startedAt, JSON.stringify(logs));

    let status = 'success';
    let summary = '';
    try {
      if (sha256(task.scriptBody) !== task.scriptHash) {
        throw new Error('任务脚本 hash 与登记值不一致，已 fail-closed。');
      }
      const script = JSON.parse(task.scriptBody) as { kind?: string; action?: SystemTaskAction };
      if (script.kind !== 'system_action_graph') {
        throw new Error('仅允许执行 system_action_graph 类型的受限任务。');
      }
      pushLog('info', '加载任务提示词契约。', { action: script.action });
      pushLog('info', `开始执行：${task.name}`);
      if (script.action === 'extract_memory_facts') {
        const result = this.extractMemoryFacts(task.workspaceId, task.profileId, pushLog);
        summary = `提取 ${result.extractedCount} 条候选事实，等待用户通过后台记忆确认流程写入 ${result.pendingCount} 条。`;
      } else if (script.action === 'promote_error_skills') {
        const result = this.promoteErrorSkills(pushLog);
        summary = `识别 ${result.patternCount} 个错误模式，新增/更新 ${result.skillCount} 个技能。`;
      } else {
        throw new Error(`未知系统任务动作：${String(script.action)}`);
      }
      pushLog('info', summary);
    } catch (error) {
      status = 'failed';
      summary = error instanceof Error ? error.message : String(error);
      pushLog('error', summary);
    } finally {
      const finishedAt = Date.now();
      this.dbs.appDb
        .prepare(
          `UPDATE task_executions
           SET status = ?, finished_at = ?, log_json = ?, summary = ?
           WHERE id = ?`
        )
        .run(status, finishedAt, JSON.stringify(logs), summary, executionId);
      this.dbs.appDb.prepare('UPDATE scheduled_tasks SET updated_at = ? WHERE id = ?').run(finishedAt, task.id);
      this.writeAuditEvent('scheduler.task_executed', {
        taskId: task.id,
        executionId,
        taskName: task.name,
        status,
        summary
      });
      this.runningTasks.delete(task.id);
    }
  }

  private extractMemoryFacts(
    workspaceId: string,
    profileId: string,
    pushLog: (level: SchedulerLogEntry['level'], message: string, data?: unknown) => void
  ): { extractedCount: number; pendingCount: number } {
    const workspace = this.dbs.appDb
      .prepare('SELECT root_path AS rootPath FROM workspaces WHERE id = ?')
      .get(workspaceId) as { rootPath: string } | undefined;
    if (!workspace || !existsSync(workspace.rootPath)) {
      pushLog('warn', '工作空间不存在，跳过记忆写入。', { workspaceId });
      return { extractedCount: 0, pendingCount: 0 };
    }

    const rows = this.dbs.appDb
      .prepare(
        `SELECT m.content, m.created_at AS createdAt
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.workspace_id = ?
           AND s.profile_id = ?
           AND m.role IN ('user', 'assistant')
         ORDER BY m.created_at DESC
         LIMIT 80`
      )
      .all(workspaceId, profileId) as Array<{ content: string; createdAt: number }>;

    const candidates = rows.flatMap((row) => extractDurableFactCandidates(row.content, row.createdAt));
    if (candidates.length === 0) return { extractedCount: 0, pendingCount: 0 };

    const now = Date.now();
    let pendingCount = 0;
    const pendingPreview: string[] = [];
    const insertCandidate = this.dbs.appDb.prepare(
      `INSERT OR IGNORE INTO memory_candidates
        (id, workspace_id, profile_id, fact, source_message_at, fact_hash, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`
    );

    for (const candidate of candidates) {
      const hash = sha256(candidate.fact).slice(0, 16);
      const result = insertCandidate.run(randomUUID(), workspaceId, profileId, candidate.fact, candidate.createdAt, hash, now);
      if (result.changes > 0) {
        pendingCount += 1;
        pendingPreview.push(candidate.fact);
      }
    }

    if (pendingCount > 0) {
      pushLog('info', '已生成长期记忆候选，等待用户确认后写入 .agent-memory。', {
        pendingCount,
        candidates: pendingPreview.slice(0, 8)
      });
    }

    return { extractedCount: candidates.length, pendingCount };
  }

  private promoteErrorSkills(
    pushLog: (level: SchedulerLogEntry['level'], message: string, data?: unknown) => void
  ): { patternCount: number; skillCount: number } {
    const rows = this.dbs.appDb
      .prepare(
        `SELECT tool_name AS toolName, product, action, version, danger, status, error_code AS errorCode,
                error_message AS errorMessage, COUNT(*) AS count, MAX(created_at) AS lastSeenAt
         FROM tool_invocations
         WHERE status != 'SUCCESS'
           AND (error_code IS NOT NULL OR error_message IS NOT NULL)
         GROUP BY tool_name, product, action, version, danger, status, error_code, error_message
         ORDER BY count DESC, lastSeenAt DESC
         LIMIT 12`
      )
      .all() as Array<{
      toolName: string;
      product: string | null;
      action: string | null;
      version: string | null;
      danger: string | null;
      status: string;
      errorCode: string | null;
      errorMessage: string | null;
      count: number;
      lastSeenAt: number;
    }>;

    let skillCount = 0;
    for (const row of rows) {
      const signature = [row.toolName, row.product, row.action, row.errorCode, normalizeErrorMessage(row.errorMessage)].join('|');
      const id = `auto-error-${sha256(signature).slice(0, 12)}`;
      const title = `错误自愈：${row.errorCode || row.status}`;
      const productAction = [row.product, row.action].filter(Boolean).join(' / ') || row.toolName;
      const description = `${productAction} 失败模式，已出现 ${row.count} 次。`;
      const body = [
        '# 触发条件',
        `- 工具：${row.toolName}`,
        `- 接口：${productAction}`,
        `- 状态：${row.status}`,
        `- 错误码：${row.errorCode || '未知'}`,
        `- 最近出现：${formatIso(row.lastSeenAt)}`,
        '',
        '# 处理纪律',
        '- 不要凭记忆拼接 product/action/version；必须先查 catalog.db 或既有接口事实。',
        '- 如果是别名、弃用 Action 或缺少必填参数，先纠正事实来源，再重试。',
        '- 后台调度任务的 dangerous 操作保持首次授权确认，不能因为任务来源于调度器而自动放行。',
        '',
        '# 原始错误摘要',
        row.errorMessage || '无错误消息。'
      ].join('\n');

      this.saveSkill({
        id,
        title,
        description,
        body,
        keywords: [row.errorCode, row.product, row.action, row.status].filter(Boolean).join('\n'),
        sourcePath: 'scheduler:auto-error-promotion'
      });
      skillCount += 1;
    }

    if (rows.length > 0) {
      pushLog('info', '已将错误模式升格为技能。', { skillCount });
    }
    return { patternCount: rows.length, skillCount };
  }

  private listTaskExecutions(): TaskExecution[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, task_id AS taskId, status, started_at AS startedAt,
                finished_at AS finishedAt, log_json AS logJson, summary
         FROM task_executions
         ORDER BY started_at DESC
         LIMIT 100`
      )
      .all() as TaskExecution[];
  }

  private listMemoryCandidates(): MemoryCandidate[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, workspace_id AS workspaceId, profile_id AS profileId, fact,
                source_message_at AS sourceMessageAt, fact_hash AS factHash,
                status, created_at AS createdAt, decided_at AS decidedAt
         FROM memory_candidates
         ORDER BY
           CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
           created_at DESC
         LIMIT 100`
      )
      .all() as MemoryCandidate[];
  }

  private applyMemoryCandidate(candidate: MemoryCandidate): void {
    const workspace = this.getWorkspaceById(candidate.workspaceId);
    const base = resolve(workspace.rootPath);
    const relativePath = `.agent-memory/${candidate.profileId}/facts.md`;
    const absolute = resolveWorkspacePath(base, relativePath);
    if (!absolute) throw new Error('记忆路径越界，无法写入。');
    mkdirSync(dirname(absolute), { recursive: true });

    const existing = existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
    if (existing.includes(`fact-hash:${candidate.factHash}`)) {
      indexWorkspaceRoot(this.dbs.appDb, workspace);
      return;
    }

    const block = [
      `- ${candidate.fact}`,
      `  - 来源：会话消息 ${formatIso(candidate.sourceMessageAt)}；确认时间 ${formatIso(Date.now())}`,
      `  - <!-- fact-hash:${candidate.factHash} -->`
    ].join('\n');
    const nextContent = existing.trim() ? `${existing.trimEnd()}\n${block}\n` : `# Profile Memory Facts\n\n${block}\n`;
    writeFileSync(absolute, nextContent, 'utf8');
    indexWorkspaceRoot(this.dbs.appDb, workspace);
  }

  private listAuditRows(): AuditRow[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, created_at AS createdAt, tool_name AS toolName, product, action, status,
                resolved_endpoint AS resolvedEndpoint, request_id AS requestId, ak_id_masked AS akIdMasked
         FROM tool_invocations ORDER BY created_at DESC LIMIT 100`
      )
      .all() as AuditRow[];
  }

  private listApprovalRequests(): ApprovalRequest[] {
    return this.dbs.appDb
      .prepare(
        `SELECT id, session_id AS sessionId, run_id AS runId, tool_call_id AS toolCallId,
                status, reason, danger, summary, params_json AS paramsJson,
                provenance_json AS provenanceJson, created_at AS createdAt, decided_at AS decidedAt
         FROM approval_requests
         ORDER BY created_at DESC
         LIMIT 100`
      )
      .all() as ApprovalRequest[];
  }

  private getApprovalRequestById(id: string): ApprovalRequest | null {
    return (
      (this.dbs.appDb
        .prepare(
          `SELECT id, session_id AS sessionId, run_id AS runId, tool_call_id AS toolCallId,
                  status, reason, danger, summary, params_json AS paramsJson,
                  provenance_json AS provenanceJson, created_at AS createdAt, decided_at AS decidedAt
           FROM approval_requests
           WHERE id = ?`
        )
        .get(id) as ApprovalRequest | undefined) ?? null
    );
  }

  private getLlmSettings(): LlmSettings {
    const row = this.dbs.appDb
      .prepare(
        `SELECT provider, model, base_url AS baseUrl, api_key_masked AS apiKeyMasked, updated_at AS updatedAt
         FROM llm_settings WHERE id = 'default'`
      )
      .get() as LlmSettings | undefined;

    return (
      row ?? {
        provider: null,
        model: null,
        baseUrl: null,
        apiKeyMasked: null,
        updatedAt: null
      }
    );
  }

  private getExistingEncryptedLlmKey(): string | null {
    const row = this.dbs.appDb
      .prepare("SELECT api_key_encrypted AS apiKeyEncrypted FROM llm_settings WHERE id = 'default'")
      .get() as { apiKeyEncrypted: string | null } | undefined;
    return row?.apiKeyEncrypted ?? null;
  }

  private getLlmRuntimeSettings(): { model: string | null; baseUrl: string | null; apiKey: string | null } {
    const row = this.dbs.appDb
      .prepare(
        `SELECT model, base_url AS baseUrl, api_key_encrypted AS apiKeyEncrypted
         FROM llm_settings WHERE id = 'default'`
      )
      .get() as { model: string | null; baseUrl: string | null; apiKeyEncrypted: string | null } | undefined;
    return {
      model: row?.model ?? null,
      baseUrl: row?.baseUrl ?? null,
      apiKey: decryptSecret(row?.apiKeyEncrypted ?? null)
    };
  }

  private writeAuditEvent(eventType: string, payload: unknown): void {
    this.dbs.appDb
      .prepare(
        `INSERT INTO audit_events
          (id, event_type, actor_type, payload_json, created_at)
         VALUES (?, ?, 'local_user', ?, ?)`
      )
      .run(randomUUID(), eventType, JSON.stringify(payload), Date.now());
  }

  private startWorkspaceWatchers(): void {
    for (const workspace of this.listWorkspaces()) {
      this.startWorkspaceWatcher(workspace);
    }
  }

  private startWorkspaceWatcher(workspace: Workspace): void {
    if (this.workspaceWatchers.has(workspace.id) || !existsSync(workspace.rootPath)) return;
    const watcher = chokidar.watch(workspace.rootPath, {
      ignoreInitial: true,
      ignored: (path) => {
        const name = basename(path);
        if (WORKSPACE_SKIP_DIRS.has(name)) return true;
        return name.startsWith('.') && name !== '.agent-memory';
      }
    });
    const schedule = (): void => {
      const existing = this.workspaceReindexTimers.get(workspace.id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.workspaceReindexTimers.delete(workspace.id);
        indexWorkspaceRoot(this.dbs.appDb, workspace);
        this.writeAuditEvent('workspace.index.updated', {
          workspaceId: workspace.id,
          rootPath: workspace.rootPath
        });
      }, 300);
      this.workspaceReindexTimers.set(workspace.id, timer);
    };
    watcher.on('add', schedule).on('change', schedule).on('unlink', schedule).on('addDir', schedule).on('unlinkDir', schedule);
    this.workspaceWatchers.set(workspace.id, watcher);
  }
}

export function indexWorkspaceRoot(db: Database.Database, workspace: Workspace): void {
  if (!existsSync(workspace.rootPath)) return;
  const root = resolve(workspace.rootPath);
  const files: Array<{ path: string; title: string; mtime: number; size: number; content: string; contentHash: string }> = [];

  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir)) {
      if (WORKSPACE_SKIP_DIRS.has(entry)) continue;
      if (entry.startsWith('.') && entry !== '.agent-memory') continue;

      const absolute = resolve(absoluteDir, entry);
      if (!absolute.startsWith(`${root}${sep}`) && absolute !== root) continue;
      const stats = statSync(absolute);
      const path = toWorkspaceRelativePath(root, absolute);
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stats.isFile() || !shouldIndexWorkspacePath(path, stats.size)) continue;

      try {
        const content = readFileSync(absolute, 'utf8');
        files.push({
          path,
          title: basename(absolute),
          mtime: Math.trunc(stats.mtimeMs),
          size: stats.size,
          content,
          contentHash: sha256(content)
        });
      } catch {
        // Ignore files that disappear or cannot be decoded while indexing.
      }
    }
  };

  walk(root);
  const rootStats = statSync(root);
  const sync = db.transaction(() => {
    db.prepare('DELETE FROM workspace_index WHERE workspace_id = ?').run(workspace.id);
    db.prepare('DELETE FROM workspace_fts WHERE workspace_id = ?').run(workspace.id);
    db.prepare(
      `INSERT OR REPLACE INTO workspace_index
        (workspace_id, path, title, mtime, size, content_hash)
       VALUES (?, '.', ?, ?, ?, NULL)`
    ).run(workspace.id, workspace.name, Math.trunc(rootStats.mtimeMs), rootStats.size);

    const insertIndex = db.prepare(
      `INSERT OR REPLACE INTO workspace_index
        (workspace_id, path, title, mtime, size, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertFts = db.prepare(
      `INSERT INTO workspace_fts (workspace_id, path, title, content)
       VALUES (?, ?, ?, ?)`
    );

    for (const file of files) {
      insertIndex.run(workspace.id, file.path, file.title, file.mtime, file.size, file.contentHash);
      insertFts.run(workspace.id, file.path, file.title, file.content);
    }
  });
  sync();
}

function normalizeWorkspacePath(value: string | null | undefined): string {
  const trimmed = (value || '.').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return trimmed && trimmed !== '.' ? trimmed : '.';
}

/**
 * 从首条用户消息推导一个简洁的会话标题：取首行有效文本，
 * 去掉 @文件引用 等噪声，限制在 24 个字符内。
 */
function deriveSessionTitle(message: string): string {
  const firstLine = (message || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return '';
  const cleaned = firstLine
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || firstLine;
  const MAX = 24;
  return base.length > MAX ? `${base.slice(0, MAX)}…` : base;
}

function slugifyTopic(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'memory';
}

function resolveWorkspacePath(root: string, relativePath: string): string | null {
  const absolute = relativePath === '.' ? root : resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return null;
  return absolute;
}

function toWorkspaceRelativePath(root: string, absolute: string): string {
  const path = relative(root, absolute).split(sep).join('/');
  return path || '.';
}

function shouldIndexWorkspacePath(path: string, size: number): boolean {
  if (size > WORKSPACE_MAX_FILE_BYTES) return false;
  const extension = extname(path).toLowerCase();
  if (WORKSPACE_INDEX_EXTENSIONS.has(extension)) return true;
  return basename(path).startsWith('.env');
}

function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((part) => part.replace(/"/g, '""').trim())
    .filter(Boolean)
    .map((part) => `"${part}"`)
    .join(' ');
}

function maskAk(akId: string): string {
  const trimmed = akId.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function floorToMinute(value: number): number {
  return Math.floor(value / 60_000) * 60_000;
}

function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return (
    cronFieldMatches(minute, date.getMinutes(), 0, 59) &&
    cronFieldMatches(hour, date.getHours(), 0, 23) &&
    cronFieldMatches(dayOfMonth, date.getDate(), 1, 31) &&
    cronFieldMatches(month, date.getMonth() + 1, 1, 12) &&
    cronFieldMatches(dayOfWeek, date.getDay(), 0, 6)
  );
}

function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    const stepMatch = part.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      return step > 0 && (value - min) % step === 0;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      return value >= start && value <= end;
    }
    const exact = Number(part);
    return Number.isInteger(exact) && exact >= min && exact <= max && value === exact;
  });
}

function extractDurableFactCandidates(content: string, createdAt: number): Array<{ fact: string; createdAt: number }> {
  const sentences = content
    .split(/[\n。！？!?；;]/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 8 && line.length <= 220);
  const durablePattern = /(记住|以后|后续|默认|偏好|必须|不要|禁止|始终|固定|优先|region|Region|Profile|工作空间|环境|凭证|审批)/;
  return sentences
    .filter((sentence) => durablePattern.test(sentence))
    .map((sentence) => ({
      fact: sentence.replace(/^(请|帮我|你要|需要)\s*/, ''),
      createdAt
    }));
}

function normalizeErrorMessage(message: string | null): string {
  return (message || '')
    .replace(/[0-9a-f]{8,}/gi, '<id>')
    .replace(/\d{4,}/g, '<num>')
    .slice(0, 240);
}

function scriptActionOf(scriptBody: string): SystemTaskAction | null {
  const parsed = parseJsonValue(scriptBody);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const action = (parsed as { action?: unknown }).action;
  return action === 'extract_memory_facts' || action === 'promote_error_skills' ? action : null;
}

function formatIso(value: number): string {
  return new Date(value).toISOString();
}

function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

function encryptSecret(secret: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(secret.trim()).toString('base64');
}

function encryptRequiredSecret(secret: string, label: string): string {
  const encrypted = encryptSecret(secret);
  if (!encrypted) {
    throw new Error(`当前系统不可用 Electron safeStorage，无法安全保存 ${label}。`);
  }
  return encrypted;
}

function decryptSecret(encrypted: string | null): string | null {
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return null;
  }
}

function redactBaseUrl(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return baseUrl;
  }
}

function normalizeNullable(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseJsonArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? parseJsonValue(value) : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function discoverApiFallbackRows(catalogDb: Database.Database, query: string, limit: number): Row[] {
  const terms = expandCatalogQueryTerms(query);
  if (terms.length === 0) return [];

  const clauses = terms
    .map(() => `(lower(ca.product) LIKE ? OR lower(ca.action) LIKE ? OR lower(IFNULL(ca.summary_cn, '')) LIKE ? OR lower(IFNULL(co.keywords, '')) LIKE ?)`)
    .join(' OR ');
  const termParams = terms.flatMap((term) => {
    const like = `%${term.toLowerCase()}%`;
    return [like, like, like, like];
  });
  const preferredAction = inferPreferredCatalogAction(query) ?? '';
  const preferredProduct = inferPreferredCatalogProduct(query) ?? '';

  return catalogDb
    .prepare(
      `SELECT ca.product, ca.action, ca.version, ca.danger, ca.summary_cn AS summaryCn,
              ca.required_json AS requiredJson, cp.default_version AS defaultVersion,
              co.deprecated, co.replaced_by AS replacedBy
       FROM catalog_actions ca
       JOIN catalog_products cp
         ON cp.product = ca.product
       LEFT JOIN catalog_overlay co
         ON co.product = ca.product AND co.action = ca.action
       WHERE ${clauses}
       ORDER BY
         CASE
           WHEN ? <> '' AND ca.product = ? THEN 0
           ELSE 1
         END,
         CASE
           WHEN ? <> '' AND ca.action = ? THEN 0
           WHEN ? <> '' AND ca.action LIKE ? THEN 1
           WHEN ca.danger = 'safe' AND ca.action LIKE 'Describe%' THEN 2
           WHEN ca.danger = 'safe' AND ca.action LIKE 'List%' THEN 3
           WHEN ca.danger = 'safe' THEN 4
           ELSE 5
         END,
         ca.product,
         ca.action
       LIMIT ?`
    )
    .all(...termParams, preferredProduct, preferredProduct, preferredAction, preferredAction, preferredAction, `%${preferredAction}%`, limit) as Row[];
}

function mapCatalogDiscoveryRows(rows: Row[]): Array<Record<string, unknown> & { lookup: CatalogLookup }> {
  return rows.map((row) => {
    const product = String(row.product);
    const action = String(row.action);
    const lookup: CatalogLookup = {
      product,
      action,
      version: String(row.defaultVersion ?? row.version)
    };
    return {
      product: row.product,
      action: row.action,
      version: row.version,
      danger: row.danger,
      summary: row.summaryCn,
      required: normalizeRequiredParams(product, action, parseJsonArray(row.requiredJson)),
      deprecated: isCatalogDeprecated(product, action, Number(row.deprecated ?? 0), typeof row.replacedBy === 'string' ? row.replacedBy : null),
      replacedBy: row.replacedBy ?? null,
      lookup
    };
  });
}

function expandCatalogQueryTerms(query: string): string[] {
  const normalized = query.trim();
  const rawTerms = normalized
    .split(/[\s,，。；;:：/\\|()[\]{}"'`]+/u)
    .map((term) => term.trim())
    .filter(Boolean);
  const terms = [...rawTerms];
  const lower = normalized.toLowerCase();

  if (/(ecs|云服务器|服务器|实例|instance)/i.test(normalized)) {
    terms.push('ecs', 'instance', '实例', '云服务器', 'DescribeInstances');
  }
  if (/(命令|脚本|shell|command|执行结果|invocation)/i.test(normalized) && /(ecs|云服务器|服务器|实例|instance)/i.test(normalized)) {
    terms.push('RunCommand', 'DescribeInvocationResults', 'invocation');
  }
  if (/(dns|域名|解析|record)/i.test(normalized)) {
    terms.push('alidns', 'domain', 'record', '域名', '解析', 'DescribeDomainRecords');
  }
  if (/(ssl|证书|certificate|https)/i.test(normalized)) {
    terms.push('cas', 'certificate', '证书');
  }
  if (/(云效|流水线|发布|pipeline|devops)/i.test(normalized)) {
    terms.push('devops', 'pipeline', '流水线', '发布');
  }
  if (/(redis|tair|kvstore|缓存)/i.test(normalized)) {
    terms.push('r-kvstore', 'redis', 'tair', 'kvstore', '缓存');
  }

  if (lower.includes('describeinstances')) {
    terms.push('DescribeInstances');
  }

  return [...new Set(terms.map((term) => term.toLowerCase()).filter((term) => term.length > 0))].slice(0, 16);
}

function inferPreferredCatalogAction(query: string): string | null {
  if (/(ecs|云服务器|服务器|实例|instance)/i.test(query) && /(列表|有哪些|状态|运行|健康|盘点|查询|describe|list|instance)/i.test(query)) {
    return 'DescribeInstances';
  }
  if (/(ecs|云服务器|服务器|实例|instance)/i.test(query) && /(执行结果|输出|invocation)/i.test(query)) {
    return 'DescribeInvocationResults';
  }
  if (/(ecs|云服务器|服务器|实例|instance)/i.test(query) && /(命令|脚本|shell|command)/i.test(query)) {
    return 'RunCommand';
  }
  if (/(dns|域名|解析|record)/i.test(query)) {
    return 'DescribeDomainRecords';
  }
  return null;
}

function inferPreferredCatalogProduct(query: string): string | null {
  if (/(ecs|云服务器|服务器|实例|instance)/i.test(query)) return 'ecs';
  if (/(dns|域名|解析|record)/i.test(query)) return 'alidns';
  if (/(ssl|证书|certificate|https)/i.test(query)) return 'cas';
  if (/(云效|流水线|发布|pipeline|devops)/i.test(query)) return 'devops';
  if (/(redis|tair|kvstore|缓存)/i.test(query)) return 'r-kvstore';
  return null;
}

function normalizeRequiredParams(product: string, action: string, required: string[]): string[] {
  if (product.toLowerCase() === 'ecs' && action === 'DescribeInstances') {
    return ['RegionId'];
  }
  return required;
}

function isCatalogDeprecated(product: string, action: string, deprecated: number | null, replacedBy: string | null): boolean {
  if (!deprecated) return false;
  if (product.toLowerCase() === 'ecs' && /^Describe/.test(action) && replacedBy === 'ActivateRouterInterface') {
    return false;
  }
  return true;
}

function summarizeParamsMetadata(product: string, action: string, params: unknown, required: string[]): unknown {
  if (!params || typeof params !== 'object') return { required, optionalExamples: [] };
  const record = params as { requestClass?: string; params?: Array<Record<string, unknown>> };
  const optionalExamples = Array.isArray(record.params)
    ? record.params
        .filter((param) => typeof param.name === 'string' && !required.includes(String(param.name)))
        .slice(0, 12)
        .map((param) => ({ name: param.name, type: param.type, required: false }))
    : [];
  return normalizeParamsMetadata(product, action, {
    requestClass: record.requestClass,
    required,
    optionalExamples
  });
}

function normalizeParamsMetadata(product: string, action: string, params: unknown): unknown {
  if (product.toLowerCase() !== 'ecs' || action !== 'DescribeInstances' || !params || typeof params !== 'object') {
    return params;
  }
  const record = params as { params?: Array<Record<string, unknown>>; optionalExamples?: Array<Record<string, unknown>> };
  const candidates = Array.isArray(record.params) ? record.params : record.optionalExamples;
  if (!Array.isArray(candidates)) return params;
  return {
    ...record,
    [Array.isArray(record.params) ? 'params' : 'optionalExamples']: candidates.map((param) =>
      param.name === 'HttpTokens'
        ? { ...param, required: false, note: 'SDK 类型抽取误判；DescribeInstances 查询实例列表不需要传 HttpTokens。' }
        : param
    )
  };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !/accesskey|secret|token|password/i.test(key))
  );
}

function resolveEndpoint(endpointTpl: string, endpointMapJson: string | null, regionId: string): string {
  const endpointMap = parseEndpointMap(endpointMapJson);
  const mappedEndpoint = endpointMap[regionId];
  if (mappedEndpoint) return mappedEndpoint;
  return endpointTpl.replace('{region}', regionId);
}

function parseEndpointMap(endpointMapJson: string | null): Record<string, string> {
  const parsed = parseJsonValue(endpointMapJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])
    )
  );
}

function normalizeOpenApiQuery(params: Record<string, unknown>): Record<string, string> {
  const query: Record<string, string> = {};
  const appendValue = (key: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      query[key] = String(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => appendValue(`${key}.${index + 1}`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        appendValue(`${key}.${childKey}`, childValue);
      }
    }
  };

  for (const [key, value] of Object.entries(params)) {
    appendValue(key, value);
  }
  return query;
}

function stringParam(params: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = paramValue(params, name);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

function numberParam(params: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = paramValue(params, name);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function recordParam(params: Record<string, unknown>, names: string[]): Record<string, unknown> | undefined {
  for (const name of names) {
    const value = paramValue(params, name);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function paramValue(params: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  const match = Object.keys(params).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? params[match] : undefined;
}

function normalizeOssEndpoint(endpoint: string, regionId: string): string {
  const trimmed = endpoint.trim().replace(/^https?:\/\//i, '').replace(/\/+$/g, '');
  if (/^oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(trimmed)) return trimmed;
  if (/^oss\.[a-z0-9-]+\.aliyuncs\.com$/i.test(trimmed)) return trimmed.replace(/^oss\./i, 'oss-');
  if (/^oss\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(trimmed)) return trimmed.replace(/^oss\./i, '');
  return `oss-${regionId}.aliyuncs.com`;
}

function requireOssBucket(params: Record<string, unknown>): string {
  const bucket = stringParam(params, ['Bucket', 'BucketName', 'bucket', 'bucketName']);
  if (!bucket) {
    throw gatewayError('MISSING_OSS_BUCKET', 'OSS 操作缺少 bucket 参数：请传 Bucket 或 BucketName。');
  }
  if (/^oss-[a-z0-9-]+$/i.test(bucket)) {
    throw gatewayError('INVALID_OSS_BUCKET', `OSS bucket 参数看起来像地域 ${bucket}，请传真实存储桶名称。`);
  }
  return bucket;
}

const SIMPLE_OSS_BUCKET_ACTIONS = new Set([
  'AbortBucketWorm',
  'DeleteBucket',
  'DeleteBucketCors',
  'DeleteBucketEncryption',
  'DeleteBucketLifecycle',
  'DeleteBucketLogging',
  'DeleteBucketTags',
  'GetBucketCors',
  'GetBucketEncryption',
  'GetBucketLifecycle',
  'GetBucketLocation',
  'GetBucketLogging',
  'GetBucketReferer',
  'GetBucketReplication',
  'GetBucketReplicationLocation',
  'GetBucketRequestPayment',
  'GetBucketTags',
  'GetBucketTransferAcceleration',
  'GetBucketVersioning',
  'GetBucketWorm'
]);

function invokeSimpleOssBucketAction(
  client: OssClient,
  action: string,
  params: Record<string, unknown>,
  runtime: RuntimeOptions
): Promise<unknown> | null {
  if (!SIMPLE_OSS_BUCKET_ACTIONS.has(action)) return null;
  const methodName = `${action.charAt(0).toLowerCase()}${action.slice(1)}WithOptions`;
  const method = (client as unknown as Record<string, unknown>)[methodName];
  if (typeof method !== 'function') return null;
  return method.call(client, requireOssBucket(params), {}, runtime) as Promise<unknown>;
}

function invokeOssSdkAction(
  client: OssClient,
  action: string,
  params: Record<string, unknown>,
  runtime: RuntimeOptions
): Promise<unknown> | null {
  const methodName = `${action.charAt(0).toLowerCase()}${action.slice(1)}WithOptions`;
  const method = (client as unknown as Record<string, unknown>)[methodName];
  if (typeof method !== 'function') return null;

  const parameterNames = getOssSdkMethodParameterNames(method, methodName);
  if (!parameterNames.length) return null;
  const args = parameterNames.map((name) => buildOssSdkMethodArgument(action, name, params, runtime));
  return method.call(client, ...args) as Promise<unknown>;
}

function invokeRawOssAction(
  client: OssClient,
  input: AliyunProviderInput,
  runtime: RuntimeOptions
): Promise<unknown> | null {
  const rawSpec = parseOssRawCatalogSpec(input.catalogParamsBlob);
  const params = input.params;
  const method = stringParam(params, ['Method', 'method']) ?? rawSpec.method ?? input.catalogMethod ?? undefined;
  const pathname = resolveRawOssPathname(
    stringParam(params, ['Pathname', 'pathname', 'Path', 'path']) ?? rawSpec.pathname,
    params
  );
  if (!method || !pathname) return null;

  const request = new OpenApiRequest({
    headers: normalizeRawOssHeaders(params),
    query: normalizeRawOssQuery(params),
    body: normalizeRawOssBody(input.action, params)
  } as Record<string, unknown>);
  const bucket = stringParam(params, ['Bucket', 'BucketName', 'bucket', 'bucketName']);
  if (bucket) {
    (request as OpenApiRequest & { hostMap: { bucket: string } }).hostMap = { bucket };
  }

  const openApiParams = new OpenApiParams({
    action: input.action,
    version: '2019-05-17',
    protocol: stringParam(params, ['Protocol', 'protocol']) ?? 'HTTPS',
    pathname,
    method: method.toUpperCase(),
    authType: 'AK',
    style: rawSpec.style ?? input.catalogStyle ?? 'ROA',
    reqBodyType: stringParam(params, ['ReqBodyType', 'reqBodyType']) ?? rawSpec.reqBodyType ?? 'xml',
    bodyType: stringParam(params, ['BodyType', 'bodyType']) ?? rawSpec.bodyType ?? 'xml'
  });
  return client.execute(openApiParams, request, runtime);
}

function resolveRawOssPathname(pathname: string | undefined, params: Record<string, unknown>): string | undefined {
  if (!pathname) return undefined;
  return pathname.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = lookupOssParam(params, [key, toPascalName(key)]);
    return value === undefined || value === null ? '' : encodeURIComponent(String(value));
  });
}

function parseOssRawCatalogSpec(paramsBlob: string | null | undefined): {
  method?: string;
  style?: string;
  pathname?: string;
  reqBodyType?: string;
  bodyType?: string;
} {
  const parsed = parseJsonValue(paramsBlob);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const raw = record.raw && typeof record.raw === 'object' && !Array.isArray(record.raw)
    ? record.raw as Record<string, unknown>
    : record;
  return {
    method: typeof raw.method === 'string' ? raw.method : undefined,
    style: typeof raw.style === 'string' ? raw.style : undefined,
    pathname: typeof raw.pathname === 'string' ? raw.pathname : typeof raw.path === 'string' ? raw.path : undefined,
    reqBodyType: typeof raw.reqBodyType === 'string' ? raw.reqBodyType : undefined,
    bodyType: typeof raw.bodyType === 'string' ? raw.bodyType : undefined
  };
}

function normalizeRawOssHeaders(params: Record<string, unknown>): Record<string, string> {
  const explicit = recordParam(params, ['Headers', 'headers']);
  const headers = explicit ? primitiveRecordToStrings(explicit) : {};
  return {
    ...collectOssCommonHeaders(params),
    ...headers
  };
}

function normalizeRawOssQuery(params: Record<string, unknown>): Record<string, string> {
  const explicit = recordParam(params, ['Query', 'query']);
  return explicit ? primitiveRecordToStrings(explicit) : {};
}

function normalizeRawOssBody(action: string, params: Record<string, unknown>): unknown {
  const body = lookupOssParam(params, ['Body', 'body']);
  if (['PutCname', 'CreateCnameToken', 'DeleteCname'].includes(action)) {
    return normalizeOssCnameBody(body, params);
  }
  if (body === undefined || body === null || body === '') return undefined;
  if (typeof body === 'string' && body.startsWith('file://')) return createReadStream(body.slice('file://'.length));
  return body;
}

function normalizeOssCnameBody(body: unknown, params: Record<string, unknown>): unknown {
  if (body === undefined || body === null || body === '') {
    const domain = stringParam(params, ['Domain', 'domain', 'Cname', 'cname']);
    if (!domain) return undefined;
    return {
      BucketCnameConfiguration: {
        Cname: {
          Domain: domain
        }
      }
    };
  }
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (record.BucketCnameConfiguration) return body;
    if (record.Cname) return { BucketCnameConfiguration: record };
  }
  const domain = stringParam(params, ['Domain', 'domain', 'Cname', 'cname']);
  if (!domain) return body;
  return {
    BucketCnameConfiguration: {
      Cname: {
        Domain: domain
      }
    }
  };
}

function primitiveRecordToStrings(record: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    }
  }
  return result;
}

function getOssSdkMethodParameterNames(method: unknown, methodName: string): string[] {
  if (typeof method !== 'function') return [];
  const source = Function.prototype.toString.call(method);
  const pattern = new RegExp(`${methodName}\\s*\\(([^)]*)\\)`);
  const match = pattern.exec(source);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildOssSdkMethodArgument(
  action: string,
  parameterName: string,
  params: Record<string, unknown>,
  runtime: RuntimeOptions
): unknown {
  switch (parameterName) {
    case 'bucket':
      return requireOssBucket(params);
    case 'key':
      return requireOssKey(params);
    case 'channel':
      return requireOssChannel(params);
    case 'playlist':
      return requireOssPlaylist(params);
    case 'request':
    case 'tmpReq':
      return buildOssSdkModel(`${action}Request`, params, 'request');
    case 'headers':
      return buildOssSdkModel(`${action}Headers`, params, 'headers');
    case 'runtime':
      return runtime;
    default:
      throw gatewayError('UNSUPPORTED_OSS_SDK_SIGNATURE', `OSS SDK action ${action} 包含暂不支持的参数 ${parameterName}。`);
  }
}

function buildOssSdkModel(modelName: string, params: Record<string, unknown>, kind: 'request' | 'headers'): unknown {
  const ctor = (OssSdk as unknown as Record<string, unknown>)[modelName];
  const explicit = recordParam(params, [modelName, kind === 'request' ? 'Request' : 'Headers', kind]);
  const source = explicit ?? params;
  const map = typeof ctor === 'function' ? buildOssSdkModelMap(ctor as OssModelConstructor, source, kind) : {};
  return typeof ctor === 'function' ? new (ctor as OssModelConstructor)(map) : map;
}

type OssModelConstructor = {
  new (map?: Record<string, unknown>): unknown;
  names?: () => Record<string, string>;
};

function buildOssSdkModelMap(
  ctor: OssModelConstructor,
  params: Record<string, unknown>,
  kind: 'request' | 'headers'
): Record<string, unknown> {
  const names = typeof ctor.names === 'function' ? ctor.names() : {};
  const map: Record<string, unknown> = {};
  for (const [propertyName, apiName] of Object.entries(names)) {
    const value = lookupOssParam(params, [propertyName, apiName, toPascalName(propertyName), toPascalName(apiName)]);
    if (value === undefined || value === null || value === '') continue;
    map[propertyName] = propertyName === 'body' ? normalizeOssBody(value) : value;
  }

  if (kind === 'request' && Object.prototype.hasOwnProperty.call(names, 'body') && map.body === undefined) {
    const body = lookupOssParam(params, ['Body', 'body', 'Content', 'content']);
    if (body !== undefined && body !== null && body !== '') {
      map.body = normalizeOssBody(body);
    }
  }

  if (kind === 'headers' && Object.prototype.hasOwnProperty.call(names, 'commonHeaders')) {
    const commonHeaders = collectOssCommonHeaders(params);
    if (Object.keys(commonHeaders).length) {
      map.commonHeaders = {
        ...(typeof map.commonHeaders === 'object' && map.commonHeaders ? map.commonHeaders as Record<string, unknown> : {}),
        ...commonHeaders
      };
    }
  }
  return map;
}

function lookupOssParam(params: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = paramValue(params, name);
    if (value !== undefined) return value;
    const normalizedName = normalizeOssParamName(name);
    const match = Object.keys(params).find((key) => normalizeOssParamName(key) === normalizedName);
    if (match) return params[match];
  }
  return undefined;
}

function normalizeOssParamName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function toPascalName(name: string): string {
  const normalized = name
    .replace(/[-_]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase())
    .replace(/^[a-z]/, (char) => char.toUpperCase());
  return normalized;
}

function normalizeOssBody(value: unknown): unknown {
  if (value instanceof Readable) return value;
  if (Buffer.isBuffer(value)) return Readable.from([value]);
  if (typeof value === 'string') {
    if (value.startsWith('file://')) {
      return createReadStream(value.slice('file://'.length));
    }
    return Readable.from([value]);
  }
  return value;
}

function collectOssCommonHeaders(params: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (!/^(x-oss-|content-|cache-control$|expires$|range$|if-)/i.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      headers[key] = String(value);
    }
  }
  return headers;
}

function requireOssKey(params: Record<string, unknown>): string {
  const key = stringParam(params, ['Key', 'key', 'ObjectName', 'objectName', 'ObjectKey', 'objectKey']);
  if (!key) {
    throw gatewayError('MISSING_OSS_OBJECT_KEY', 'OSS Object 操作缺少 key 参数：请传 Key 或 ObjectName。');
  }
  return key;
}

function requireOssChannel(params: Record<string, unknown>): string {
  const channel = stringParam(params, ['Channel', 'channel', 'LiveChannel', 'liveChannel', 'ChannelName', 'channelName']);
  if (!channel) {
    throw gatewayError('MISSING_OSS_CHANNEL', 'OSS LiveChannel 操作缺少 channel 参数：请传 Channel。');
  }
  return channel;
}

function requireOssPlaylist(params: Record<string, unknown>): string {
  const playlist = stringParam(params, ['Playlist', 'playlist']);
  if (!playlist) {
    throw gatewayError('MISSING_OSS_PLAYLIST', 'OSS VodPlaylist 操作缺少 playlist 参数：请传 Playlist。');
  }
  return playlist;
}

function requireOssAcl(params: Record<string, unknown>): string {
  const acl = stringParam(params, ['x-oss-acl', 'xOssAcl', 'ACL', 'Acl', 'acl']);
  if (!acl) {
    throw gatewayError('MISSING_OSS_ACL', 'PutBucketAcl 缺少 x-oss-acl/acl 参数，例如 private、public-read、public-read-write。');
  }
  return acl;
}

function requireOssBucketPolicy(params: Record<string, unknown>): string {
  const policy =
    paramValue(params, 'Policy') ?? paramValue(params, 'Body') ?? paramValue(params, 'BucketPolicy') ?? paramValue(params, 'bucketPolicy');
  if (typeof policy === 'string' && policy.trim()) return policy.trim();
  if (policy && typeof policy === 'object') return JSON.stringify(policy);
  throw gatewayError('MISSING_OSS_BUCKET_POLICY', 'PutBucketPolicy 缺少 body/policy 参数，请传 Bucket Policy JSON 字符串或对象。');
}

function buildCreateBucketConfiguration(params: Record<string, unknown>): CreateBucketConfiguration | undefined {
  const config = recordParam(params, ['CreateBucketConfiguration', 'createBucketConfiguration']);
  const storageClass = stringParam(config ?? params, ['StorageClass', 'storageClass']);
  const dataRedundancyType = stringParam(config ?? params, ['DataRedundancyType', 'dataRedundancyType']);
  if (!storageClass && !dataRedundancyType) return undefined;
  return new CreateBucketConfiguration({ storageClass, dataRedundancyType });
}

function booleanParam(params: Record<string, unknown>, names: string[]): boolean | undefined {
  for (const name of names) {
    const value = paramValue(params, name);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no'].includes(normalized)) return false;
    }
  }
  return undefined;
}

function toPlainAliyunResponse(response: unknown): unknown {
  const plain = toPlainValue(response);
  if (!plain || typeof plain !== 'object' || Array.isArray(plain)) return plain;
  const record = plain as Record<string, unknown>;
  const headers = record.headers && typeof record.headers === 'object' ? record.headers as Record<string, unknown> : {};
  return {
    ...record,
    requestId: extractHeaderRequestId(headers) ?? extractRequestId(record)
  };
}

function toPlainValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toPlainValue);
  const maybeModel = value as { toMap?: () => unknown };
  if (typeof maybeModel.toMap === 'function') return toPlainValue(maybeModel.toMap());
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => typeof entryValue !== 'function' && entryValue !== undefined)
      .map(([key, entryValue]) => [key, toPlainValue(entryValue)])
  );
}

function extractHeaderRequestId(headers: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'x-oss-request-id' && typeof value === 'string') return value;
  }
  return null;
}

function formatAliyunSdkError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const record = error as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : null;
  const parts = [
    typeof record.code === 'string' ? record.code : null,
    typeof record.name === 'string' ? record.name : null,
    typeof record.message === 'string' ? record.message : null,
    data && typeof data.Code === 'string' ? data.Code : null,
    data && typeof data.Message === 'string' ? data.Message : null,
    data && typeof data.RequestId === 'string' ? `RequestId=${data.RequestId}` : null
  ].filter(Boolean);
  return parts.length ? parts.join('\n') : JSON.stringify(error);
}

function requestBodyToString(body: unknown): string | null {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return null;
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function summarizeLlmRequestPayload(bodyText: string | null): Record<string, unknown> {
  const payload = parseJsonObject(bodyText);
  if (!payload) return { bodyReadable: false };
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return {
    bodyReadable: true,
    model: typeof payload.model === 'string' ? payload.model : null,
    stream: payload.stream === true,
    toolsPresent: tools.length > 0,
    toolCount: tools.length,
    toolNames: tools.map(extractToolName).filter(Boolean).slice(0, 30),
    toolChoice: payload.tool_choice ?? null,
    parallelToolCalls: payload.parallel_tool_calls ?? null,
    messageCount: messages.length,
    systemInstructionChars: summarizeMessageChars(messages, 'system'),
    userMessageChars: summarizeMessageChars(messages, 'user')
  };
}

function summarizeLlmResponsePayload(httpStatus: number, bodyText: string | null, contentType: string | null = null): Record<string, unknown> {
  if (bodyText && isSseLlmResponse(contentType, bodyText)) {
    return summarizeSseLlmResponsePayload(httpStatus, bodyText);
  }
  const payload = parseJsonObject(bodyText);
  if (!payload) return { httpStatus, bodyReadable: false, usage: null };
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0] as Record<string, unknown> | undefined;
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? firstChoice.message as Record<string, unknown>
    : null;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const content = typeof message?.content === 'string' ? message.content : '';
  const error = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : null;
  return {
    httpStatus,
    bodyReadable: true,
    responseId: typeof payload.id === 'string' ? payload.id : null,
    choiceCount: choices.length,
    finishReason: firstChoice?.finish_reason ?? null,
    toolCallCount: toolCalls.length,
    toolCallNames: toolCalls.map(extractToolCallName).filter(Boolean).slice(0, 30),
    toolCalls: summarizeToolCalls(toolCalls),
    contentLength: content.length,
    usage: summarizeLlmUsage(payload.usage),
    errorType: error?.type ?? null,
    errorCode: error?.code ?? null,
    errorMessage: typeof error?.message === 'string' ? error.message.slice(0, 300) : null
  };
}

function isSseLlmResponse(contentType: string | null, bodyText: string): boolean {
  return contentType?.toLowerCase().includes('text/event-stream') === true || bodyText.trimStart().startsWith('data:');
}

function summarizeSseLlmResponsePayload(httpStatus: number, bodyText: string): Record<string, unknown> {
  let responseId: string | null = null;
  let choiceCount = 0;
  let finishReason: unknown = null;
  let content = '';
  let usage: Record<string, number | null> | null = null;
  let error: Record<string, unknown> | null = null;
  const toolCallNames = new Set<string>();
  const toolCallsByIndex = new Map<number, { name: string | null; argumentsText: string }>();

  for (const line of bodyText.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    const chunk = parseJsonObject(data);
    if (!chunk) continue;

    if (typeof chunk.id === 'string') responseId = chunk.id;
    const chunkUsage = summarizeLlmUsage(chunk.usage);
    if (chunkUsage) usage = chunkUsage;
    const chunkError = chunk.error && typeof chunk.error === 'object' ? chunk.error as Record<string, unknown> : null;
    if (chunkError) error = chunkError;

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    choiceCount = Math.max(choiceCount, choices.length);
    for (const choiceItem of choices) {
      if (!choiceItem || typeof choiceItem !== 'object') continue;
      const choice = choiceItem as Record<string, unknown>;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;

      const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta as Record<string, unknown> : null;
      if (delta) {
        if (typeof delta.content === 'string') content += delta.content;
        const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const toolCall of deltaToolCalls) {
          const name = extractToolCallName(toolCall);
          if (name) toolCallNames.add(name);
          const record = toolCall && typeof toolCall === 'object' ? toolCall as Record<string, unknown> : {};
          const index = typeof record.index === 'number' ? record.index : toolCallsByIndex.size;
          const existing = toolCallsByIndex.get(index) ?? { name: null, argumentsText: '' };
          const argumentsText = extractToolCallArguments(toolCall);
          toolCallsByIndex.set(index, {
            name: name ?? existing.name,
            argumentsText: argumentsText === null ? existing.argumentsText : `${existing.argumentsText}${argumentsText}`
          });
        }
      }
    }
  }

  const names = Array.from(toolCallNames).slice(0, 30);
  const toolCalls = Array.from(toolCallsByIndex.entries())
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => summarizeToolCall(toolCall.name, toolCall.argumentsText));
  return {
    httpStatus,
    bodyReadable: true,
    responseId,
    choiceCount,
    finishReason,
    toolCallCount: names.length,
    toolCallNames: names,
    toolCalls: toolCalls.slice(0, 30),
    contentLength: content.length,
    usage,
    errorType: error?.type ?? null,
    errorCode: error?.code ?? null,
    errorMessage: typeof error?.message === 'string' ? error.message.slice(0, 300) : null
  };
}

function summarizeLlmUsage(usage: unknown): Record<string, number | null> | null {
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  return {
    prompt_tokens: typeof record.prompt_tokens === 'number' ? record.prompt_tokens : null,
    completion_tokens: typeof record.completion_tokens === 'number' ? record.completion_tokens : null,
    total_tokens: typeof record.total_tokens === 'number' ? record.total_tokens : null
  };
}

function extractToolName(toolDef: unknown): string | null {
  if (!toolDef || typeof toolDef !== 'object') return null;
  const record = toolDef as Record<string, unknown>;
  if (typeof record.name === 'string') return record.name;
  const fn = record.function;
  if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
    return (fn as Record<string, unknown>).name as string;
  }
  return typeof record.type === 'string' ? record.type : null;
}

function extractToolCallName(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const record = toolCall as Record<string, unknown>;
  const fn = record.function;
  if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
    return (fn as Record<string, unknown>).name as string;
  }
  return typeof record.name === 'string' ? record.name : null;
}

function extractToolCallArguments(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const record = toolCall as Record<string, unknown>;
  const fn = record.function;
  if (fn && typeof fn === 'object') {
    const fnArguments = (fn as Record<string, unknown>).arguments;
    if (typeof fnArguments === 'string') return fnArguments;
    if (fnArguments !== undefined) return JSON.stringify(fnArguments);
  }
  if (typeof record.arguments === 'string') return record.arguments;
  if (record.arguments !== undefined) return JSON.stringify(record.arguments);
  return null;
}

function summarizeToolCalls(toolCalls: unknown[]): Array<{ name: string | null; argsPreview: unknown }> {
  return toolCalls.slice(0, 30).map((toolCall) => summarizeToolCall(extractToolCallName(toolCall), extractToolCallArguments(toolCall)));
}

function summarizeToolCall(name: string | null, argumentsText: string | null): { name: string | null; argsPreview: unknown } {
  return {
    name,
    argsPreview: argumentsText === null ? null : sanitizeTraceMeta(argumentsText.slice(0, 300))
  };
}

function summarizeMessageChars(messages: unknown[], role: string): number {
  return messages.reduce<number>((total, message) => {
    if (!message || typeof message !== 'object') return total;
    const record = message as Record<string, unknown>;
    if (record.role !== role) return total;
    const content = record.content;
    if (typeof content === 'string') return total + content.length;
    if (Array.isArray(content)) return total + JSON.stringify(content).length;
    return total;
  }, 0);
}

function sanitizeTraceMeta(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeTraceMeta);
  if (typeof value !== 'object') return String(value);

  const sanitized: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (!/_tokens$/i.test(key) && /accesskey|secret|token|password|api[_-]?key/i.test(key)) {
      sanitized[key] = '[REDACTED]';
      continue;
    }
    if (key === 'response' || key === 'body' || key === 'content') {
      sanitized[key] = summarizeLargeValue(entryValue);
      continue;
    }
    sanitized[key] = sanitizeTraceMeta(entryValue);
  }
  return sanitized;
}

function summarizeTraceResult(requestMeta: unknown, result: unknown): unknown {
  const summary: Record<string, unknown> = { request: sanitizeTraceMeta(requestMeta) };
  if (typeof result === 'string') {
    summary.result = { type: 'string', length: result.length, preview: result.slice(0, 240) };
    return summary;
  }
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    summary.result = {
      type: Array.isArray(result) ? 'array' : 'object',
      ok: record.ok,
      status: record.status,
      errorCode: record.errorCode,
      requestId: extractRequestId(record),
      keys: Object.keys(record).slice(0, 20)
    };
    return summary;
  }
  summary.result = { type: typeof result, value: result };
  return summary;
}

function summarizeLargeValue(value: unknown): unknown {
  if (typeof value === 'string') return { type: 'string', length: value.length, preview: value.slice(0, 240) };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (value && typeof value === 'object') return { type: 'object', keys: Object.keys(value as Record<string, unknown>).slice(0, 20) };
  return sanitizeTraceMeta(value);
}

function extractRequestId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  for (const key of ['RequestId', 'requestId', 'request_id']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  if (record.headers && typeof record.headers === 'object') {
    const requestId = extractHeaderRequestId(record.headers as Record<string, unknown>);
    if (requestId) return requestId;
  }
  if (record.body && typeof record.body === 'object') return extractRequestId(record.body);
  return null;
}

function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result);
  const record = result as Record<string, unknown>;
  const ok = record.ok === true ? 'ok' : 'failed';
  const status = typeof record.status === 'string' ? record.status : null;
  const product = typeof record.product === 'string' ? record.product : null;
  const action = typeof record.action === 'string' ? record.action : null;
  const version = typeof record.version === 'string' ? record.version : null;
  const danger = typeof record.danger === 'string' ? record.danger : null;
  const errorCode = typeof record.errorCode === 'string' ? record.errorCode : null;
  const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage : null;
  const response = record.response as Record<string, unknown> | undefined;
  const totalCount = response && typeof response.TotalCount !== 'undefined' ? ` TotalCount=${String(response.TotalCount)}` : '';
  const target = [product, action, version].filter(Boolean).join('/');
  const error = errorCode ? ` ${errorCode}: ${errorMessage || ''}` : '';
  return `${ok}${status ? ` ${status}` : ''}${target ? ` ${target}` : ''}${danger ? ` danger=${danger}` : ''}${totalCount}${error}`.trim();
}

// 把一次工具调用翻译成给用户看的"正在做什么"短语。
function describeToolActivity(toolName: string, args: Record<string, unknown> | null): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  switch (toolName) {
    case 'discover_api':
      return `🔍 正在搜索接口：${str(args?.query) || '…'}`;
    case 'get_api_params':
      return `📖 正在读取接口参数：${[str(args?.product), str(args?.action)].filter(Boolean).join('/') || '…'}`;
    case 'call_openapi': {
      const target = [str(args?.product), str(args?.action)].filter(Boolean).join('/') || '…';
      return args?.dry_run ? `🧪 正在校验调用（DryRun）：${target}` : `☁️ 正在调用阿里云：${target}`;
    }
    case 'list_workspace':
      return '📁 正在浏览工作区…';
    case 'search_workspace':
      return `📁 正在检索工作区：${str(args?.query) || '…'}`;
    case 'read_workspace_file':
      return `📄 正在读取文件：${str(args?.path) || '…'}`;
    case 'search_memory':
      return `🧠 正在检索记忆：${str(args?.query) || '…'}`;
    case 'search_skills':
      return `📚 正在检索技能：${str(args?.query) || '…'}`;
    case 'load_skill':
      return `📚 正在加载技能：${str(args?.id) || '…'}`;
    default:
      return `⚙️ 正在执行：${toolName}`;
  }
}

function gatewayError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function isGatewayError(error: unknown): error is Error & { code: string } {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    [
      'MISSING_OSS_BUCKET',
      'INVALID_OSS_BUCKET',
      'MISSING_OSS_ACL',
      'MISSING_OSS_BUCKET_POLICY',
      'MISSING_OSS_PUBLIC_ACCESS_BLOCK',
      'MISSING_OSS_OBJECT_KEY',
      'MISSING_OSS_CHANNEL',
      'MISSING_OSS_PLAYLIST',
      'UNSUPPORTED_OSS_SDK_SIGNATURE',
      'UNSUPPORTED_OSS_ACTION'
    ].includes(code)
  );
}

function slugifySkillId(title: string): string {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || randomUUID();
}

function findSkillDirectories(rootPath: string): string[] {
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error(`技能目录不存在：${rootPath}`);
  }
  if (existsSync(join(rootPath, 'SKILL.md'))) return [rootPath];

  return readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootPath, entry.name))
    .filter((skillDir) => existsSync(join(skillDir, 'SKILL.md')))
    .sort();
}

function parseSkillDirectory(skillDir: string): SaveSkillInput {
  const skillPath = join(skillDir, 'SKILL.md');
  const markdown = readFileSync(skillPath, 'utf8');
  const { metadata, content } = parseSkillMarkdown(markdown);
  const name = metadata.name || basename(skillDir);
  const description = metadata.description || firstParagraph(content) || name;
  const keywords = [metadata.name, metadata.description, metadata.version].filter(Boolean).join('\n');

  return {
    id: name,
    title: name,
    description,
    body: content.trim() || markdown.trim(),
    keywords,
    sourcePath: skillDir
  };
}

function parseSkillMarkdown(markdown: string): { metadata: Record<string, string>; content: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { metadata: {}, content: markdown };

  const metadata: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const simple = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!simple) continue;

    const key = simple[1];
    const value = simple[2];
    if (value === '|' || value === '>') {
      const block: string[] = [];
      while (lines[index + 1]?.startsWith('  ')) {
        index += 1;
        block.push(lines[index].replace(/^  /, ''));
      }
      metadata[key] = block.join('\n').trim();
    } else {
      metadata[key] = value.replace(/^['"]|['"]$/g, '').trim();
    }
  }

  return { metadata, content: markdown.slice(match[0].length) };
}

function firstParagraph(markdown: string): string | null {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((section) => section.replace(/^#+\s*/, '').trim())
    .find(Boolean);
  return paragraph ? paragraph.slice(0, 240) : null;
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(tableName);
  return Boolean(row);
}

function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || null;
}
