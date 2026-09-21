// S3 image resize on Lambda Function URL
//
// Reads photos/* from an original bucket, resizes with Sharp, caches to a
// second bucket keyed by resize parameters.
//
// Defensive layers:
//   - validateKey: charset whitelist + traversal blocks + allowed-prefix + length
//   - HeadObject pre-check: source size (413) and content-type (415)
//   - Awaited cache writes (never fire-and-forget)
//   - Sharp: limitInputPixels, failOn:'warning', withoutEnlargement
import sharp from 'sharp';
import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { validateKey } from './validateKey.mjs';

const s3 = new S3Client({});
const ORIGINAL_BUCKET = process.env.ORIGINAL_BUCKET;
const CACHE_BUCKET    = process.env.CACHE_BUCKET;

const MAX_WIDTH  = 4096;
const MAX_HEIGHT = 4096;
const MAX_RATIO  = 10;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;   // 20 MB
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff']);
const ALLOWED_SOURCE_MIME = /^image\/(jpeg|png|webp|avif|gif|tiff)$/;

export const handler = async (event) => {
  try {
    const qs = new URLSearchParams(event.rawQueryString || '');
    const key = qs.get('key');
    if (!key) return errorResponse(400, 'Missing image key');

    // FIX #1: 4-layer key validation
    if (!validateKey(key)) return errorResponse(400, 'Invalid image key');

    // Accept-header format negotiation
    const acceptHeader = (event.headers || {})['accept'] || '';
    let format = qs.get('format');
    if (!format) {
      if (acceptHeader.includes('image/avif')) format = 'avif';
      else if (acceptHeader.includes('image/webp')) format = 'webp';
      else format = 'jpeg';
    }

    // Parameter validation
    const width  = parseInt(qs.get('width'))  || null;
    const height = parseInt(qs.get('height')) || null;
    const quality = Math.min(Math.max(parseInt(qs.get('quality')) || 80, 1), 100);

    if (width  && (width  < 1 || width  > MAX_WIDTH))
      return errorResponse(400, 'Invalid width: must be 1-4096');
    if (height && (height < 1 || height > MAX_HEIGHT))
      return errorResponse(400, 'Invalid height: must be 1-4096');
    if (width && height &&
        (width / height > MAX_RATIO || height / width > MAX_RATIO))
      return errorResponse(400, 'Extreme aspect ratio rejected (max 10:1)');
    if (!ALLOWED_FORMATS.has(format)) format = 'jpeg';

    // Cache lookup
    const cacheKey =
      `${key}/${width||'auto'}x${height||'auto'}_q${quality}.${format}`;
    try {
      const cached = await s3.send(
        new GetObjectCommand({ Bucket: CACHE_BUCKET, Key: cacheKey })
      );
      const buf = Buffer.from(await cached.Body.transformToByteArray());
      return imageResponse(format, buf, 'HIT');
    } catch (e) { /* cache miss, continue */ }

    // FIX #3: HeadObject size + content-type check BEFORE fetching source
    let head;
    try {
      head = await s3.send(new HeadObjectCommand({
        Bucket: ORIGINAL_BUCKET, Key: key
      }));
    } catch (e) {
      const status = e.$metadata?.httpStatusCode;
      if (status === 404 || status === 403 || e.name === 'NotFound') {
        return errorResponse(404, 'Image not found');
      }
      throw e;
    }
    if (head.ContentLength > MAX_SOURCE_BYTES) {
      return errorResponse(413, 'Source image too large');
    }
    if (head.ContentType && !ALLOWED_SOURCE_MIME.test(head.ContentType)) {
      return errorResponse(415, 'Source is not a supported image');
    }

    // Fetch source
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket: ORIGINAL_BUCKET, Key: key })
    );
    const inputBuffer = Buffer.from(await Body.transformToByteArray());

    // Sharp processing
    let pipeline = sharp(inputBuffer, {
      limitInputPixels: 268402689,
      animated: false,
      failOn: 'warning',
    }).resize(width, height, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    pipeline = pipeline.toFormat(format, { quality });
    const outputBuffer = await pipeline.toBuffer();

    // FIX #2: AWAIT the cache write — don't lose it to Lambda freeze
    // Wrap in try/catch — cache write failure shouldn't fail the request
    try {
      await s3.send(new PutObjectCommand({
        Bucket: CACHE_BUCKET,
        Key: cacheKey,
        Body: outputBuffer,
        ContentType: `image/${format}`,
        CacheControl: 'public, max-age=31536000',
      }));
    } catch (err) {
      console.error('Cache write failed (non-fatal):', err);
    }

    return imageResponse(format, outputBuffer, 'MISS');
  } catch (err) {
    console.error('Image processing error:', err);
    return errorResponse(500, 'Internal processing error');
  }
};

function imageResponse(format, buffer, cacheStatus) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': `image/${format}`,
      'Cache-Control': 'public, max-age=31536000',
      'X-Cache': cacheStatus,
    },
    body: buffer.toString('base64'),
    isBase64Encoded: true,
  };
}

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}
