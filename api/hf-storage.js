'use strict';
// Experimental Hugging Face Storage Buckets adapter. Not yet concurrency-safe.
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const namespace = process.env.HF_NAMESPACE;
const bucket = process.env.HF_BUCKET;
const accessKeyId = process.env.HF_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.HF_S3_SECRET_ACCESS_KEY;
function config() {
  if (![namespace,bucket,accessKeyId,secretAccessKey].every(Boolean)) throw new Error('Missing Hugging Face Storage configuration');
}
let client;
function s3() {
  config();
  return client ||= new S3Client({
    endpoint: 'https://s3.hf.co/' + namespace, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED'
  });
}
const objectKey = key => 'monopoly/' + encodeURIComponent(key) + '.json';
async function get(key) {
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
    const record = JSON.parse(await r.Body.transformToString());
    return record.expiresAt && Date.now() > record.expiresAt ? null : record.value;
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}
async function set(key, value, ttlSeconds) {
  const record = { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null };
  await s3().send(new PutObjectCommand({ Bucket: bucket, Key: objectKey(key),
    Body: JSON.stringify(record), ContentType: 'application/json' }));
}
async function del(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey(key) }));
}
module.exports = { get, set, del };
