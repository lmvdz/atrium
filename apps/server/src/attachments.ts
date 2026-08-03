import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { MAX_ATTACHMENT_BYTES } from './room-events.js';

export { MAX_ATTACHMENT_BYTES };
export const ATTACHMENT_URL_TTL_SECONDS = 15 * 60;

export const UploadRequest = z.object({
  roomId: z.uuid(),
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

export const DownloadRequest = z.object({
  roomId: z.uuid(),
  key: z.string().min(1),
  name: z.string().trim().min(1).max(255),
});
export type DownloadRequest = z.infer<typeof DownloadRequest>;

export interface AttachmentSigner {
  upload(request: UploadRequest): Promise<{
    url: string;
    key: string;
    headers: Readonly<Record<string, string>>;
    expiresIn: number;
  }>;
  download(request: DownloadRequest): Promise<{ url: string; expiresIn: number }>;
}

export interface AttachmentSignerOptions {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Presign direct object-store transfers. This module never receives a body of
 * file bytes: the HTTP boundary authorizes the room and returns one short-lived
 * capability, then the browser talks to S3/MinIO itself.
 */
export function createAttachmentSigner(options: AttachmentSignerOptions): AttachmentSigner {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });

  return {
    upload: async (request) => {
      const input = UploadRequest.parse(request);
      const key = `${input.roomId}/${randomUUID()}`;
      const command = new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        ContentType: input.contentType,
        ContentLength: input.size,
      });
      const url = await getSignedUrl(client, command, {
        expiresIn: ATTACHMENT_URL_TTL_SECONDS,
        signableHeaders: new Set(['content-length', 'content-type']),
      });
      return {
        url,
        key,
        headers: {
          'content-type': input.contentType,
        },
        expiresIn: ATTACHMENT_URL_TTL_SECONDS,
      };
    },
    download: async (request) => {
      const input = DownloadRequest.parse(request);
      if (!input.key.startsWith(`${input.roomId}/`)) {
        throw new Error('attachment key belongs to another room');
      }
      const encodedName = encodeURIComponent(input.name).replaceAll("'", '%27');
      const command = new GetObjectCommand({
        Bucket: options.bucket,
        Key: input.key,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodedName}`,
      });
      return {
        url: await getSignedUrl(client, command, { expiresIn: ATTACHMENT_URL_TTL_SECONDS }),
        expiresIn: ATTACHMENT_URL_TTL_SECONDS,
      };
    },
  };
}
