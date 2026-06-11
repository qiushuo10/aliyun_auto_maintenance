# Catalog 事实层 v2 设计方案

状态:已实施(2026-06-10)。本文描述接口事实(catalog)数据管线的重构设计、迁移方式与后续路线。

## 1. 背景与问题

项目核心原则是「事实类信息(产品码、endpoint、版本、Action、必填参数、弃用关系)一律来自可查的知识存储,绝不由模型记忆生成」。但 v1 实现中,catalog 的相当一部分"事实"并非来自上游,而是由代码启发式**生成**:

| 问题 | v1 来源 | 后果 |
| --- | --- | --- |
| 必填参数误报 | SDK `.d.ts` 注释正则推断 | ECS 抽样 6.2% 误报(见 `docs/catalog-source-spike.md`),如 `DescribeImages.DryRun` 误标必填 |
| 参数无语义 | `params_blob` 只有参数名 + TS 类型 | LLM 不知道 enum 合法值、参数含义、取值约束,靠模型记忆猜,猜错即 `InvalidParameter` |
| OSS HTTP method 靠猜 | `resolveSnapshotOnlyMethod` 按 Action 前缀推断(`List*` → PUT) | 与真实 REST method 不符,raw 调用失败 |
| OSS summary 无语义 | 上游 `title` 即 Action 名,快照原样保存 | FTS 搜索对 OSS 失效 |
| FTS 关键词污染 | 所有 snapshot-only OSS action 统一拼接 "阻止公共访问" 等关键词 | 搜"公共访问"命中全部 172 个 OSS action |
| OSS endpoint 模板错误 | SDK 提取出 `oss.{region}.aliyuncs.com`(真实为 `oss-{region}`) | 运行时靠 `normalizeOssEndpoint` 四条正则打补丁 |
| 手工 override 堆积 | `OSS_RAW_ACTION_OVERRIDES`、`applyRequiredOverrides` 等 | 上游本有的数据被丢弃后再手补,维护成本高 |

根因:`scripts/fetch-openapi-meta.mjs` 拉取的上游 `api-docs.json` 中,参数完整 schema(类型 / 位置 / 必填 / enum / 描述 / 示例)、HTTP method、REST path **全部存在**,但 v1 快照只保留了必填参数名单和 title,其余信息被丢弃,缺口再由 SDK 注释推断和手工 override 填补。

关于「用 aliyun-cli 的 help 替换 catalog」的结论:aliyun-cli 的元数据来自同一上游(`aliyun-openapi-meta`),且冻结在 CLI 发布版本、输出为文本。直接消费结构化的 `api-docs.json` 在新鲜度、可解析性、部署依赖上全面占优,故不引入 CLI。

## 2. 设计原则

1. **上游结构化数据是唯一事实源**:`https://api.aliyun.com/meta/v1/products/{ProductCode}/versions/{version}/api-docs.json`。
2. **代码不生成事实**:启发式推断(SDK 注释解析、method 前缀猜测)只作为快照缺失时的降级路径,且降级发生时数据带 source 标记。
3. **架构不动**:`catalog.db` schema、`discover_api` / `get_api_params` / `call_openapi` 工具接口、gateway 校验、danger 分级、审批流全部保持不变;只替换数据的忠实度。
4. **渐进可回滚**:快照带 `snapshotVersion`,加载端同时兼容 v1/v2;切换由影子 diff 报告驱动。

## 3. 数据流

```
api.aliyun.com/meta (api-docs.json, 结构化)
        │  scripts/fetch-openapi-meta.mjs(手动/定期执行)
        ▼
catalog-meta/{product}.json   ← snapshotVersion 2,进版本库,可审查、可回滚
        │  src/main/catalogLoader.ts(应用启动 / catalog:refresh)
        ▼
catalog.db(catalog_products / catalog_actions / catalog_overlay / catalog_fts)
        │
        ▼
discover_api → get_api_params → gateway 校验 → call_openapi(SDK 调用)
```

## 4. 快照 schema(snapshotVersion 2)

每个 action 在 v1 字段(`required` / `deprecated` / `replacedBy` / `summary`)之外新增:

```jsonc
{
  "summary": "Queries the objects in a bucket.",   // title 为 Action 名时降级取 summary/description 首句
  "method": "GET",                                  // apis[Action].methods[0],大写
  "path": "/",                                      // REST path(ROA/OSS 类产品关键)
  "parameters": [
    {
      "name": "bucket",
      "in": "host",                                 // host / path / query / header / body
      "type": "string",
      "required": true,
      "description": "The name of the bucket.",    // 截断 200 字符
      "enum": ["PrePaid", "PostPaid"],             // 最多 20 个
      "example": "examplebucket",
      "children": [ ... ]                           // object/array 类型展开一层,最多 30 个
    }
  ]
}
```

`required` 数组保留(由 `parameters[].required` 派生),v1 加载路径与外部消费方不受影响。

## 5. 加载优先级(catalogLoader.ts)

对每个 action,`params_blob` 与 `required` 的来源优先级:

1. **快照 `parameters`(v2)** — 重建 `params_blob`,带 `source: "catalog-meta:openapi-parameters"`;
2. 快照 `required` 数组(v1)— 仅修正 SDK 推断的 required 标记;
3. SDK `.d.ts` 注释解析 — 快照缺失时的兜底。

其他修正:

- **OSS endpoint**:`ENDPOINT_TPL_OVERRIDES` 在 catalog 层直接写入 `oss-{region}.aliyuncs.com`,不再依赖运行时 `normalizeOssEndpoint` 纠错(该函数保留作为防御)。
- **FTS 关键词**:删除 snapshot-only action 的全量关键词拼接;PublicAccessBlock 六个 action 改为 `ACTION_SUMMARY_OVERRIDES` 定向加中文检索词。

## 6. OSS 专项

OSS 是 S3 风格 REST/XML API,与 RPC 模型天然错配,v2 下的处理:

- **method / path 来自快照**,不再按 Action 前缀猜测;`params_blob.raw` 对所有 OSS action 写入 `{method, pathname, style, reqBodyType, bodyType}`。
- provider 的五层 dispatch(硬编码 switch → PublicAccessBlock 模块 → simple-bucket 反射 → SDK 签名反射 → raw `client.execute`)保持不变,但最后一层 raw execute 现在对**所有**快照内 action 都有数据可用(`parseOssRawCatalogSpec` 已支持 `raw.pathname`/`raw.path`),`UNSUPPORTED_OSS_ACTION` 仅在快照确实缺 method/path 时出现。
- `OSS_RAW_ACTION_OVERRIDES`(cname 五项)保留为最高优先级——其 pathname 含 query 形式(`/?cname&comp=token`)与请求体构造耦合(`normalizeOssCnameBody`),暂不依赖快照替换。

## 7. get_api_params 输出增强(services.ts)

`summarizeParamsMetadata` 透传新字段:

- 新增 `requiredDetails`:必填参数的完整明细(type / in / description / enum / example);
- `optionalExamples` 由 12 个扩到 24 个,同样带明细。

输出仍兼容原 shape(`requestClass` / `required` / `optionalExamples`),提示词与既有消费方无需调整。

## 8. 渐进式迁移与回滚

- 快照重新生成后,先跑 `node scripts/diff-catalog-sources.mjs`(对比工作区与 git HEAD 的快照):逐产品报告 action 增删、required 集合变化、v2 字段覆盖率;`--verbose` 列出全部明细。重灾区(ECS / RDS / VPC / OSS)人工过目后再提交。
- 回滚 = `git checkout` 旧快照 + 重新 `catalog:refresh`。加载端兼容 v1,无需回滚代码。
- 单产品异常可单独回滚该产品的 json,不影响其他产品。

## 9. 验证

- `npm test`(vitest):`catalogMeta.test.ts` 校验 OSS 快照含 PublicAccessBlock 全系、snapshot-only/ossutil action 正常入库、CAS 检索词存在。
- diff 脚本输出作为每次快照更新的评审产物。

## 10. 后续路线(未实施)

1. **Action 全集换源**:目前 action 全集仍以本地 SDK `Client.prototype` 方法为准(OSS 除外)。RPC 产品的调用走通用 `@alicloud/openapi-client`,并不依赖产品 SDK 方法存在,后续可改为以快照为全集、SDK 仅提供版本与 endpoint 规则,消除 SDK 落后导致的覆盖缺口。
2. **invocable 标记**:catalog 按 provider 实际能力标记 action 是否可执行,`discover_api` 过滤不可执行项,彻底消除"搜得到调不了"。
3. **OSS provider 收敛**:数据驱动的 raw execute 升级为主路径,硬编码 switch 仅保留复杂 XML body 的 action(如 `PutBucketWebsite`),五层收敛为两层。
4. **快照定期刷新**:将 `fetch-openapi-meta.mjs` + diff 报告纳入定期任务(CI 或应用内定时),带 checksum 与变更审计。
5. **清理代偿逻辑**:v2 稳定后,逐步移除 `normalizeParamsMetadata` 中的 ECS `HttpTokens` 硬补丁、`applyRequiredOverrides` 中可由快照覆盖的条目。
