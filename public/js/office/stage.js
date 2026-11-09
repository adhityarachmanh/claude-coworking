// Renders the active Scene: low-res pixel canvas scaled up, plus an HTML overlay for crisp text.
import { activeModelOf, drawModelLogo, logoIndex } from '../core/model-logo.js';
import { roleColor } from './cast.js';
import { RADIO, drawRadioLive, grooving, radio } from './radio.js';
import { fitLabels, labelVariants, sharedPrefix } from './tags.js';
import { BOARD, DESKS, SIGNS, W, buildFurniture, drawDoor, drawLighting, drawThemeOverlay, drawWallLive, renderBackground, room } from './world.js';

const STATUS_MARK = { completed: '✔', in_progress: '▶', pending: '○' };

// The Lead's corner office has free wall between the Claude poster (x 514-536) and its window (x 584): a small framed
// plaque with the active model's logo. Like the poster next to it, it hangs across the wainscot's top edge at y 26.
const PLAQUE = { x: 548, y: 8, w: 34, h: 28 };

export class Stage {
  constructor(host) {
    this.host = host;
    this.world = document.createElement('canvas');
    this.world.width = W;
    this.world.height = room.h;
    this.wg = this.world.getContext('2d');
    this.view = host.querySelector('canvas');
    this.vg = this.view.getContext('2d');
    this.overlay = host.querySelector('.overlay');
    this.background = renderBackground();
    this.furniture = buildFurniture();
    this.scene = null;
    this.model = { model: '', label: '', file: null }; // the plaque's model, cached until the status changes
    this.modelKey = '';
    logoIndex(); // warm the logo names now, so the first frame already shows the real logo (not a monogram)
    this.scale = 2;
    this.tags = new Map();
    this.tagsDirty = true; // labels must be fitted again (resize, rename, team or ×N change)
    this.boardEl = this.el('div', 'board');
    this.emptyEl = this.el('div', 'stage-empty');
    // Pod names and room plates: crisp HTML text, placed in resize(). A private office's door plate only shows
    // while the room is empty (its role switched off): otherwise the person's own name tag says who works there.
    this.signs = SIGNS.map((sign) => {
      const node = this.el('div', sign.plate ? 'sign plate' : 'sign');
      node.textContent = sign.text;
      if (sign.vacant) node.title = `Ruang ${sign.text} kosong`;
      return { sign, node };
    });
    this.showVacantPlates();
    // Hidden copy of a name tag, to measure label variants with the live font size.
    // ♪ The lounge radio's button (features/spotify.js names it and handles the click): at least 32×32 CSS px even
    // on a phone-sized stage, over the 14×9 px sprite.
    this.radioBtn = this.el('button', 'office-radio');
    this.radioBtn.type = 'button';
    this.radioBtn.hidden = true;
    this.radioBtn.setAttribute('aria-haspopup', 'dialog');
    this.musicKey = '';
    this.measure = this.el('div', 'actor tag-measure');
    this.measure.setAttribute('aria-hidden', 'true');
    this.measure.innerHTML = '<div class="name"></div>';
    this.setRoomSize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  /** Theme switched: rebuild the cached background and the furniture list (sprites are cleared by the caller). */
  refreshTheme() {
    this.background = renderBackground();
    this.furniture = buildFurniture();
  }

  /** The team changed (👥 Kelola tim): desks fill or empty in place; the floor keeps its size. */
  refreshLayout() {
    this.setRoomSize();
    this.showVacantPlates();
    this.tagsDirty = true;
    this.refreshTheme();
    this.resize();
  }

  /** Door plates of the private offices: shown only while the room's role is off the team. */
  showVacantPlates() {
    for (const { sign, node } of this.signs) if (sign.vacant) node.hidden = Boolean(DESKS[sign.vacant]);
  }

  /** The phone layout sizes the stage from the floor's logical size (--room-w × --room-h). */
  setRoomSize() {
    this.world.height = room.h;
    this.host.style.setProperty('--room-w', String(W));
    this.host.style.setProperty('--room-h', String(room.h));
  }

  el(tag, cls) {
    const node = document.createElement(tag);
    node.className = cls;
    this.overlay.append(node);
    return node;
  }

  setScene(scene) {
    this.scene = scene;
    for (const tag of this.tags.values()) tag.root.remove();
    this.tags.clear();
    this.lastBoard = null;
    this.tagsDirty = true;
  }

  resize() {
    const { clientWidth: cw, clientHeight: ch } = this.host;
    if (!cw || !ch) return;
    const fit = Math.min(cw / W, ch / room.h);
    // Render at an integer multiple for crisp pixels, then let CSS do the (small) remaining scale.
    const k = Math.max(1, Math.round(fit));
    this.view.width = W * k;
    this.view.height = room.h * k;
    this.k = k;
    this.scale = fit;
    const width = Math.floor(W * fit);
    const height = Math.floor(room.h * fit);
    for (const node of [this.view, this.overlay]) {
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
    }
    this.view.style.imageRendering = fit >= k ? 'pixelated' : 'auto';
    this.overlay.style.setProperty('--s', fit.toFixed(3));
    this.lastBoard = null; // reposition the whiteboard overlay
    for (const { sign, node } of this.signs) Object.assign(node.style, { left: `${(sign.x * fit).toFixed(1)}px`, top: `${(sign.y * fit).toFixed(1)}px` });
    const box = Math.max(32, RADIO.w * fit);
    Object.assign(this.radioBtn.style, { width: `${box}px`, height: `${box}px`, left: `${((RADIO.x + RADIO.w / 2) * fit - box / 2).toFixed(1)}px`, top: `${((RADIO.y + RADIO.h / 2 - 2) * fit - box / 2).toFixed(1)}px` });
    for (const tag of this.tags.values()) tag.bubbleSize = null; // bubbles scale with --s: measure again
    this.tagsDirty = true; // so do the name tags
  }

  frame(t) {
    const scene = this.scene;
    const g = this.wg;
    const now = performance.now();
    g.drawImage(this.background, 0, 0);
    const light = drawWallLive(g, t, new Date(), scene ? scene.activity(now) : { busy: false, bars: [] });
    this.markMusic();
    this.drawModelPlaque(g, scene ? scene.status : null); // on the wall, before the furniture and the people
    if (!scene) {
      this.blit();
      return;
    }
    drawDoor(g, scene.doorOpen);
    // Either may be off the team (👥 Kelola tim).
    const ctx = { rackBusy: Boolean(scene.people.devops?.isBusy(now) || scene.people.backend?.isBusy(now)), coffeeBusy: now < scene.coffeeUntil };
    const drawables = [
      ...this.furniture.map((f) => ({ y: f.y, draw: (gg, tt) => f.draw(gg, tt, ctx) })),
      ...scene.drawables(now),
    ].sort((a, b) => a.y - b.y);
    for (const d of drawables) d.draw(g, t);
    drawRadioLive(g, now);
    drawThemeOverlay(g, t);
    drawLighting(g, light, scene.monitorGlows(now), t);
    scene.drawEffects(g, now);
    this.blit();
    this.updateOverlay(now);
  }

  /** ♪ Radio state on the stage element (data-music / data-groove): CSS hooks, and what the UI tests read. */
  markMusic() {
    const groove = grooving() ? 'on' : 'off';
    const key = `${radio.mode}|${groove}|${radio.button}`;
    if (key === this.musicKey) return;
    this.musicKey = key;
    this.host.dataset.music = radio.mode;
    this.host.dataset.groove = groove;
    this.radioBtn.hidden = !radio.button;
  }

  blit() {
    this.vg.imageSmoothingEnabled = false;
    this.vg.drawImage(this.world, 0, 0, this.view.width, this.view.height);
  }

  // ---------- the active model ----------

  /**
   * The active model of a project: its logo file and short label, cached until the status or the logo index changes.
   * Also mirrored on the stage element (data-model-logo / data-model-name): what the UI tests read without pixels.
   */
  modelFor(status) {
    const key = `${status?.activeModel ?? ''}|${status?.model ?? ''}|${status?.engine ?? ''}|${logoIndex().length}`;
    if (key !== this.modelKey) {
      this.modelKey = key;
      this.model = activeModelOf(status, status?.engine);
      this.host.dataset.modelLogo = this.model.file ?? '';
      this.host.dataset.modelName = this.model.label;
    }
    return this.model;
  }

  /**
   * The plaque on the Lead's wall: a dark frame, a cream panel, the active model's logo, and a dot that says whether
   * the Lead is busy (green) or idle (amber). Integer coordinates and hard edges keep it crisp at the pixel scale.
   */
  drawModelPlaque(g, status) {
    const model = this.modelFor(status);
    const { x, y, w, h } = PLAQUE;
    const busy = Boolean(status?.busy || status?.cliBusy);
    g.save();
    g.fillStyle = '#2b2320'; // frame
    g.fillRect(x, y, w, h);
    g.fillStyle = '#f3ead6'; // panel
    g.fillRect(x + 2, y + 2, w - 4, h - 4);
    g.fillStyle = '#cbbfa6'; // inner bevel
    g.fillRect(x + 2, y + h - 3, w - 4, 1);
    drawModelLogo(g, model.file, x + w / 2, y + h / 2 + 1, 18, {
      font: 'bold 8px ui-monospace, monospace',
      label: model.label,
    });
    g.fillStyle = busy ? '#3ddc84' : '#ffc24a';
    g.fillRect(x + w - 6, y + 4, 3, 3);
    g.restore();
  }

  // ---------- HTML overlay ----------

  tagFor(actor) {
    let tag = this.tags.get(actor);
    if (!tag) {
      const root = document.createElement('div');
      root.className = 'actor';
      root.innerHTML = '<div class="bubble"></div><div class="name"></div>';
      this.overlay.append(root);
      tag = { root, bubble: root.firstChild, name: root.lastChild, bubbleKey: null, key: null, label: null };
      tag.name.style.setProperty('--c', actor.cfg.color ?? roleColor(actor.id));
      this.tags.set(actor, tag);
      this.tagsDirty = true;
    }
    // Names can be renamed at runtime (team dialog); ×N = parallel subagents of this role.
    const key = `${actor.cfg.name}
${actor.agentCount}`;
    if (tag.key !== key) {
      tag.key = key;
      this.tagsDirty = true;
    }
    return tag;
  }

  /**
   * Chooses each name tag's label so no two overlap where the people sit: the full name while it fits, else the
   * name without the prefix the whole team shares ("Adhitron - "), else the role's short title. The full name stays
   * in the tag's tooltip and accessible name. Runs only when sizes, names or the team change.
   */
  fitTags(actors) {
    this.tagsDirty = false;
    const s = this.scale;
    const seated = actors.filter((a) => a.seat); // the visitor walks through: always its full label
    const prefix = sharedPrefix(seated.map((a) => a.cfg.name));
    const box = this.measure.firstChild;
    const items = [];
    for (const actor of actors) {
      const tag = this.tags.get(actor);
      const variants = labelVariants({ name: actor.cfg.name, short: actor.cfg.short, count: actor.agentCount }, actor.seat ? prefix : '');
      const widths = variants.map((text) => {
        box.textContent = text;
        return box.getBoundingClientRect().width;
      });
      const spot = actor.seat ?? actor;
      items.push({ tag, variants, x: spot.x * s, y: spot.y * s + box.offsetTop, h: box.offsetHeight, widths });
    }
    const levels = fitLabels(items, 2);
    items.forEach(({ tag, variants }, i) => {
      const label = variants[levels[i]];
      if (tag.label === label) return;
      tag.label = label;
      const full = variants[0];
      tag.name.title = full;
      if (label === full) tag.name.textContent = label;
      else {
        // Shortened: screen readers still get the full name.
        const shown = document.createElement('span');
        shown.setAttribute('aria-hidden', 'true');
        shown.textContent = label;
        const spoken = document.createElement('span');
        spoken.className = 'sr-only';
        spoken.textContent = full;
        tag.name.replaceChildren(shown, spoken);
      }
      tag.name.classList.toggle('short', label !== full);
      tag.bubbleSize = null; // the name's height may differ: measure the bubble's anchor again
    });
  }

  updateOverlay(now) {
    const s = this.scale;
    const actors = new Set(this.scene.actors());
    for (const [actor, tag] of this.tags) {
      if (!actors.has(actor)) {
        tag.root.remove();
        this.tags.delete(actor);
        this.tagsDirty = true;
      }
    }
    for (const actor of actors) this.tagFor(actor);
    if (this.tagsDirty) this.fitTags([...actors]);
    for (const actor of actors) {
      const tag = this.tags.get(actor);
      tag.root.style.transform = `translate(${(actor.x * s).toFixed(1)}px, ${(actor.y * s).toFixed(1)}px)`;
      tag.root.style.zIndex = String(Math.round(actor.y));
      tag.root.classList.toggle('busy', actor.isBusy(now));
      const bubble = actor.bubble;
      if (bubble?.key !== tag.bubbleKey) {
        tag.bubbleKey = bubble?.key ?? null;
        tag.bubble.textContent = bubble?.text ?? '';
        tag.bubble.className = `bubble ${bubble ? `show tone-${bubble.tone}` : ''}`;
        tag.bubbleSize = null; // new text: measure again
      }
      if (bubble) {
        this.placeBubble(actor, tag);
        tag.root.style.zIndex = '500';
      }
    }
    this.updateBoard();
  }

  /** Keeps a speech bubble inside the office: shifted sideways near the walls, flipped below near the top. */
  placeBubble(actor, tag) {
    const s = this.scale;
    const PAD = 4;
    // offsetWidth/Height ignore the pop-in scale transform; measured once per text (and after a resize).
    tag.bubbleSize ??= { w: tag.bubble.offsetWidth, h: tag.bubble.offsetHeight, nameBottom: tag.name.offsetTop + tag.name.offsetHeight };
    const { w, h, nameBottom } = tag.bubbleSize;
    const x = actor.x * s;
    const left = x - w / 2;
    const right = x + w / 2;
    const dx = left < PAD ? PAD - left : right > W * s - PAD ? W * s - PAD - right : 0;
    const above = (actor.y - actor.headTop()) * s + 6; // gap from the feet to the bubble's bottom edge
    const below = actor.y * s - above - h < PAD; // not enough room above the head
    tag.bubble.classList.toggle('below', below);
    tag.bubble.style.setProperty('--dx', `${dx.toFixed(1)}px`);
    if (below) {
      tag.bubble.style.bottom = '';
      tag.bubble.style.top = `${(nameBottom + 4).toFixed(1)}px`;
    } else {
      tag.bubble.style.top = '';
      tag.bubble.style.bottom = `${above.toFixed(1)}px`;
    }
  }

  updateBoard() {
    const { goal, items } = this.scene.board;
    const key = JSON.stringify([goal, items]);
    if (key === this.lastBoard) return;
    this.lastBoard = key;
    const s = this.scale;
    Object.assign(this.boardEl.style, { left: `${BOARD.x * s}px`, top: `${BOARD.y * s}px`, width: `${BOARD.w * s}px`, height: `${BOARD.h * s}px` });
    // Show the active part of the list: finished items scroll off first.
    const firstOpen = items.findIndex((i) => i.status !== 'completed');
    const start = Math.max(0, Math.min(firstOpen < 0 ? items.length : firstOpen - 1, items.length - 4));
    const rows = items.slice(start, start + 4).map((item) => {
      const mark = STATUS_MARK[item.status] ?? '○';
      return `<li class="st-${item.status}"><span>${mark}</span>${escapeHtml(item.content)}</li>`;
    });
    this.boardEl.innerHTML = `<b>SPRINT BOARD</b>${goal ? `<p>${escapeHtml(goal)}</p>` : ''}<ul>${rows.join('') || '<li class="muted">Belum ada task</li>'}</ul>`;
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
