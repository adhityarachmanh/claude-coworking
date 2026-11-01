// Office themes. One object per theme; adding a theme = adding an entry to THEMES:
//   label, icon        – shown in ⚙ Pengaturan
//   looks[role](color) – costume overrides merged onto the role's base look (role colour stays an accent);
//                        roles without an entry keep their normal look
//   colors             – world palette remap (kantor colour → theme colour) for floors, walls, furniture
//   cat                – cat palette
//   decor              – { paintStatic(g), furniture(), overlay(g, t), lights(t) } extra scenery (decor.js)
//   sky                – window sky override; light – lighting tint/glows (see world.js drawLighting)
// The active theme lives in `theme.current` (mutable object, see app.js module rules); features/theme.js
// switches it, persists it and redraws.
import { CAST } from './cast.js';
import { HALLOWEEN_DECOR } from './decor.js';

export const theme = { current: 'kantor' };

const KANTOR_CAT = { fur: '#f0a050', stripe: '#c8752e', eye: '#2a1e2c', closed: '#2a1e2c', nose: '#e07a7a', outline: '#2a1e2c' };

// ---------- Halloween ----------

const ghost = (sheet, sheetShade, extra) => ({ costume: 'ghost', float: true, alpha: 0.86, sheet, sheetShade, ...extra });

const HALLOWEEN_LOOKS = {
  claude: (c) => ({ costume: 'vampire', skin: '#efe9f3', skinShade: '#d4cade', blush: '#e7b9c9', hair: '#17121c', hairShade: '#2c2333', hairStyle: 'short', top: '#2a2133', topShade: '#1a1420', topStyle: 'blazer', pants: '#211a28', pantsShade: '#140f19', shoes: '#0e0b12', cape: '#1a1320', lining: c }),
  pm: (c) => ({ costume: 'witch', hair: '#3b2352', hairShade: '#5a3a78', hairStyle: 'long', top: '#3a2552', topShade: '#2a1a3d', topStyle: 'plain', pants: '#3a2552', pantsShade: '#2a1a3d', shoes: '#15111a', hat: '#2a1b3a', band: c }),
  ba: (c) => ({ costume: 'mummy', skin: '#e8dfc8', skinShade: '#cfc3a6', blush: '#e8dfc8', hair: '#e8dfc8', hairShade: '#cfc3a6', hairStyle: 'buzz', top: '#e8dfc8', topShade: '#cfc3a6', topStyle: 'tie', accent: c, pants: '#ddd3b9', pantsShade: '#c5b999', shoes: '#bdb194', wrap: '#bfb293' }),
  architect: () => ({ costume: 'franken', skin: '#93c47d', skinShade: '#78a865', blush: '#80b06a', hair: '#1b1b20', hairShade: '#2f2f38', hairStyle: 'buzz', pants: '#2b2d42', shoes: '#1a1a20' }),
  'ui-ux': (c) => ghost('#f1f2f8', '#c9cbe0', { bow: true, accent: c, cheeks: '#f6b9c9' }),
  frontend: () => ({ costume: 'pumpkin', skin: '#f0c4a0', skinShade: '#d8a986', pants: '#2a2f3a', shoes: '#1f2229' }),
  backend: (c) => ({ costume: 'skeleton', skin: '#efe9dc', skinShade: '#cdc5b3', bone: '#efe9dc', boneShade: '#cdc5b3', glow: c, top: '#1c1b22', topShade: '#121117', topStyle: 'plain', pants: '#1c1b22', pantsShade: '#121117', shoes: '#efe9dc', acc: ['headphones'], accColor: c }),
  dba: () => ({ costume: 'werewolf', skin: '#8d6a4d', skinShade: '#715339', blush: '#8d6a4d', hair: '#5b3f2c', hairShade: '#76543c', hairStyle: 'curly', topStyle: 'plain', pants: '#3a3a48', shoes: '#2a1f18' }),
  qa: (c) => ghost('#d8f3ec', '#a9d6cb', { scarf: true, accent: c, mouth: 'o' }),
  security: (c) => ({ costume: 'reaper', skin: '#e6e0d2', skinShade: '#c9c2b0', hood: '#34313f', hoodShade: '#24222c', glow: c, top: '#2b2935', topShade: '#1e1c26', topStyle: 'plain', pants: '#2b2935', pantsShade: '#1e1c26', shoes: '#1e1c26' }),
  devops: () => ({ costume: 'zombie', skin: '#a3b58c', skinShade: '#879a72', blush: '#8fa279', hair: '#2e2a1f', hairShade: '#4a4232', hairStyle: 'curly', topStyle: 'plain', pants: '#3b4a5c', pantsShade: '#2f3b4a', shoes: '#3a2f28' }),
  writer: (c) => ghost('#ece6ff', '#c3b8e6', { small: true, glasses: true, lantern: true, accent: c }),
  freelancer: (c) => ({ costume: 'blackcat', hair: '#211e29', hairShade: '#2e2a38', hairStyle: 'hijab', top: '#211e29', topShade: '#16141b', topStyle: 'plain', pants: '#211e29', pantsShade: '#16141b', shoes: '#16141b', collar: c }),
};

// Kantor colour → Halloween colour: darker, purple-tinted floors and walls, plum sofa, orange accents.
const HALLOWEEN_COLORS = {
  // wood floor
  '#c9a57a': '#4d3b52', '#c39e72': '#47364c', '#b48e64': '#3a2c3f',
  // pantry tiles
  '#e7e0d3': '#433a4f', '#dad1c1': '#3a3245', '#a98a64': '#2e2433',
  // boss carpet + rug
  '#5a2f33': '#3a1a2c', '#52292d': '#331726', '#c9a227': '#d9741f', '#7a2e35': '#4a1830', '#86343b': '#55203a',
  // rugs
  '#8b3a3a': '#5a2d6b', '#a24848': '#6b3a7d', '#c98b6b': '#5b2f4f', '#d69b7b': '#6a3a5c',
  // walls
  '#5e4a3a': '#22172a', '#efe5d4': '#4e3d5e', '#e6d9c3': '#463655', '#e2d3b9': '#3e2f4c', '#d2bf9f': '#352842',
  '#e8ddd0': '#4a3a58', '#8a5a3b': '#3d2436', '#a87648': '#4d3043', '#7a4e33': '#2e1a28', '#97806a': '#2a1f33',
  '#dfe9ec': '#3e3752', '#ccdade': '#373049', '#7a6248': '#2a2030', '#bfa88a': '#3d3048',
  '#c4ad92': '#4c3e52', '#a99278': '#3d3142', '#7b6650': '#2a2030', '#6e4b30': '#3a2a30',
  // furniture: desks, counter, tables, sofa
  '#c4935f': '#5e4450', '#d8ab78': '#70545f', '#94673f': '#48323c',
  '#a3826a': '#4b3a45', '#bf9c82': '#5c4855', '#a7835f': '#5a4048', '#c19b75': '#6b4f58', '#86643f': '#46313a',
  '#4f7299': '#5b3a6e', '#6a8fb8': '#6e4a85', '#5e83ad': '#64427a', '#7aa0c9': '#7a5592', '#45678c': '#4a2f5c', '#f2c14e': '#e8742a',
  '#e3e9ee': '#a9a6ba', '#f5f8fa': '#c2bfd2', '#b8c2ca': '#8f8ca2', '#9aa5ae': '#77748a',
  // plants: a little withered
  '#3d8b5a': '#3f6b45', '#4caf72': '#4f8752', '#5cc282': '#5f9a5c', '#b5653b': '#8a4a2b', '#cf7a4c': '#a35a35',
};

export const THEMES = {
  kantor: {
    id: 'kantor',
    label: 'Kantor',
    icon: '🏢',
    looks: {},
    colors: null,
    cat: KANTOR_CAT,
    decor: null,
    sky: null,
    light: null,
  },
  halloween: {
    id: 'halloween',
    label: 'Halloween',
    icon: '🎃',
    looks: HALLOWEEN_LOOKS,
    colors: HALLOWEEN_COLORS,
    cat: { fur: '#2b2733', stripe: '#38333f', eye: '#ffd23f', closed: '#8a8494', nose: '#c46a8a', outline: '#0e0b12' },
    decor: HALLOWEEN_DECOR,
    // Windows always show a moonlit purple night.
    sky: { top: '#24163d', bottom: '#4a2550', moon: '#f6efc4', star: '#e9e2ff' },
    // Tint over the whole office (stronger at night) + warm lamp glows; candles/pumpkins add their own.
    light: { tint: 'rgba(36,10,58,.30)', nightTint: 'rgba(16,6,36,.46)', lamp: 'rgba(255,140,60,.13)', lampNight: 'rgba(255,140,60,.20)' },
  },
};

export const THEME_IDS = Object.keys(THEMES);
export const isTheme = (id) => Object.hasOwn(THEMES, id);
export const activeTheme = () => THEMES[theme.current] ?? THEMES.kantor;

const lookCache = new Map();

/**
 * The look to paint for a base look under the active theme. Kantor (no override) returns the very same
 * object, so the default rendering is untouched. Themed looks get their own id (sprite cache key).
 */
export function themedLook(look) {
  const t = activeTheme();
  const costume = t.looks[look.id];
  if (!costume) return look;
  const key = `${t.id}|${look.id}`;
  let themed = lookCache.get(key);
  if (!themed) {
    const color = CAST[look.id]?.color ?? look.top;
    // Base accessories (glasses, caps, beards) belong to the office outfit: costumes start without them.
    themed = { ...look, acc: [], accColor: undefined, sleeve: undefined, ...costume(color), id: `${look.id}@${t.id}` };
    lookCache.set(key, themed);
  }
  return themed;
}
