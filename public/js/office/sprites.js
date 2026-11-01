// Procedural pixel-art sprites (characters, cat, icons) with automatic dark outlines, cached per state.
// Characters and the cat follow the active office theme (themes.js); costumes are painted by costumes.js.
import { COSTUMES } from './costumes.js';
import { activeTheme, themedLook } from './themes.js';

export const SPRITE_W = 20;
export const SPRITE_H = 32;
export const ANCHOR_X = 10; // feet center
export const ANCHOR_Y = 31;
const TOP_PAD = 2; // headroom for buns, pompoms and spikes

const OUTLINE = '#2a1e2c';
const EYE = '#2a1e2c';
const WHITE = '#f4f1ea';
const cache = new Map();

/** Drops every cached sprite/avatar (after a theme switch the old ones are never drawn again). */
export function clearSpriteCache() {
  cache.clear();
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function painter(g) {
  return (x, y, w, h, color) => {
    if (!color || w <= 0 || h <= 0) return;
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  };
}

/** Adds a 1px outline around every opaque pixel (4-neighbourhood). */
function outline(c, color = OUTLINE) {
  const g = c.getContext('2d');
  const { width: w, height: h } = c;
  const data = g.getImageData(0, 0, w, h).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] > 128;
  g.fillStyle = color;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) g.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

function mirror(src) {
  const c = canvas(src.width, src.height);
  const g = c.getContext('2d');
  g.translate(src.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  return c;
}

// ---------- character ----------

/** Headscarf: frames the face, wraps under the chin and drapes over the shoulders. */
function paintHijab(p, c, shade, view, headY, torsoY) {
  if (view === 'side') {
    p(5, headY - 1, 9, 1, c);
    p(5, headY, 11, 3, c);
    p(9, headY + 3, 7, 8, c);
    p(5, headY + 10, 11, 2, c);
    p(6, torsoY, 9, 3, c);
    p(7, headY, 4, 1, shade);
  } else if (view === 'down') {
    p(4, headY - 1, 12, 1, c);
    p(3, headY, 14, 3, c);
    p(3, headY + 3, 2, 8, c);
    p(15, headY + 3, 2, 8, c);
    p(5, headY + 3, 1, 1, c);
    p(14, headY + 3, 1, 1, c);
    p(4, headY + 10, 12, 2, c);
    p(3, torsoY, 14, 2, c);
    p(4, torsoY + 2, 12, 1, c);
    p(5, headY + 2, 10, 1, shade);
    p(6, headY - 1, 4, 1, shade);
  } else {
    p(4, headY - 1, 12, 1, c);
    p(3, headY, 14, torsoY - headY + 3, c);
    p(6, headY, 5, 1, shade);
  }
}

/** Afro: a big round puff around the head (front: face open below the hairline; side/back: covers the head). */
function paintAfro(p, h, hs, view, headY) {
  p(5, headY - 3, 10, 1, h);
  p(3, headY - 2, 14, 1, h);
  p(2, headY - 1, 16, view === 'down' ? 4 : 10, h);
  if (view === 'down') {
    p(2, headY + 3, 2, 5, h);
    p(16, headY + 3, 2, 5, h);
    p(3, headY + 8, 1, 1, h);
    p(16, headY + 8, 1, 1, h);
  } else p(3, headY + 9, 14, 1, h);
  p(6, headY - 2, 4, 1, hs);
  p(4, headY - 1, 2, 1, hs);
}

function paintHair(p, look, view, headY, torsoY) {
  const h = look.hair;
  const hs = look.hairShade;
  const style = look.hairStyle;
  if (style === 'hijab') return paintHijab(p, h, hs, view, headY, torsoY);
  if (style === 'afro') return paintAfro(p, h, hs, view, headY);

  if (view === 'side') {
    p(5, headY - 1, 9, 1, h);
    p(5, headY, 10, style === 'buzz' ? 1 : 2, h);
    const back = { long: [9, 17], bob: [9, 8], curly: [9, 7], buzz: [11, 3], ponytail: [10, 4], bun: [10, 5] }[style] ?? [10, 6];
    p(back[0], headY + 2, 15 - back[0], back[1], h);
    if (style !== 'buzz') p(5, headY + 2, 2, 1, h);
    if (style === 'ponytail') {
      p(15, headY + 1, 2, 2, look.accent ?? hs);
      p(15, headY + 3, 2, 7, h);
    }
    if (style === 'bun') p(11, headY - 3, 4, 3, h);
    if (style === 'curly') {
      for (const x of [5, 8, 11]) p(x, headY - 2, 2, 1, h);
      p(15, headY + 1, 1, 6, h);
    }
    p(7, headY - 1, 3, 1, hs);
  } else if (view === 'down') {
    p(5, headY - 1, 10, 1, h);
    p(4, headY, 12, style === 'buzz' ? 2 : 3, h);
    switch (style) {
      case 'long':
        p(4, headY + 3, 4, 1, h);
        p(12, headY + 3, 4, 1, h);
        p(3, headY + 2, 2, 16, h);
        p(15, headY + 2, 2, 16, h);
        break;
      case 'bob':
        p(5, headY + 3, 10, 1, h);
        p(3, headY + 2, 2, 8, h);
        p(15, headY + 2, 2, 8, h);
        break;
      case 'ponytail':
        p(4, headY + 3, 6, 1, h);
        p(4, headY + 3, 1, 3, h);
        p(15, headY + 3, 1, 3, h);
        p(16, headY + 2, 1, 6, h); // tail swinging behind
        break;
      case 'curly':
        p(3, headY - 1, 14, 3, h);
        for (const x of [4, 8, 13]) p(x, headY - 2, 3, 1, h);
        p(3, headY + 2, 2, 4, h);
        p(15, headY + 2, 2, 4, h);
        p(5, headY + 3, 2, 1, h);
        p(9, headY + 3, 2, 1, h);
        p(13, headY + 3, 1, 1, h);
        break;
      case 'bun':
        p(8, headY - 4, 4, 3, h);
        p(4, headY + 3, 1, 2, h);
        p(15, headY + 3, 1, 2, h);
        p(5, headY + 3, 3, 1, h);
        break;
      case 'buzz':
        p(4, headY + 2, 1, 2, h);
        p(15, headY + 2, 1, 2, h);
        break;
      default:
        p(4, headY + 3, 5, 1, h);
        p(4, headY + 3, 1, 3, h);
        p(15, headY + 3, 1, 3, h);
    }
    p(7, headY - 1, 4, 1, hs);
  } else {
    // back view: hair covers the head
    const len = { long: 19, bob: 11, curly: 9, buzz: 6, ponytail: 8, bun: 8 }[style] ?? 8;
    p(5, headY - 1, 10, 1, h);
    p(4, headY, 12, len, h);
    if (style === 'bob') {
      p(3, headY + 2, 1, 8, h);
      p(16, headY + 2, 1, 8, h);
    }
    if (style === 'curly') {
      p(3, headY, 14, 8, h);
      for (const x of [4, 8, 13]) p(x, headY - 2, 3, 1, h);
    }
    if (style === 'ponytail') {
      p(8, headY + 1, 4, 1, look.accent ?? hs);
      p(8, headY + 2, 4, 11, h);
    }
    if (style === 'bun') p(7, headY - 3, 6, 4, h);
    p(7, headY, 5, 1, hs);
  }
  if (style === 'spiky') {
    for (const x of [5, 8, 11, 14]) p(x, headY - 2, 1, 1, h);
    p(6, headY - 3, 1, 2, h);
    p(12, headY - 3, 1, 2, h);
  }
}

function paintAccessories(p, look, view, headY) {
  for (const acc of look.acc ?? []) {
    if (acc === 'glasses' && view !== 'up') {
      const gc = look.glassesColor ?? '#3b3340'; // light frames read better on dark skin
      if (view === 'down') {
        p(5, headY + 5, 4, 1, gc);
        p(11, headY + 5, 4, 1, gc);
        p(9, headY + 5, 2, 1, gc);
        p(5, headY + 6, 1, 2, gc);
        p(8, headY + 6, 1, 2, gc);
        p(11, headY + 6, 1, 2, gc);
        p(14, headY + 6, 1, 2, gc);
      } else {
        p(5, headY + 5, 3, 1, gc);
        p(5, headY + 6, 1, 2, gc);
        p(7, headY + 6, 1, 2, gc);
        p(8, headY + 5, 3, 1, gc);
      }
    }
    if (acc === 'headphones') {
      const band = '#2f3140';
      if (view === 'side') {
        p(6, headY - 2, 7, 1, band);
        p(9, headY + 3, 3, 4, look.accColor);
      } else {
        p(4, headY - 2, 12, 1, band);
        p(3, headY - 1, 1, 4, band);
        p(16, headY - 1, 1, 4, band);
        p(2, headY + 3, 2, 4, look.accColor);
        p(16, headY + 3, 2, 4, look.accColor);
      }
    }
    if (acc === 'earbuds') {
      // white earbuds with a short stem (on the hair or the cheek)
      p(3, headY + 6, 1, 2, WHITE);
      p(16, headY + 6, 1, 2, WHITE);
    }
    if (acc === 'headset') {
      // call-centre headset: band, two ear cups (accColor) and a mic boom to the mouth on one side
      const band = '#2f3140';
      p(4, headY - 2, 12, 1, band);
      p(3, headY - 1, 1, 4, band);
      p(16, headY - 1, 1, 4, band);
      p(2, headY + 3, 2, 4, look.accColor);
      p(16, headY + 3, 2, 4, look.accColor);
      if (view === 'down') {
        p(3, headY + 7, 1, 2, band);
        p(4, headY + 9, 2, 1, band);
        p(6, headY + 9, 2, 1, '#55596a'); // mic
      }
    }
    if (acc === 'cap') {
      const c = look.accColor;
      if (view === 'side') {
        p(5, headY - 2, 10, 4, c);
        p(1, headY + 2, 6, 1, c);
      } else {
        p(4, headY - 2, 12, 4, c);
        p(7, headY - 2, 3, 1, 'rgba(255,255,255,.35)');
        if (view === 'down') p(3, headY + 2, 14, 1, c);
        else p(8, headY + 1, 4, 1, look.hair);
      }
    }
    if (acc === 'beret') {
      const c = look.accColor;
      p(view === 'side' ? 5 : 3, headY - 2, view === 'side' ? 10 : 12, 3, c);
      p(9, headY - 3, 1, 1, c);
    }
    if (acc === 'beanie') {
      const c = look.accColor;
      if (view === 'side') {
        p(5, headY - 3, 10, 4, c);
        p(4, headY, 11, 2, c);
        p(4, headY + 1, 11, 1, '#00000040');
      } else {
        p(4, headY - 3, 12, 4, c);
        p(3, headY, 14, 2, c);
        p(3, headY + 1, 14, 1, '#00000040');
      }
      p(9, headY - 4, 2, 1, WHITE);
    }
    if (acc === 'beard' && view !== 'up') {
      const b = look.hair;
      if (view === 'side') {
        p(9, headY + 5, 1, 4, b);
        p(5, headY + 8, 5, 3, b);
      } else {
        p(4, headY + 5, 1, 5, b);
        p(15, headY + 5, 1, 5, b);
        p(5, headY + 9, 3, 2, b);
        p(12, headY + 9, 3, 2, b);
        p(8, headY + 10, 4, 1, b);
        p(8, headY + 8, 4, 1, b);
      }
    }
  }
}

function paintTorso(p, look, view, x, y, w, h) {
  const top = look.top;
  const shade = look.topShade;
  p(x, y, w, h, top);
  if (view === 'side') {
    p(x + w - 1, y, 1, h, shade);
    return;
  }
  p(x + w - 1, y, 1, h, shade);
  if (view === 'up') {
    if (look.topStyle === 'hoodie') p(x + 1, y, w - 2, 3, shade);
    if (look.topStyle === 'vest') p(x, y + 3, w, 1, '#e9ecef');
    return;
  }
  switch (look.topStyle) {
    case 'tie':
      p(x + 4, y, 2, 1, WHITE);
      p(x + 4, y + 1, 2, h - 2, look.accent);
      break;
    case 'blazer':
      p(x + 3, y, 4, 2, WHITE);
      p(x + 4, y + 2, 2, 2, WHITE);
      p(x + 2, y, 1, 3, shade);
      p(x + 7, y, 1, 3, shade);
      p(x + 6, y + 4, 1, 1, '#2f2a35');
      break;
    case 'hoodie':
      p(x + 1, y, w - 2, 1, shade);
      p(x + 3, y + 1, 1, 2, WHITE);
      p(x + 6, y + 1, 1, 2, WHITE);
      p(x + 2, y + h - 2, w - 4, 1, shade);
      break;
    case 'sweater':
      p(x + 5, y + 1, 1, 3, WHITE);
      p(x + 4, y + 2, 3, 1, WHITE);
      p(x, y + h - 1, w, 1, shade);
      break;
    case 'vest':
      p(x + 2, y, 1, 3, '#e9ecef');
      p(x + 7, y, 1, 3, '#e9ecef');
      p(x, y + 3, w, 1, '#e9ecef');
      break;
    case 'cardigan':
      // open cardigan over a light shirt: two buttons, pockets, ribbed hem
      p(x + 4, y, 2, h - 1, look.undershirt);
      p(x + 3, y, 1, h, shade);
      p(x + 3, y + 2, 1, 1, look.undershirt);
      p(x + 3, y + 4, 1, 1, look.undershirt);
      p(x + 1, y + h - 3, 2, 1, shade);
      p(x + 7, y + h - 3, 2, 1, shade);
      p(x, y + h - 1, w, 1, shade);
      break;
    case 'polo':
      // collar tips, button placket and an ID badge on a lanyard
      p(x + 2, y, 2, 1, look.undershirt);
      p(x + 6, y, 2, 1, look.undershirt);
      p(x + 4, y, 2, 3, shade);
      p(x + 6, y + 3, 2, 2, look.undershirt);
      p(x + 6, y + 3, 2, 1, '#4dabf7');
      p(x + 7, y + 1, 1, 2, '#2f3140');
      break;
    case 'sweatervest':
      // V-neck over a shirt (sleeves = shirt colour), white collar points, a row of argyle dots, ribbed hem
      p(x + 3, y, 4, 1, look.undershirt);
      p(x + 4, y + 1, 2, 1, look.undershirt);
      p(x + 3, y, 1, 1, WHITE);
      p(x + 6, y, 1, 1, WHITE);
      for (const dx of [1, 4, 7]) p(x + dx, y + 3, 2, 1, shade);
      p(x, y + h - 1, w, 1, shade);
      break;
    case 'plain': // costumes paint their own details
      break;
    default:
      p(x + 4, y, 2, 1, WHITE);
  }
}

/**
 * @param look character palette/style
 * @param s { view: 'down'|'up'|'left'|'right', pose: 'stand'|'walk'|'sit'|'sofa', frame, arms, blink, talk, mood, item }
 */
function paintCharacter(look, s) {
  const c = canvas(SPRITE_W, SPRITE_H);
  const g = c.getContext('2d');
  g.translate(0, TOP_PAD);
  const p = painter(g);
  const view = s.view === 'right' ? 'left' : s.view;
  const seated = s.pose === 'sit' || s.pose === 'sofa';
  const headY = seated ? 6 : 3;
  const torsoY = headY + 12;
  const torsoH = seated ? 6 : 7;
  const sleeve = look.sleeve ?? look.top;
  const arms = s.arms ?? 'down';
  const f = s.frame ?? 0;
  // Theme costume hooks (none for the plain office look: that path paints exactly as before).
  const costume = look.costume ? COSTUMES[look.costume] : null;
  const ctx = costume && { view, s, headY, torsoY, torsoH, seated, arms, f, sleeve, paintItem };
  if (costume?.ghost) {
    costume.paint(p, look, ctx);
    return finishCharacter(c, g, look, s);
  }
  costume?.back?.(p, look, ctx);

  // legs
  if (s.pose === 'stand' || s.pose === 'walk') {
    if (view === 'left') {
      p(7, 22, 6, 2, look.pants);
      if (f === 0) {
        p(8, 24, 4, 4, look.pants);
        p(7, 28, 5, 1, look.shoes);
      } else {
        p(6, 24, 3, 4, f === 1 ? look.pants : look.pantsShade);
        p(5, 28, 4, 1, look.shoes);
        p(11, 24, 3, 4, f === 1 ? look.pantsShade : look.pants);
        p(11, 28, 4, 1, look.shoes);
      }
    } else {
      p(5, 22, 10, 2, look.pants);
      const liftL = f === 1 ? 1 : 0;
      const liftR = f === 2 ? 1 : 0;
      p(6, 24, 3, 4 - liftL, look.pants);
      p(5, 28 - liftL, 4, 1, look.shoes);
      p(11, 24, 3, 4 - liftR, look.pants);
      p(11, 28 - liftR, 4, 1, look.shoes);
    }
  } else if (s.pose === 'sofa') {
    p(5, 24, 10, 2, look.pants);
    p(6, 26, 3, 2, look.pants);
    p(11, 26, 3, 2, look.pants);
    p(5, 28, 4, 1, look.shoes);
    p(11, 28, 4, 1, look.shoes);
  }

  // back arm (behind torso) for side view
  if (view === 'left') {
    paintTorso(p, look, view, 7, torsoY, 6, torsoH);
  } else {
    paintTorso(p, look, view, 5, torsoY, 10, torsoH);
  }
  costume?.body?.(p, look, ctx);

  // head
  if (costume?.head) {
    costume.head(p, look, ctx);
  } else if (view === 'left') {
    p(5, headY, 10, 11, look.skin);
    p(4, headY + 6, 1, 1, look.skin); // nose
    p(10, headY + 5, 1, 2, look.skinShade); // ear
    if (s.view !== 'up') {
      p(6, headY + 6, 1, s.blink ? 1 : 2, EYE);
      p(7, headY + 8, 1, 1, look.blush);
      if (s.talk || s.mood === 'happy') p(5, headY + 9, 2, 1, '#b5525a');
    }
  } else {
    p(4, headY, 12, 11, look.skin);
    p(15, headY + 1, 1, 9, look.skinShade);
    if (view === 'down') {
      const eyeY = headY + 6;
      p(7, s.blink ? eyeY + 1 : eyeY, 1, s.blink ? 1 : 2, EYE);
      p(12, s.blink ? eyeY + 1 : eyeY, 1, s.blink ? 1 : 2, EYE);
      p(6, headY + 8, 1, 1, look.blush);
      p(13, headY + 8, 1, 1, look.blush);
      if (s.talk) p(9, headY + 9, 2, 1, '#b5525a');
      else if (s.mood === 'happy') p(8, headY + 9, 4, 1, '#b5525a');
      else if (s.mood === 'worried') {
        p(6, headY + 4, 2, 1, look.hair);
        p(12, headY + 4, 2, 1, look.hair);
        p(9, headY + 9, 2, 1, '#8a4a52');
      }
    }
  }
  if (!costume?.head) {
    // neck
    p(9, headY + 11, 2, 1, look.skinShade);
    paintHair(p, look, view, headY, torsoY);
  }
  paintAccessories(p, look, view, headY);
  if (s.mood === 'worried' && view === 'down') p(17, headY + 1, 1, 2, '#8fd3ff');
  costume?.front?.(p, look, ctx);
  if (!costume?.arms?.(p, look, ctx)) paintArms(p, look, s, view, headY, torsoY, sleeve, arms, f);
  if (look.gadget) paintGadget(p, look, s, view, torsoY, arms);
  costume?.after?.(p, look, ctx);
  return finishCharacter(c, g, look, s);
}

function paintArms(p, look, s, view, headY, torsoY, sleeve, arms, f) {
  // arms
  const armUp = (x) => {
    p(x, headY + 2, 2, torsoY - headY - 2, sleeve);
    p(x, headY, 2, 2, look.skin);
  };
  if (view === 'left') {
    if (arms === 'raise' || arms === 'cheer') {
      p(9, headY + 1, 2, torsoY - headY, sleeve);
      p(9, headY - 1, 2, 2, look.skin);
    } else if (arms === 'hold') {
      p(8, torsoY, 2, 3, sleeve);
      p(5, torsoY + 3, 4, 1, look.skin);
      paintItem(p, s.item, 1, torsoY);
    } else {
      const swing = s.pose === 'walk' ? (f === 1 ? -1 : f === 2 ? 1 : 0) : 0;
      p(9, torsoY, 2, 4, sleeve);
      p(9 + swing, torsoY + 4, 2, 2, look.skin);
      p(9 + swing * 2, torsoY + 6, 2, 1, look.skin);
    }
  } else if (arms === 'type') {
    const t = f % 2;
    p(3, torsoY - t, 2, 4, sleeve);
    p(15, torsoY - (1 - t), 2, 4, sleeve);
  } else if (arms === 'cheer') {
    armUp(2);
    armUp(16);
  } else if (arms === 'raise') {
    p(3, torsoY, 2, 4, sleeve);
    p(3, torsoY + 4, 2, 3, look.skin);
    armUp(16);
  } else if (arms === 'scratch') {
    p(3, torsoY, 2, 4, sleeve);
    p(15, torsoY - 3, 2, 4, sleeve);
    p(14, headY + 3, 2, torsoY - headY - 5, look.skin);
    p(12, headY + 2, 3, 2, look.skin);
  } else if (arms === 'hold' && view === 'down') {
    p(3, torsoY, 2, 4, sleeve);
    p(3, torsoY + 4, 2, 3, look.skin);
    p(15, torsoY, 2, 3, sleeve);
    p(13, torsoY + 3, 3, 1, look.skin);
    paintItem(p, s.item, 13, torsoY);
  } else {
    const swingL = s.pose === 'walk' && f === 1 ? 1 : 0;
    const swingR = s.pose === 'walk' && f === 2 ? 1 : 0;
    p(3, torsoY, 2, 4, sleeve);
    p(3, torsoY + 4, 2, 3 - swingL, look.skin);
    p(15, torsoY, 2, 4, sleeve);
    p(15, torsoY + 4, 2, 3 - swingR, look.skin);
  }
}

/** A phone in the free hand (arms down, facing the viewer or sideways); the screen glows in gadgetGlow. */
function paintGadget(p, look, s, view, torsoY, arms) {
  if (look.gadget !== 'phone' || arms !== 'down' || view === 'up' || s.pose === 'sit') return;
  const glow = look.gadgetGlow ?? '#8fd3ff';
  if (view === 'left') {
    p(7, torsoY + 3, 2, 4, '#262a36');
    p(7, torsoY + 4, 1, 2, glow);
    return;
  }
  const lift = s.pose === 'walk' && s.frame === 2 ? 1 : 0;
  p(14, torsoY + 4 - lift, 3, 4, '#262a36');
  p(15, torsoY + 5 - lift, 1, 2, glow);
}

/** Outline, optional translucency (ghosts), mirror for the right-facing view. */
function finishCharacter(c, g, look, s) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  outline(c);
  let out = c;
  if (look.alpha) {
    out = canvas(c.width, c.height);
    const og = out.getContext('2d');
    og.globalAlpha = look.alpha;
    og.drawImage(c, 0, 0);
  }
  return s.view === 'right' ? mirror(out) : out;
}

function paintItem(p, item, x, y) {
  if (item === 'cup') {
    p(x, y + 1, 3, 3, WHITE);
    p(x, y + 1, 3, 1, '#7a4a2a');
    p(x + 3, y + 2, 1, 1, WHITE);
  } else if (item === 'paper') {
    p(x - 1, y - 1, 5, 6, WHITE);
    p(x, y + 1, 3, 1, '#9aa3ad');
    p(x, y + 3, 3, 1, '#9aa3ad');
  }
}

export function characterSprite(baseLook, s) {
  const look = themedLook(baseLook);
  const key = `${look.id}|${s.view}|${s.pose}|${s.frame ?? 0}|${s.arms ?? 'down'}|${s.blink ? 1 : 0}|${s.talk ? 1 : 0}|${s.mood ?? ''}|${s.item ?? ''}`;
  let sprite = cache.get(key);
  if (!sprite) {
    sprite = paintCharacter(look, s);
    cache.set(key, sprite);
  }
  return sprite;
}

/**
 * Pixels to lift the sprite off the floor this frame: floating costumes (ghosts) bob gently; others 0.
 * The phase comes from the role so ghosts don't bob in sync.
 */
export function spriteLift(baseLook, now) {
  const look = themedLook(baseLook);
  if (!look.float) return 0;
  const phase = [...look.id].reduce((n, ch) => n + ch.charCodeAt(0), 0);
  return 1 + Math.round(Math.sin(now / 420 + phase) * 1.4);
}

/** Head-and-shoulders portrait as a data URL for the team panel. */
export function avatarURL(baseLook, scale = 3) {
  const look = themedLook(baseLook);
  const key = `avatar|${look.id}|${scale}`;
  if (cache.has(key)) return cache.get(key);
  const sprite = characterSprite(baseLook, { view: 'down', pose: 'stand', mood: 'happy' });
  const c = canvas(18 * scale, 21 * scale);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(sprite, 1, 0, 18, 21, 0, 0, 18 * scale, 21 * scale);
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

// ---------- cat ----------

export function catSprite(state, frame, flip) {
  const pal = activeTheme().cat;
  const key = `cat|${activeTheme().id}|${state}|${frame}|${flip ? 1 : 0}|${pal.fur}`;
  if (cache.has(key)) return cache.get(key);
  const c = canvas(16, 12);
  const p = painter(c.getContext('2d'));
  const { fur, stripe } = pal;
  if (state === 'sleep') {
    p(3, 6, 10, 4, fur);
    p(2, 7, 12, 3, fur);
    p(10, 4, 4, 4, fur);
    p(10, 3, 1, 1, fur);
    p(13, 3, 1, 1, fur);
    p(5, 6, 1, 3, stripe);
    p(8, 6, 1, 3, stripe);
    p(11, 6, 2, 1, pal.closed);
    p(2, 9, 6, 1, stripe);
  } else if (state === 'sit') {
    p(5, 5, 6, 6, fur);
    p(4, 1, 8, 5, fur);
    p(4, 0, 1, 1, fur);
    p(11, 0, 1, 1, fur);
    p(6, 3, 1, 1, pal.eye);
    p(9, 3, 1, 1, pal.eye);
    p(7, 4, 2, 1, pal.nose);
    p(10, 9, 4, 1, fur);
    p(6, 7, 1, 2, stripe);
    p(9, 7, 1, 2, stripe);
  } else {
    p(4, 4, 8, 4, fur);
    p(1, 2, 5, 4, fur);
    p(1, 1, 1, 1, fur);
    p(4, 1, 1, 1, fur);
    p(2, 3, 1, 1, pal.eye);
    p(12, 1, 1, 4, fur);
    p(13, 0, 1, 2, fur);
    p(6, 4, 1, 3, stripe);
    p(9, 4, 1, 3, stripe);
    const legs = frame ? [4, 7, 9, 11] : [5, 6, 10, 11];
    for (const x of legs) p(x, 8, 1, 2, fur);
  }
  pal.wear?.(p, state); // theme accessory (Santa hat, peci, bandana) painted before the outline
  outline(c, pal.outline);
  const result = flip ? mirror(c) : c;
  cache.set(key, result);
  return result;
}

// ---------- icons ----------

const ICONS = {
  check: { color: '#3fb950', rows: ['......x', '.....xx', 'x...xx.', 'xx.xx..', '.xxx...', '..x....'] },
  cross: { color: '#f0524a', rows: ['x....x', 'xx..xx', '.xxxx.', '.xxxx.', 'xx..xx', 'x....x'] },
  alert: { color: '#f0524a', rows: ['.xx.', '.xx.', '.xx.', '.xx.', '....', '.xx.'] },
  ask: { color: '#f5a524', rows: ['.xxx.', 'x...x', '...x.', '..x..', '.....', '..x..'] },
  zzz: { color: '#9fb7ff', rows: ['xxxx', '..x.', '.x..', 'xxxx'] },
  stuck: { color: '#9fb7ff', rows: ['......xxx', '........x', '.......x.', '.........', 'x.x.x..x.'] }, // "…?": no sign of progress for a while
  heart: { color: '#ff6b8b', rows: ['.x.x.', 'xxxxx', 'xxxxx', '.xxx.', '..x..'] },
  think: { color: '#c9d1e3', rows: ['x.x.x'] },
  note: { color: '#ffd166', rows: ['xxxx', 'x..x', 'xxxx', 'x..x', 'xxxx'] },
};

export function iconSprite(name) {
  const key = `icon|${name}`;
  if (cache.has(key)) return cache.get(key);
  const def = ICONS[name] ?? ICONS.alert;
  const w = def.rows[0].length + 2;
  const h = def.rows.length + 2;
  const c = canvas(w, h);
  const p = painter(c.getContext('2d'));
  def.rows.forEach((row, y) => [...row].forEach((ch, x) => ch === 'x' && p(x + 1, y + 1, 1, 1, def.color)));
  outline(c, '#1a1320');
  cache.set(key, c);
  return c;
}
