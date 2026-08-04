export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface UploadedAttachment {
  id: string;
  key: string;
  name: string;
  contentType: string;
  size: number;
  capability: string;
}

/** Upload bytes directly to the signed object-store URL; Atrium sees metadata only. */
export async function uploadAttachment(roomId: string, file: File): Promise<UploadedAttachment> {
  if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('attachments must be between 1 byte and 25 MB');
  }
  const contentType = file.type || 'application/octet-stream';
  const response = await fetch('/attachments/presign-upload', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, name: file.name, contentType, size: file.size }),
  });
  if (!response.ok) throw new Error('the attachment upload was refused');
  const signed = (await response.json()) as {
    id: string;
    url: string;
    key: string;
    headers: Record<string, string>;
    capability: string;
  };
  const uploaded = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: file });
  if (!uploaded.ok) throw new Error(`the object store refused the upload (${uploaded.status})`);
  return {
    id: signed.id,
    key: signed.key,
    name: file.name,
    contentType,
    size: file.size,
    capability: signed.capability,
  };
}

export async function attachmentDownloadUrl(
  roomId: string,
  attachment: Pick<UploadedAttachment, 'key' | 'name'>,
): Promise<string> {
  const response = await fetch('/attachments/presign-download', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, key: attachment.key, name: attachment.name }),
  });
  if (!response.ok) throw new Error('the attachment download was refused');
  const body = (await response.json()) as { url: string };
  return body.url;
}

/** A download is a distinct user act from preview and always gets a fresh grant. */
export async function downloadAttachment(
  roomId: string,
  attachment: Pick<UploadedAttachment, 'key' | 'name'>,
): Promise<void> {
  const url = await attachmentDownloadUrl(roomId, attachment);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = attachment.name;
  anchor.rel = 'noopener';
  anchor.click();
}
