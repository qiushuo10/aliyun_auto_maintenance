import { OpenApiRequest, Params as OpenApiParams } from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';

export interface OssPublicAccessBlockClient {
  execute(params: OpenApiParams, request: OpenApiRequest, runtime: RuntimeOptions): Promise<unknown>;
}

type PublicAccessBlockAction =
  | 'GetPublicAccessBlock'
  | 'PutPublicAccessBlock'
  | 'DeletePublicAccessBlock'
  | 'GetBucketPublicAccessBlock'
  | 'PutBucketPublicAccessBlock'
  | 'DeleteBucketPublicAccessBlock';

export function isPublicAccessBlockAction(action: string): action is PublicAccessBlockAction {
  return [
    'GetPublicAccessBlock',
    'PutPublicAccessBlock',
    'DeletePublicAccessBlock',
    'GetBucketPublicAccessBlock',
    'PutBucketPublicAccessBlock',
    'DeleteBucketPublicAccessBlock'
  ].includes(action);
}

export async function invokePublicAccessBlockAction(
  client: OssPublicAccessBlockClient,
  action: PublicAccessBlockAction,
  params: Record<string, unknown>,
  runtime: RuntimeOptions
): Promise<unknown> {
  const bucket = action.includes('Bucket') ? requireOssBucket(params) : null;
  const method = action.startsWith('Get') ? 'GET' : action.startsWith('Delete') ? 'DELETE' : 'PUT';
  const request = new OpenApiRequest({
    headers: {},
    body: method === 'PUT' ? buildPublicAccessBlockBody(params) : undefined
  } as Record<string, unknown>);
  if (bucket) {
    (request as OpenApiRequest & { hostMap: { bucket: string } }).hostMap = { bucket };
  }

  const openApiParams = new OpenApiParams({
    action,
    version: '2019-05-17',
    protocol: 'HTTPS',
    pathname: '/?publicAccessBlock',
    method,
    authType: 'AK',
    style: 'ROA',
    reqBodyType: 'xml',
    bodyType: 'xml'
  });

  try {
    return await client.execute(openApiParams, request, runtime);
  } catch (error) {
    if (!isOssEmptyXmlSuccessDecodeError(error) || method === 'GET') throw error;
    return { statusCode: 200, action, bucket };
  }
}

function buildPublicAccessBlockBody(params: Record<string, unknown>): Record<string, unknown> {
  return {
    PublicAccessBlockConfiguration: {
      BlockPublicAccess: requireBlockPublicAccess(params)
    }
  };
}

function requireBlockPublicAccess(params: Record<string, unknown>): boolean {
  const config = recordParam(params, ['PublicAccessBlockConfiguration', 'publicAccessBlockConfiguration']) ?? {};
  const value =
    paramValue(config, 'BlockPublicAccess') ??
    paramValue(config, 'blockPublicAccess') ??
    paramValue(params, 'BlockPublicAccess') ??
    paramValue(params, 'blockPublicAccess');
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw gatewayError(
    'MISSING_OSS_PUBLIC_ACCESS_BLOCK',
    'OSS PublicAccessBlock 操作缺少 BlockPublicAccess 参数，请传 true 或 false。'
  );
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

function paramValue(params: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  const match = Object.keys(params).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? params[match] : undefined;
}

function isOssEmptyXmlSuccessDecodeError(error: unknown): boolean {
  return error instanceof Error && error.message === 'not a valid value for parameter';
}

function gatewayError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
