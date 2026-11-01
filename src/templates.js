// Prompt templates the user made (⚡ Template in the composer): stored with the office state (state.json),
// so the laptop and a paired phone see the same list. The built-in ones live in the web app only.
import { randomBytes } from 'node:crypto';

export const TEMPLATE_LIMITS = Object.freeze({ name: 60, text: 8000, count: 50 });

/** A template the server refuses; the message is shown to the user as is. */
export class TemplateError extends Error {}

// Control characters (except tab/newline in the body) never belong in a template.
const NAME_JUNK = /[\u0000-\u001f\u007f]/g;
const TEXT_JUNK = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ID = /^t_[a-z0-9]{6,32}$/;

/** Validates and normalises { name, text }; throws TemplateError with a user-facing reason. */
export function cleanTemplate(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const name = String(raw.name ?? '').replace(NAME_JUNK, ' ').replace(/\s+/g, ' ').trim();
  const text = String(raw.text ?? '').replace(/\r\n?/g, '\n').replace(TEXT_JUNK, '').trim();
  if (!name) throw new TemplateError('Nama template wajib diisi.');
  if (name.length > TEMPLATE_LIMITS.name) throw new TemplateError(`Nama template maksimal ${TEMPLATE_LIMITS.name} karakter.`);
  if (!text) throw new TemplateError('Isi template wajib diisi.');
  if (text.length > TEMPLATE_LIMITS.text) throw new TemplateError(`Isi template maksimal ${TEMPLATE_LIMITS.text} karakter.`);
  return { name, text };
}

/** The user's templates on top of hub.persisted.templates; every change is written right away. */
export class TemplateStore {
  constructor(hub) {
    this.hub = hub;
  }

  /** Stored entries that still look right (a hand-edited or old state.json never breaks the list). */
  list() {
    const stored = Array.isArray(this.hub.persisted.templates) ? this.hub.persisted.templates : [];
    return stored.filter((t) => t && ID.test(String(t.id)) && typeof t.name === 'string' && typeof t.text === 'string').slice(0, TEMPLATE_LIMITS.count);
  }

  /** Adds (no id) or updates (known id) a template; returns it. */
  save(input) {
    const { name, text } = cleanTemplate(input);
    const list = this.list();
    const id = input?.id == null || input.id === '' ? null : String(input.id);
    const now = Date.now();
    let template;
    if (list.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new TemplateError(`Sudah ada template bernama "${name}".`);
    if (id) {
      const i = list.findIndex((t) => t.id === id);
      if (i < 0) throw new TemplateError('Template tidak ditemukan (mungkin sudah dihapus).');
      template = { ...list[i], name, text, updatedAt: now };
      list[i] = template;
    } else {
      if (list.length >= TEMPLATE_LIMITS.count) throw new TemplateError(`Maksimal ${TEMPLATE_LIMITS.count} template. Hapus yang tidak dipakai dulu.`);
      template = { id: `t_${randomBytes(6).toString('hex')}`, name, text, createdAt: now, updatedAt: now };
      list.push(template);
    }
    this.write(list);
    return template;
  }

  /** Removes a template; an unknown id is an error (the list on screen is stale). */
  remove(id) {
    const list = this.list();
    const next = list.filter((t) => t.id !== String(id ?? ''));
    if (next.length === list.length) throw new TemplateError('Template tidak ditemukan (mungkin sudah dihapus).');
    this.write(next);
  }

  write(list) {
    this.hub.persisted.templates = list;
    this.hub.save(); // small and rare: written at once, not on the debounced timer
  }
}
