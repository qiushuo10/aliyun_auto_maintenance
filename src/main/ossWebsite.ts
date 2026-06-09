import { OpenApiRequest, Params as OpenApiParams } from '@alicloud/openapi-client';
import OpenApiUtil from '@alicloud/openapi-util';
import {
  ErrorDocument,
  IndexDocument,
  PutBucketWebsiteRequest,
  WebsiteConfiguration
} from '@alicloud/oss20190517';
import { RuntimeOptions } from '@alicloud/tea-util';

export interface OssWebsiteClient {
  execute(params: OpenApiParams, request: OpenApiRequest, runtime: RuntimeOptions): Promise<unknown>;
  getBucketWebsiteWithOptions(bucket: string, headers: Record<string, string>, runtime: RuntimeOptions): Promise<unknown>;
}

export async function putBucketWebsiteWithRootXml(
  client: OssWebsiteClient,
  bucket: string,
  websiteConfiguration: WebsiteConfiguration,
  runtime: RuntimeOptions
): Promise<unknown> {
  const request = new PutBucketWebsiteRequest({ websiteConfiguration });
  const params = new OpenApiParams({
    action: 'PutBucketWebsite',
    version: '2019-05-17',
    protocol: 'HTTPS',
    pathname: '/?website',
    method: 'PUT',
    authType: 'AK',
    style: 'ROA',
    reqBodyType: 'xml',
    bodyType: 'xml'
  });
  const openApiRequest = new OpenApiRequest({
    headers: {},
    body: OpenApiUtil.parseToMap(request)
  } as Record<string, unknown>);
  (openApiRequest as OpenApiRequest & { hostMap: { bucket: string } }).hostMap = { bucket };

  try {
    return await client.execute(params, openApiRequest, runtime);
  } catch (error) {
    if (!isOssEmptyXmlSuccessDecodeError(error)) throw error;
    try {
      const verification = await client.getBucketWebsiteWithOptions(bucket, {}, runtime);
      return normalizeVerifiedPutBucketWebsiteResponse(verification);
    } catch {
      throw error;
    }
  }
}

export function buildWebsiteConfiguration(params: Record<string, unknown>): WebsiteConfiguration {
  const config = recordParam(params, ['WebsiteConfiguration', 'websiteConfiguration']) ?? {};
  const indexConfig = recordParam(config, ['IndexDocument', 'indexDocument']) ?? {};
  const errorConfig = recordParam(config, ['ErrorDocument', 'errorDocument']) ?? {};
  const indexSuffix =
    stringParam(indexConfig, ['Suffix', 'suffix']) ??
    stringParam(params, ['IndexDocumentSuffix', 'indexDocumentSuffix', 'IndexSuffix', 'indexSuffix']) ??
    'index.html';
  const errorKey =
    stringParam(errorConfig, ['Key', 'key']) ??
    stringParam(params, ['ErrorDocumentKey', 'errorDocumentKey', 'ErrorKey', 'errorKey']) ??
    'error.html';
  const errorHttpStatus = stringParam(errorConfig, ['HttpStatus', 'httpStatus']);
  return new WebsiteConfiguration({
    indexDocument: new IndexDocument({
      suffix: indexSuffix,
      supportSubDir: booleanParam(indexConfig, ['SupportSubDir', 'supportSubDir']),
      type: stringParam(indexConfig, ['Type', 'type'])
    }),
    errorDocument: new ErrorDocument({
      key: errorKey,
      httpStatus: errorHttpStatus
    })
  });
}

export function isOssEmptyXmlSuccessDecodeError(error: unknown): boolean {
  return error instanceof Error && error.message === 'not a valid value for parameter';
}

function normalizeVerifiedPutBucketWebsiteResponse(verification: unknown): Record<string, unknown> {
  if (!verification || typeof verification !== 'object') {
    return { statusCode: 200, body: null };
  }
  const record = verification as Record<string, unknown>;
  return {
    ...record,
    statusCode: typeof record.statusCode === 'number' ? record.statusCode : 200,
    verifiedBy: 'GetBucketWebsite'
  };
}

function stringParam(params: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = paramValue(params, name);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
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

function paramValue(params: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  const match = Object.keys(params).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? params[match] : undefined;
}
