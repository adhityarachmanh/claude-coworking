// Lebaran (Idulfitri) costume painters — same hook contract as costumes.js. Baju koko with peci and sarung,
// gamis with a kerudung (hijab) or a selendang; gold embroidery. Merged into COSTUMES by costumes.js.

const GOLD = '#e0b84a';
export const PECI = '#2b2836';
const PECI_SHEEN = '#4d4858';
const PECI_RIM = '#121016';

/** Peci: black songkok (or a white knitted kopiah) sitting over the hairline. Also used by the 17 Agustus costumes. */
export function peci(p, view, headY, color = PECI, dots = null) {
  const x0 = view === 'left' ? 5 : 4;
  const w = view === 'left' ? 10 : 12;
  // Sits high (above the hairline) with a velvet sheen on top and a dark rim, so it reads on black hair too.
  p(x0 + 1, headY - 3, w - 2, 1, dots ? color : PECI_SHEEN);
  p(x0, headY - 2, w, 2, color);
  p(x0, headY, w, 1, dots ? '#c9c2b4' : PECI_RIM);
  if (dots) for (let x = x0 + 1; x < x0 + w; x += 2) p(x, headY - 1, 1, 1, dots);
  else p(x0 + 2, headY - 2, 3, 1, PECI_SHEEN);
}

/** Lower garment over the legs (sarung, gamis skirt): tube from the hips down to the ankles. */
function skirt(p, { view, s }, color) {
  if (s.pose === 'sofa') {
    p(5, 24, 10, 4, color);
    return null;
  }
  if (s.pose !== 'stand' && s.pose !== 'walk') return null;
  if (view === 'left') {
    p(6, 22, 8, 6, color);
    return { x: 6, w: 8 };
  }
  p(5, 22, 10, 6, color);
  return { x: 5, w: 10 };
}

/** Small held item in the free hand (standing, facing the viewer, arms down). */
function heldProp(p, look, { view, torsoY, seated, arms }) {
  if (seated || view !== 'down' || arms !== 'down' || !look.prop) return;
  if (look.prop === 'amplop') {
    // THR envelope: green with a gold seal
    p(15, torsoY + 5, 4, 3, '#2e8b57');
    p(15, torsoY + 5, 4, 1, '#1f6b45');
    p(17, torsoY + 6, 1, 1, GOLD);
  } else if (look.prop === 'toples') {
    // jar of kue kering (nastar) with a red lid
    p(15, torsoY + 3, 4, 1, '#c8102e');
    p(15, torsoY + 4, 4, 4, '#d8eef4');
    p(16, torsoY + 5, 2, 2, '#e9a23b');
  } else if (look.prop === 'ketupat') {
    p(17, torsoY + 4, 1, 1, '#8a6a3c');
    p(16, torsoY + 5, 3, 3, '#3f9b4f');
    p(17, torsoY + 6, 1, 1, '#d9c45a');
  } else if (look.prop === 'kurma') {
    // box of dates with a gold lid
    p(15, torsoY + 4, 4, 1, GOLD);
    p(15, torsoY + 5, 4, 3, '#5a2e16');
    p(16, torsoY + 5, 1, 1, '#9a5a2c');
    p(17, torsoY + 6, 1, 1, '#9a5a2c');
  } else if (look.prop === 'rantang') {
    // rantang (stacked food carrier) for silaturahmi visits
    p(15, torsoY + 2, 4, 1, '#9aa5ae');
    p(15, torsoY + 3, 1, 1, '#9aa5ae');
    p(18, torsoY + 3, 1, 1, '#9aa5ae');
    p(15, torsoY + 4, 4, 5, '#2e8b57');
    p(15, torsoY + 5, 4, 1, '#f4efe2');
    p(15, torsoY + 7, 4, 1, '#f4efe2');
  }
}

export const LEBARAN_COSTUMES = {
  // Baju koko (mandarin collar, gold embroidery down the front), peci and a checked sarung.
  koko: {
    body(p, look, ctx) {
      const { view, torsoY, torsoH } = ctx;
      const E = look.embroid;
      if (view === 'left') {
        p(7, torsoY, 4, 1, E);
        p(7, torsoY + 1, 1, torsoH - 2, E);
      } else if (view === 'down') {
        p(6, torsoY, 8, 1, E);
        p(9, torsoY + 1, 2, torsoH - 2, E);
        p(7, torsoY + 2, 1, 1, E);
        p(12, torsoY + 2, 1, 1, E);
      } else p(6, torsoY, 8, 1, E);
      const tube = skirt(p, ctx, look.sarung);
      if (!tube) return;
      p(tube.x, 22, tube.w, 1, look.sarungCheck);
      p(tube.x, 24, tube.w, 1, look.sarungCheck);
      p(tube.x, 26, tube.w, 1, look.sarungCheck);
      p(tube.x + 2, 22, 1, 6, look.sarungCheck);
      p(tube.x + tube.w - 3, 22, 1, 6, look.sarungCheck);
    },
    front(p, look, { view, headY, torsoY }) {
      peci(p, view, headY, look.peci, look.peciDots);
      // folded sajadah over the shoulder, on the way to the Ied prayer
      if (look.sajadah && view !== 'left') {
        const x = view === 'up' ? 5 : 12;
        p(x, torsoY - 1, 3, 6, look.sajadah);
        p(x + 1, torsoY, 1, 4, GOLD);
        p(x, torsoY + 5, 3, 1, '#f4efe2');
      } else if (look.sajadah) p(9, torsoY - 1, 3, 5, look.sajadah);
    },
    after: heldProp,
  },

  // Gamis: long dress to the ankles with a gold hem and waist; a kerudung (hijab hair style) or a selendang.
  gamis: {
    body(p, look, ctx) {
      const { view, torsoY, torsoH } = ctx;
      const x0 = view === 'left' ? 7 : 5;
      const w = view === 'left' ? 6 : 10;
      p(x0, torsoY + 4, w, 1, look.trim);
      if (view === 'down' && look.hairStyle !== 'hijab') p(8, torsoY, 4, 1, look.trim);
      if (view === 'down' && torsoH > 6) {
        p(7, torsoY + 6, 1, 1, look.trim);
        p(12, torsoY + 6, 1, 1, look.trim);
      }
      const tube = skirt(p, ctx, look.top);
      if (!tube) return;
      p(tube.x + tube.w - 1, 22, 1, 6, look.topShade);
      p(tube.x - 1, 24, 1, 4, look.top);
      p(tube.x + tube.w, 24, 1, 4, look.topShade);
      p(tube.x - 1, 27, tube.w + 2, 1, look.trim);
    },
    front(p, look, { view, torsoY, torsoH }) {
      if (look.hairStyle === 'hijab') {
        if (view === 'down') p(9, torsoY + 1, 2, 1, look.trim); // brooch on the kerudung
        return;
      }
      const sel = look.selendang;
      if (!sel) return;
      if (view === 'left') {
        p(7, torsoY, 6, 1, sel);
        p(11, torsoY + 1, 2, 4, sel);
      } else if (view === 'down') {
        p(5, torsoY, 10, 1, sel);
        p(12, torsoY + 1, 3, torsoH - 1, sel);
        p(12, torsoY + torsoH - 1, 3, 1, look.trim);
      } else {
        p(5, torsoY, 10, 1, sel);
        p(6, torsoY + 1, 3, torsoH - 1, sel);
      }
    },
    after: heldProp,
  },
};
