import OpenApiUtil from '@alicloud/openapi-util';
import { RuntimeOptions } from '@alicloud/tea-util';
import { describe, expect, it, vi } from 'vitest';
import {
  buildWebsiteConfiguration,
  isOssEmptyXmlSuccessDecodeError,
  putBucketWebsiteWithRootXml,
  type OssWebsiteClient
} from './ossWebsite';

describe('oss website provider', () => {
  it('builds default website configuration when only bucket is provided', () => {
    const config = buildWebsiteConfiguration({ bucket: 'demo-bucket' });

    expect(OpenApiUtil.parseToMap(config)).toEqual({
      ErrorDocument: { Key: 'error.html' },
      IndexDocument: { Suffix: 'index.html' }
    });
  });

  it('sends OSS website XML with bucket host map and WebsiteConfiguration root', async () => {
    const execute = vi.fn().mockResolvedValue({ statusCode: 200, headers: { 'x-oss-request-id': 'put-1' } });
    const client = {
      execute,
      getBucketWebsiteWithOptions: vi.fn()
    } satisfies OssWebsiteClient;

    const result = await putBucketWebsiteWithRootXml(
      client,
      'demo-bucket',
      buildWebsiteConfiguration({
        WebsiteConfiguration: {
          IndexDocument: { Suffix: 'home.html' },
          ErrorDocument: { Key: 'oops.html' }
        }
      }),
      new RuntimeOptions({})
    );

    expect(result).toEqual({ statusCode: 200, headers: { 'x-oss-request-id': 'put-1' } });
    expect(execute).toHaveBeenCalledTimes(1);
    const [, request] = execute.mock.calls[0];
    expect((request as { hostMap?: unknown }).hostMap).toEqual({ bucket: 'demo-bucket' });
    expect(OpenApiUtil.parseToMap((request as { body?: unknown }).body)).toEqual({
      WebsiteConfiguration: {
        ErrorDocument: { Key: 'oops.html' },
        IndexDocument: { Suffix: 'home.html' }
      }
    });
  });

  it('treats the SDK empty XML decode error as success only after read-back verification', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('not a valid value for parameter'));
    const getBucketWebsiteWithOptions = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: { IndexDocument: { Suffix: 'index.html' } }
    });
    const client = { execute, getBucketWebsiteWithOptions } satisfies OssWebsiteClient;

    const result = await putBucketWebsiteWithRootXml(client, 'demo-bucket', buildWebsiteConfiguration({}), new RuntimeOptions({}));

    expect(getBucketWebsiteWithOptions).toHaveBeenCalledWith('demo-bucket', {}, expect.any(RuntimeOptions));
    expect(result).toEqual({
      statusCode: 200,
      body: { IndexDocument: { Suffix: 'index.html' } },
      verifiedBy: 'GetBucketWebsite'
    });
  });

  it('rethrows the SDK decode error when read-back verification fails', async () => {
    const original = new Error('not a valid value for parameter');
    const client = {
      execute: vi.fn().mockRejectedValue(original),
      getBucketWebsiteWithOptions: vi.fn().mockRejectedValue(new Error('NoSuchWebsiteConfiguration'))
    } satisfies OssWebsiteClient;

    await expect(putBucketWebsiteWithRootXml(client, 'demo-bucket', buildWebsiteConfiguration({}), new RuntimeOptions({}))).rejects.toBe(
      original
    );
  });

  it('recognizes the OSS gateway empty XML success decode error', () => {
    expect(isOssEmptyXmlSuccessDecodeError(new Error('not a valid value for parameter'))).toBe(true);
    expect(isOssEmptyXmlSuccessDecodeError(new Error('NoSuchBucket'))).toBe(false);
  });
});
