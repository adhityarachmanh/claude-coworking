// App-wide state: the token, the active project, and everything the event stream reports.

export const TOKEN = document.querySelector('meta[name="office-token"]').content;
export const APP_NAME = 'Adhit Office';
export const DEMO_ID = 'demo';

export const state = {
  projects: [],
  statuses: {},
  chats: {},
  events: {},
  approvals: new Map(),
  active: null,
  search: '',
  tab: 'chat',
};

// A phone on plain-HTTP WiFi may only look (the server enforces it: wifiAllows in src/remote.js).
export const READ_ONLY_HINT = 'Hanya lihat lewat WiFi — pakai Tailscale untuk mengirim perintah';

export const projectName = (id) => state.projects.find((p) => p.id === id)?.name ?? 'project';
