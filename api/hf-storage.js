'use strict';
// HF Storage Buckets adapter with optimistic concurrency control.
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const namespace = process.env.HF_NAMESPACE;
const bucket = process.env.HF_BUCKET;
const accessKeyId = process.env.HF_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.HF_S3_SECRET_ACCESS_KEY;
let client;
function s3() {
  if (![namespace, bucket, accessKeyId, secretAccessKey].every(Boolean))
    throw new Error('Missing HF Storage Buckets configuration');
  return client ||= new S3Client({
    endpoint: 'https://s3.hf.co/' + encodeURIComponent(namespace),
    region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 2
  });
}
const keyOf = key => 'monopoly/' + encodeURIComponent(key) + '.json';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const seen = () => context.getStore();
function runWithContext(fn) { return context.run(new Map(), fn); }
function conflict(e) {
  return e.$metadata?.httpStatusCode === 412 || e.$metadata?.httpStatusCode === 409 ||
    e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict';
}
async function get(key) {
  try {
    const result = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: keyOf(key) }));
    const record = JSON.parse(await result.Body.transformToString());
    seen()?.set(key, result.ETag);
    return record.expiresAt && Date.now() >= record.expiresAt ? null : record.value;
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      seen()?.set(key, null);
      return null;
    }
    throw e;
  }
}
async function set(key, value, ttlSeconds) {
  // The calling request MUST have loaded the key first, or explicitly create it.
  // Conditional writes ensure concurrent requests never silently overwrite data.
  const etag = seen()?.has(key) ? seen()?.get(key) : undefined;
  const params = {
    Bucket: bucket, Key: keyOf(key),
    Body: JSON.stringify({ value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null }),
    ContentType: 'application/json'
  };
  if (etag === null) params.IfNoneMatch = '*';
  else if (etag) params.IfMatch = etag;
  else throw Object.assign(new Error('Write without prior read'), { code: 'HF_READ_REQUIRED' });
  try {
    await s3().send(new PutObjectCommand(params));
    // Avoid reusing stale ETags: a subsequent write must reload the object.
    seen()?.delete(key);
  } catch (e) {
    if (conflict(e)) throw Object.assign(new Error('Concurrent storage update; retry action'), { code: 'HF_CONFLICT' });
    throw e;
  }
}
async function del(key) {
  // Deleting without CAS is unsafe. Expire the record instead.
  await set(key, null, 1);
}
module.exports = { get, set, del, runWithContext };
