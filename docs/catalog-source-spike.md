# Catalog Source Accuracy Spike

Date: 2026-06-03

## Scope

This spike evaluated whether the catalog loader should continue inferring required parameters from `@alicloud/*` TypeScript SDK comments, or migrate required/deprecated/summary data to Aliyun OpenAPI metadata. ECS was used as the sample product.

Local SDK sample:

- Package: `@alicloud/ecs20140526`
- Installed version: `7.8.1`
- API version: `2014-05-26`
- Request declaration files inspected: `node_modules/@alicloud/ecs20140526/dist/models/*Request.d.ts`

## Quick Fix Validation

`src/main/catalogLoader.ts` now treats a parameter as required only when its comment contains an explicit required marker:

- `@required`
- a line-start `Required:` label, case-insensitive
- a standalone sentence matching `This parameter is required.` or `This parameter is mandatory.`

This excludes incidental prose such as `required permissions`, `required parameters are specified`, enum values named `required`, and conditional text like `This parameter is required if ...`.

Validation against installed ECS declarations:

| Action | Required params after fix | Note |
| --- | --- | --- |
| `DescribeImages` | `RegionId` | `DryRun` is no longer flagged. Its comment only mentions required permissions/parameters inside dry-run prose. |
| `DeleteInstance` | `InstanceId` | Positive check preserved. |
| `DescribeInstanceAttribute` | `InstanceId` | Positive check preserved. |

Local ECS-wide heuristic impact:

| Metric | Count |
| --- | ---: |
| ECS request declarations analyzed | 376 |
| Required param detections with old loose regex | 739 |
| Required param detections after quick fix | 693 |
| Removed detections | 46 |
| Actions affected by removals | 30 |
| Actions still having at least one required param | 364 |

Representative removed false positives:

- `DescribeImages.DryRun`: dry-run text says the system checks whether required parameters are specified.
- `RunInstances.DryRun`: same dry-run prose pattern.
- `CreateInstance.HttpTokens`: enum value text says `required` means IMDSv2 is forced.
- `CreateInstance.ImageId`: conditionally required if `ImageFamily` is not specified.
- `CreateInstance.VSwitchId`: required only for VPC creation.

## OpenAPI Metadata Availability

Official Aliyun documentation says OpenAPI metadata is available through unauthenticated HTTP endpoints:

- Product/version metadata: `https://api.aliyun.com/meta/v1/products/{product}/versions/{version}/api-docs.json`
- Single API metadata: `https://api.aliyun.com/meta/v1/products/{product}/versions/{version}/apis/{api_name}/api.json`
- English metadata can be requested with `?language=EN_US`.

The documented metadata model contains an `apis` map. Each API entry contains `parameters`, and each parameter has a `schema.required` boolean. The same metadata also carries fields such as `deprecated`, `title`, `summary`, and `description`, which are better suited to catalog population than parsing SDK comments.

Sources:

- https://help.aliyun.com/zh/sdk/product-overview/openapi-metadata
- https://api.aliyun.com/openmeta
- https://api.aliyun.com/openmeta/api/GetAPIDocs

## Fetch Attempt

I attempted to fetch the full ECS metadata locally:

```sh
curl -L --max-time 30 -o /tmp/ecs-api-docs.json \
  'https://api.aliyun.com/meta/v1/products/Ecs/versions/2014-05-26/api-docs.json?language=EN_US'
```

The local sandbox could not reach the network:

```text
curl: (7) Failed to connect to 127.0.0.1 port 7897 after 0 ms: Couldn't connect to server
```

Because the metadata JSON could not be fetched from this environment, this spike could not produce a full OpenAPI-vs-loader ECS mismatch table. The discrepancy data above is therefore local SDK heuristic data, not a structured metadata comparison.

## Expected Discrepancies

Based on the installed SDK shape and the old-vs-fixed comparison, the most likely discrepancies between SDK-comment inference and OpenAPI metadata are:

- False positives from prose that mentions required concepts without marking the current parameter as unconditionally required.
- Conditional required parameters, where comments say `required if ...`; OpenAPI `schema.required` is expected to be `false` unless the parameter is always required.
- Enum values named `required`, such as IMDS `HttpTokens`.
- Dry-run descriptions that mention required permissions or parameter checks.
- Summary/deprecation differences caused by the current loader reading method comments from `client.d.ts` instead of the richer API metadata fields.

The quick fix removes 46 suspicious required detections across 30 ECS actions. That is 6.2% of old required detections in this installed ECS SDK sample. This is enough drift to justify replacing comment inference with structured metadata when a reproducible metadata snapshot is available.

## Conclusion

It is worth migrating required/deprecated/summary sources from SDK comments to OpenAPI metadata.

Reasons:

- Required flags are structured as `schema.required` in OpenAPI metadata; SDK `.d.ts` request properties are all optional and force the loader into fragile comment parsing.
- Metadata includes API-level `deprecated`, `title`, `summary`, and `description`, avoiding separate regex extraction from generated SDK docs.
- The official metadata endpoints are unauthenticated and designed for tooling, SDK generation, IDE plugins, and documentation rendering.

Offline/reproducible access is feasible only if the project vendors or snapshots the metadata.

The installed npm SDK package does not appear to include the full per-product OpenAPI metadata JSON. Therefore, a runtime loader that depends on live `api.aliyun.com` access would not be offline reliable. A reproducible approach would be:

1. Add a build-time or maintenance script that fetches `api-docs.json` per product/version.
2. Commit the metadata snapshots, or store them as versioned artifacts with checksums.
3. Teach `catalogLoader.ts` to prefer snapshot metadata for `required`, `deprecated`, and `summary`, while keeping SDK declarations as the fallback for method discovery and TypeScript type strings.
4. Roll out per product with a generated mismatch report before switching defaults.

Until that migration exists, the tightened SDK-comment heuristic is a low-risk improvement: it fixes the known `DescribeImages.DryRun` false positive and preserves explicit markers such as `DeleteInstance.InstanceId` and `DescribeInstanceAttribute.InstanceId`.

## Structured Metadata Snapshot Refresh

Run the snapshot refresh script from the project root:

```sh
node scripts/fetch-openapi-meta.mjs
```

The script discovers installed `@alicloud/*` SDK products from `node_modules/@alicloud`, extracts the product id and OpenAPI version from each generated `dist/client.js`, fetches the public OpenAPI metadata endpoint, and writes normalized snapshots. It honors `HTTPS_PROXY` first and `ALL_PROXY` second for HTTPS requests. `OPENAPI_META_TIMEOUT_MS` can be set to override the default 30000 ms request timeout.

Expected output is one line per product, followed by a summary:

```text
OK ecs 2014-05-26 376 actions
FAIL rds 2014-08-15: HTTP 404: ...

OpenAPI metadata snapshots complete: 1 succeeded, 1 failed.
Failed products:
- rds 2014-08-15: HTTP 404: ...
```

Snapshots live under:

```text
catalog-meta/
  ecs.json
  rds.json
  ...
```

Each `catalog-meta/<product>.json` file contains `snapshotVersion`, the SDK catalog `product`, the OpenAPI endpoint product code used for fetch, the API `version`, the source URL, `fetchedAt`, and an `actions` object keyed by action name. Each action can contain structured `required`, `deprecated`, `replacedBy`, and `summary` fields.

`src/main/catalogLoader.ts` still uses the SDK as the source of product and method discovery. For each action it first builds the current SDK-inferred action metadata, then applies the matching snapshot action when `catalog-meta/<product>.json` exists. Snapshot fields are additive: a present `required`, `deprecated`, `replacedBy`, or `summary` field overrides only that field, while SDK-inferred fields not present in the snapshot are preserved.

If `catalog-meta/` does not exist, a product snapshot file is missing, a snapshot cannot be parsed, or an action is absent from the snapshot, the loader falls back to the existing SDK parsing path. This keeps the catalog refresh behavior identical for products without snapshots, including the tightened `extractRequiredPropertyNames` required-parameter heuristic.
