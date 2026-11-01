// 17 Agustus (HUT RI) costume painters — same hook contract as costumes.js. Red-white lomba outfits:
// kaos with a race number, ikat kepala, a sack-race karung, a pejuang with a decorative bamboo flagpole,
// a paskibra uniform and kebaya. Merged into COSTUMES by costumes.js.
import { peci } from './costumes-lebaran.js';

export const RED = '#d7182a';
export const WHITE = '#f6f3ee';
const GOLD = '#ffd23f';
const INK = '#1d1424';

/** Ikat kepala merah-putih: red over white band on the hairline, knot tails at the back. */
function ikat(p, view, headY) {
  if (view === 'left') {
    p(5, headY + 1, 10, 1, RED);
    p(5, headY + 2, 10, 1, WHITE);
    p(15, headY + 1, 2, 1, RED);
    p(15, headY + 2, 2, 2, WHITE);
  } else if (view === 'up') {
    p(4, headY + 1, 12, 1, RED);
    p(4, headY + 2, 12, 1, WHITE);
    p(9, headY + 3, 1, 3, RED);
    p(10, headY + 3, 1, 3, WHITE);
  } else {
    p(4, headY + 1, 12, 1, RED);
    p(4, headY + 2, 12, 1, WHITE);
    p(16, headY + 1, 2, 1, RED);
    p(17, headY + 2, 1, 2, WHITE);
  }
}

/** Lower garment (kain) over the legs while standing/walking or on the sofa. */
function kain(p, { view, s }, color) {
  if (s.pose === 'sofa') {
    p(5, 24, 10, 4, color);
    return { x: 5, w: 10, y: 24 };
  }
  if (s.pose !== 'stand' && s.pose !== 'walk') return null;
  if (view === 'left') {
    p(6, 22, 8, 6, color);
    return { x: 6, w: 8, y: 22 };
  }
  p(5, 22, 10, 6, color);
  return { x: 5, w: 10, y: 22 };
}

/** Lomba makan kerupuk: a round kerupuk hanging on a string right at the mouth. */
function kerupuk(p, look, { view, s, headY, seated }) {
  if (seated || view === 'up') return;
  const K = '#f3e3b0';
  const dot = '#d9a95a';
  const x = view === 'left' ? 1 : 7;
  const sx = view === 'left' ? 3 : 10;
  p(sx, -2, 1, headY + 9, '#6b5a48');
  const y = headY + 7 + (s.pose === 'walk' && s.frame === 1 ? 1 : 0);
  p(x + 1, y, 4, 1, K);
  p(x, y + 1, 6, 3, K);
  p(x + 1, y + 4, 4, 1, K);
  p(x + 1, y + 1, 1, 1, dot);
  p(x + 4, y + 2, 1, 1, dot);
  p(x + 2, y + 3, 1, 1, dot);
  if (view === 'down') p(x + 3, y + 4, 2, 1, '#e0c88a'); // a bite out of it
}

/** Tarik tambang: a thick rope held across the body at hand height. */
function tambang(p, look, { view, s, torsoY, seated, arms }) {
  if (seated || arms !== 'down' || view === 'up') return;
  const R = '#c9a46a';
  const RS = '#9c7a45';
  const y = torsoY + 5;
  const w = view === 'left' ? 11 : 20;
  p(0, y, w, 2, R);
  for (let x = 0; x < w; x += 3) {
    p(x, y, 1, 1, RS);
    p(x + 1, y + 1, 1, 1, RS);
  }
  if (view === 'left') p(9, y, 2, 2, look.skin);
  else {
    p(3, y, 2, 2, look.skin);
    p(15, y, 2, 2, look.skin);
  }
  if (s.pose === 'walk') p(view === 'left' ? 0 : 18, y + 2, 2, 1, RS); // rope end swinging
}

/** Balap bakiak: a long wooden plank under both feet with black rubber straps. */
function bakiak(p, look, { view, s }) {
  if (s.pose !== 'stand' && s.pose !== 'walk' && s.pose !== 'sofa') return;
  const wood = '#b5834f';
  p(view === 'left' ? 2 : 3, 28, view === 'left' ? 15 : 14, 1, wood);
  p(view === 'left' ? 2 : 3, 29, view === 'left' ? 15 : 14, 1, '#8a5f33');
  if (view === 'left') p(7, 27, 6, 1, INK);
  else {
    p(5, 27, 4, 1, INK);
    p(11, 27, 4, 1, INK);
  }
}

export const AGUSTUS_COSTUMES = {
  // Juri lomba: white kemeja tucked in, peci, red-white rosette, whistle on a role-colour lanyard, clipboard.
  juri: {
    body(p, look, { view, torsoY, torsoH }) {
      const c = look.lanyard;
      const x0 = view === 'left' ? 7 : 5;
      const w = view === 'left' ? 6 : 10;
      p(x0, torsoY + torsoH - 1, w, 1, INK);
      if (view === 'left') {
        p(8, torsoY, 1, 3, c);
        p(8, torsoY + 3, 1, 1, '#c9d1d9');
        return;
      }
      if (view === 'up') {
        p(7, torsoY, 6, 1, c);
        return;
      }
      p(7, torsoY, 1, 1, '#c9c2b4');
      p(12, torsoY, 1, 1, '#c9c2b4');
      p(8, torsoY, 1, 2, c);
      p(11, torsoY, 1, 2, c);
      p(9, torsoY + 2, 2, 1, c);
      p(9, torsoY + 3, 2, 1, '#c9d1d9');
      p(5, torsoY + 1, 2, 2, RED);
      p(6, torsoY + 2, 1, 1, WHITE);
    },
    front(p, look, { view, headY }) {
      peci(p, view, headY);
    },
    after(p, look, { view, torsoY, seated, arms }) {
      if (seated || arms !== 'down' || view === 'up') return;
      const x = view === 'left' ? 5 : 14;
      p(x, torsoY + 2, 4, 6, '#a0703f');
      p(x + 1, torsoY + 3, 2, 4, WHITE);
      p(x + 1, torsoY + 4, 2, 1, '#9aa3ad');
      p(x + 1, torsoY + 6, 2, 1, '#9aa3ad');
      p(x + 1, torsoY + 2, 2, 1, look.lanyard);
    },
  },

  // Lomba kaos: red-over-white (or white with red collar/sleeves), a race number in the role colour, ikat kepala.
  kaos: {
    body(p, look, { view, torsoY, torsoH }) {
      const x0 = view === 'left' ? 7 : 5;
      const w = view === 'left' ? 6 : 10;
      if (look.shirt === 'merahputih') p(x0, torsoY + 3, w, torsoH - 3, WHITE);
      else p(7, torsoY, view === 'left' ? 3 : 6, 1, RED); // red collar on the white kaos
      const bib = look.bib;
      if (view === 'left') {
        p(8, torsoY + 3, 3, 2, bib);
        return;
      }
      // number cloth on the white half, leaving the red-white split visible at the sides
      p(7, torsoY + 3, 6, 3, bib);
      if (view === 'down') {
        // "17" in white on the number cloth
        p(8, torsoY + 3, 1, 2, WHITE);
        p(10, torsoY + 3, 2, 1, WHITE);
        p(11, torsoY + 4, 1, 1, WHITE);
      }
    },
    front(p, look, { view, headY }) {
      if (look.headband) ikat(p, view, headY);
    },
    arms(p, look, { view, s, torsoY, sleeve, arms }) {
      // lomba makan kerupuk: hands behind the back (only the short sleeves show)
      if (look.prop !== 'kerupuk' || arms !== 'down' || view !== 'down' || (s.pose !== 'stand' && s.pose !== 'walk')) return false;
      p(3, torsoY, 2, 3, sleeve);
      p(15, torsoY, 2, 3, sleeve);
      return true;
    },
    after(p, look, ctx) {
      const { view, torsoY, seated, arms } = ctx;
      if (look.prop === 'kerupuk') return kerupuk(p, look, ctx);
      if (look.prop === 'tambang') return tambang(p, look, ctx);
      if (look.prop === 'bakiak') return bakiak(p, look, ctx);
      // lomba kelereng: a spoon with a marble, held in front
      if (look.prop !== 'kelereng' || seated || view !== 'down' || arms !== 'down') return;
      p(16, torsoY + 2, 1, 4, '#c9d1d9');
      p(15, torsoY + 1, 3, 1, '#c9d1d9');
      p(16, torsoY, 1, 1, look.marble);
    },
  },

  // Balap karung: burlap sack from the chest down (feet inside), hands on the rim, ikat kepala.
  karung: {
    body(p, look, { view, s, torsoY, torsoH, seated }) {
      const top = torsoY + 3;
      const h = s.pose === 'sit' ? torsoH - 3 : seated ? 28 - top : 29 - top;
      const x0 = view === 'left' ? 6 : 4;
      const w = view === 'left' ? 9 : 12;
      p(x0, top, w, h, look.sack);
      p(x0 + w - 1, top + 1, 1, h - 1, look.sackShade);
      p(x0, top, w, 1, look.sackDark);
      for (const [dx, dy] of [[2, 3], [6, 5], [9, 2], [3, 7], [7, 9]]) if (dx < w - 1 && dy < h) p(x0 + dx, top + dy, 1, 1, look.sackShade);
      if (view === 'down' && h > 6) {
        // stencilled stripe on the sack
        p(x0 + 3, top + 5, w - 6, 1, RED);
      }
    },
    front(p, look, { view, headY }) {
      ikat(p, view, headY);
    },
  },

  // Pejuang: peci, shirt in the role colour, red-white sash, a bamboo pole with a small flag (decorative).
  pejuang: {
    body(p, look, { view, torsoY, torsoH }) {
      if (view === 'left') {
        p(8, torsoY + 1, 1, torsoH - 2, RED);
        p(9, torsoY + 1, 1, torsoH - 2, WHITE);
        return;
      }
      for (let i = 0; i < torsoH; i++) {
        const x = view === 'up' ? 13 - i : 5 + i;
        p(x, torsoY + i, 1, 1, RED);
        p(view === 'up' ? x - 1 : x + 1, torsoY + i, 1, 1, WHITE);
      }
    },
    front(p, look, { view, headY }) {
      peci(p, view, headY);
    },
    after(p, look, { view, headY, seated, arms }) {
      if (seated || view !== 'down' || arms !== 'down') return;
      p(17, headY - 1, 1, 25, '#c9b458');
      p(17, headY + 6, 1, 1, '#8f7d32');
      p(17, headY + 14, 1, 1, '#8f7d32');
      p(17, headY - 2, 1, 1, '#e3d48a');
      p(18, headY - 1, 2, 2, RED);
      p(18, headY + 1, 2, 2, WHITE);
    },
  },

  // Paskibra: white uniform with gold buttons, black belt, a role-colour shoulder cord, peci with a gold emblem.
  paskibra: {
    body(p, look, { view, torsoY, torsoH }) {
      const x0 = view === 'left' ? 7 : 5;
      const w = view === 'left' ? 6 : 10;
      p(x0, torsoY + torsoH - 2, w, 1, INK);
      if (view === 'left') {
        p(8, torsoY, 2, 1, look.cord);
        p(8, torsoY + 1, 1, 2, look.cord);
        return;
      }
      if (view === 'up') return;
      p(9, torsoY + torsoH - 2, 2, 1, GOLD);
      for (const dy of [1, 3]) p(9, torsoY + dy, 1, 1, GOLD);
      p(12, torsoY, 3, 1, look.cord);
      p(13, torsoY + 1, 1, 2, look.cord);
      p(12, torsoY + 3, 2, 1, look.cord);
      p(6, torsoY + 1, 2, 1, RED);
    },
    front(p, look, { view, headY }) {
      peci(p, view, headY);
      if (view !== 'up') p(view === 'left' ? 7 : 9, headY - 1, 2, 1, GOLD);
    },
  },

  // Kebaya kutubaru: contrasting centre panel with gold brooches, lace hem; batik kain in the role colour;
  // with or without a hijab.
  kebaya: {
    body(p, look, ctx) {
      const { view, torsoY, torsoH } = ctx;
      const L = look.lace;
      if (view === 'down') {
        p(9, torsoY, 2, torsoH - 1, look.inner);
        for (const dy of [1, 3, 5]) if (dy < torsoH - 1) p(9, torsoY + dy, 2, 1, GOLD);
        for (let x = 5; x < 15; x += 2) p(x, torsoY + torsoH - 1, 1, 1, L);
      } else if (view === 'left') p(7, torsoY + 1, 1, torsoH - 1, look.inner);
      else for (let x = 5; x < 15; x += 2) p(x, torsoY + torsoH - 1, 1, 1, L);
      const k = kain(p, ctx, look.kain);
      if (!k) return;
      for (let x = k.x + 1; x < k.x + k.w - 1; x += 3) {
        p(x, k.y + 1, 1, 1, look.kainDark);
        p(x + 1, k.y + 3, 1, 1, look.kainDark);
      }
      if (view === 'down') p(k.x + k.w - 4, k.y, 1, 6 - (k.y - 22), look.kainDark); // wrap fold
      p(k.x, k.y, k.w, 1, look.top); // kebaya hem over the kain
    },
  },
};
