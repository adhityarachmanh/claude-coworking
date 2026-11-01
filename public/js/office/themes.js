// Office themes. One object per theme; adding a theme = adding an entry to THEMES:
//   label, icon        – shown in ⚙ Pengaturan
//   looks[role](color) – costume overrides merged onto the role's base look (role colour stays an accent);
//                        roles without an entry keep their normal look
//   colors             – world palette remap (kantor colour → theme colour) for floors, walls, furniture
//   cat                – cat palette; optional wear(p, state) paints an accessory (Santa hat, peci, bandana)
//   decor              – { paintStatic(g), furniture(), overlay(g, t), lights(t), sky?(r, sky, wx, t) } extra
//                        scenery (decor.js, decor-<theme>.js); sky() paints the window view itself
//   sky                – window sky colours; light – lighting tint/glows/beams (see world.js drawLighting)
// The active theme lives in `theme.current` (mutable object, see app.js module rules); features/theme.js
// switches it, persists it and redraws.
import { CAST } from './cast.js';
import { HALLOWEEN_DECOR } from './decor.js';
import { AGUSTUS_DECOR } from './decor-agustus.js';
import { LEBARAN_DECOR } from './decor-lebaran.js';
import { NATAL_DECOR } from './decor-natal.js';

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
  mobile: (c) => ({ costume: 'imp', top: '#3b1f3f', topShade: '#2a152d', topStyle: 'plain', pants: '#3b1f3f', pantsShade: '#2a152d', shoes: '#1a1220', horns: c, gadgetGlow: '#b6ff6b' }),
  data: (c) => ({ costume: 'bat', top: '#2b2735', topShade: '#1d1a25', topStyle: 'plain', pants: '#2b2735', pantsShade: '#1d1a25', shoes: '#16131c', wing: '#40384d', wingShade: '#2a2433', lining: c, acc: ['glasses'] }),
  support: (c) => ({ costume: 'scarecrow', top: c, topShade: shade(c), topStyle: 'plain', pants: '#4a6fa5', pantsShade: '#3a5a88', shoes: '#5e3a1e', hat: '#d9b45a', hatShade: '#b8913d', straw: '#f2d36b', acc: ['headset'], accColor: '#dfe3e8' }),
  reviewer: (c) => ({ costume: 'owl', top: '#7a5a3c', topShade: '#5e4430', topStyle: 'plain', pants: '#5e4430', pantsShade: '#4a3524', shoes: '#e9a23b', hood: '#7a5a3c', hoodShade: '#5e4430', chest: '#efe0c0', feather: '#a07a52', tie: c, acc: ['glasses'] }),
  // A countess in a mauve-lined cape (the Lead's vampire costume, her own palette and long hair).
  compliance: (c) => ({ costume: 'vampire', skin: '#f1eaee', skinShade: '#d8ccd4', blush: '#e9bccb', hair: '#1e1418', hairShade: '#3a2830', hairStyle: 'long', top: '#2e2230', topShade: '#1f1720', topStyle: 'blazer', pants: '#261c28', pantsShade: '#18111a', shoes: '#120d14', cape: '#3a1f33', lining: c }),
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

/** Darker variant of a #rrggbb colour (shade for role-colour garments). */
function shade(hex, f = 0.78) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) * f).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

// Shared Kantor-colour → theme-colour keys: boss carpet + rug, door/pantry rugs, sofa.
const remap = (carpet, carpetLine, bossRug, bossRugIn, doorRug, doorRugIn, pantryRug, pantryRugIn, sofa, sofaTop, sofaSeat, sofaSeatTop, sofaSide, cushion) => ({
  '#5a2f33': carpet, '#52292d': carpetLine, '#7a2e35': bossRug, '#86343b': bossRugIn,
  '#8b3a3a': doorRug, '#a24848': doorRugIn, '#c98b6b': pantryRug, '#d69b7b': pantryRugIn,
  '#4f7299': sofa, '#6a8fb8': sofaTop, '#5e83ad': sofaSeat, '#7aa0c9': sofaSeatTop, '#45678c': sofaSide, '#f2c14e': cushion,
});

// ---------- Natal ----------

const XRED = '#c8102e';
const XRED_SHADE = '#9e0c24';
const XGREEN = '#2e8b57';
const SNOW = '#f4f1ea';

const sweater = (c, extra) => ({ costume: 'sweater', top: c, topShade: shade(c), topStyle: 'plain', knit: SNOW, band: XRED, ...extra });
const snowman = (extra) => ({ costume: 'snowman', snow: '#f4f6fb', snowShade: '#cfd8e6', top: '#f4f6fb', topShade: '#cfd8e6', topStyle: 'plain', pants: '#e8eef7', pantsShade: '#cfd8e6', shoes: '#2a2a33', hat: '#1d1424', hatBand: XRED, ...extra });

const NATAL_LOOKS = {
  claude: (c) => ({ costume: 'santa', hair: '#e8e4dc', hairShade: '#cfc9be', hairStyle: 'short', top: XRED, topShade: XRED_SHADE, topStyle: 'plain', pants: XRED, pantsShade: XRED_SHADE, shoes: '#1d1424', trim: SNOW, beard: SNOW, sack: c }),
  pm: (c) => ({ costume: 'elf', top: XGREEN, topShade: '#23704a', topStyle: 'plain', pants: XRED, pantsShade: XRED_SHADE, shoes: XGREEN, hat: XGREEN, hatShade: '#23704a', collar: c }),
  ba: (c) => sweater(c, { motif: 'star', hat: 'santa', acc: ['glasses'] }),
  architect: (c) => ({ costume: 'nutcracker', hair: SNOW, hairShade: '#d6d0c4', top: XRED, topShade: XRED_SHADE, topStyle: 'plain', pants: SNOW, pantsShade: '#d6d0c4', shoes: '#1d1424', hat: '#1d1424', sash: c, beard: SNOW, acc: ['glasses'] }),
  'ui-ux': (c) => sweater(c, { hair: '#b3122e', hairShade: '#8e0e24', band: XGREEN, motif: 'tree', pin: true }),
  frontend: (c) => snowman({ skin: c, skinShade: shade(c), hatType: 'top', scarf: c }),
  backend: (c) => ({ costume: 'reindeer', hairStyle: 'hijab', hair: '#8a5a3b', hairShade: '#6e4527', top: '#8a5a3b', topShade: '#6e4527', topStyle: 'plain', pants: '#8a5a3b', pantsShade: '#6e4527', shoes: '#3b2a1e', belly: '#e8cfa8', antler: '#d8b98a', acc: ['headphones'], accColor: c }),
  dba: (c) => sweater(c, { band: XGREEN, motif: 'tree', hat: 'antlers' }),
  qa: (c) => sweater(c, { hair: '#1f7a4a', hairShade: '#17603a', motif: 'star', pin: true }),
  security: (c) => snowman({ skin: XGREEN, skinShade: '#23704a', hatType: 'beanie', hat: c, hatShade: shade(c), scarf: XGREEN }),
  devops: (c) => ({ costume: 'xtree', hairStyle: 'short', top: '#1f6b3a', topShade: '#17552e', topStyle: 'plain', pants: '#5e3a1e', pantsShade: '#4a2d16', tree: '#1f6b3a', treeLight: XGREEN, tinsel: c, acc: ['beard'] }),
  writer: (c) => sweater(c, { motif: 'tree', band: XGREEN, hat: 'earmuffs', acc: ['glasses'] }),
  freelancer: (c) => ({ costume: 'gift', top: XRED, topShade: XRED_SHADE, topStyle: 'plain', box: XRED, boxShade: XRED_SHADE, ribbon: c, ribbonShade: shade(c) }),
  mobile: (c) => ({ costume: 'gingerbread', skin: '#b8733a', skinShade: '#94592a', top: '#b8733a', topShade: '#94592a', topStyle: 'plain', pants: '#b8733a', pantsShade: '#94592a', shoes: '#94592a', icing: '#fbf6ee', gum: c, gadgetGlow: '#ffd23f' }),
  data: (c) => sweater(c, { motif: 'snowflake', hat: 'pompom', acc: ['glasses'] }),
  support: (c) => ({ costume: 'elf', top: XRED, topShade: XRED_SHADE, topStyle: 'plain', pants: XGREEN, pantsShade: '#23704a', shoes: XRED, hat: XRED, hatShade: XRED_SHADE, collar: c, ears: false, acc: ['headset'], accColor: SNOW }),
  reviewer: (c) => ({ costume: 'caroler', top: '#24543f', topShade: '#1b4030', topStyle: 'plain', pants: '#2b2d42', pantsShade: '#22253a', shoes: '#1d1424', scarf: c, hat: '#1d1424', hatBand: XGREEN, scroll: '#f4efe2', acc: ['glasses'] }),
  compliance: (c) => sweater(c, { motif: 'star', band: XGREEN, hat: 'earmuffs' }),
};

const NATAL_COLORS = remap('#24503a', '#1f4632', '#8e1b2b', '#a3222f', '#1f6b45', XGREEN, '#a3222f', '#c8243a', '#2e6b4a', '#3f8a62', '#367a56', '#4f9d72', '#245a3d', '#e5383b');

/** Cat in a Santa hat (16×12 cat sprite: sleep / sit / walk). */
function santaCat(p, state) {
  if (state === 'sleep') {
    p(10, 3, 4, 1, SNOW);
    p(10, 2, 4, 1, XRED);
    p(12, 1, 3, 1, XRED);
    p(15, 1, 1, 2, SNOW);
  } else if (state === 'sit') {
    p(4, 1, 8, 1, SNOW);
    p(5, 0, 6, 1, XRED);
    p(11, 0, 2, 1, XRED);
    p(13, 0, 1, 2, SNOW);
  } else {
    p(1, 2, 5, 1, SNOW);
    p(1, 1, 5, 1, XRED);
    p(2, 0, 3, 1, XRED);
    p(5, 0, 2, 1, XRED);
    p(7, 0, 1, 2, SNOW);
  }
}

// ---------- Lebaran ----------

const LGOLD = '#e0b84a';
const LGREEN = '#2c7a4b';
const CREAM = '#f4efe2';

const koko = (top, sarung, extra) => ({ costume: 'koko', top, topShade: shade(top, 0.86), topStyle: 'plain', embroid: LGOLD, sarung, sarungCheck: shade(sarung, 0.74), pants: sarung, pantsShade: shade(sarung, 0.74), shoes: '#5e3a1e', ...extra });
const kopiah = { peci: '#f4f1ea', peciDots: '#d6d0c4' };
const gamis = (top, extra) => ({ costume: 'gamis', top, topShade: shade(top), topStyle: 'plain', pants: top, pantsShade: shade(top), trim: LGOLD, shoes: '#e9e4dc', ...extra });

const LEBARAN_LOOKS = {
  claude: (c) => koko(CREAM, c, { embroid: '#c9a227', prop: 'amplop' }),
  pm: (c) => gamis(c, { hairStyle: 'hijab', hair: '#7e3a64', hairShade: '#652c50' }),
  ba: (c) => koko(c, LGREEN, { acc: ['glasses'] }),
  architect: (c) => koko(c, '#6b2a33', { acc: ['glasses', 'beard'] }),
  'ui-ux': (c) => gamis(c, {}), // keeps her own pink hijab
  frontend: (c) => gamis(c, { selendang: LGOLD, trim: '#f4e3b0' }),
  backend: (c) => koko(c, '#b08a3e', kopiah),
  dba: (c) => koko(c, '#1f6b4a', { embroid: '#f4e3b0', prop: 'toples' }),
  qa: (c) => gamis(c, { hair: '#1f7a4a', hairShade: '#17603a', trim: '#fff1c2' }),
  security: (c) => koko(CREAM, c, { embroid: LGREEN }),
  devops: (c) => koko(c, '#2b4a6b', { ...kopiah, acc: ['beard'], prop: 'ketupat' }),
  writer: (c) => gamis(c, { selendang: LGREEN, acc: ['glasses'] }),
  freelancer: (c) => gamis(c, { selendang: '#1f6b4a', trim: CREAM }),
  mobile: (c) => gamis(c, { selendang: '#2b4a8b', gadgetGlow: '#b6f0c8' }), // video call with family back home
  data: (c) => koko(c, '#5b4a3a', { ...kopiah, acc: ['glasses'], prop: 'kurma' }),
  support: (c) => gamis(c, { trim: CREAM, prop: 'rantang' }), // keeps her own navy hijab
  reviewer: (c) => koko(c, '#2f4858', { sajadah: LGREEN, acc: ['glasses'] }),
  compliance: (c) => gamis(c, { selendang: CREAM, trim: LGOLD }),
};

const LEBARAN_COLORS = remap('#1d4a3a', '#18402f', '#2c6e4f', '#347d5b', LGREEN, '#c9a227', LGREEN, '#3a8d5c', LGREEN, '#3f9662', '#358a57', '#4aa36d', '#22603b', '#f2c14e');

/** Cat with a little peci and a ketupat on its collar. */
function peciCat(p, state) {
  const K = '#1d1b22';
  if (state === 'sleep') p(11, 2, 2, 2, K);
  else if (state === 'sit') {
    p(5, 0, 6, 2, K);
    p(7, 6, 2, 2, '#3f9b4f');
    p(7, 6, 1, 1, '#d9c45a');
  } else {
    p(2, 0, 2, 2, K);
    p(5, 6, 2, 2, '#3f9b4f');
    p(5, 6, 1, 1, '#d9c45a');
  }
}

// ---------- 17 Agustus ----------

const MERAH = '#d7182a';
const MERAH_SHADE = '#a8101f';
const PUTIH = '#f6f3ee';
const PUTIH_SHADE = '#d9d4cc';
const LACE_GOLD = '#e0c27a';

const kaos = (c, shirt, extra) => ({
  costume: 'kaos', shirt, topStyle: 'plain', bib: c, headband: true, pants: '#2b2d42', pantsShade: '#22253a',
  ...(shirt === 'putih' ? { top: PUTIH, topShade: PUTIH_SHADE, sleeve: MERAH } : { top: MERAH, topShade: MERAH_SHADE }),
  ...extra,
});
const kebaya = (c, top, topShade, extra) => ({ costume: 'kebaya', top, topShade, topStyle: 'plain', lace: PUTIH, inner: PUTIH, kain: c, kainDark: shade(c, 0.62), pants: c, pantsShade: shade(c), shoes: '#5e3a1e', ...extra });

const AGUSTUS_LOOKS = {
  claude: (c) => ({ costume: 'pejuang', top: c, topShade: shade(c), topStyle: 'plain', pants: '#3d3d46', pantsShade: '#2b2b33', shoes: '#3b2a1e' }),
  pm: (c) => ({ costume: 'paskibra', top: PUTIH, topShade: PUTIH_SHADE, topStyle: 'plain', pants: PUTIH, pantsShade: PUTIH_SHADE, shoes: '#1d1424', cord: c }),
  ba: (c) => kaos(c, 'merahputih', { acc: ['glasses'] }),
  architect: (c) => kaos(c, 'putih', { acc: ['glasses', 'beard'] }),
  'ui-ux': (c) => kebaya(c, PUTIH, PUTIH_SHADE, { hair: MERAH, hairShade: MERAH_SHADE, lace: '#d9c7a0', inner: MERAH }),
  frontend: (c) => ({ costume: 'karung', top: c, topShade: shade(c), topStyle: 'plain', sack: '#c8a46b', sackShade: '#a8834e', sackDark: '#8a6a3c' }),
  backend: (c) => kaos(c, 'merahputih', { acc: ['headphones'], accColor: c }),
  dba: (c) => kaos(c, 'putih'),
  qa: (c) => kebaya(c, MERAH, MERAH_SHADE, { hair: '#8e1b2b', hairShade: '#701521' }),
  security: (c) => kaos(c, 'merahputih'),
  devops: (c) => kaos(c, 'putih', { acc: ['beard'], prop: 'kelereng', marble: '#4dabf7' }),
  writer: (c) => kebaya(c, MERAH, MERAH_SHADE, { acc: ['glasses'] }),
  freelancer: (c) => kaos(c, 'merahputih', { headband: false, acc: ['cap'], accColor: c }),
  mobile: (c) => kaos(c, 'merahputih', { prop: 'kerupuk', gadget: undefined }), // hands behind the back: no phone
  data: (c) => kaos(c, 'putih', { acc: ['glasses'], prop: 'tambang' }),
  support: (c) => kaos(c, 'merahputih', { prop: 'bakiak' }),
  reviewer: (c) => ({ costume: 'juri', top: PUTIH, topShade: PUTIH_SHADE, topStyle: 'plain', pants: '#2b2d42', pantsShade: '#22253a', shoes: '#1d1424', lanyard: c, acc: ['glasses'] }),
  compliance: (c) => kebaya(c, PUTIH, PUTIH_SHADE, { lace: LACE_GOLD }),
};

const AGUSTUS_COLORS = remap('#5a2f33', '#52292d', '#b3122e', '#c8243a', MERAH, PUTIH, MERAH, PUTIH, '#c8243a', '#e0404f', '#d0303f', '#ec5a66', '#9e1b2b', PUTIH);

/** Cat with a red-white bandana. */
function bandanaCat(p, state) {
  if (state === 'sleep') {
    p(9, 6, 2, 1, MERAH);
    p(9, 7, 2, 1, PUTIH);
  } else if (state === 'sit') {
    p(5, 5, 6, 1, MERAH);
    p(6, 6, 4, 1, PUTIH);
  } else {
    p(6, 4, 1, 3, MERAH);
    p(7, 4, 1, 3, PUTIH);
  }
}

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
  natal: {
    id: 'natal',
    label: 'Natal',
    icon: '🎄',
    looks: NATAL_LOOKS,
    colors: NATAL_COLORS,
    cat: { fur: '#8d96a8', stripe: '#6f7889', eye: '#2a1e2c', closed: '#2a1e2c', nose: '#e07a7a', outline: '#2a1e2c', wear: santaCat },
    decor: NATAL_DECOR,
    // Snowy evening in the windows; a cosy warm tint, tree lights and candles glow.
    sky: { top: '#1b2a4e', bottom: '#36507f', moon: '#f4f1c9', star: '#e6eeff', snow: '#ffffff', ground: '#e6eef8' },
    light: { tint: 'rgba(48,22,30,.16)', nightTint: 'rgba(14,16,44,.42)', lamp: 'rgba(255,170,90,.14)', lampNight: 'rgba(255,180,100,.22)' },
  },
  lebaran: {
    id: 'lebaran',
    label: 'Lebaran',
    icon: '🌙',
    looks: LEBARAN_LOOKS,
    colors: LEBARAN_COLORS,
    cat: { fur: '#f1e6d2', stripe: '#d98e3e', eye: '#2a1e2c', closed: '#2a1e2c', nose: '#e8a0a0', outline: '#2a1e2c', wear: peciCat },
    decor: LEBARAN_DECOR,
    // Malam takbiran: crescent, mosque silhouette, small fireworks; golden lantern light.
    sky: { top: '#0b1838', bottom: '#1d3461', moon: '#f6e7a1', star: '#e9e2ff', silhouette: '#081127' },
    light: { tint: 'rgba(8,24,48,.26)', nightTint: 'rgba(6,12,36,.44)', lamp: 'rgba(255,200,110,.14)', lampNight: 'rgba(255,200,110,.22)' },
  },
  agustus: {
    id: 'agustus',
    label: '17 Agustus',
    icon: '🇮🇩',
    looks: AGUSTUS_LOOKS,
    colors: AGUSTUS_COLORS,
    cat: { fur: '#a0754f', stripe: '#7a5536', eye: '#2a1e2c', closed: '#2a1e2c', nose: '#e07a7a', outline: '#2a1e2c', wear: bandanaCat },
    decor: AGUSTUS_DECOR,
    // A bright, sunny day at any hour: blue sky with clouds and a kite, sun beams on the floor.
    sky: { top: '#4aa8e8', bottom: '#9fd6f5', sun: '#fff3a0', cloud: '#ffffff' },
    light: { tint: 'rgba(255,246,220,.04)', nightTint: 'rgba(255,240,205,.06)', lamp: 'rgba(255,245,215,.03)', lampNight: 'rgba(255,245,215,.05)', beams: 'rgba(255,250,225,.10)' },
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
