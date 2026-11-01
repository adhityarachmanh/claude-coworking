// Scripted demo: replays a realistic stream-json transcript through the same translator
// the real sessions use, including one approval that waits for a click in the browser.
import { DEMO_ID } from './hub.js';
import { StreamTranslator } from './translator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPROVAL_TIMEOUT_MS = 30000;

const text = (t, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: `msg-${Math.random()}`, content: [{ type: 'text', text: t }] } });
const use = (id, name, input, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: `msg-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const done = (id, content = 'ok', isError = false, parent = null) => ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const TASKS = ['Scope & acceptance criteria', 'Analisis & desain teknis', 'UI form login', 'API auth + tabel users', 'Test, review & security', 'Build & dokumentasi'];
const todos = (doneCount) => ({
  todos: TASKS.map((content, i) => ({ content, status: i < doneCount ? 'completed' : i === doneCount ? 'in_progress' : 'pending' })),
});

const PROMPT = 'Buatkan fitur login dengan validasi email & password';

/** One delegation: Agent call, the subagent's tool calls, then the hand-back. */
function delegate(id, type, description, steps, report) {
  const out = [[900, use(id, 'Agent', { subagent_type: type, description })]];
  steps.forEach(([tool, input, result = 'ok', failed = false], i) => {
    const toolId = `${id}-${i}`;
    out.push([i === 0 ? 3200 : 700, use(toolId, tool, input, id)], [1700, done(toolId, result, failed, id)]);
  });
  out.push([700, done(id, report)]);
  return out;
}

/** [delay ms, stream message | { approval }] */
const SCRIPT = [
  [2500, text('Siap! Saya susun rencananya dulu, lalu saya bagi ke tim sesuai keahlian.')],
  [800, use('p0', 'EnterPlanMode', {})], // PM, Tech Lead and BA huddle on the open floor
  [400, done('p0')],
  [7000, use('t0', 'TodoWrite', todos(0))],
  [500, done('t0')],
  ...delegate('a-pm', 'pm', 'Scope & acceptance criteria login', [['Write', { file_path: 'docs/login-scope.md' }]], 'Scope dan 6 acceptance criteria siap.'),
  [800, use('t1', 'TodoWrite', todos(1))],
  [400, done('t1')],
  ...delegate('a-ba', 'ba', 'Analisis alur & aturan login', [['Read', { file_path: 'docs/requirements.md' }], ['Grep', { pattern: 'session|auth' }]], 'Aturan bisnis dan edge case terdokumentasi.'),
  ...delegate('a-ar', 'architect', 'Desain teknis auth (JWT + bcrypt)', [['Glob', { pattern: 'src/**/*.ts' }], ['Write', { file_path: 'docs/adr/003-auth.md' }]], 'Desain: JWT httpOnly cookie, bcrypt, rate limit.'),
  [800, use('t2', 'TodoWrite', todos(2))],
  [400, done('t2')],
  ...delegate('a-ux', 'ui-ux', 'Desain form login', [['Edit', { file_path: 'src/styles/login.css' }]], 'Style dan state error siap.'),
  ...delegate('a-fe', 'frontend', 'Implementasi halaman login', [['Write', { file_path: 'src/components/LoginForm.tsx' }], ['Edit', { file_path: 'src/pages/login.tsx' }]], 'Halaman login terhubung ke API.'),
  [800, use('t3', 'TodoWrite', todos(3))],
  [400, done('t3')],
  ...delegate('a-db', 'dba', 'Tabel users + index email', [['Write', { file_path: 'db/migrations/004_users.sql' }], ['Bash', { command: 'npx prisma migrate dev' }]], 'Migrasi users siap, index unik email.'),
  [900, use('a-be', 'Agent', { subagent_type: 'backend', description: 'API auth & session' })],
  [3200, use('be-1', 'Write', { file_path: 'src/api/auth.ts' }, 'a-be')],
  [1700, done('be-1', 'ok', false, 'a-be')],
  [700, use('be-2', 'Bash', { command: 'npm install zod bcrypt', description: 'Install validasi & hashing' }, 'a-be')],
  [1200, { approval: 'be-2' }],
  [1800, done('be-2', 'added 2 packages', false, 'a-be')],
  [700, done('a-be', 'Endpoint /login dan /logout siap.')],
  [800, use('t4', 'TodoWrite', todos(4))],
  [400, done('t4')],
  ...delegate('a-qa', 'qa', 'Test end-to-end login', [['Write', { file_path: 'tests/login.spec.ts' }], ['Bash', { command: 'npm test -- login' }, '2 failing: email dengan spasi lolos validasi', true]], 'BUG: email dengan spasi lolos validasi (2 test gagal).'),
  [1200, text('QA menemukan bug. Backend perbaiki akar masalahnya, lalu Tech Lead review.')],
  ...delegate('a-fix', 'backend', 'Perbaiki validasi email', [['Edit', { file_path: 'src/api/auth.ts' }]], 'Akar masalah: email tidak di-trim sebelum validasi. Sudah diperbaiki.'),
  // Nested delegation: the tech lead hands a side search to the freelancer, who reports back to them.
  [900, use('a-rv', 'Agent', { subagent_type: 'architect', description: 'Review diff perbaikan' })],
  [3200, use('rv-1', 'Bash', { command: 'git diff src/api/auth.ts' }, 'a-rv')],
  [1700, done('rv-1', 'diff ok', false, 'a-rv')],
  [700, use('a-gp', 'Agent', { subagent_type: 'general-purpose', description: 'Cari pemakaian validasi email lain' }, 'a-rv')],
  [4500, use('gp-1', 'Grep', { pattern: 'validateEmail' }, 'a-gp')],
  [1700, done('gp-1', '3 file', false, 'a-gp')],
  [1200, done('a-gp', 'Ada 3 pemakaian lain, semuanya sudah lewat trim.', false, 'a-rv')],
  [5000, done('a-rv', 'Review OK, test regresi sudah ada.')],
  ...delegate('a-qa2', 'qa', 'Verifikasi ulang', [['Bash', { command: 'npm test' }, '24 passed']], 'Semua test lulus.'),
  ...delegate('a-sec', 'security', 'Security review auth', [['Bash', { command: 'npm audit --omit=dev' }, '0 vulnerabilities'], ['Grep', { pattern: 'password|secret' }]], 'Tidak ada temuan kritis. Saran: rate limit login.'),
  [800, use('t5', 'TodoWrite', todos(5))],
  [400, done('t5')],
  ...delegate('a-ops', 'devops', 'Build & cek pipeline', [['Bash', { command: 'npm run build' }], ['Edit', { file_path: '.github/workflows/ci.yml' }]], 'Build hijau, CI menjalankan test login.'),
  ...delegate('a-doc', 'writer', 'Dokumentasi fitur login', [['Edit', { file_path: 'README.md' }], ['Edit', { file_path: 'CHANGELOG.md' }]], 'README & changelog diperbarui.'),
  [800, use('t6', 'TodoWrite', todos(6))],
  [400, done('t6')],
  [1500, text('Fitur login selesai ✅\n\n| Bagian | Hasil |\n|---|---|\n| Scope & desain | `login-scope.md`, ADR-003 |\n| UI | `LoginForm.tsx`, `login.css` |\n| API & DB | `auth.ts`, migrasi `users` |\n| Bug | email tidak di-trim → diperbaiki & di-review |\n| Kualitas | 24 test lulus, 0 vulnerability |\n| Rilis | build hijau, README & changelog |')],
  [800, { type: 'result', subtype: 'success', is_error: false, duration_ms: 118000, num_turns: 31, permission_denials: [] }],
];

let running = false;

export async function runDemo(hub) {
  if (running) return false;
  running = true;
  const id = DEMO_ID;
  const translator = new StreamTranslator({
    office: (evt) => hub.office(id, evt),
    chat: (msg) => hub.chat(id, msg),
    updateChat: (chatId, patch) => hub.updateChat(id, chatId, patch),
  });

  try {
    hub.chat(id, { kind: 'user', text: PROMPT, source: 'demo' });
    hub.office(id, { kind: 'prompt', role: 'claude', label: PROMPT });
    hub.setStatus(id, { busy: true });

    for (const [delay, step] of SCRIPT) {
      await sleep(delay);
      if (step.approval) await demoApproval(hub, id, translator.roleOf(step.approval) ?? 'backend');
      else translator.handle(step);
    }
  } finally {
    hub.setStatus(id, { busy: false });
    running = false;
  }
  return true;
}

function demoApproval(hub, id, role) {
  return new Promise((resolve) => {
    const approvalId = `demo-${Date.now()}`;
    const label = 'Install validasi & hashing'; // what describeTool shows for this Bash call (its description)
    const chatId = hub.chat(id, { kind: 'approval', role, text: label, approvalId, status: 'pending' });
    const timer = setTimeout(() => hub.resolveApproval(approvalId, { allow: true }), APPROVAL_TIMEOUT_MS);
    hub.requestApproval(
      id,
      { id: approvalId, chatId, role, kind: 'tool', tool: 'Bash', label, description: 'Install validasi & hashing (demo — otomatis diizinkan dalam 30 detik)', input: { command: 'npm install zod bcrypt' }, canAlways: true },
      (decision) => {
        clearTimeout(timer);
        hub.office(id, { kind: 'ask_done', role, allowed: Boolean(decision.allow) });
        resolve(decision);
      },
    );
    hub.office(id, { kind: 'ask', role, label });
  });
}
