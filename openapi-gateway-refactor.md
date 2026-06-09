# 知识接地的阿里云 Agent — 全新系统设计文档

状态：设计稿（全新系统，非存量改造）
形态：本地优先桌面应用
技术栈：TypeScript（Electron + better-sqlite3/FTS5 + chokidar）
日期：2026-05-28

> 本文从第一性原理设计一个全新系统，不继承任何现有代码。涉及的"事故场景"仅作为本架构必须防住的**典型失败模式**来驱动设计，不指代某段存量代码的缺陷。

---

## 1. 设计目标与定位

构建一个**本地优先的桌面 Agent**，帮助用户用自然语言完成阿里云运维（ECS/DNS/SSL/短信/云效/OSS 等）。核心设计承诺：

> **事实类信息（产品码、endpoint、版本、Action、必填参数、弃用关系）一律来自可查的知识存储，绝不由模型记忆生成。** 模型只表达意图，在 loop 中按需拉取详情（渐进式披露），自主驱动；发请求前经确定性网关校验、解析不出即 fail-closed；用"接地 + 校验 + 人确认"三层防御覆盖不同类别错误。

定位决定的根基（本地优先桌面）：
- 存储用**嵌入式 SQLite**（含 FTS5 全文检索），无外部服务依赖。
- 业务知识用**本地文件工作空间**，用户可用编辑器/git 直接管理。
- 检索默认**关键词（FTS）+ 模型迭代**，不引入向量库（规模需要时再加）。

---

## 2. 设计动机：必须防住的典型失败模式

一个 function-calling agent 若让模型凭记忆拼接 API 身份，会产生一类**结构性错误**。典型例子（本架构的头号回归用例）：

用户要"创建带变量的短信模板"，模型凭记忆产出：

```json
{ "product": "dysms", "action": "AddSmsTemplate", "version": "2017-05-25" }
```

三处皆错且会**连环放大**：

| 错误 | 真相 | 失败模式归类 |
|------|------|------------|
| `dysms` 当成产品码 | `dysms` 是 RAM 权限码；OpenAPI 产品码是 `dysmsapi` | 模型把"权限码命名空间"与"OpenAPI 产品命名空间"混淆 |
| `AddSmsTemplate` | 已下线，应为 `CreateSmsTemplate` | 模型记忆停留在旧接口 |
| 漏 `TemplateRule`/`RelatedSignName` | 带变量模板的必填项 | 模型不知道业务必填约束 |

若系统再"静默兜底"（拼出一个看似合理的错误 endpoint）并"丢弃结构化错误"（只留 RequestId），模型就会把根因误判成"网络/TLS 问题"，陷入无法自纠的循环。

**本架构的目标，就是让上述每一步都无法发生**：身份从 catalog 解析、必填由 catalog 校验、未知即 fail-closed、错误无损回灌。这一节贯穿后文的验收（§14）。

---

## 3. 技术栈选择（结论与依据）

**采用 TypeScript 生态。** 关键依据按权重：

1. **catalog 数据来源**：阿里云官方 `@alicloud/*` SDK 由 Darabonba 生成、本身是 TS，内嵌 endpoint 规则（`_endpointRule`/`_endpointMap`）与每个 Action 的元数据。用 TS 抽取 = 直接 import/解析；换语言则必须绕道官方 meta 仓/门户，丢掉这条已验证的可行路径（§12）。
2. **桌面轮子成熟**：Electron（壳）、better-sqlite3（同步、FTS5）、chokidar（文件 watcher）、AJV（schema 校验）都现成。
3. **单一语言**：主进程、agent loop、工具、catalog loader 同语言，减少胶水。

> 取舍：TS 在重 CPU 计算上不如 Go/Rust，但本系统是 I/O 密集（LLM、阿里云 API、本地 DB/文件），无瓶颈。

---

## 4. 总体架构

```
                    ┌──────────── 上下文（"菜单"，小，每轮都在） ────────────┐
  用户意图 ───────► │  目录式摘要(指针) + 工具清单 + 技能名 + 记忆索引 + 手动约定 │
                    └───────┬───────────────────────────────────────────────┘
                            │ 模型在 loop 里自主按需调用工具拉取（渐进式披露）
     ┌────────────┬───────────────┬──────────────┬────────────┬──────────────┐
     ▼            ▼               ▼              ▼            ▼              ▼
discover_api  search/read_   search/write_  load_skill  call_openapi
(查接口形状)   workspace      memory        (载食谱)     (发起调用)
     │        (查业务文档)    (查/写记忆)        │            │
     ▼            ▼               ▼              ▼            ▼
┌──────────┐ ┌───────────┐ ┌───────────┐ ┌────────┐ ┌──────────────────────┐
│catalog.db│ │文档工作空间│ │.agent-    │ │ skills │ │ OpenApiGateway        │
│独立只读库 │ │文件+FTS镜像│ │memory/子区│ │ (表)   │ │ resolve→validate→     │
│①接口事实 │ │②业务知识   │ │③自我记忆  │ │④食谱   │ │ assess→invoke→无损捕获 │
└────┬─────┘ └───────────┘ └───────────┘ └────────┘ │ 未解析 ⇒ fail-closed   │
     │                                               └──────────┬───────────┘
     └──────────────── 校验时回查 catalog ─────────────────────────┘
                                                                   ▼
                       三层防御: ① grounding ② Gateway 校验 ③ 人确认 → 执行
```

设计原则：

- **模型表意图，系统供事实。** 事实查表，不让概率模型生成。
- **渐进式披露。** 上下文只放目录指针，详情懒载。
- **模型自主，不做中央路由。** 查哪层、什么顺序、信谁，由模型在 loop 中判断；不写确定性级联或优先级引擎。
- **三层防御，各管一类错。**
- **工具数量与知识覆盖解耦。** 知识由存储全覆盖，暴露工具保持精简。

---

## 5. 存储与检索总览

四类知识按"形状"选介质，每类的管理与检索方案见 §6 对应小节。

| # | 知识 | 介质 | 数据源（真相） | 可搜镜像/索引 | 检索方式 | 常驻指针 | 写入者 |
|---|------|------|---------------|--------------|---------|---------|--------|
| ① | 接口事实 catalog | **独立只读 SQLite 库 `catalog.db`** | 官方 SDK/spec/文档最新快照 | `catalog_fts` | keyed + FTS5/BM25 + 别名 | "用 discover_api 查" | catalog loader |
| ② | 业务知识 | **文件系统工作空间** | 用户文档（.md/.json…） | `workspace_index`+`workspace_fts` | list + FTS(grep 兜底) + read | 文件树大纲 | 用户为主（agent 需确认） |
| ③ | 自我记忆 | **工作空间 `.agent-memory/` 子区** | agent 积累的文档 | 同 ② 复用 | 同 ② | 记忆索引(条目) | agent（强制确认） |
| ④ | 流程食谱 skills | **主库 SQLite 表** | 内置/自建 | `skills_fts` | 名+描述匹配 + 懒载 | 技能名清单 | 维护者 |

三个一致原则：
- **真相与索引分离**：FTS 表/索引只是"可搜镜像"，可随时从数据源重建；数据源（spec/文件）才是权威。
- **大体量不常驻**：上下文只放指针，正文/全参数/记忆条目用到才懒载。
- **接地式检索统一**：catalog 走 DB FTS，文档/记忆走文件 FTS+grep，机制同构（关键词检索 + 模型迭代重搜，不上向量）。

> 两个本地 DB 文件：`catalog.db`（只读、可整体替换的接口事实）与 `app.db`（用户数据：会话、任务、审计、workspace 索引、skills）。

---

## 6. 各存储的管理与检索（逐个详述）

每节含两部分：**A. 存储管理**（介质/schema/生命周期/写入纪律）与 **B. 检索方案**。

### 6.1 catalog — 接口事实（独立只读库 `catalog.db`）

#### A. 存储管理

**独立建库，与用户库 `app.db` 物理分离。** 理由：catalog 是机器生成、只读、可整体重建；用户库必须保护、只增量演进。二者生命周期相反，独立库让"刷新 catalog"变成"换文件"，零风险触及用户数据。

- 物理：`<userData>/catalog.db`；运行时主连接 `ATTACH DATABASE 'catalog.db' AS cat` 跨库 join，或独立只读连接。
- 分发：**构建期** loader 从 `@alicloud/*` SDK 抽取生成 `catalog.db` 种子随包分发（不随包带 SDK 源）；首启复制到 userData。
- 刷新：spec 升级 = **整文件替换** `catalog.db`，用户库零影响。带 `meta(schema_version, spec_snapshot_date)` 自描述版本。

```sql
-- catalog.db 内（独立库）

CREATE TABLE catalog_products (
  product       TEXT PRIMARY KEY,         -- 'dysmsapi'
  endpoint_mode TEXT NOT NULL,            -- 'global' | 'regional'
  endpoint_tpl  TEXT NOT NULL,            -- 'dysmsapi.aliyuncs.com' | '{product}.{region}.aliyuncs.com'
  endpoint_map  TEXT,                     -- 特殊 region 覆盖(JSON)，来自 SDK _endpointMap
  default_version TEXT,
  source        TEXT NOT NULL,            -- 'spec' | 'overlay'
  updated_at    INTEGER NOT NULL
);

CREATE TABLE catalog_actions (
  product       TEXT NOT NULL,
  action        TEXT NOT NULL,            -- 'CreateSmsTemplate'
  version       TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'POST',
  style         TEXT NOT NULL DEFAULT 'RPC',
  required_json TEXT NOT NULL,            -- ["TemplateName","TemplateContent","TemplateType"]
  danger        TEXT NOT NULL,            -- 'safe' | 'write' | 'dangerous'
  summary_cn    TEXT,                     -- 中文一句话用途
  params_blob   TEXT,                     -- 【分级存储】全参数定义(类型/枚举/约束)，体积大，不进 FTS、仅 get_api_params 读
  source        TEXT NOT NULL,            -- 'spec' | 'overlay'
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (product, action, version)
);

CREATE TABLE catalog_overlay (             -- loader 从官方文档/SDK派生，刷新时可重建
  product TEXT NOT NULL, action TEXT NOT NULL,
  deprecated INTEGER NOT NULL DEFAULT 0,
  replaced_by TEXT,                        -- 'CreateSmsTemplate'
  keywords TEXT,                           -- '短信,模板,sms,create,通知'
  note TEXT,
  PRIMARY KEY (product, action)
);

CREATE TABLE catalog_aliases (             -- loader 从官方命名/兼容信息派生，刷新时可重建
  alias TEXT PRIMARY KEY,                  -- 'dysms'（RAM 权限码）
  product TEXT NOT NULL,                   -- 'dysmsapi'
  kind TEXT NOT NULL                       -- 'ram_code' | 'typo' | 'legacy'
);

CREATE VIRTUAL TABLE catalog_fts USING fts5(
  doc_id UNINDEXED,                        -- 'product:action'
  product, action, summary_cn, keywords,
  tokenize = 'unicode61'                   -- 中文按字切；配合 keywords 桥中英文
);
```

管理要点：
- **整库刷新**：接口事实以官方 SDK/spec/文档最新快照为准；`catalog_products`、`catalog_actions`、`catalog_overlay`、`catalog_aliases` 都可由 loader 重建，不把人工修改当作接口真相来源。
- **`params_blob` 分级存储**：全参数定义是体积大头（全量可达数十 MB），单列存放、**不进 FTS**，仅 `get_api_params` 按需读；检索只用摘要字段。
- 索引随 catalog.db 构建期一起生成，运行时无触发器负担。

#### B. 检索方案

```sql
-- discover_api(intent="创建短信模板")
SELECT doc_id, bm25(catalog_fts, 5.0, 3.0, 1.0, 2.0) AS score   -- action/title 加权前置
FROM catalog_fts
WHERE catalog_fts MATCH :q       -- :q = '创建 OR 短信 OR 模板 OR sms OR template'（查询扩展）
ORDER BY score LIMIT 8;
-- 返回前 join catalog_overlay：deprecated=1 则附 replaced_by
```

三种路径：

| 路径 | 触发 | 机制 |
|------|------|------|
| 精确查 | product/action 已知 | 主键 `SELECT`，零歧义 |
| 关键词检索 | 模糊中文意图 | FTS5 + BM25 + 查询扩展（中文 OR 英文同义） |
| 别名命中 | 模型填易混码 `dysms` | `catalog_aliases` → 纠正/拦截 |

裁剪：检索只返回摘要（action/summary_cn/required/danger/replaced_by），`params_blob` 选定后由 `get_api_params` 二次懒载。

### 6.2 业务知识 — 文档工作空间（文件系统）

#### A. 存储管理

数据源是磁盘文件夹/文件，**用户可用编辑器/git 直接管理**，系统不强加结构：

```
<userData>/workspace/<profile_id>/
├── 短信/
│   ├── 签名.md          "默认签名：杭州虎翊智能科技"
│   └── 模板规范.md
├── 环境/region映射.md   "prod=cn-hangzhou"
└── 命名规范.md
```

可搜镜像（在 `app.db`，由 watcher 维护）：

```sql
CREATE TABLE workspace_index (
  profile_id TEXT NOT NULL, path TEXT NOT NULL,   -- '短信/签名.md'
  title TEXT, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
  PRIMARY KEY (profile_id, path)
);
CREATE VIRTUAL TABLE workspace_fts USING fts5(
  path UNINDEXED, title, content, tokenize='unicode61'
);
```

- 文件类型：Markdown/纯文本为主，允许 .json/.yaml。
- 索引同步：**文件 watcher**（chokidar）监听，按 `mtime` 增量重建；索引随时可由文件全量重建（兜底）。

写入纪律：

| 规则 | 说明 |
|------|------|
| 用户为主 | 文件归用户管理，agent 只协助补充，不抢所有权 |
| 后台积累 | 主运维 Agent 不写业务文档；知识积累由定时任务 Agent 生成候选并经用户确认后落盘 |
| 冲突不入代码 | 多文件冲突由模型在上下文判断（用户明示值优先）；不写优先级引擎 |
| 时效 | `mtime` 即时效线索；云同步落地文档在文首标同步时间 |

#### B. 检索方案（看树 → 找文件 → 读全文）

| 动作 | 工具 | 机制 |
|------|------|------|
| 看结构 | `list_workspace(path?)` | 列文件树（菜单也用它派生） |
| 按内容找 | `search_workspace(query)` | **B 主**：`workspace_fts` BM25 返回 path+片段；**A 兜底**：索引不可用时实时 grep |
| 按路径找 | `search_workspace` | glob 文件夹/文件名（`短信/*`） |
| 读全文 | `read_workspace_file(path)` | 懒加载文件正文 |

裁剪：`search_workspace` 只回 path+片段，选定后才 `read_workspace_file` 读全文。

### 6.3 自我记忆 — agent 积累（工作空间 `.agent-memory/` 子区）

> 业务知识是**用户写**的断言事实；自我记忆是**agent 积累**的经历/偏好/教训。二者作者、风险、纪律都不同，必须分开。

#### A. 存储管理

复用工作空间机制，开一个 agent 专属子目录，用户仍可见可编辑：

```
workspace/<profile_id>/
├── 短信/签名.md            ← ② 用户业务知识
└── .agent-memory/          ← ③ agent 记忆区
    ├── preferences.md       "用户偏好简洁回复；删除前必确认"
    └── episodic.md          "2026-05-28 建模板用签名'杭州虎翊智能科技'"
```

- 复用 `workspace_index`/`workspace_fts`（`.agent-memory/` 路径前缀区分）+ 同一套 watcher 与检索，不另造存储。
- **写入纪律（比业务文档更严）**：
  - 主运维 Agent 只读记忆，不写记忆；后台定时任务 Agent 提取候选，用户确认才落盘。**禁止从单次成功调用自动学**（防记忆投毒）。
  - **去重**：写前先 `search_memory` 同主题，存在则更新而非追加。
  - **巩固 consolidation**：定期合并/剪枝，防 `.agent-memory/` 膨胀撑大常驻索引。
  - **过期**：条目带日期，陈旧可剪。

**边界（关键）**：**接口类教训不进记忆**。"dysms 应为 dysmsapi"这类接口事实必须通过刷新 catalog 让 loader 从官方来源重新接地，不能塞进自由文本记忆，也不要求用户手工改 overlay。记忆只装：用户偏好、跨会话情景、非接口层面的失败模式。

#### B. 检索方案

与 §6.2 同构：`search_memory(query)`（限定 `.agent-memory/` 前缀的 `workspace_fts` 查询）→ 命中条目 → 读全文。常驻菜单放"记忆索引"（条目标题一行一条，有上限）。

### 6.4 流程食谱 — skills（主库 SQLite 表）

#### A. 存储管理

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
  body TEXT NOT NULL,                      -- 食谱正文（懒载）
  keywords TEXT, updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE skills_fts USING fts5(
  doc_id UNINDEXED, title, description, keywords, tokenize='unicode61'
);
```
触发器同步 `skills_fts`。技能数量少、变更低频，留在主库即可。

#### B. 检索方案

常驻菜单放"技能名 + 一句描述"；模型命中后 `load_skill(id)` 懒载 `body`。模糊时可 `skills_fts` 检索。**技能正文是建议食谱，非强制流程**（模型可改）。

### 6.5 公共检索循环与语义检索升级

所有 FTS 检索共享一个循环（agentic search）：

```
模型造查询(中文意图) → FTS5 BM25 取 topK → 模型看够不够 → 不够换词重搜(loop) → 选定 → 懒载详情
```

智能在"模型迭代廉价检索"里，不在索引里。中英文桥靠两点：①各表 `keywords` 存中英文同义词（召回主力）；②模型换词重搜。

何时上向量：

```
关键词检索(+别名+模型重搜)  ──默认，覆盖绝大多数
        │ 当业务文档/记忆量大、措辞乱、关键词频繁召不回
        ▼
向量/embedding 检索          ──后期增强，按规模引入；catalog 等其余仍走 FTS
```

---

## 7. 渐进式披露与常驻"菜单"

上下文每轮常驻的只有"目录指针"，且**从存储自动派生**，保证永远小：

```
【技能】建短信模板 | 申请SSL | 发流水线              ← SELECT title FROM skills
【接口】用 discover_api(intent) 查具体接口            ← 一句话；catalog 不进上下文
【业务知识·工作空间】                                ← list_workspace 派生的文件树大纲(仅路径)
   短信/(签名.md, 模板规范.md)  环境/(region映射.md)  命名规范.md
【记忆索引】· 偏好简洁回复  · 删除前必确认             ← .agent-memory/ 条目标题(一行一条，有上限)
【手动约定】prod=cn-hangzhou                          ← 此层小，直接全给值
```

规则：**小且每轮相关 → 全给（手动约定）；大或看情况 → 只给目录，做成工具让模型拉。** catalog 全量、业务文档正文、记忆正文、技能正文一律不常驻——常驻的只是**树大纲/条目标题（不含内容）**，模型据此决定 `read_workspace_file`/`search_memory` 读哪个。

---

## 8. 工具体系（从零设计）

工具面 = **知识检索/写入工具 + 通用网关出口 + 少量高频 typed 工具**。三类都经统一校验，事实一律查 catalog。

### 8.1 主运维 Agent 的知识检索工具

| 工具 | 参数 | 返回 | danger | 说明 |
|------|------|------|--------|------|
| `discover_api` | `intent:string`, `product?:string` | `[{product,endpoint,version,action,required[],danger,replaced_by?}]` | safe | FTS 查 catalog；中文意图→接口形状 |
| `get_api_params` | `product`, `action`, `version` | 完整 `params_blob`（类型/枚举/约束） | safe | 选定 Action 后二次懒载全参数 |
| `list_workspace` | `path?:string` | 文件夹/文件树（路径列表） | safe | 浏览业务知识结构；菜单也用它派生 |
| `search_workspace` | `query:string` | `[{path, snippet}]` | safe | 业务文档内容检索：B 走 `workspace_fts`，A 兜底 grep |
| `read_workspace_file` | `path:string` | 文件全文 | safe | 懒加载读业务文档/记忆 |
| `search_memory` | `query:string` | `[{path, snippet}]` | safe | 检索 `.agent-memory/`（限定前缀的 workspace_fts） |
| `load_skill` | `id:string` | 技能正文 | safe | 懒载 `skills.body` |

### 8.2 通用调用出口 `call_openapi`

```
call_openapi(product, action, version, region_id?, params{}, dry_run?)
```

- **不暴露 `endpoint` 参数**：endpoint 由 Gateway 从 catalog 解析，模型无从填错。
- danger 由 catalog 的 `danger` 字段决定，不靠 action 名前缀猜。
- 内部全程走 §9 OpenApiGateway。

这是覆盖**长尾接口**的主力出口：任何无专用工具的 Action 都经它 + catalog 完成，不必为每个场景造工具。

### 8.3 少量高频 typed 工具（刻意选择，而非历史遗留）

为最高频的几类操作（如 ECS 启停/查询、DNS 记录、SSL 申请）提供强类型工具，理由是**降低高频路径的幻觉与延迟**（强类型表单 + 无"先发现"开销）。判据严格：

- **值得 typed**：有"单次调用之外语义"——多步编排（SSL 申请流程）、特殊安全建模（命令执行接黑名单、安全组规则评估）。
- **不值得**：纯 CRUD（dns record、oss list、ecs 只读）→ 走 `call_openapi` + catalog。

所有 typed 工具**内部同样走 Gateway**，参数 schema 可由 catalog 的 Action 元数据生成（必填项来自元数据，不手抄）。这样"工具数量"是刻意策展，与"知识覆盖"解耦——避免为可靠性而无限堆工具。

### 8.4 Gateway 不是模型可见工具

`OpenApiGateway` 是 `call_openapi` 与所有 typed 工具的**内部统一管道**，不单独暴露给模型。

---

## 9. OpenApiGateway（确定性校验出口）

所有 OpenAPI 调用的唯一内部出口：

```
invoke(product, action, version, params):
  1. resolve   catalog_aliases 纠正易混码 → catalog_products 取 endpoint → 规范化 version
               未知产品/接口 ⇒ 抛 fail-closed（错误带正确答案）
  2. validate  action 存在? 弃用→给 replaced_by；required_json 必填齐? 否 ⇒ 报错(指明缺啥)
  3. assess    danger 取自 catalog；write/dangerous ⇒ 标记需确认
  4. invoke    构造 OpenApiClient(resolvedEndpoint) 发起
  5. capture   无损捕获 {code,message,http_status,resolved_endpoint,resolved_version,request_params,request_id}
```

fail-closed 示例：模型填 `product:"dysms"` →
`错误: dysms 是 RAM 权限码，非 OpenAPI 产品码。短信产品为 dysmsapi，模板创建用 CreateSmsTemplate（AddSmsTemplate 已下线）。`
→ 模型下一轮自纠。

**无损错误回灌**：结构化错误（含 `error_code` 与 `replaced_by`）既写入审计表，也作为 tool 结果回灌给 loop，使模型据实自纠，而非误判"网络问题"。审计表 `tool_invocations` 自带：`error_code/error_message/http_status/resolved_endpoint/resolved_version/request_params/request_id`。

---

## 10. 装配编排（端到端示例，模型自主）

场景："帮我建个短信模板，内容是 您好,${accountName}的${miniProgramName}小程序已审核通过，变量都是带数字的字符"。

| 轮 | 模型动作 | 进入上下文 |
|---|---------|----------|
| 开局 | 仅常驻菜单 | 菜单（指针） |
| 1 | 命中"建短信模板"技能 → `load_skill('sms-template')` | + 技能食谱 |
| 2 | 不自填产品 → `discover_api("创建短信模板")` | + `dysmsapi/CreateSmsTemplate` 形状（必填 TemplateContent/TemplateRule/RelatedSignName） |
| 3 | 缺签名 → `search_workspace("短信 签名")` → 命中 `短信/签名.md` → `read_workspace_file(...)` | + 签名值"杭州虎翊智能科技" |
| 3.5 | 本地组装参数（每个值标来源） | — |
| 4 | `call_openapi(dysmsapi, CreateSmsTemplate, …)` → Gateway 校验通过 | — |
| 5 | 确认卡（"签名=杭州虎翊智能科技 来自 短信/签名.md"）→ 用户确认 → 执行 | + 执行结果 |
| 收尾 | 回答用户；新知识沉淀由后台定时任务 Agent 后续提取候选 | 不占常驻 |

全程 catalog 其余几千 action、其他技能、其他业务文档**一个都没进上下文**。轮次顺序由模型 loop 现场生成 + 技能食谱建议，非菜单或代码规定。

---

## 11. 三层防御（各管一类错）

| 错误类型 | 例子 | grounding(前) | Gateway 校验(中) | 人确认(后) |
|---|---|---|---|---|
| 未知产品/接口不存在/已弃用 | `dysms`/`AddSmsTemplate` | 预防 | **能拦（fail-closed）** | ✓ |
| 缺必填参数 | 漏 TemplateRule | 预防 | **能拦** | ✓ |
| 格式对、值填错 | 用了另一个合法签名 | 降概率 | **拦不住** | **能拦** |
| 意图选错 | 该 Update 却 Create | 帮忙 | **拦不住** | **能拦** |
| 用了过期数据 | region 缓存已变 | 弱 | 弱 | 部分 + TTL |

后校验有天花板（只拦"畸形/不可能"，拦不住"合法但错"），故接地（预防）与人确认（拦意图错）都不能省。

---

## 12. catalog 数据来源（已核实可行）

官方机读元数据存在且充分，catalog 核心可从 `@alicloud/*` SDK 抽取（无需联网）：

| catalog 字段 | 官方 spec 覆盖 | 来源 |
|---|---|---|
| 产品 → endpoint 规则（regional/central 模板 + 特殊 region map） | ✅ 完全 | `@alicloud/endpoint-util` + 各 SDK 内嵌 `_endpointRule`/`_endpointMap`/`_productId` |
| 产品 → 版本 | ✅ 完全 | 各产品 SDK / api.aliyun.com 门户 |
| Action 存在性 + protocol/method/style/pathname/reqBodyType | ✅ 完全 | 各产品 SDK `client.ts` |
| Action 必填参数 | ✅ 基本 | SDK `*Request` 类型 / 门户参数定义 |
| **危险级别 safe/write/dangerous** | ❌ spec 无此概念 | loader 依据官方 action 元数据和本地规则派生，刷新时重建 |
| **弃用→替代映射（AddSmsTemplate→CreateSmsTemplate）** | ⚠️ 文档标注但无机读字段 | loader 从最新官方文档/SDK 注释抽取，刷新时重建 |
| **易混码别名（dysms→dysmsapi，RAM 权限码）** | ❌ 不同命名空间，spec 无 | loader 从官方命名/兼容信息派生，刷新时重建 |

**结论**：endpoint 规则与 Action 元数据 SDK 即带，catalog 应由 loader 直接从官方 SDK/spec/文档最新快照抽取。spec 未覆盖但可由文档、SDK 注释或规则派生的字段，仍落入 catalog 表中供网关校验，但不作为人工长期维护文件。

**catalog loader（构建期）**：
1. 遍历 `@alicloud/<product><version>` SDK，抽取每个 Action 的 `{action,version,protocol,method,style,...}`、endpoint 字段、`_endpointMap` → 生成种子 `catalog.db`（`source='spec'`）。
2. loader 同步生成 `catalog_overlay`（弃用/中文别名/danger）与 `catalog_aliases`（易混码），刷新时随官方快照一起重建。
3. 缺产品 SDK 时按需安装（如 `@alicloud/dysmsapi20170525`）后纳入抽取。
4. 运行时主库 `ATTACH catalog.db`；升级 = 整文件替换。

可选增强：以 `api.aliyun.com` 门户 / `aliyun-openapi-meta` 仓作在线刷新源（后者结构不稳定，仅作参考）。

参考：
- [aliyun/aliyun-openapi-meta](https://github.com/aliyun/aliyun-openapi-meta)
- [aliyun/darabonba-openapi](https://github.com/aliyun/darabonba-openapi)
- [CreateSmsTemplate 官方文档](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-createsmstemplate)
- [短信服务 OpenAPI 门户](https://api.aliyun.com/product/Dysmsapi)

---

## 13. 实施路线（全新构建顺序）

| 阶段 | 内容 | 产出 |
|------|------|------|
| 0 | 工程骨架：Electron + TS + better-sqlite3，`app.db` 迁移框架，LLM provider + 基础 agent loop（function calling） | 能跑通空 loop |
| 1 | **catalog loader + `catalog.db`**：构建期/刷新期从官方 SDK/spec/文档抽取 | 接口事实可查 |
| 2 | **OpenApiGateway**：resolve→validate→assess→invoke→无损捕获，fail-closed | 安全出口 |
| 3 | **`call_openapi` + `discover_api`/`get_api_params`**：长尾接口端到端可用 | §2 失败模式被防住 |
| 4 | **审计 + 无损错误回灌**：`tool_invocations` 结构化错误，回灌 loop | 可自纠 |
| 5 | **业务知识工作空间**：目录 + watcher + `workspace_*` + list/search/read/write | 业务值接地 |
| 6 | **菜单与渐进式披露**：目录指针自动派生注入 prompt | 上下文受控 |
| 7 | **技能**：`skills` 表 + `load_skill` | 流程复用 |
| 8 | **自我记忆**：`.agent-memory/` + `search_memory` + 后台定时任务候选确认（去重+巩固） | 经验沉淀 |
| 9 | **少量高频 typed 工具 + 人确认卡 UI** | 高频路径提速 + 第三层防御 |

最小可用闭环 = 阶段 0–4（直接消灭 §2 整类失败）；5–9 为知识与体验增强，按需推进。

---

## 14. 验收用例

1. `call_openapi(product=dysms, action=AddSmsTemplate)` → fail-closed，错误点名 `dysmsapi`/`CreateSmsTemplate`/必填 `TemplateRule`/`RelatedSignName`。
2. 正确调用 `dysmsapi / CreateSmsTemplate` + 必填 → 成功。
3. `tool_invocations` 能查到 `error_code` 与完整入参。
4. 失败错误回灌后，模型总结不出现"网络/TLS 问题"。
5. `discover_api("创建短信模板")` 命中 `CreateSmsTemplate`（中文别名 FTS）。
6. `discover_api` 命中已弃用 Action 时返回 `replaced_by`。
7. `search_workspace("短信 签名")` 命中 `短信/签名.md`；删除/损坏索引后 grep 兜底仍可搜。
8. 工作空间新增/改文件后，watcher 增量更新索引，能搜到新内容。
9. 后台定时任务 Agent 的知识候选须用户确认才落盘。
10. 记忆写入前去重：同主题已存在则更新而非追加。
11. catalog 刷新（替换 `catalog.db`）后用户库 `app.db` 数据不受影响。
