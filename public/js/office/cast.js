// The office team: names, role colors and how each person looks.
export const ROLE_ORDER = ['claude', 'pm', 'ba', 'architect', 'ui-ux', 'frontend', 'backend', 'dba', 'qa', 'security', 'devops', 'writer', 'freelancer'];

const base = { pantsShade: '#22253a', shoes: '#2a2a33' };

export const CAST = {
  claude: {
    // Walks a bit faster: the boss office is further from everyone's desk.
    name: 'Adhit - Lead', title: 'Engineering Lead', color: '#d97757', speed: 1.4,
    look: { ...base, id: 'claude', skin: '#f2c9a8', skinShade: '#dcae8b', blush: '#f0a3a0', hair: '#4a3426', hairShade: '#6b4c38', hairStyle: 'short', top: '#d97757', topShade: '#b85f42', topStyle: 'sweater', pants: '#3b3f58' },
  },
  pm: {
    name: 'Adhit - PM', title: 'Product Manager', color: '#e64980',
    look: { ...base, id: 'pm', skin: '#e8b994', skinShade: '#d09f7b', blush: '#e39a8a', hair: '#2a1d16', hairShade: '#4a3426', hairStyle: 'short', top: '#e64980', topShade: '#c2306a', topStyle: 'blazer', pants: '#3d405b', shoes: '#4a2c2a' },
  },
  ba: {
    name: 'Adhit - BA', title: 'Business Analyst', color: '#3d85c6',
    look: { ...base, id: 'ba', skin: '#d9a27c', skinShade: '#c08a66', blush: '#d98a7a', hair: '#1d1d22', hairShade: '#34343c', hairStyle: 'short', top: '#3d85c6', topShade: '#2f6aa1', topStyle: 'tie', accent: '#1f3b63', acc: ['glasses'], pants: '#2b2d42', shoes: '#3a2a1e' },
  },
  architect: {
    name: 'Adhit - Tech Lead', title: 'Tech Lead / Architect', color: '#5c5fd6',
    look: { ...base, id: 'architect', skin: '#c99a76', skinShade: '#b0815f', blush: '#c98575', hair: '#2b2b30', hairShade: '#55555e', hairStyle: 'buzz', top: '#5c5fd6', topShade: '#4447b0', topStyle: 'blazer', acc: ['glasses', 'beard'], pants: '#2b2d42' },
  },
  'ui-ux': {
    name: 'Adhit - UI/UX', title: 'UI/UX Designer', color: '#9b5de5',
    look: { ...base, id: 'ui-ux', skin: '#f3d0b0', skinShade: '#dcb594', blush: '#f2a0b0', hair: '#e5707e', hairShade: '#c9566a', hairStyle: 'hijab', top: '#9b5de5', topShade: '#7c45bd', topStyle: 'shirt', pants: '#33334d', shoes: '#e9e4dc' },
  },
  frontend: {
    name: 'Adhit - Frontend', title: 'Frontend Developer', color: '#15aabf',
    look: { ...base, id: 'frontend', skin: '#f0c4a0', skinShade: '#d8a986', blush: '#f09a9a', hair: '#2b1d14', hairShade: '#4a3426', hairStyle: 'ponytail', accent: '#15aabf', top: '#15aabf', topShade: '#0f8a9c', topStyle: 'shirt', pants: '#2c3e50', shoes: '#f4f1ea' },
  },
  backend: {
    name: 'Adhit - Backend', title: 'Backend Developer', color: '#2b9a66',
    look: { ...base, id: 'backend', skin: '#c98d66', skinShade: '#b07652', blush: '#cf7f6f', hair: '#16161c', hairShade: '#2e2e38', hairStyle: 'spiky', top: '#2b9a66', topShade: '#1f7a50', topStyle: 'hoodie', acc: ['headphones'], accColor: '#e9c46a', pants: '#264653', shoes: '#f4f1ea' },
  },
  dba: {
    name: 'Adhit - DBA', title: 'Database Engineer', color: '#c0703a',
    look: { ...base, id: 'dba', skin: '#cf9a72', skinShade: '#b6825c', blush: '#cc8670', hair: '#241a14', hairShade: '#443226', hairStyle: 'short', top: '#c0703a', topShade: '#9c5528', topStyle: 'shirt', pants: '#3a3a48', shoes: '#3a2a1e' },
  },
  qa: {
    name: 'Adhit - QA', title: 'QA Engineer', color: '#e9a23b',
    look: { ...base, id: 'qa', skin: '#f0c8a4', skinShade: '#d8ad89', blush: '#f0a0a0', hair: '#2f6f5e', hairShade: '#255a4c', hairStyle: 'hijab', top: '#e9a23b', topShade: '#c8841f', topStyle: 'vest', sleeve: '#33415c', pants: '#3d3d46' },
  },
  security: {
    name: 'Adhit - Security', title: 'Security Engineer', color: '#d9480f',
    look: { ...base, id: 'security', skin: '#d6a07a', skinShade: '#bd8762', blush: '#d38676', hair: '#1a1a1f', hairShade: '#333340', hairStyle: 'short', top: '#3b3f4a', topShade: '#2b2e37', topStyle: 'hoodie', acc: ['beanie'], accColor: '#d9480f', pants: '#22252e' },
  },
  devops: {
    name: 'Adhit - DevOps', title: 'DevOps / SRE', color: '#74b816',
    look: { ...base, id: 'devops', skin: '#b97b56', skinShade: '#9f6644', blush: '#b8705e', hair: '#1f1712', hairShade: '#3a2a20', hairStyle: 'curly', top: '#74b816', topShade: '#5a9410', topStyle: 'shirt', acc: ['beard'], pants: '#34495e' },
  },
  writer: {
    name: 'Adhit - Writer', title: 'Technical Writer', color: '#7d8fa3',
    look: { ...base, id: 'writer', skin: '#f5d6bd', skinShade: '#ddb99d', blush: '#f2a5a5', hair: '#7a4b2a', hairShade: '#9a6640', hairStyle: 'bun', top: '#7d8fa3', topShade: '#647588', topStyle: 'blazer', acc: ['glasses'], pants: '#3d405b', shoes: '#4a2c2a' },
  },
  // Generalist for subagents that are not one of the specialists (general-purpose, fork, custom types).
  freelancer: {
    name: 'Adhit - Freelancer', title: 'Freelancer / Generalist', color: '#e0b100',
    look: { ...base, id: 'freelancer', skin: '#dcaa85', skinShade: '#c39069', blush: '#d99282', hair: '#3b2a20', hairShade: '#5a4232', hairStyle: 'bob', top: '#495057', topShade: '#343a40', topStyle: 'hoodie', acc: ['cap'], accColor: '#e0b100', pants: '#2b3a4a', shoes: '#f4f1ea' },
  },
};

export const VISITOR = {
  name: 'Kamu', title: 'Kamu', color: '#8b98a9', speed: 2.2, // reach the boss before the work starts
  look: { ...base, id: 'visitor', skin: '#e0b48f', skinShade: '#c99a76', blush: '#e09a8a', hair: '#2a2a2a', hairShade: '#444', hairStyle: 'short', top: '#6c7a89', topShade: '#56626f', topStyle: 'shirt', pants: '#34495e' },
};

export const DEFAULT_NAMES = Object.fromEntries(Object.entries(CAST).map(([id, c]) => [id, c.name]));

/** Custom names from the server (per role); missing ones fall back to the defaults. Returns true if anything changed. */
export function applyTeamNames(names = {}) {
  let changed = false;
  for (const id of ROLE_ORDER) {
    const next = names[id] || DEFAULT_NAMES[id];
    if (CAST[id].name !== next) {
      CAST[id].name = next;
      changed = true;
    }
  }
  return changed;
}

export const roleName = (role) => CAST[role]?.name ?? 'Claude';
export const roleColor = (role) => CAST[role]?.color ?? CAST.claude.color;
