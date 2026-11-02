// Name tags over the office people: which label each one shows so no two tags overlap (pure, no DOM).
//
// Three variants per person, longest first:
//   0  the full name                      "Adhit - Frontend"
//   1  without the prefix the team shares  "Frontend"      (whole team at once, so the tags stay consistent)
//   2  the role's short title             "FE"            (only the tags that still collide)

// Separators that end a shared prefix: "Adhit - X", "Adhit – X", "Tim: X", "Adhit | X", "Adhit · X".
const SEPARATOR = /\s[-–—|·]\s|:\s/g;

/**
 * The "<prefix> - " every name starts with ('' when there is none). Computed from the current names (people can
 * be renamed), cut back to the last separator, and only if every name keeps some text after it.
 */
export function sharedPrefix(names) {
  if (names.length < 2) return '';
  let common = names[0];
  for (const name of names) {
    let i = 0;
    while (i < common.length && i < name.length && common[i] === name[i]) i++;
    common = common.slice(0, i);
    if (!common) return '';
  }
  let end = 0;
  for (const m of common.matchAll(SEPARATOR)) end = m.index + m[0].length;
  if (!end) return '';
  const prefix = common.slice(0, end);
  return names.every((name) => name.slice(end).trim()) ? prefix : '';
}

/** Label variants for one person, longest first (×N = parallel subagents, kept on every variant). */
export function labelVariants({ name, short, count = 1 }, prefix) {
  const suffix = count > 1 ? ` ×${count}` : '';
  const stripped = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  // Always three slots (level = index), even when two of them are the same text.
  return [name, stripped, short || stripped].map((label) => label + suffix);
}

/**
 * Picks a variant level per tag so no two tags overlap. `items`: { x, y, h, widths: [w0, w1, w2] } in CSS px,
 * tag centred on x with its top at y. First the whole team drops the shared prefix if anything collides, then
 * the wider tag of each colliding pair falls back to its short title. Returns the level per item.
 */
export function fitLabels(items, gap = 2) {
  const level = items.map(() => 0);
  const box = (i) => {
    const { x, y, h, widths } = items[i];
    const w = widths[level[i]];
    return { l: x - w / 2, r: x + w / 2, t: y, b: y + h };
  };
  const collides = (i, j) => {
    const a = box(i);
    const b = box(j);
    return a.l < b.r + gap && b.l < a.r + gap && a.t < b.b && b.t < a.b;
  };
  /** First colliding pair in which at least one tag can still shrink (`any`: any colliding pair). */
  const collision = (any = false) => {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if ((any || level[i] < 2 || level[j] < 2) && collides(i, j)) return [i, j];
      }
    }
    return null;
  };
  if (!collision(true)) return level;
  level.fill(1);
  // Each step shortens one tag for good, so this ends after at most items.length steps.
  for (let pair = collision(); pair; pair = collision()) {
    const open = pair.filter((k) => level[k] < 2);
    const width = (k) => items[k].widths[level[k]];
    // Shorten the wider tag of the pair (or the only one that can still shrink).
    const target = open.length === 1 ? open[0] : width(pair[0]) >= width(pair[1]) ? pair[0] : pair[1];
    level[target] = 2;
  }
  return level;
}
