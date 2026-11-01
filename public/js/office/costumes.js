// Costume painters for themed characters (e.g. Halloween). A look with `costume: '<name>'` is painted by
// sprites.js as usual, with these hooks layered in (all optional; coordinates are the 20×32 sprite grid):
//   back   – before the legs (capes, tails: things behind the body)
//   body   – after the torso (ribs, torn shirt, belts)
//   head   – REPLACES the head, face and hair (pumpkin, skull, hood); paints its own neck
//   front  – after hair/accessories (hats, ears, collars, face details)
//   arms   – return true to replace the default arms
//   after  – last, over everything (held props)
// `ghost: true` costumes paint the whole figure themselves (no legs: they float).
// ctx = { view: 'down'|'up'|'left' (right is mirrored), s, headY, torsoY, torsoH, seated, arms, f, sleeve, paintItem }
// Natal, Lebaran and 17 Agustus costumes live in costumes-<theme>.js and are merged into COSTUMES below.
import { AGUSTUS_COSTUMES } from './costumes-agustus.js';
import { LEBARAN_COSTUMES } from './costumes-lebaran.js';
import { NATAL_COSTUMES } from './costumes-natal.js';

const WHITE = '#f4f1ea';
const INK = '#1d1424';

// ---------- ghosts (UI/UX, QA, Writer) ----------

/** Sheet ghost: dome head, wavy hem, nub arms, big black eyes. Accent (bow/scarf/lantern) per variant. */
function paintGhost(p, look, ctx) {
  const { view, s, headY, torsoY, seated, f } = ctx;
  const sheet = look.sheet;
  const shade = look.sheetShade;
  const top = headY + (look.small ? 3 : 0);
  const bottom = seated ? torsoY + 7 : s.pose === 'sofa' ? 27 : look.small ? 25 : 26;
  const wave = (s.pose === 'walk' ? f : 0) + (seated ? 0 : 1);
  const arms = ctx.arms;

  if (view === 'left') {
    p(7, top - 1, 5, 1, sheet);
    p(5, top, 9, 1, sheet);
    p(4, top + 1, 11, bottom - top - 1, sheet);
    p(13, top + 1, 2, bottom - top - 1, shade);
    // trailing tail behind (facing left, so the tail streams right)
    p(14, bottom - 4, 3, 3, sheet);
    p(16, bottom - 3, 2, 2, shade);
    for (let x = 4; x < 14; x++) if ((x + wave) % 3 !== 0) p(x, bottom, 1, 1, sheet);
    if (look.glasses) {
      p(4, top + 3, 4, 1, '#3b3340');
      p(4, top + 6, 4, 1, '#3b3340');
      p(7, top + 4, 1, 2, '#3b3340');
    }
    p(5, s.blink ? top + 5 : top + 4, 2, s.blink ? 1 : look.small ? 2 : 3, INK);
    if (s.talk || look.mouth === 'o') p(5, top + 8, 1, 2, INK);
    // nub arm reaching forward
    if (arms === 'hold') {
      p(3, torsoY + 2, 5, 2, sheet);
      ctx.paintItem(p, s.item, 1, torsoY);
    } else if (arms === 'raise' || arms === 'cheer') p(8, top - 2, 2, torsoY - top + 2, sheet);
    else p(7 - (s.pose === 'walk' && f === 1 ? 1 : 0), torsoY + 1, 3, 2, shade);
    ghostAccent(p, look, ctx, top, bottom);
    return;
  }

  // front / back: dome + wide body
  p(7, top - 1, 6, 1, sheet);
  p(5, top, 10, 1, sheet);
  p(4, top + 1, 12, 2, sheet);
  p(3, top + 3, 14, bottom - top - 3, sheet);
  p(15, top + 1, 1, 2, shade);
  p(16, top + 3, 1, bottom - top - 3, shade);
  p(6, torsoY + 1, 1, Math.max(1, bottom - torsoY - 2), shade);
  for (let x = 3; x < 17; x++) if ((x + wave) % 4 < 2) p(x, bottom, 1, 1, x > 14 ? shade : sheet);

  if (view === 'down') {
    if (look.glasses) {
      for (const gx of [5, 11]) {
        p(gx, top + 3, 4, 1, '#3b3340');
        p(gx, top + 6, 4, 1, '#3b3340');
        p(gx, top + 4, 1, 2, '#3b3340');
        p(gx + 3, top + 4, 1, 2, '#3b3340');
      }
      p(9, top + 4, 2, 1, '#3b3340');
      p(6, s.blink ? top + 5 : top + 4, 2, s.blink ? 1 : 2, INK);
      p(12, s.blink ? top + 5 : top + 4, 2, s.blink ? 1 : 2, INK);
    } else {
      p(6, s.blink ? top + 6 : top + 4, 2, s.blink ? 1 : 3, INK);
      p(12, s.blink ? top + 6 : top + 4, 2, s.blink ? 1 : 3, INK);
    }
    if (look.cheeks) {
      p(5, top + 7, 1, 1, look.cheeks);
      p(14, top + 7, 1, 1, look.cheeks);
    }
    if (s.talk) p(9, top + 8, 2, 2, INK);
    else if (s.mood === 'happy') {
      p(8, top + 9, 4, 1, INK);
      p(7, top + 8, 1, 1, INK);
      p(12, top + 8, 1, 1, INK);
    } else if (s.mood === 'worried') {
      p(8, top + 9, 1, 1, INK);
      p(9, top + 8, 2, 1, INK);
      p(11, top + 9, 1, 1, INK);
    } else if (look.mouth === 'o') p(9, top + 8, 2, 2, INK);
  }

  // nub arms
  const t = f % 2;
  const swing = s.pose === 'walk' ? (f === 1 ? -1 : f === 2 ? 1 : 0) : 0;
  if (arms === 'type') {
    p(1, torsoY - t, 3, 2, sheet);
    p(16, torsoY - (1 - t), 3, 2, shade);
  } else if (arms === 'cheer') {
    p(1, top + 1, 2, torsoY - top, sheet);
    p(17, top + 1, 2, torsoY - top, shade);
  } else if (arms === 'raise') {
    p(1, torsoY + 1, 3, 2, sheet);
    p(17, top + 1, 2, torsoY - top, shade);
  } else if (arms === 'scratch') {
    p(1, torsoY + 1, 3, 2, sheet);
    p(15, top + 3, 3, 2, shade);
    p(17, top + 5, 2, torsoY - top - 4, shade);
  } else if (arms === 'hold' && view === 'down') {
    p(1, torsoY + 1, 3, 2, sheet);
    p(14, torsoY + 3, 3, 2, shade);
    ctx.paintItem(p, s.item, 13, torsoY);
  } else {
    p(1, torsoY + 1 + swing, 3, 2, sheet);
    p(16, torsoY + 1 - swing, 3, 2, shade);
  }
  ghostAccent(p, look, ctx, top, bottom);
}

function ghostAccent(p, look, ctx, top) {
  const { view, torsoY, seated, s } = ctx;
  const c = look.accent;
  if (look.bow) {
    // a bow on top of the sheet in the role colour
    const x = view === 'left' ? 9 : 11;
    p(x, top - 2, 2, 2, c);
    p(x + 3, top - 2, 2, 2, c);
    p(x + 2, top - 1, 1, 1, c);
  }
  if (look.scarf) {
    if (view === 'left') {
      p(4, torsoY - 1, 11, 2, c);
      p(13, torsoY + 1, 2, 3, c);
    } else {
      p(3, torsoY - 1, 14, 2, c);
      if (view === 'down') p(11, torsoY + 1, 2, 4, c);
      else p(6, torsoY + 1, 2, 4, c);
    }
  }
  if (look.lantern && !seated && view !== 'up' && s.arms !== 'hold') {
    // small paper lantern hanging from the nub (role-colour frame, warm light)
    const x = view === 'left' ? 1 : 16;
    p(x + 1, torsoY + 2, 1, 2, '#3b3340');
    p(x, torsoY + 4, 3, 4, c);
    p(x + 1, torsoY + 5, 1, 2, '#ffd166');
  }
}

// ---------- shared bits ----------

const pointedEars = (p, headY, view, fur, inner) => {
  if (view === 'left') {
    p(10, headY - 3, 2, 1, fur);
    p(10, headY - 2, 3, 2, fur);
    if (inner) p(11, headY - 2, 1, 1, inner);
    return;
  }
  p(4, headY - 3, 2, 1, fur);
  p(4, headY - 2, 3, 2, fur);
  p(14, headY - 3, 2, 1, fur);
  p(13, headY - 2, 3, 2, fur);
  if (inner && view === 'down') {
    p(5, headY - 2, 1, 1, inner);
    p(14, headY - 2, 1, 1, inner);
  }
};

/** Bat wings spread from the shoulders (front view: behind the arms; back view: over the back). */
function batWings(p, look, torsoY, back) {
  const W = look.wing;
  const L = look.lining;
  for (const mirror of [false, true]) {
    const r = (x, y, w, h, c) => p(mirror ? 20 - x - w : x, y, w, h, c);
    r(2, torsoY - 2, 3, 1, W);
    r(1, torsoY - 1, 4, 1, W);
    r(0, torsoY, 5, 5, W);
    r(1, torsoY, 3, 4, L);
    r(0, torsoY + 5, 1, 1, W);
    r(2, torsoY + 5, 1, 1, W);
    r(4, torsoY + 5, 1, 1, W);
    r(2, torsoY + 1, 1, 4, look.wingShade);
  }
  if (back) {
    p(5, torsoY - 1, 10, 6, W);
    p(9, torsoY, 2, 5, look.wingShade);
  }
}

// ---------- costumes ----------

export const COSTUMES = {
  // Lead: vampire — high cape collar with a role-colour lining, fangs, widow's peak.
  vampire: {
    back(p, look, { view, torsoY, seated }) {
      const len = seated ? 7 : 13;
      if (view === 'left') {
        p(10, torsoY - 1, 6, len, look.cape);
        p(15, torsoY + 1, 1, len - 3, look.lining);
      } else if (view === 'down') {
        p(3, torsoY - 1, 14, len, look.cape);
        p(3, torsoY + 6, 1, len - 7, look.lining);
        p(16, torsoY + 6, 1, len - 7, look.lining);
      }
    },
    body(p, look, { view, torsoY }) {
      if (view === 'down') p(9, torsoY + 3, 2, 2, look.lining); // medallion
    },
    front(p, look, { view, s, headY, torsoY, seated }) {
      if (view === 'down') {
        p(9, headY + 3, 2, 1, look.hair); // widow's peak
        p(2, headY + 6, 2, 6, look.cape);
        p(16, headY + 6, 2, 6, look.cape);
        p(3, headY + 7, 1, 5, look.lining);
        p(16, headY + 7, 1, 5, look.lining);
        if (!s.talk) p(8, headY + 9, 4, 1, '#7a1f2b');
        p(8, headY + 10, 1, 1, WHITE);
        p(11, headY + 10, 1, 1, WHITE);
      } else if (view === 'up') {
        const len = seated ? 7 : 13;
        p(2, headY + 6, 16, 5, look.cape);
        p(3, torsoY - 1, 14, len, look.cape);
        p(3, torsoY + len - 2, 14, 1, look.lining);
        p(9, torsoY, 1, len - 3, '#2a2030');
      } else {
        p(12, headY + 5, 4, 7, look.cape);
        p(12, headY + 6, 1, 5, look.lining);
        p(6, headY + 10, 1, 1, WHITE);
      }
    },
  },

  // PM: witch — tall bent hat with a role-colour band, sash.
  witch: {
    body(p, look, { view, torsoY }) {
      if (view === 'left') p(7, torsoY + 4, 6, 1, look.band);
      else p(5, torsoY + 4, 10, 1, look.band);
    },
    front(p, look, { view, headY }) {
      const h = look.hat;
      const x0 = view === 'left' ? 1 : 2;
      const span = view === 'left' ? 16 : 16;
      p(x0, headY + 1, span, 1, h);
      p(5, headY - 1, 10, 2, h);
      p(5, headY, 10, 1, look.band);
      p(6, headY - 2, 7, 1, h);
      p(7, headY - 3, 5, 1, h);
      p(8, headY - 4, 4, 1, h);
      p(10, headY - 5, 3, 1, h);
      p(7, headY - 1, 2, 1, '#4a3563');
      if (view === 'down') p(9, headY, 2, 1, '#ffd166'); // buckle
    },
  },

  // BA: mummy — bandage wraps, dark eye slit, the role-colour tie still visible.
  mummy: {
    body(p, look, { view, torsoY, torsoH }) {
      const l = look.wrap;
      if (view === 'left') {
        p(7, torsoY + 2, 6, 1, l);
        p(7, torsoY + 5, 6, 1, l);
        return;
      }
      p(5, torsoY + 2, 4, 1, l);
      p(11, torsoY + 2, 4, 1, l);
      if (torsoH > 5) {
        p(5, torsoY + 5, 4, 1, l);
        p(11, torsoY + 5, 4, 1, l);
      }
    },
    front(p, look, { view, s, headY }) {
      const l = look.wrap;
      if (view === 'up') {
        for (const dy of [1, 4, 7, 10]) p(4, headY + dy, 12, 1, l);
        p(15, headY + 3, 2, 5, look.skin); // loose end
        return;
      }
      if (view === 'left') {
        p(5, headY + 1, 10, 1, l);
        p(5, headY + 3, 10, 1, l);
        p(5, headY + 5, 4, 3, '#3b3026');
        if (!s.blink) p(6, headY + 6, 1, 1, '#ffe9a0');
        p(5, headY + 9, 10, 1, l);
        p(15, headY + 3, 2, 6, look.skin);
        return;
      }
      p(4, headY + 1, 12, 1, l);
      p(6, headY + 3, 10, 1, l);
      p(5, headY + 5, 10, 3, '#3b3026');
      if (!s.blink) {
        p(7, headY + 6, 1, 1, '#ffe9a0');
        p(12, headY + 6, 1, 1, '#ffe9a0');
      }
      p(4, headY + 9, 4, 1, l);
      p(12, headY + 9, 4, 1, l);
      p(16, headY + 4, 1, 5, look.skin); // loose bandage end
    },
  },

  // Tech Lead: Frankenstein's monster — green skin, flat top, neck bolts, forehead stitches.
  franken: {
    front(p, look, { view, s, headY }) {
      const h = look.hair;
      const bolt = '#a3acb8';
      if (view === 'left') {
        p(5, headY - 2, 10, 3, h);
        p(10, headY + 9, 3, 2, bolt);
        p(5, headY + 4, 4, 1, h);
        return;
      }
      p(4, headY - 2, 12, 3, h);
      p(1, headY + 8, 3, 2, bolt);
      p(16, headY + 8, 3, 2, bolt);
      if (view === 'down') {
        p(6, headY + 3, 8, 1, '#2f4a2a');
        for (const x of [7, 10, 13]) p(x, headY + 4, 1, 1, '#2f4a2a');
        p(6, headY + 5, 3, 1, h);
        p(11, headY + 5, 3, 1, h);
        if (!s.talk && s.mood !== 'happy') p(8, headY + 9, 4, 1, '#2f4a2a');
      }
    },
  },

  ghost: { ghost: true, paint: paintGhost },

  // Frontend: jack-o'-lantern head with glowing carved face; role-colour shirt.
  pumpkin: {
    head(p, look, { view, s, headY }) {
      const P = '#f08a24';
      const PS = '#c25e10';
      const G = '#ffe14d';
      const dark = '#6b2a05';
      const stem = '#4f7d2b';
      p(8, headY + 11, 4, 1, stem); // vine neck
      if (view === 'left') {
        p(5, headY, 9, 1, P);
        p(4, headY + 1, 12, 9, P);
        p(5, headY + 10, 10, 1, P);
        p(10, headY + 1, 1, 9, PS);
        p(15, headY + 1, 1, 9, PS);
        p(10, headY - 2, 2, 2, stem);
        p(5, headY + 5, 2, 1, s.blink ? dark : G);
        p(5, headY + 4, 1, 1, s.blink ? P : G);
        p(4, headY + 8, 4, 1, G);
        if (s.talk) p(4, headY + 9, 3, 1, G);
        return;
      }
      p(5, headY, 10, 1, P);
      p(3, headY + 1, 14, 9, P);
      p(4, headY + 10, 12, 1, P);
      p(6, headY + 1, 1, 9, PS);
      p(13, headY + 1, 1, 9, PS);
      p(16, headY + 1, 1, 9, PS);
      p(4, headY + 2, 1, 3, '#ffad4d');
      p(9, headY - 2, 2, 2, stem);
      p(11, headY - 2, 2, 1, '#6aa84f');
      if (view === 'up') {
        p(9, headY + 1, 2, 9, PS);
        return;
      }
      const eye = s.blink ? dark : G;
      p(6, headY + 5, 3, 1, eye);
      p(11, headY + 5, 3, 1, eye);
      if (!s.blink) {
        p(7, headY + 4, 1, 1, G);
        p(12, headY + 4, 1, 1, G);
      }
      p(9, headY + 6, 2, 1, G);
      if (s.mood === 'worried') p(7, headY + 8, 6, 1, G);
      else {
        p(5, headY + 8, 10, 1, G);
        p(5, headY + 7, 1, 1, G);
        p(14, headY + 7, 1, 1, G);
        p(8, headY + 8, 1, 1, P);
        p(11, headY + 8, 1, 1, P);
        if (s.talk || s.mood === 'happy') p(7, headY + 9, 6, 1, G);
      }
    },
  },

  // Backend: skeleton — skull with role-colour eye glints, ribs on a black suit, headphones kept.
  skeleton: {
    head(p, look, { view, s, headY }) {
      const B = look.bone;
      const BS = look.boneShade;
      const hole = '#1a1520';
      p(9, headY + 11, 2, 1, BS); // neck vertebra
      if (view === 'left') {
        p(5, headY, 9, 1, B);
        p(4, headY + 1, 11, 7, B);
        p(5, headY + 8, 7, 3, B);
        p(14, headY + 1, 1, 7, BS);
        p(5, headY + 4, 3, 3, hole);
        if (!s.blink) p(6, headY + 5, 1, 1, look.glow);
        p(4, headY + 7, 1, 1, hole);
        p(5, headY + 9, 5, 1, s.talk ? hole : BS);
        return;
      }
      p(5, headY, 10, 1, B);
      p(4, headY + 1, 12, 7, B);
      p(5, headY + 8, 10, 1, B);
      p(6, headY + 9, 8, 2, B);
      p(15, headY + 1, 1, 7, BS);
      if (view === 'up') {
        p(6, headY + 9, 8, 1, BS);
        return;
      }
      p(6, headY + 4, 3, 3, hole);
      p(11, headY + 4, 3, 3, hole);
      if (!s.blink) {
        p(7, headY + 5, 1, 1, look.glow);
        p(12, headY + 5, 1, 1, look.glow);
      }
      p(9, headY + 7, 2, 1, hole);
      p(7, headY + 9, 6, 1, s.talk ? hole : BS);
      for (const x of [8, 10, 12]) p(x, headY + 10, 1, 1, BS);
    },
    body(p, look, { view, torsoY, torsoH }) {
      const B = look.bone;
      if (view === 'left') {
        for (let i = 0; i < 3; i++) p(8, torsoY + 1 + i * 2, 4, 1, B);
        return;
      }
      if (view === 'up') {
        p(9, torsoY, 2, torsoH, B);
        return;
      }
      p(9, torsoY, 2, torsoH - 1, B);
      for (let i = 0; i < 3; i++) p(6 + (i === 2 ? 1 : 0), torsoY + 1 + i * 2, i === 2 ? 6 : 8, 1, B);
    },
  },

  // DBA: werewolf — pointed ears, shaggy fur, snout, yellow eyes, torn role-colour shirt.
  werewolf: {
    body(p, look, { view, torsoY, torsoH }) {
      if (view === 'left') {
        p(8, torsoY + torsoH - 1, 1, 1, look.skin);
        p(11, torsoY + torsoH - 1, 1, 1, look.skin);
        return;
      }
      for (const x of [6, 9, 12]) p(x, torsoY + torsoH - 1, 1, 1, look.skin);
      if (view === 'down') p(9, torsoY, 2, 2, look.hair);
    },
    front(p, look, { view, s, headY }) {
      pointedEars(p, headY, view, look.hair, '#c98a7a');
      if (view === 'up') return;
      const muzzle = '#c8a27c';
      if (view === 'left') {
        p(2, headY + 7, 5, 3, muzzle);
        p(2, headY + 7, 1, 1, '#1a1520');
        if (!s.blink) p(6, headY + 6, 1, 1, '#ffd23f');
        p(5, headY + 4, 3, 1, look.hair);
        return;
      }
      p(3, headY + 5, 1, 4, look.hair);
      p(16, headY + 5, 1, 4, look.hair);
      p(6, headY + 4, 1, 1, look.hair);
      p(7, headY + 5, 2, 1, look.hair);
      p(13, headY + 4, 1, 1, look.hair);
      p(11, headY + 5, 2, 1, look.hair);
      if (!s.blink) {
        p(6, headY + 6, 2, 1, '#ffd23f');
        p(12, headY + 6, 2, 1, '#ffd23f');
        p(7, headY + 6, 1, 1, '#1a1520');
        p(12, headY + 6, 1, 1, '#1a1520');
      }
      p(7, headY + 7, 6, 3, muzzle);
      p(9, headY + 7, 2, 1, '#1a1520');
      if (s.talk) p(9, headY + 9, 2, 1, '#5a2a2a');
      p(8, headY + 10, 1, 1, WHITE);
      p(11, headY + 10, 1, 1, WHITE);
    },
  },

  // Security: grim reaper — deep hood, dark face with role-colour glowing eyes, rope belt, scythe.
  reaper: {
    head(p, look, { view, s, headY }) {
      const H = look.hood;
      const HS = look.hoodShade;
      const voidC = '#0d0b10';
      if (view === 'left') {
        p(6, headY - 2, 8, 1, H);
        p(4, headY - 1, 12, 14, H);
        p(13, headY, 3, 12, HS);
        p(4, headY + 3, 4, 8, voidC);
        if (!s.blink) p(5, headY + 6, 2, 1, look.glow);
        return;
      }
      p(6, headY - 2, 8, 1, H);
      p(4, headY - 1, 12, 1, H);
      p(3, headY, 14, 13, H);
      p(15, headY, 2, 13, HS);
      if (view === 'up') {
        p(9, headY, 1, 12, HS);
        return;
      }
      p(5, headY + 2, 1, 10, HS);
      p(7, headY + 2, 6, 1, voidC);
      p(6, headY + 3, 8, 8, voidC);
      if (!s.blink) {
        p(7, headY + 6, 2, 1, look.glow);
        p(11, headY + 6, 2, 1, look.glow);
      }
      if (s.talk) p(9, headY + 9, 2, 1, '#3a3545');
    },
    body(p, look, { view, torsoY }) {
      if (view === 'left') p(7, torsoY + 4, 6, 1, look.glow);
      else p(5, torsoY + 4, 10, 1, look.glow);
    },
    after(p, look, { view, s, headY, seated, arms }) {
      if (seated || view !== 'down' || arms !== 'down') return;
      p(17, headY, 1, 24, '#6b4a2e');
      p(12, headY - 1, 7, 1, '#c9d1d9');
      p(11, headY, 3, 1, '#c9d1d9');
      p(10, headY + 1, 2, 1, '#9aa5b1');
      if (s.pose === 'walk') p(17, headY + 24, 1, 1, '#6b4a2e');
    },
  },

  // DevOps: zombie — grey-green skin, one pale eye, scar, torn role-colour shirt, arms forward when walking.
  zombie: {
    body(p, look, { view, torsoY, torsoH }) {
      if (view === 'left') {
        p(8, torsoY + 3, 2, 1, look.skinShade);
        return;
      }
      p(6, torsoY + 3, 2, 1, look.skinShade);
      p(12, torsoY + 5, 1, 1, look.skinShade);
      for (const x of [5, 8, 13]) p(x, torsoY + torsoH - 1, 1, 1, look.pants);
    },
    front(p, look, { view, s, headY }) {
      if (view === 'up') return;
      if (view === 'left') {
        p(5, headY + 9, 3, 1, '#4a3a3a');
        return;
      }
      if (!s.blink) p(12, headY + 6, 1, 2, '#efeed8');
      p(6, headY + 8, 2, 1, '#73845e');
      p(4, headY + 3, 5, 1, '#6b4a4a');
      p(5, headY + 4, 1, 1, '#6b4a4a');
      p(7, headY + 4, 1, 1, '#6b4a4a');
      if (!s.talk && s.mood !== 'happy') {
        p(8, headY + 9, 4, 1, '#4a3a3a');
        p(10, headY + 9, 1, 1, '#e8e4cc');
      }
    },
    arms(p, look, { view, s, torsoY, sleeve, arms }) {
      if (view !== 'left' || arms !== 'down' || (s.pose !== 'walk' && s.pose !== 'stand')) return false;
      p(4, torsoY + 1, 7, 2, sleeve);
      p(2, torsoY + 1, 2, 2, look.skin);
      return true;
    },
  },

  // Freelancer: black cat — hood with ears, whiskers, role-colour collar with a bell, tail.
  blackcat: {
    back(p, look, { view, torsoY, torsoH }) {
      const fur = look.hair;
      if (view === 'down') {
        p(15, torsoY + torsoH - 2, 3, 1, fur);
        p(17, torsoY - 2, 1, torsoH + 1, fur);
        p(16, torsoY - 3, 1, 1, fur);
      } else if (view === 'left') {
        p(13, torsoY + torsoH - 2, 3, 1, fur);
        p(16, torsoY - 1, 1, torsoH, fur);
      }
    },
    front(p, look, { view, s, headY, torsoY, torsoH, seated }) {
      const fur = look.hair;
      pointedEars(p, headY, view, fur, '#e58fb0');
      if (view === 'up') {
        p(9, torsoY + torsoH - 2, 2, seated ? 2 : 5, fur);
        p(11, torsoY + torsoH + (seated ? -1 : 2), 2, 1, fur);
        p(6, torsoY, 8, 1, look.collar);
        return;
      }
      if (view === 'left') {
        p(7, torsoY, 6, 1, look.collar);
        p(1, headY + 8, 3, 1, '#d8d4e3');
        return;
      }
      p(6, torsoY, 8, 1, look.collar);
      p(9, torsoY + 1, 2, 1, '#ffe066');
      p(1, headY + 7, 4, 1, '#d8d4e3');
      p(1, headY + 9, 3, 1, '#d8d4e3');
      p(15, headY + 7, 4, 1, '#d8d4e3');
      p(16, headY + 9, 3, 1, '#d8d4e3');
      if (!s.talk && s.mood !== 'happy') p(9, headY + 8, 2, 1, '#e58fb0');
    },
  },

  // Mobile: imp — little horns and a pointed tail in the role colour, dark outfit, phone glowing eerie green.
  imp: {
    back(p, look, { view, torsoY, torsoH }) {
      const c = look.horns;
      if (view === 'down') {
        p(15, torsoY + torsoH - 2, 2, 1, c);
        p(17, torsoY, 1, torsoH - 1, c);
        p(16, torsoY - 2, 3, 1, c);
        p(17, torsoY - 3, 1, 1, c);
        p(17, torsoY - 1, 1, 1, c);
      } else if (view === 'left') {
        p(13, torsoY + torsoH - 2, 3, 1, c);
        p(16, torsoY, 1, torsoH - 1, c);
        p(15, torsoY - 2, 3, 1, c);
        p(16, torsoY - 3, 1, 1, c);
        p(16, torsoY - 1, 1, 1, c);
      }
    },
    body(p, look, { view, torsoY }) {
      if (view === 'left') p(7, torsoY + 4, 6, 1, look.horns);
      else p(5, torsoY + 4, 10, 1, look.horns);
    },
    front(p, look, { view, headY, torsoY, torsoH, seated }) {
      const c = look.horns;
      const left = view === 'left' ? 2 : 0;
      p(4 + left, headY - 2, 2, 2, c);
      p(4 + left, headY - 3, 1, 1, c);
      p(14, headY - 2, 2, 2, c);
      p(15, headY - 3, 1, 1, c);
      if (view === 'up') {
        // tail hanging down the back, arrow tip at the end
        const len = seated ? 2 : 5;
        const y = torsoY + torsoH - 2;
        p(9, y, 1, len, c);
        p(8, y + len, 3, 1, c);
        p(9, y + len + 1, 1, 1, c);
      }
    },
  },

  // Data/AI: vampire bat — scalloped wings with a role-colour membrane, bat ears over the afro, tiny fangs.
  bat: {
    back(p, look, { view, torsoY }) {
      if (view === 'down') batWings(p, look, torsoY, false);
      else if (view === 'left') {
        p(12, torsoY - 2, 4, 1, look.wing);
        p(11, torsoY - 1, 6, 6, look.wing);
        p(12, torsoY, 4, 4, look.lining);
        for (const x of [11, 13, 15]) p(x, torsoY + 5, 1, 1, look.wing);
      }
    },
    body(p, look, { view, torsoY }) {
      if (view === 'left') p(7, torsoY, 6, 1, look.lining);
      else p(5, torsoY, 10, 1, look.lining);
    },
    front(p, look, { view, s, headY, torsoY }) {
      const W = look.wing;
      p(3, headY - 5, 2, 1, W);
      p(3, headY - 4, 3, 1, W);
      p(15, headY - 5, 2, 1, W);
      p(14, headY - 4, 3, 1, W);
      if (view === 'down') {
        p(4, headY - 4, 1, 1, look.lining);
        p(15, headY - 4, 1, 1, look.lining);
        if (!s.talk) {
          p(8, headY + 10, 1, 1, WHITE);
          p(11, headY + 10, 1, 1, WHITE);
        }
      }
      if (view === 'up') batWings(p, look, torsoY, true);
    },
  },

  // Support: scarecrow — straw hat over the hijab (a crow on the brim), patched shirt in the role colour,
  // rope belt, straw tufts; the helpdesk headset stays on.
  scarecrow: {
    body(p, look, { view, torsoY, torsoH }) {
      const x0 = view === 'left' ? 7 : 5;
      const w = view === 'left' ? 6 : 10;
      p(x0, torsoY + 4, w, 1, '#c9a46a');
      if (view === 'down') {
        p(6, torsoY + 2, 2, 2, '#c95a3a');
        p(12, torsoY + 5, 2, 2, '#6b8fb8');
        p(7, torsoY + 3, 1, 1, '#f4f1ea');
      } else if (view === 'up') p(7, torsoY + 2, 3, 2, '#c95a3a');
      for (let x = x0; x < x0 + w; x += 2) p(x, torsoY + torsoH, 1, 1, look.straw);
    },
    front(p, look, { view, headY }) {
      const H = look.hat;
      p(view === 'left' ? 1 : 1, headY, view === 'left' ? 17 : 18, 1, H);
      p(2, headY + 1, 1, 2, look.straw);
      p(17, headY + 1, 1, 2, look.straw);
      p(5, headY - 3, 10, 3, H);
      p(5, headY - 1, 10, 1, '#7a3b2a');
      p(6, headY - 3, 3, 1, look.hatShade);
      p(1, headY, 3, 1, look.hatShade);
      if (view !== 'up') {
        // a crow perched on the brim
        p(15, headY - 2, 3, 2, '#1d1a22');
        p(16, headY - 3, 2, 1, '#1d1a22');
        p(14, headY - 2, 1, 1, '#e9a23b');
        p(16, headY - 2, 1, 1, '#f4f1ea');
      }
    },
  },

  // Reviewer: owl professor — feathered hood with ear tufts, beak, pale chest, role-colour bow tie, glasses, talons.
  owl: {
    body(p, look, { view, torsoY, torsoH }) {
      const c = look.tie;
      if (view === 'left') {
        p(7, torsoY + 1, 2, torsoH - 2, look.chest);
        p(7, torsoY, 2, 2, c);
        return;
      }
      if (view === 'up') {
        for (const [x, y] of [[6, 1], [12, 1], [9, 3], [6, 5], [12, 5]]) if (y < torsoH) p(x, torsoY + y, 2, 1, look.hoodShade);
        return;
      }
      p(7, torsoY + 1, 6, torsoH - 2, look.chest);
      for (const [x, y] of [[8, 3], [11, 3], [9, 5]]) if (y < torsoH - 1) p(x, torsoY + y, 1, 1, look.feather);
      p(7, torsoY, 2, 2, c);
      p(11, torsoY, 2, 2, c);
      p(9, torsoY, 2, 1, c);
    },
    front(p, look, { view, s, headY }) {
      const H = look.hood;
      const HS = look.hoodShade;
      p(3, headY - 3, 2, 2, H);
      p(15, headY - 3, 2, 2, H);
      if (view !== 'down') {
        p(3, headY - 1, 14, 12, H);
        for (const [x, y] of [[6, 2], [11, 2], [8, 5], [13, 5], [5, 8], [10, 8]]) p(x, headY + y, 2, 1, HS);
        return;
      }
      p(3, headY - 1, 14, 3, H);
      p(3, headY + 2, 2, 8, H);
      p(15, headY + 2, 2, 8, H);
      p(4, headY - 3, 1, 1, HS);
      p(15, headY - 3, 1, 1, HS);
      for (const x of [6, 9, 12]) p(x, headY, 2, 1, HS);
      p(9, headY + 8, 2, 1, '#e9a23b');
      if (s.talk) p(9, headY + 9, 2, 1, '#b5525a');
    },
  },

  ...NATAL_COSTUMES,
  ...LEBARAN_COSTUMES,
  ...AGUSTUS_COSTUMES,
};
