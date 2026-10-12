// The one place the AMS talks to object storage (one import point per heavy library): any S3-compatible service,
// configured by environment (DEC-008). Garage in the Compose stack.
import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ObjectStore } from '../ctx.js';
import type { Env } from '@ams/shared';

export function s3Store(env: Pick<Env, 'S3_ENDPOINT' | 'S3_REGION' | 'S3_BUCKET' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_FORCE_PATH_STYLE'>): ObjectStore {
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    // Recent SDK versions add CRC checksums to every request by default; many S3-compatible services (Garage 1.0 among
    // them) reject those. Send and check them only where the S3 API requires it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async put(key, body, mime) {
      const sha256 = createHash('sha256').update(body).digest('hex');
      await client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: mime, ContentLength: body.byteLength }));
      return { size: body.byteLength, sha256 };
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
        if (!out.Body) return null;
        return { body: await out.Body.transformToByteArray(), mime: out.ContentType ?? 'application/octet-stream' };
      } catch (e) {
        if (e instanceof NoSuchKey) return null;
        throw e;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    },
  };
}
