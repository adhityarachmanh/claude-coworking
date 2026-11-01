// Natal (Christmas) costume painters — same hook contract as costumes.js (back/body/head/front/arms/after,
// 20×32 sprite grid, painter y from -2). Merged into COSTUMES by costumes.js.

const WHITE = '#f4f1ea';
const INK = '#1d1424';
const RED = '#c8102e';
const GREEN = '#2e8b57';
const GOLD = '#ffd23f';
const NOSE = '#e5383b';

/** Santa hat: white fur band over the hairline, red cap drooping to the right, pompom. Also used by the cat. */
export function santaHat(p, view, headY, red = RED, trim = WHITE) {
  if (view === 'left') {
    p(5, headY, 10, 2, trim);
    p(5, headY - 1, 10, 1, red);
    p(6, headY - 2, 8, 1, red);
    p(9, headY - 3, 6, 1, red);
    p(12, headY - 4, 3, 1, red);
  } else {
    p(3, headY, 14, 2, trim);
    p(4, headY - 1, 12, 1, red);
    p(5, headY - 2, 10, 1, red);
    p(7, headY - 3, 8, 1, red);
    p(10, headY - 4, 5, 1, red);
  }
  p(15, headY - 3, 2, 2, red);
  p(16, headY - 1, 2, 2, trim);
}

/** Reindeer antlers (headband or onesie hood). */
function antlers(p, view, headY, color) {
  if (view === 'left') {
    p(8, headY - 4, 1, 3, color);
    p(10, headY - 4, 1, 2, color);
    p(9, headY - 3, 1, 1, color);
    return;
  }
  p(5, headY - 4, 1, 3, color);
  p(3, headY - 4, 1, 2, color);
  p(4, headY - 3, 1, 1, color);
  p(14, headY - 4, 1, 3, color);
  p(16, headY - 4, 1, 2, color);
  p(15, headY - 3, 1, 1, color);
}

/** Red reindeer nose (front and side). */
function rudolphNose(p, view, headY) {
  if (view === 'down') p(9, headY + 7, 2, 1, NOSE);
  else if (view === 'left') p(3, headY + 6, 2, 1, NOSE);
}

function earmuffs(p, view, headY, muff, band) {
  if (view === 'left') {
    p(8, headY - 1, 3, 1, band);
    p(9, headY + 3, 4, 4, muff);
    return;
  }
  p(5, headY - 1, 10, 1, band);
  p(2, headY + 3, 3, 4, muff);
  p(15, headY + 3, 3, 4, muff);
}

/** Knitted pattern on the torso: zigzag, a dotted band, optional centre motif and ribbed hem. */
function knit(p, look, { view, torsoY, torsoH }) {
  const x0 = view === 'left' ? 7 : 5;
  const w = view === 'left' ? 6 : 10;
  p(x0, torsoY, w, 1, look.topShade);
  for (let x = x0; x < x0 + w; x++) p(x, torsoY + 1 + ((x + 1) % 2), 1, 1, look.knit);
  for (let x = x0 + 1; x < x0 + w; x += 2) p(x, torsoY + 3, 1, 1, look.band);
  if (view === 'down' && look.motif === 'tree') {
    p(9, torsoY + 4, 2, 1, GREEN);
    p(8, torsoY + 5, 4, 1, GREEN);
  } else if (view === 'down' && look.motif === 'star') {
    p(9, torsoY + 4, 2, 2, GOLD);
  }
  if (torsoH > 6) p(x0, torsoY + torsoH - 1, w, 1, look.topShade);
}

export const NATAL_COSTUMES = {
  // Lead: Santa — red suit with fur trim and belt, white beard, Santa hat, a sack in the role colour.
  santa: {
    back(p, look, { view, torsoY, seated }) {
      if (view === 'down' && !seated) {
        p(15, torsoY - 4, 4, 7, look.sack);
        p(16, torsoY - 5, 2, 1, '#6b3a1e');
      } else if (view === 'left') {
        p(13, torsoY - 3, 5, seated ? 7 : 9, look.sack);
        p(14, torsoY - 4, 3, 1, '#6b3a1e');
      }
    },
    body(p, look, { view, torsoY, torsoH }) {
      const x0 = view === 'left' ? 7 : 5;
      const w = view === 'left' ? 6 : 10;
      if (view === 'down') p(9, torsoY, 2, torsoH, look.trim);
      p(x0, torsoY + 4, w, 1, INK);
      if (view !== 'up') p(view === 'left' ? 8 : 9, torsoY + 4, 2, 1, GOLD);
      if (torsoH > 6) p(x0, torsoY + torsoH - 1, w, 1, look.trim);
    },
    front(p, look, { view, s, headY, torsoY, seated }) {
      const B = look.beard;
      if (view === 'up') {
        p(4, torsoY - 2, 12, seated ? 7 : 9, look.sack);
        p(9, torsoY - 3, 2, 1, '#6b3a1e');
      } else if (view === 'down') {
        p(4, headY + 6, 1, 4, B);
        p(15, headY + 6, 1, 4, B);
        p(5, headY + 8, 10, 3, B);
        p(6, headY + 11, 8, 1, B);
        if (s.talk || s.mood === 'happy') p(9, headY + 9, 2, 1, '#b5525a');
      } else {
        p(4, headY + 7, 6, 4, B);
        p(5, headY + 11, 4, 1, B);
      }
      santaHat(p, view, headY, RED, look.trim);
    },
  },

  // PM: elf — green tunic with a zigzag collar and hem in the role colour, belt, pointy hat with a bell, pointy ears.
  elf: {
    body(p, look, { view, torsoY, torsoH }) {
      const x0 = view === 'left' ? 7 : 5;
      const w = view === 'left' ? 6 : 10;
      for (let x = x0; x < x0 + w; x++) {
        p(x, torsoY, 1, view === 'down' && x % 2 ? 2 : 1, look.collar);
        if (x % 2 === 0) p(x, torsoY + torsoH - 1, 1, 1, look.collar);
      }
      p(x0, torsoY + 4, w, 1, '#3b2a1e');
      if (view !== 'up') p(view === 'left' ? 8 : 9, torsoY + 4, 2, 1, GOLD);
    },
    front(p, look, { view, headY }) {
      const H = look.hat;
      const left = view === 'left';
      p(left ? 5 : 4, headY, left ? 10 : 12, 1, look.collar);
      p(left ? 6 : 5, headY - 1, left ? 9 : 10, 1, H);
      p(left ? 8 : 7, headY - 2, left ? 8 : 9, 1, H);
      p(left ? 11 : 10, headY - 3, left ? 6 : 7, 1, H);
      p(14, headY - 4, 4, 1, H);
      p(left ? 6 : 5, headY - 1, 3, 1, look.hatShade);
      p(18, headY - 4, 1, 2, GOLD); // bell
      if (left) {
        p(12, headY + 4, 2, 2, look.skin);
        p(13, headY + 3, 1, 1, look.skin);
        return;
      }
      p(3, headY + 5, 1, 2, look.skin);
      p(2, headY + 4, 1, 2, look.skin);
      p(16, headY + 5, 1, 2, look.skin);
      p(17, headY + 4, 1, 2, look.skin);
    },
  },

  // Knitted Christmas sweater in the role colour; topped with a Santa hat, antlers or earmuffs (or a hijab + holly pin).
  sweater: {
    body: knit,
    front(p, look, { view, headY, torsoY }) {
      if (look.hat === 'santa') santaHat(p, view, headY);
      else if (look.hat === 'antlers') {
        if (view !== 'left') p(5, headY - 1, 10, 1, '#6b4a2e');
        antlers(p, view, headY, '#a0703f');
        rudolphNose(p, view, headY);
      } else if (look.hat === 'earmuffs') earmuffs(p, view, headY, WHITE, RED);
      if (look.pin && view === 'down') {
        p(12, torsoY, 2, 1, GREEN);
        p(13, torsoY + 1, 1, 1, NOSE);
        p(12, torsoY + 1, 1, 1, '#9e0c24');
      }
    },
  },

  // Tech Lead: nutcracker — tall black hat with gold brim, red jacket with epaulettes, role-colour sash, white beard.
  nutcracker: {
    body(p, look, { view, torsoY, torsoH }) {
      const c = look.sash;
      if (view === 'left') {
        p(7, torsoY, 2, 1, GOLD);
        p(9, torsoY + 1, 2, torsoH - 2, c);
        return;
      }
      p(5, torsoY, 2, 1, GOLD);
      p(13, torsoY, 2, 1, GOLD);
      for (let i = 0; i < torsoH - 1; i++) p(view === 'up' ? 12 - i : 6 + i, torsoY + i, 2, 1, c);
    },
    front(p, look, { view, s, headY }) {
      const left = view === 'left';
      p(5, headY - 2, 10, 3, look.hat);
      p(5, headY - 2, 10, 1, '#3a3540');
      p(4, headY + 1, left ? 11 : 12, 1, GOLD);
      if (!left) p(9, headY - 1, 2, 2, GOLD);
      if (view === 'up') return;
      const B = look.beard;
      if (left) {
        p(4, headY + 8, 5, 3, B);
        return;
      }
      p(4, headY + 7, 1, 3, B);
      p(15, headY + 7, 1, 3, B);
      p(5, headY + 9, 10, 2, B);
      p(7, headY + 8, 6, 1, B);
      if (s.talk) p(9, headY + 9, 2, 1, '#5a2a2a'); // the nutcracker jaw
    },
  },

  // Snowman: round snow head with coal eyes and carrot nose, coal buttons, role-colour mittens; top hat or beanie.
  snowman: {
    head(p, look, { view, s, headY }) {
      const S = look.snow;
      const SS = look.snowShade;
      const coal = '#2a2a33';
      const carrot = '#f08a24';
      if (view === 'left') {
        p(5, headY, 9, 1, S);
        p(4, headY + 1, 11, 9, S);
        p(5, headY + 10, 9, 1, S);
        p(14, headY + 1, 1, 9, SS);
        p(6, s.blink ? headY + 5 : headY + 4, 1, s.blink ? 1 : 2, coal);
        p(1, headY + 6, 3, 1, carrot);
        p(5, headY + 8, 1, 1, coal);
        p(6, headY + 9, 1, 1, coal);
        return;
      }
      p(5, headY, 10, 1, S);
      p(4, headY + 1, 12, 9, S);
      p(5, headY + 10, 10, 1, S);
      p(15, headY + 1, 1, 9, SS);
      if (view === 'up') return;
      p(7, s.blink ? headY + 5 : headY + 4, 1, s.blink ? 1 : 2, coal);
      p(12, s.blink ? headY + 5 : headY + 4, 1, s.blink ? 1 : 2, coal);
      p(9, headY + 6, 3, 1, carrot);
      p(5, headY + 7, 1, 1, '#f6b9c9');
      p(14, headY + 7, 1, 1, '#f6b9c9');
      if (s.talk) p(9, headY + 8, 2, 2, coal);
      else if (s.mood === 'worried') {
        p(7, headY + 9, 1, 1, coal);
        p(9, headY + 8, 2, 1, coal);
        p(12, headY + 9, 1, 1, coal);
      } else {
        p(7, headY + 8, 1, 1, coal);
        p(8, headY + 9, 1, 1, coal);
        p(10, headY + 9, 1, 1, coal);
        p(12, headY + 8, 1, 1, coal);
      }
    },
    body(p, look, { view, torsoY }) {
      if (view === 'up') return;
      const x = view === 'left' ? 8 : 9;
      const w = view === 'left' ? 1 : 2;
      p(x, torsoY + 2, w, 1, '#2a2a33');
      p(x, torsoY + 4, w, 1, '#2a2a33');
    },
    front(p, look, { view, headY, torsoY }) {
      if (look.hatType === 'beanie') {
        p(view === 'left' ? 5 : 4, headY - 2, view === 'left' ? 10 : 12, 3, look.hat);
        p(view === 'left' ? 4 : 3, headY + 1, view === 'left' ? 12 : 14, 1, look.hatShade);
        p(9, headY - 3, 2, 1, WHITE);
      } else {
        p(6, headY - 2, 8, 3, look.hat);
        p(6, headY, 8, 1, look.hatBand);
        p(4, headY + 1, 12, 1, look.hat);
      }
      const sc = look.scarf;
      if (view === 'left') {
        p(5, torsoY - 1, 10, 2, sc);
        p(13, torsoY + 1, 2, 4, sc);
        return;
      }
      p(4, torsoY - 1, 12, 2, sc);
      p(view === 'up' ? 6 : 12, torsoY + 1, 2, 4, sc);
    },
  },

  // Backend: reindeer onesie — brown hood with antlers and ears, red nose, light belly, headphones in the role colour.
  reindeer: {
    body(p, look, { view, torsoY, torsoH }) {
      if (view === 'down') p(7, torsoY + 3, 6, torsoH - 3, look.belly);
      else if (view === 'left') p(7, torsoY + 3, 2, torsoH - 4, look.belly);
      else p(9, torsoY + torsoH - 2, 2, 2, WHITE); // tail
    },
    front(p, look, { view, headY }) {
      antlers(p, view, headY, look.antler);
      if (view === 'left') p(12, headY + 1, 3, 2, look.hair);
      else {
        p(1, headY + 1, 2, 2, look.hair);
        p(17, headY + 1, 2, 2, look.hair);
        if (view === 'down') {
          p(2, headY + 1, 1, 1, '#e8a0a0');
          p(17, headY + 1, 1, 1, '#e8a0a0');
        }
      }
      rudolphNose(p, view, headY);
    },
  },

  // DevOps: Christmas tree — green cone over the head with a gold star, ornaments and a role-colour garland.
  xtree: {
    body(p, look, { view, torsoY, torsoH }) {
      const c = look.tinsel;
      if (view === 'left') {
        p(7, torsoY + 1, 3, 1, c);
        p(10, torsoY + 2, 3, 1, c);
        p(8, torsoY + 4, 1, 1, NOSE);
        p(11, torsoY + 5, 1, 1, GOLD);
        return;
      }
      p(5, torsoY + 1, 4, 1, c);
      p(9, torsoY + 2, 3, 1, c);
      p(12, torsoY + 3, 3, 1, c);
      p(5, torsoY + 4, 3, 1, c);
      p(8, torsoY + 5, 3, 1, c);
      p(7, torsoY + 3, 1, 1, NOSE);
      p(13, torsoY + 1, 1, 1, GOLD);
      p(11, torsoY + 4, 1, 1, '#4dabf7');
      p(4, torsoY + torsoH - 1, 12, 1, look.tree);
    },
    front(p, look, { view, headY }) {
      const T = look.tree;
      p(7, headY - 1, 6, 1, T);
      p(5, headY, 10, 1, T);
      if (view === 'left') p(5, headY + 1, 11, 2, T);
      else {
        p(4, headY + 1, 12, 2, T);
        p(2, headY + 3, 2, 2, T);
        p(16, headY + 3, 2, 2, T);
        p(6, headY + 1, 1, 1, GOLD);
        p(12, headY + 2, 1, 1, NOSE);
        p(9, headY, 1, 1, look.tinsel);
      }
      p(6, headY, 2, 1, look.treeLight);
      p(9, headY - 4, 2, 1, GOLD);
      p(8, headY - 3, 4, 1, GOLD);
      p(9, headY - 2, 2, 1, GOLD);
    },
  },

  // Freelancer: wrapped present — red box over the torso with a role-colour ribbon and a bow on the head.
  gift: {
    body(p, look, { view, torsoY, torsoH, seated }) {
      const h = seated ? torsoH + 1 : torsoH + 3;
      const c = look.ribbon;
      if (view === 'left') {
        p(6, torsoY - 1, 9, h, look.box);
        p(14, torsoY - 1, 1, h, look.boxShade);
        p(10, torsoY - 1, 1, h, c);
        p(6, torsoY + 3, 9, 1, c);
        return;
      }
      p(4, torsoY - 1, 12, h, look.box);
      p(15, torsoY - 1, 1, h, look.boxShade);
      p(9, torsoY - 1, 2, h, c);
      p(4, torsoY + 3, 12, 1, c);
    },
    front(p, look, { view, headY }) {
      const c = look.ribbon;
      const x = view === 'left' ? 7 : 6;
      p(x, headY - 3, 3, 2, c);
      p(x + 5, headY - 3, 3, 2, c);
      p(x + 3, headY - 2, 2, 2, c);
      p(x + 3, headY - 2, 2, 1, look.ribbonShade);
    },
  },
};
