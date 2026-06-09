import OpenApiUtil from '@alicloud/openapi-util';
import { RuntimeOptions } from '@alicloud/tea-util';
import { describe, expect, it, vi } from 'vitest';
import {
  invokePublicAccessBlockAction,
  isPublicAccessBlockAction,
  type OssPublicAccessBlockClient
} from './ossPublicAccessBlock';

describe('oss public access block provider', () => {
  it('builds bucket-level get requests with bucket host map', async () => {
    const execute = vi.fn().mockResolvedValue({ statusCode: 200, body: { BlockPublicAccess: 'true' } });
    const client = { execute } satisfies OssPublicAccessBlockClient;

    await invokePublicAccessBlockAction(
      client,
      'GetBucketPublicAccessBlock',
      { bucket: 'admin-fat-tigerzn' },
      new RuntimeOptions({})
    );

    const [params, request] = execute.mock.calls[0];
    expect((params as { method?: string; pathname?: string }).method).toBe('GET');
    expect((params as { pathname?: string }).pathname).toBe('/?publicAccessBlock');
    expect((request as { hostMap?: unknown }).hostMap).toEqual({ bucket: 'admin-fat-tigerzn' });
  });

  it('builds account-level put requests with BlockPublicAccess XML root', async () => {
    const execute = vi.fn().mockResolvedValue({ statusCode: 200 });
    const client = { execute } satisfies OssPublicAccessBlockClient;

    await invokePublicAccessBlockAction(client, 'PutPublicAccessBlock', { BlockPublicAccess: false }, new RuntimeOptions({}));

    const [params, request] = execute.mock.calls[0];
    expect((params as { method?: string }).method).toBe('PUT');
    expect((request as { hostMap?: unknown }).hostMap).toBeUndefined();
    expect(OpenApiUtil.parseToMap((request as { body?: unknown }).body)).toEqual({
      PublicAccessBlockConfiguration: {
        BlockPublicAccess: false
      }
    });
  });

  it('throws a gateway-shaped error when bucket-level actions omit bucket', async () => {
    const client = { execute: vi.fn() } satisfies OssPublicAccessBlockClient;

    await expect(invokePublicAccessBlockAction(client, 'GetBucketPublicAccessBlock', {}, new RuntimeOptions({}))).rejects.toMatchObject({
      code: 'MISSING_OSS_BUCKET'
    });
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('detects supported public access block actions', () => {
    expect(isPublicAccessBlockAction('GetBucketPublicAccessBlock')).toBe(true);
    expect(isPublicAccessBlockAction('GetBucketAcl')).toBe(false);
  });
});
