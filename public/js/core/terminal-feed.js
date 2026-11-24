// 💻 Mode Terminal: the project's chat timeline turned into one terminal panel per role. Every line is a real row of
// the chat — the prompt, the commands with their output, the edits as a diff, delegations, approvals — on the panel of
// the role that did it (the same attribution the office uses). Pure: no DOM, no state; office/terminal.js draws it.

const NAMES = { claude: 'Lead', pm: 'PM' };
const MAX_ROWS = 400; // only the recent timeline is looked at (a long chat stays cheap per frame)
const WIDTH = 140;

/** One line of untrusted text: ANSI escapes and control characters removed, clipped. */
const clean = (s, n = WIDTH) => {
  const t = String(s ?? '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trimEnd();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const linesOf = (s) =>
  String(s ?? '')
    .split(/\r?\n/)
    .map((l) => clean(l))
    .filter((l) => l.trim());
const base = (file) => String(file ?? '').split(/[\\/]/).pop() || String(file ?? '');
const first = (s) => linesOf(s)[0] ?? '';

/**
 * @param {object[]} chat  the project's chat messages (state.chats[project])
 * @param {{ coordinator?: string, maxLines?: number, live?: (msg: object) => string, events?: object[],
 *   nameOf?: (role: string) => string }} options
 *   coordinator: who speaks for the team ('pm' when the team has a PM, else the Lead 'claude')
 *   live: the live output of a running shell row (its task output), '' when unknown
 *   events: the project's office events (the latest `tests` result per role is shown on its panel)
 * @returns {Map<string, { role, lines: {id, text, tone}[], state: 'idle'|'busy'|'ask'|'error', lastAt: number,
 *   board?: {text, status}[], tests?: {passed, failed} }>}  Lead first, then the coordinator, then the most recent
 */
export function terminalFeed(chat, { coordinator = 'claude', maxLines = 14, live = () => '', events = [], nameOf = (r) => NAMES[r] ?? r } = {}) {
  const panels = new Map();
  const panel = (role) => {
    let p = panels.get(role);
    if (!p) panels.set(role, (p = { role, lines: [], state: 'idle', lastAt: -1, running: 0, failed: false, asking: false }));
    return p;
  };
  const add = (role, id, text, tone, at) => {
    const p = panel(role);
    p.lines.push({ id, text: clean(text), tone });
    p.lastAt = Math.max(p.lastAt, at);
  };
  panel('claude');
  panel(coordinator);
  const reports = new Map(); // role -> the finished delegation's report line, flushed after its own work
  const flush = (role) => {
    const r = reports.get(role);
    if (r) add(role, r.id, r.text, r.tone, r.at);
    reports.delete(role);
  };

  const rows = (Array.isArray(chat) ? chat : []).slice(-MAX_ROWS);
  rows.forEach((m, at) => {
    if (!m || typeof m !== 'object') return;
    const id = String(m.id ?? at);
    const toolRole = !m.role || m.role === 'claude' ? coordinator : m.role;
    switch (m.kind) {
      case 'user':
        if (first(m.text)) add('claude', `${id}:0`, `> ${first(m.text)}`, 'cmd', at);
        break;
      case 'assistant':
        if (first(m.text)) add(coordinator, `${id}:0`, `» ${first(m.text)}`, 'info', at);
        break;
      case 'error':
        add(coordinator, `${id}:0`, `✖ ${first(m.text)}`, 'err', at);
        break;
      case 'delegate': {
        const role = m.role || 'freelancer';
        // In the office the coordinator hands the Lead's work out (src/translator.js does the same for its events)
        const from = (m.from ?? 'claude') === 'claude' && coordinator !== 'claude' && role !== coordinator ? coordinator : (m.from ?? 'claude');
        flush(role);
        add(from, `${id}:out`, `⇢ ${role}: ${first(m.text)}`, 'info', at);
        add(role, `${id}:in`, `⇠ ${nameOf(from)}: ${first(m.text)}`, 'info', at);
        if (m.status === 'running') panel(role).running++;
        else if (m.status === 'ok') reports.set(role, { id: `${id}:done`, text: `✔ laporan ke ${nameOf(from)}`, tone: 'add', at });
        else if (m.status === 'fail') reports.set(role, { id: `${id}:done`, text: `✖ gagal, dilaporkan ke ${nameOf(from)}`, tone: 'err', at });
        break;
      }
      case 'approval':
        if (m.status === 'pending') {
          add(toolRole, `${id}:0`, `⚠ ACCESS REQUEST ▸ ${first(m.text)}`, 'warn', at);
          panel(toolRole).asking = true;
        }
        break;
      case 'tool':
        toolLines(m, id, at, toolRole);
        break;
      default:
    }
  });
  for (const role of [...reports.keys()]) flush(role);

  function toolLines(m, id, at, role) {
    const input = m.input ?? {};
    let n = 0;
    const put = (text, tone) => add(role, `${id}:${n++}`, text, tone, at);
    switch (m.tool) {
      case 'Bash':
      case 'PowerShell': {
        put(`$ ${first(input.command) || first(m.text)}`, 'cmd');
        const out = m.status === 'running' ? linesOf(live(m)).slice(-4) : linesOf(m.output).slice(-3);
        for (const l of out) put(l, 'out');
        break;
      }
      case 'Edit':
      case 'MultiEdit': {
        const e = input.edits?.[0] ?? input;
        put(`✎ edit ${base(input.file)}`, 'cmd');
        for (const l of linesOf(e.old).slice(0, 2)) put(`- ${l}`, 'del');
        for (const l of linesOf(e.new).slice(0, 3)) put(`+ ${l}`, 'add');
        break;
      }
      case 'Write':
        put(`+ write ${base(input.file)} (${String(input.content ?? '').split(/\r?\n/).length} baris)`, 'add');
        break;
      case 'Read':
        put(`cat ${base(input.file)}`, 'cmd');
        break;
      case 'Grep':
        put(`grep "${input.pattern ?? ''}"${input.path ? ` ${input.path}` : ''}`, 'cmd');
        break;
      case 'Glob':
        put(`find ${input.pattern ?? ''}`, 'cmd');
        break;
      case 'WebFetch':
        put(`curl ${input.url ?? ''}`, 'cmd');
        break;
      case 'WebSearch':
        put(`search "${input.query ?? ''}"`, 'cmd');
        break;
      case 'TodoWrite': {
        const todos = (input.todos ?? []).map((t) => ({ text: clean(t.content, 60), status: t.status }));
        panel(role).board = todos;
        put(`⊞ papan task diperbarui (${todos.length})`, 'info');
        break;
      }
      default:
        put(`› ${first(m.text) || m.tool}`, 'cmd');
    }
    const p = panel(role);
    if (m.status === 'running') p.running++;
    else if (m.status === 'denied') put('⛔ ditolak', 'warn');
    else if (m.status === 'cancel') put('■ dibatalkan', 'muted');
    else if (m.status === 'fail') put('✖ gagal', 'err');
    p.failed = m.status === 'fail';
  }

  for (const e of Array.isArray(events) ? events : []) {
    if (e?.kind === 'tests' && e.role) panel(e.role).tests = { passed: Number(e.passed) || 0, failed: Number(e.failed) || 0 };
  }

  for (const p of panels.values()) {
    if (p.lines.length > maxLines) p.lines = p.lines.slice(-maxLines);
    p.state = p.asking ? 'ask' : p.running ? 'busy' : p.failed ? 'error' : 'idle';
    delete p.running;
    delete p.asking;
    delete p.failed;
  }
  const rest = [...panels.values()].filter((p) => p.role !== 'claude' && p.role !== coordinator).sort((a, b) => b.lastAt - a.lastAt);
  const order = [panels.get('claude'), ...(coordinator !== 'claude' ? [panels.get(coordinator)] : []), ...rest];
  return new Map(order.map((p) => [p.role, p]));
}
