#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_LOG_PATH = join(homedir(), 'Library/Application Support/aliy-agent/logs/run-trace.jsonl');
const EXPERIENCE_CODES = new Set(['MISSING_REQUIRED_PARAMS', 'ACTION_DEPRECATED']);

const args = parseArgs(process.argv.slice(2));
const filePath = expandHome(args.file ?? DEFAULT_LOG_PATH);

if (!existsSync(filePath)) {
  console.error(`日志文件不存在：${filePath}`);
  process.exit(1);
}

const { rows, errors } = readTraceRows(filePath);
for (const error of errors.slice(0, 20)) {
  console.error(`解析警告：第 ${error.lineNo} 行 JSON 解析失败：${error.reason}`);
}
if (errors.length > 20) {
  console.error(`解析警告：还有 ${errors.length - 20} 行解析失败，已跳过。`);
}

const runs = groupRuns(rows);
let selectedRuns = Array.from(runs.values()).sort((a, b) => a.firstAt - b.firstAt);

if (args.run) {
  selectedRuns = selectedRuns.filter((run) => run.runId === args.run);
} else if (typeof args.last === 'number') {
  selectedRuns = selectedRuns.slice(-args.last);
}

if (selectedRuns.length === 0) {
  const reason = args.run ? `没有找到 runId=${args.run}` : '没有可分析的 run';
  console.log(`${reason}。日志文件：${filePath}`);
  process.exit(0);
}

console.log(`日志文件：${filePath}`);
console.log(`分析 run 数：${selectedRuns.length}`);
console.log('');

selectedRuns.forEach((run, index) => {
  const report = analyzeRun(run);
  if (index > 0) console.log('');
  printRunReport(report);
});

function parseArgs(argv) {
  const parsed = { file: null, run: null, last: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--file') {
      parsed.file = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith('--file=')) {
      parsed.file = arg.slice('--file='.length);
      continue;
    }
    if (arg === '--run') {
      parsed.run = argv[++index] ?? null;
      continue;
    }
    if (arg.startsWith('--run=')) {
      parsed.run = arg.slice('--run='.length);
      continue;
    }
    if (arg === '--last') {
      parsed.last = parsePositiveInt(argv[++index], '--last');
      continue;
    }
    if (arg.startsWith('--last=')) {
      parsed.last = parsePositiveInt(arg.slice('--last='.length), '--last');
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    console.error(`未知参数：${arg}`);
    printUsage();
    process.exit(1);
  }
  return parsed;
}

function printUsage() {
  console.log([
    '用法：node scripts/analyze-trace.mjs [--file=<路径>] [--run=<id>] [--last=N]',
    '',
    `默认日志：${DEFAULT_LOG_PATH}`,
    '--run 优先于 --last。'
  ].join('\n'));
}

function parsePositiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    console.error(`${name} 必须是正整数。`);
    process.exit(1);
  }
  return number;
}

function expandHome(path) {
  if (!path) return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

function readTraceRows(path) {
  const text = readFileSync(path, 'utf8');
  const rows = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object') {
        errors.push({ lineNo: index + 1, reason: '不是 JSON object' });
        continue;
      }
      if (typeof row.runId !== 'string' || !row.runId) {
        errors.push({ lineNo: index + 1, reason: '缺少 runId，已跳过' });
        continue;
      }
      rows.push({ ...row, __lineNo: index + 1 });
    } catch (error) {
      errors.push({ lineNo: index + 1, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { rows, errors };
}

function groupRuns(rows) {
  const runs = new Map();
  for (const row of rows) {
    const at = asNumber(row.at) ?? 0;
    const existing = runs.get(row.runId);
    if (!existing) {
      runs.set(row.runId, { runId: row.runId, firstAt: at, rows: [row] });
      continue;
    }
    existing.firstAt = Math.min(existing.firstAt, at);
    existing.rows.push(row);
  }
  return runs;
}

function analyzeRun(run) {
  const rows = run.rows
    .filter((row) => row.event !== 'run_digest')
    .sort((a, b) => (asNumber(a.at) ?? 0) - (asNumber(b.at) ?? 0) || (a.__lineNo ?? 0) - (b.__lineNo ?? 0));
  const digestRows = run.rows.filter((row) => row.event === 'run_digest');
  const allRowsForTime = rows.length ? rows : run.rows;
  const startedAt = Math.min(...allRowsForTime.map((row) => asNumber(row.at) ?? 0));
  const endedAt = Math.max(...allRowsForTime.map((row) => asNumber(row.at) ?? 0));
  const wallMs = Math.max(0, endedAt - startedAt);
  const llmRows = rows.filter((row) => row.event === 'llm_http_response');
  const llmMs = sumDurations(llmRows);
  const cloudRows = rows.filter((row) => row.event === 'aliyun_sdk_end' || row.event === 'aliyun_cli_end');
  const cloudMs = sumDurations(cloudRows);
  const llmTrips = rows.filter((row) => row.event === 'llm_http_request').length;
  const tokenUsage = sumTokenUsage(llmRows);
  const toolStats = collectToolStats(rows);
  const requestedToolStats = collectRequestedToolStats(rows);
  const gatewayStats = collectGatewayStats(rows);
  const flags = collectFlags({ rows, wallMs, llmMs, llmTrips, toolStats, requestedToolStats, gatewayStats });

  return {
    runId: run.runId,
    sessionId: firstString(rows, 'sessionId') ?? firstString(run.rows, 'sessionId'),
    startedAt,
    endedAt,
    wallMs,
    llmMs,
    cloudMs,
    llmTrips,
    tokenUsage,
    toolStats,
    requestedToolStats,
    gatewayStats,
    flags,
    eventCount: rows.length,
    digestCount: digestRows.length
  };
}

function sumDurations(rows) {
  return rows.reduce((total, row) => total + Math.max(0, asNumber(row.durationMs) ?? 0), 0);
}

function sumTokenUsage(rows) {
  let prompt = 0;
  let completion = 0;
  let totalFromPromptCompletion = 0;
  let totalTokens = 0;
  let seen = false;

  for (const row of rows) {
    const usage = row.meta && typeof row.meta === 'object' ? row.meta.usage : null;
    if (!usage || typeof usage !== 'object') continue;
    const promptTokens = asNumber(usage.prompt_tokens);
    const completionTokens = asNumber(usage.completion_tokens);
    const totalTokenValue = asNumber(usage.total_tokens);
    if (promptTokens !== null) {
      prompt += promptTokens;
      totalFromPromptCompletion += promptTokens;
      seen = true;
    }
    if (completionTokens !== null) {
      completion += completionTokens;
      totalFromPromptCompletion += completionTokens;
      seen = true;
    }
    if (totalTokenValue !== null) totalTokens += totalTokenValue;
  }

  return {
    prompt,
    completion,
    total: seen ? totalFromPromptCompletion : totalTokens,
    seen: seen || totalTokens > 0
  };
}

function collectToolStats(rows) {
  const stats = new Map();
  for (const row of rows) {
    if (row.event !== 'tool_end') continue;
    const target = typeof row.target === 'string' && row.target ? row.target : '(unknown)';
    const entry = stats.get(target) ?? { target, success: 0, failed: 0, total: 0 };
    entry.total += 1;
    if (isSuccessStatus(row.status)) {
      entry.success += 1;
    } else {
      entry.failed += 1;
    }
    stats.set(target, entry);
  }
  return Array.from(stats.values()).sort((a, b) => b.total - a.total || a.target.localeCompare(b.target));
}

function collectRequestedToolStats(rows) {
  const stats = new Map();
  for (const row of rows) {
    if (row.event !== 'llm_http_response') continue;
    const meta = row.meta && typeof row.meta === 'object' ? row.meta : null;
    if (!meta) continue;

    const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : null;
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        if (!toolCall || typeof toolCall !== 'object') continue;
        const name = stringValue(toolCall.name);
        if (name) incrementToolCount(stats, name);
      }
      continue;
    }

    const toolCallNames = Array.isArray(meta.toolCallNames) ? meta.toolCallNames : [];
    for (const name of toolCallNames) {
      if (typeof name === 'string' && name) incrementToolCount(stats, name);
    }
  }
  return Array.from(stats.values()).sort((a, b) => b.total - a.total || a.target.localeCompare(b.target));
}

function incrementToolCount(stats, target) {
  const entry = stats.get(target) ?? { target, total: 0 };
  entry.total += 1;
  stats.set(target, entry);
}

function collectGatewayStats(rows) {
  const groups = new Map();
  const events = [];
  for (const row of rows) {
    if (row.event !== 'gateway_end') continue;
    const target = typeof row.target === 'string' && row.target ? row.target : '(unknown)';
    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    const status = stringValue(meta.gatewayStatus) ?? stringValue(row.status) ?? '(unknown)';
    const errorCode = stringValue(meta.errorCode) ?? 'none';
    const key = `${status}||${errorCode}`;
    const entry = groups.get(key) ?? { status, errorCode, count: 0, targets: new Set() };
    entry.count += 1;
    entry.targets.add(target);
    groups.set(key, entry);
    events.push({
      at: asNumber(row.at) ?? 0,
      lineNo: row.__lineNo ?? 0,
      target,
      status,
      errorCode,
      product: stringValue(meta.product) ?? splitTarget(target).product,
      action: stringValue(meta.action) ?? splitTarget(target).action
    });
  }
  return {
    groups: Array.from(groups.values())
      .map((entry) => ({ ...entry, targets: Array.from(entry.targets).sort() }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status) || a.errorCode.localeCompare(b.errorCode)),
    events
  };
}

function collectFlags({ rows, wallMs, llmMs, llmTrips, toolStats, requestedToolStats, gatewayStats }) {
  const flags = [];
  const llmRatio = wallMs > 0 ? llmMs / wallMs : 0;
  if (llmRatio > 0.8) {
    flags.push({
      title: 'LLM 占总耗时 >80%',
      evidence: `LLM 累计 ${formatDuration(llmMs)} / 总墙钟 ${formatDuration(wallMs)} = ${formatPercent(llmRatio)}`,
      reason: '推断原因：模型回合太重，主要等待时间花在 LLM 往返或流式响应上。'
    });
  }

  const repeatedAfterReject = findRepeatedGatewayCallsAfterReject(rows);
  for (const item of repeatedAfterReject) {
    flags.push({
      title: '网关拒绝后仍继续调用同一 action',
      evidence: `${item.product}/${item.action} 在 ${formatTime(item.rejectedAt)} 被拒绝后，又调用 ${item.laterCalls} 次；错误码：${item.errorCode}`,
      reason: '推断原因：计划没有吸收网关反馈，出现白跑或循环。'
    });
  }

  for (const code of EXPERIENCE_CODES) {
    const events = gatewayStats.events.filter((event) => event.errorCode === code);
    if (events.length >= 2) {
      flags.push({
        title: `反复出现 ${code}`,
        evidence: `${code} 出现 ${events.length} 次，涉及 ${formatList(unique(events.map((event) => event.target)), 6)}`,
        reason: '推断原因：catalog 接地不准，必填参数或弃用 Action 没有在规划阶段被消化。'
      });
    }
  }

  if (llmTrips >= 6) {
    flags.push({
      title: 'LLM 往返 >=6',
      evidence: `本 run 共有 ${llmTrips} 次 llm_http_request。`,
      reason: '推断原因：规划发散，多轮工具选择或纠错拉长了体验。'
    });
  }

  const toolEndCounts = new Map(toolStats.map((item) => [item.target, item.total]));
  for (const requested of requestedToolStats) {
    const executed = toolEndCounts.get(requested.target) ?? 0;
    if (requested.total <= executed) continue;
    flags.push({
      title: `模型请求的工具未全部执行：${requested.target}`,
      evidence: `llm_http_response 显示模型请求 ${requested.target} ${requested.total} 次，但 tool_end 只有 ${executed} 次，差 ${requested.total - executed} 次。`,
      reason: '推断原因：工具参数未通过 zod validation，或被 SDK 在 execute 前拦截；参数无效或 SDK 拦截发生在 execute 外，因此写在 execute 内的 tool/run_step/gateway 日志不可见。'
    });
  }

  const unreadableResponses = rows.filter((row) => {
    if (row.event !== 'llm_http_response') return false;
    const meta = row.meta && typeof row.meta === 'object' ? row.meta : null;
    return meta?.bodyReadable === false;
  });
  if (unreadableResponses.length > 0) {
    flags.push({
      title: '出现不可读的 LLM 响应体',
      evidence: `${unreadableResponses.length} 条 llm_http_response 的 meta.bodyReadable=false。`,
      reason: '推断原因：SSE 日志瞎，无法从日志看清模型返回、usage 或 tool_call 细节。'
    });
  }

  return flags;
}

function findRepeatedGatewayCallsAfterReject(rows) {
  const ordered = rows
    .filter((row) => row.event === 'gateway_start' || row.event === 'gateway_end')
    .sort((a, b) => (asNumber(a.at) ?? 0) - (asNumber(b.at) ?? 0) || (a.__lineNo ?? 0) - (b.__lineNo ?? 0));
  const items = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const row = ordered[index];
    if (row.event !== 'gateway_end') continue;
    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    const gatewayStatus = stringValue(meta.gatewayStatus) ?? stringValue(row.status) ?? '';
    if (gatewayStatus !== 'REJECTED_BY_GATEWAY') continue;
    const target = typeof row.target === 'string' ? row.target : '';
    const product = stringValue(meta.product) ?? splitTarget(target).product;
    const action = stringValue(meta.action) ?? splitTarget(target).action;
    if (!product || !action) continue;
    const laterCalls = ordered.slice(index + 1).filter((later) => {
      if (later.event !== 'gateway_start') return false;
      const laterMeta = later.meta && typeof later.meta === 'object' ? later.meta : {};
      const laterTarget = typeof later.target === 'string' ? later.target : '';
      const laterProduct = stringValue(laterMeta.product) ?? splitTarget(laterTarget).product;
      const laterAction = stringValue(laterMeta.action) ?? splitTarget(laterTarget).action;
      return lower(laterProduct) === lower(product) && lower(laterAction) === lower(action);
    });
    if (laterCalls.length > 0) {
      items.push({
        product,
        action,
        rejectedAt: asNumber(row.at) ?? 0,
        laterCalls: laterCalls.length,
        errorCode: stringValue(meta.errorCode) ?? 'none'
      });
    }
  }

  const deduped = new Map();
  for (const item of items) {
    const key = `${lower(item.product)}/${lower(item.action)}/${item.errorCode}`;
    const existing = deduped.get(key);
    if (!existing || item.rejectedAt < existing.rejectedAt) deduped.set(key, item);
  }
  return Array.from(deduped.values()).slice(0, 6);
}

function printRunReport(report) {
  const llmRatio = report.wallMs > 0 ? report.llmMs / report.wallMs : 0;
  const gatewayRejectCount = report.gatewayStats.events.filter((event) => event.status !== 'SUCCESS').length;
  const tokenText = report.tokenUsage.seen
    ? `${report.tokenUsage.total}（prompt ${report.tokenUsage.prompt} + completion ${report.tokenUsage.completion}）`
    : '无 usage';

  console.log(`runId: ${report.runId}`);
  if (report.sessionId) console.log(`sessionId: ${report.sessionId}`);
  console.log('');
  console.log('1) 概览');
  console.log(`- 起止时间：${formatTime(report.startedAt)} -> ${formatTime(report.endedAt)}`);
  console.log(`- 总墙钟耗时：${formatDuration(report.wallMs)}`);
  console.log(`- LLM 累计耗时：${formatDuration(report.llmMs)}（占比 ${formatPercent(llmRatio)}）`);
  console.log(`- 云端累计耗时（aliyun_sdk+aliyun_cli）：${formatDuration(report.cloudMs)}`);
  console.log(`- LLM 往返次数：${report.llmTrips}`);
  console.log(`- token 合计：${tokenText}`);
  if (report.digestCount > 0) console.log(`- run_digest 行：${report.digestCount} 条`);
  console.log('');

  console.log('2) 工具调用统计');
  if (report.toolStats.length === 0) {
    console.log('- 无 tool_end 记录。');
  } else {
    for (const item of report.toolStats) {
      console.log(`- ${item.target}: ${item.total} 次（成功 ${item.success} / 失败 ${item.failed}）`);
    }
  }
  console.log('');

  console.log('3) 网关结果');
  if (report.gatewayStats.groups.length === 0) {
    console.log('- 无 gateway_end 记录。');
  } else {
    for (const group of report.gatewayStats.groups) {
      console.log(`- ${group.status} + ${group.errorCode}: ${group.count} 次；target=${formatList(group.targets, 8)}`);
    }
  }
  console.log('');

  console.log('4) 体验问题旗标');
  if (report.flags.length === 0) {
    console.log('- 未命中明显体验问题旗标。');
  } else {
    for (const flag of report.flags) {
      console.log(`- ⚠ ${flag.title}`);
      console.log(`  证据：${flag.evidence}`);
      console.log(`  ${flag.reason}`);
    }
  }
  console.log('');

  console.log('5) Run 汇总');
  console.log(
    `汇总：runId=${report.runId} | 总耗时 ${formatDuration(report.wallMs)} | LLM ${formatDuration(report.llmMs)} (${formatPercent(llmRatio)}) | 云端 ${formatDuration(report.cloudMs)} | LLM往返 ${report.llmTrips} | 工具 ${sum(report.toolStats.map((item) => item.total))} 次 | 网关非成功 ${gatewayRejectCount} 次 | 旗标 ${report.flags.length} 个`
  );
}

function isSuccessStatus(status) {
  return status === 'success' || status === 'ok' || status === 'SUCCESS';
}

function splitTarget(target) {
  const [product, action] = String(target ?? '').split('/');
  return { product: product || null, action: action || null };
}

function firstString(rows, key) {
  for (const row of rows) {
    if (typeof row[key] === 'string' && row[key]) return row[key];
  }
  return null;
}

function stringValue(value) {
  return typeof value === 'string' && value ? value : null;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function lower(value) {
  return String(value ?? '').toLowerCase();
}

function formatTime(ms) {
  if (!ms) return '未知';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m${seconds}s`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '0.0%';
  return `${(value * 100).toFixed(1)}%`;
}

function formatList(values, limit) {
  if (!values.length) return '无';
  const visible = values.slice(0, limit);
  const suffix = values.length > limit ? ` 等 ${values.length} 项` : '';
  return `${visible.join(', ')}${suffix}`;
}
