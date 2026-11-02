// 📎 Prompt attachments, server side: every file the browser sends is checked again here (kind, magic bytes /
// UTF-8, size, count, totals, name) with the same rules the browser uses (public/js/core/attachment-rules.js),
// then turned into the content blocks Claude Code's stream-json input takes.
import { ATTACH_LIMITS, attachmentTextBlock, checkAttachmentSet, inspectAttachment } from '../public/js/core/attachment-rules.js';

export class AttachmentError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const LEGACY_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * Reads `body.attachments` ([{ name, mediaType, data(base64) }]) and the older `body.images`
 * ([{ mediaType, data }]). Throws AttachmentError (400) with an Indonesian message on the first problem.
 * @returns {{ kind, name, size, mediaType, data?, text? }[]} data (base64) for image/pdf, text for text
 */
export function readAttachments(body) {
  const listed = Array.isArray(body?.attachments) ? body.attachments : [];
  const images = Array.isArray(body?.images) ? body.images : [];
  // Count first, before anything is copied or decoded.
  if (listed.length + images.length > ATTACH_LIMITS.maxFiles) throw new AttachmentError(`Maksimal ${ATTACH_LIMITS.maxFiles} lampiran per pesan.`);
  const legacy = images.map((img, i) => ({
    name: `gambar-${i + 1}.${LEGACY_EXT[img?.mediaType] ?? 'png'}`,
    mediaType: img?.mediaType,
    data: img?.data,
  }));
  const raw = [...listed, ...legacy];
  // Total size from the base64 lengths, before any Buffer is allocated.
  const declared = raw.reduce((sum, a) => sum + (typeof a?.data === 'string' ? Math.floor((a.data.length * 3) / 4) : 0), 0);
  if (declared > ATTACH_LIMITS.totalBytes + 2 * raw.length) throw new AttachmentError(checkAttachmentSet([{ kind: 'pdf', size: declared }]));
  const items = raw.map((a) => {
    const data = typeof a?.data === 'string' ? a.data : '';
    // Buffer.from() silently skips characters that are not base64: insist on the canonical form instead.
    if (!data || data.length % 4 !== 0 || !BASE64.test(data)) throw new AttachmentError('Data lampiran rusak (bukan base64).');
    const bytes = Buffer.from(data, 'base64');
    const checked = inspectAttachment({ name: String(a?.name ?? ''), mediaType: String(a?.mediaType ?? ''), bytes });
    if (!checked.ok) throw new AttachmentError(checked.error);
    return checked.item.kind === 'text' ? checked.item : { ...checked.item, data };
  });
  const setError = checkAttachmentSet(items);
  if (setError) throw new AttachmentError(setError);
  return items;
}

/** Content blocks for the user message: attachments first (the API's advice for documents), then the prompt. */
export function contentBlocks(items, text) {
  const blocks = items.map((a) => {
    if (a.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } };
    if (a.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name };
    return { type: 'text', text: attachmentTextBlock(a) };
  });
  return [...blocks, { type: 'text', text }];
}

/** What the chat bubble keeps: name, size and kind — never the content. */
export const attachmentChips = (items) => items.map(({ kind, name, size }) => ({ kind, name, size }));
