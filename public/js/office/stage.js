// Renders the active Scene: low-res pixel canvas scaled up, plus an HTML overlay for crisp text.
import { roleColor } from './cast.js';
import { BOARD, SIGNS, W, buildFurniture, drawDoor, drawLighting, drawThemeOverlay, drawWallLive, renderBackground, room } from './world.js';

const STATUS_MARK = { completed: '✔', in_progress: '▶', pending: '○' };

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
    this.scale = 2;
    this.tags = new Map();
    this.boardEl = this.el('div', 'board');
    this.emptyEl = this.el('div', 'stage-empty');
    // Pod names and door nameplates: crisp HTML text, placed in resize().
    this.signs = SIGNS.map((sign) => {
      const node = this.el('div', sign.plate ? 'sign plate' : 'sign');
      node.textContent = sign.text;
      return { sign, node };
    });
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
    this.refreshTheme();
    this.resize();
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
    for (const tag of this.tags.values()) tag.bubbleSize = null; // bubbles scale with --s: measure again
  }

  frame(t) {
    const scene = this.scene;
    const g = this.wg;
    const now = performance.now();
    g.drawImage(this.background, 0, 0);
    const light = drawWallLive(g, t, new Date(), scene ? scene.activity(now) : { busy: false, bars: [] });
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
    drawThemeOverlay(g, t);
    drawLighting(g, light, scene.monitorGlows(now), t);
    scene.drawEffects(g, now);
    this.blit();
    this.updateOverlay(now);
  }

  blit() {
    this.vg.imageSmoothingEnabled = false;
    this.vg.drawImage(this.world, 0, 0, this.view.width, this.view.height);
  }

  // ---------- HTML overlay ----------

  tagFor(actor) {
    let tag = this.tags.get(actor);
    if (!tag) {
      const root = document.createElement('div');
      root.className = 'actor';
      root.innerHTML = '<div class="bubble"></div><div class="name"></div>';
      this.overlay.append(root);
      tag = { root, bubble: root.firstChild, name: root.lastChild, bubbleKey: null };
      tag.name.style.setProperty('--c', actor.cfg.color ?? roleColor(actor.id));
      this.tags.set(actor, tag);
    }
    // Names can be renamed at runtime (team dialog); ×N = parallel subagents of this role.
    const label = actor.agentCount > 1 ? `${actor.cfg.name} ×${actor.agentCount}` : actor.cfg.name;
    if (tag.nameText !== label) tag.name.textContent = tag.nameText = label;
    return tag;
  }

  updateOverlay(now) {
    const s = this.scale;
    const actors = new Set(this.scene.actors());
    for (const [actor, tag] of this.tags) {
      if (!actors.has(actor)) {
        tag.root.remove();
        this.tags.delete(actor);
      }
    }
    for (const actor of actors) {
      const tag = this.tagFor(actor);
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
