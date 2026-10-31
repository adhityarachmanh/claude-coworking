// One office per project: people, cat, whiteboard and effects, driven by office events from the server.
import { CAST, ROLE_ORDER, VISITOR } from './cast.js';
import { ANCHOR_X, ANCHOR_Y, catSprite, characterSprite, iconSprite } from './sprites.js';
import { CAT_SPOTS, DESKS, DOOR, SOFA_SEATS, SPOTS, drawBossChair, drawBossDesk, drawChair, drawDesk, drawMonitors, findPath, rectFn } from './world.js';

const WALK_SPEED = 46; // logical px per second
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (a, b) => a + Math.random() * (b - a);

const ROLE_SCREEN = {
  claude: 'terminal', pm: 'kanban', ba: 'doc', architect: 'review', 'ui-ux': 'design', frontend: 'code',
  backend: 'code', dba: 'db', qa: 'tests', security: 'security', devops: 'pipeline', writer: 'doc', freelancer: 'code',
};
const MEET_SPOTS = ['meet1', 'meet2', 'meet3', 'meet4'];
const ERRAND_MS = 9000; // an errand (report, bug hand-off, huddle) is not cut short by new work
const DELEGATION_STALE_MS = 8000;
const IDLE_ACTIVITIES = {
  claude: ['window2', 'coffee', 'meet', 'stretch'],
  pm: ['board', 'coffee', 'meet', 'chat', 'stretch'],
  ba: ['shelf', 'coffee', 'water', 'window', 'chat'],
  architect: ['board', 'meet', 'coffee', 'window2', 'chat'],
  'ui-ux': ['window', 'sofa', 'coffee', 'chat', 'stretch'],
  frontend: ['coffee', 'sofa', 'cafe', 'chat', 'stretch'],
  backend: ['rack', 'coffee', 'fridge', 'stretch', 'sofa'],
  dba: ['rack', 'coffee', 'water', 'cafe', 'chat'],
  qa: ['water', 'coffee', 'meet', 'chat', 'stretch'],
  security: ['rack', 'window2', 'coffee', 'stretch'],
  devops: ['rack', 'coffee', 'fridge', 'chat'],
  writer: ['shelf', 'sofa', 'cafe', 'window', 'coffee'],
  freelancer: ['cafe', 'coffee', 'sofa', 'window', 'chat'],
};
const ACTIVITY_BUCKETS = 12;
const BUCKET_MS = 5000;
const CHAT_LINES = [
  ['Udah makan siang?', 'Belum, nanti bareng 😄'],
  ['Deploy aman kan?', 'Aman, hijau semua ✅'],
  ['Kopinya enak hari ini', 'Barista baru tuh ☕'],
  ['Meeting jam berapa?', 'Habis ini, 15 menit'],
];

class Person {
  constructor(scene, id, cfg, seat, start) {
    this.scene = scene;
    this.id = id;
    this.cfg = cfg;
    this.seat = seat;
    this.x = start?.x ?? seat.x;
    this.y = start?.y ?? seat.y;
    this.seated = !start && Boolean(seat);
    this.onSofa = null;
    this.facing = 'up';
    this.plan = [];
    this.walking = false;
    this.busyUntil = 0;
    this.agentCount = 0; // subagents of this role running right now (parallel ones stack)
    this.errandUntil = 0;
    this.task = '';
    this.screen = null;
    this.flashUntil = 0;
    this.bubble = null;
    this.icon = null;
    this.asking = false;
    this.cheerUntil = 0;
    this.scratchUntil = 0;
    this.worriedUntil = 0;
    this.holding = null;
    this.delegations = [];
    this.blinkOffset = Math.random() * 4000;
    this.nextIdleAt = performance.now() + rand(15000, 40000);
  }

  isBusy(now) {
    const status = this.scene.status;
    return this.agentCount > 0 || now < this.busyUntil || (this.id === 'claude' && Boolean(status.busy || status.cliBusy));
  }

  say(text, tone = 'normal', ms = 4500) {
    if (!text) return;
    this.bubble = { text, tone, until: performance.now() + ms, key: Math.random() };
  }

  setIcon(name, ms = 2000) {
    this.icon = { name, until: performance.now() + ms };
  }

  go(steps) {
    this.release();
    this.plan = steps;
  }

  release() {
    if (this.reserved) this.scene.reserved.delete(this.reserved);
    this.reserved = null;
  }

  homePlan() {
    return this.seat ? [{ type: 'walk', x: this.seat.x, y: this.seat.y }, { type: 'sit' }] : [];
  }

  /** True when the only thing left to do is walk back and sit down. */
  headingHome() {
    const [first] = this.plan;
    return this.plan.length <= 2 && first?.type === 'walk' && first.x === this.seat?.x && first.y === this.seat?.y;
  }

  /** Head straight back to the desk, cutting any break short. */
  goHome() {
    if (this.seated || !this.seat) return;
    if (this.headingHome()) return;
    this.holding = null;
    this.onSofa = null;
    this.go(this.homePlan());
  }

  work(label, screen) {
    const now = performance.now();
    this.task = label;
    this.screen = screen ?? this.screen;
    this.busyUntil = Math.max(this.busyUntil, now + 9000);
    if (!this.asking && !this.delegating && now > this.errandUntil) this.goHome();
    // Mid-errand the errand's own lines stay up; the new task shows on the team card.
    if (now > this.errandUntil) this.say(label, 'work', 3800);
  }

  /** Walk over to a colleague (or the boss's desk), run `steps` there, then go back to work. */
  errand(to, steps) {
    const spot = to.id === 'claude' ? DESKS.claude.visit : { x: to.seat.x + 16, y: to.seat.y + 4 };
    this.errandUntil = performance.now() + ERRAND_MS;
    this.go([
      { type: 'walk', x: spot.x, y: spot.y },
      { type: 'face', dir: to.id === 'claude' ? 'up' : 'left' },
      ...steps,
      { type: 'call', fn: () => ((this.holding = null), (this.errandUntil = 0)) },
      ...this.homePlan(),
    ]);
  }

  /** A finished subagent brings its report to whoever delegated the work. */
  report(to, { report, failed }) {
    this.holding = 'paper';
    const text = failed ? `Ada kendala: ${report ?? 'cek chat'}` : report ? `Laporan: ${report}` : 'Tugas selesai ✓';
    const reply = failed ? 'Oke, kita cari jalan lain.' : pick(['Mantap, makasih!', 'Kerja bagus 👍', 'Sip, lanjut.']);
    this.errand(to, [
      { type: 'call', fn: () => this.say(text, failed ? 'error' : 'ok', 4000) },
      { type: 'wait', ms: 2600 },
      { type: 'call', fn: () => to.say(reply, 'ok', 2600) },
      { type: 'wait', ms: 1200 },
    ]);
  }

  // ---------- idle life ----------

  idle(now) {
    this.nextIdleAt = now + rand(20000, 55000);
    if (Math.random() < 0.45) return;
    const activity = pick(IDLE_ACTIVITIES[this.id] ?? ['coffee']);
    const scene = this.scene;
    if (activity === 'stretch') {
      this.cheerUntil = now + 1400;
      return;
    }
    if (activity === 'sofa') {
      const seat = SOFA_SEATS.find((s, i) => !scene.reserved.has(`sofa${i}`));
      if (!seat) return;
      const key = `sofa${SOFA_SEATS.indexOf(seat)}`;
      this.go([{ type: 'walk', x: seat.x, y: seat.y }, { type: 'sofa', seat }, { type: 'wait', ms: rand(6000, 11000) }, ...this.homePlan()]);
      scene.reserved.add(key);
      this.reserved = key;
      this.holding = 'cup';
      return;
    }
    if (activity === 'chat') {
      // Small talk happens at colleagues' desks, never at the boss's.
      const buddy = ROLE_ORDER.map((id) => scene.people[id]).find((p) => p !== this && p.id !== 'claude' && this.id !== 'claude' && p.seated && !p.isBusy(now) && !p.asking);
      if (!buddy) return;
      const [line, reply] = pick(CHAT_LINES);
      this.go([
        { type: 'walk', x: buddy.seat.x + 16, y: buddy.seat.y + 4 },
        { type: 'face', dir: 'left' },
        { type: 'call', fn: () => this.say(line, 'normal', 3000) },
        { type: 'wait', ms: 2200 },
        { type: 'call', fn: () => buddy.say(reply, 'normal', 3000) },
        { type: 'wait', ms: 2600 },
        ...this.homePlan(),
      ]);
      return;
    }
    const spotKey = activity === 'meet' ? pick(['meet1', 'meet2', 'meet3', 'meet4']) : activity === 'cafe' ? pick(['cafe1', 'cafe2']) : activity;
    const spot = SPOTS[spotKey];
    if (!spot || scene.reserved.has(spotKey)) return;
    const extras = [];
    if (activity === 'cafe') this.holding = 'cup';
    if (spotKey === 'coffee') {
      extras.push(
        { type: 'call', fn: () => (scene.coffeeUntil = performance.now() + 2500) },
        { type: 'wait', ms: 2600 },
        { type: 'call', fn: () => (this.holding = 'cup') },
        { type: 'walk', ...SPOTS.pantry1 },
        { type: 'face', dir: 'down' },
        { type: 'call', fn: () => this.say(pick(['☕ Ngopi dulu', 'Aah, segar', 'Kopi #2 hari ini']), 'normal', 2500) },
        { type: 'wait', ms: rand(3000, 6000) },
      );
    } else {
      extras.push({ type: 'wait', ms: rand(3500, 7000) });
      const line = {
        board: 'Update papan sprint ✍️',
        rack: 'Cek server sebentar',
        shelf: 'Cari referensi dulu 📚',
        meet1: 'Sync sebentar di ruang meeting',
        meet4: 'Review arsitektur ah',
      }[spotKey];
      if (line) extras.unshift({ type: 'call', fn: () => this.say(line, 'normal', 2500) });
    }
    this.go([{ type: 'walk', x: spot.x, y: spot.y }, { type: 'face', dir: spot.face }, ...extras, ...this.homePlan()]);
    scene.reserved.add(spotKey);
    this.reserved = spotKey;
  }

  // ---------- simulation ----------

  update(dt, now) {
    const step = this.plan[0];
    this.walking = false;
    if (step) {
      if (step.type === 'walk') {
        if (!step.path) {
          step.path = findPath({ x: this.x, y: this.y }, step);
          this.seated = false;
          this.onSofa = null;
        }
        const wp = step.path[0];
        const dx = wp.x - this.x;
        const dy = wp.y - this.y;
        const dist = Math.hypot(dx, dy);
        const move = WALK_SPEED * (this.cfg.speed ?? 1) * dt;
        if (dist <= move) {
          this.x = wp.x;
          this.y = wp.y;
          step.path.shift();
          if (!step.path.length) this.plan.shift();
        } else {
          this.x += (dx / dist) * move;
          this.y += (dy / dist) * move;
          this.walking = true;
          this.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
        }
      } else if (step.type === 'wait') {
        step.until ??= now + step.ms;
        if (now >= step.until) this.plan.shift();
      } else {
        this.plan.shift();
        if (step.type === 'sit') {
          this.x = this.seat.x;
          this.y = this.seat.y;
          this.seated = true;
          this.facing = this.seat.facing ?? 'up';
          this.holding = null;
          this.release();
        } else if (step.type === 'sofa') {
          this.onSofa = step.seat;
          this.facing = 'down';
        } else if (step.type === 'face') this.facing = step.dir;
        else if (step.type === 'call') step.fn();
      }
    } else if (this.delegations.length && !this.asking) {
      this.startDelegation(); // the boss, or a specialist handing part of its work to a colleague
    } else if (this.seat && this.seated && !this.isBusy(now) && !this.asking && !this.scene.waitingUser && now > this.nextIdleAt) {
      this.idle(now);
    } else if (this.seat && !this.seated && !this.asking && !this.onSofa) {
      this.go(this.homePlan());
    }
    if (this.bubble && now > this.bubble.until) this.bubble = null;
    if (this.icon && now > this.icon.until) this.icon = null;
    if (!this.isBusy(now) && !this.asking) this.task = '';
  }

  startDelegation() {
    // Skip hand-overs the stream has already moved past (agent finished, or queued too long):
    // walking over to assign work that is already done would replay history, not show it live.
    const now = performance.now();
    this.delegations = this.delegations.filter((d) => d.target.agentCount > 0 && now - d.at < DELEGATION_STALE_MS);
    const next = this.delegations.shift();
    if (!next) {
      this.delegating = false;
      return;
    }
    const { target, label } = next;
    this.delegating = true;
    const ask = this.id === 'claude' ? `${target.cfg.name}, tolong: ${label}` : `${target.cfg.name}, bisa bantu? ${label}`;
    const reply = target.id === 'freelancer' ? 'Siap, saya bantu!' : 'Siap, saya kerjakan!';
    const steps = [
      { type: 'walk', x: target.seat.x + 16, y: target.seat.y + 4 },
      { type: 'face', dir: 'left' },
      { type: 'call', fn: () => this.say(ask, 'normal', 3200) },
      { type: 'wait', ms: 1700 },
      { type: 'call', fn: () => target.say(reply, 'ok', 2600) },
      { type: 'wait', ms: 900 },
      { type: 'call', fn: () => (this.delegating = this.delegations.length > 0) },
    ];
    if (!this.delegations.length) steps.push(...this.homePlan());
    this.go(steps);
  }

  spriteState(now) {
    const blink = (now + this.blinkOffset) % 3600 < 140;
    const talk = Boolean(this.bubble) && Math.floor(now / 180) % 2 === 0;
    const mood = now < this.worriedUntil ? 'worried' : now < this.cheerUntil ? 'happy' : '';
    if (this.onSofa) return { view: 'down', pose: 'sofa', arms: this.holding ? 'hold' : 'down', item: this.holding, blink, talk, mood };
    if (this.seated) {
      const arms = now < this.cheerUntil ? 'cheer' : now < this.scratchUntil ? 'scratch' : this.isBusy(now) ? 'type' : 'down';
      const view = this.seat.facing ?? 'up'; // the boss faces the room
      return { view, pose: 'sit', arms, frame: Math.floor(now / 140) % 2, mood, blink, talk };
    }
    if (this.walking) {
      return { view: this.facing, pose: 'walk', frame: [1, 0, 2, 0][Math.floor(now / 130) % 4], arms: this.holding && this.facing !== 'up' ? 'hold' : 'down', item: this.holding, blink, talk };
    }
    const arms = this.asking ? 'raise' : now < this.cheerUntil ? 'cheer' : this.holding && this.facing !== 'up' ? 'hold' : 'down';
    return { view: this.facing, pose: 'stand', arms, item: this.holding, blink, talk, mood: this.asking ? '' : mood };
  }

  headTop() {
    return this.y - (this.seated || this.onSofa ? 25 : 29);
  }

  draw(g, now) {
    const r = rectFn(g);
    const x = Math.round(this.x);
    const y = Math.round(this.y);
    r(x - 5, y - 1, 11, 2, 'rgba(0,0,0,.18)');
    r(x - 3, y - 2, 7, 1, 'rgba(0,0,0,.10)');
    g.drawImage(characterSprite(this.cfg.look, this.spriteState(now)), x - ANCHOR_X, y - ANCHOR_Y);
  }
}

export class Scene {
  constructor() {
    this.people = {};
    for (const id of ROLE_ORDER) this.people[id] = new Person(this, id, CAST[id], DESKS[id].seat);
    this.visitor = null;
    this.cat = { x: 300, y: 200, plan: null, state: 'sleep', until: performance.now() + 15000, flip: false };
    this.board = { goal: '', items: [], todoMode: false };
    this.status = { busy: false };
    this.reserved = new Set();
    this.particles = [];
    this.doorOpen = false;
    this.coffeeUntil = 0;
    this.toolTimes = [];
  }

  /** Tool calls per 5 s over the last minute, for the meeting-room TV. */
  activity(now) {
    this.toolTimes = this.toolTimes.filter((ts) => now - ts < ACTIVITY_BUCKETS * BUCKET_MS);
    const buckets = new Array(ACTIVITY_BUCKETS).fill(0);
    for (const ts of this.toolTimes) buckets[ACTIVITY_BUCKETS - 1 - Math.floor((now - ts) / BUCKET_MS)]++;
    const max = Math.max(3, ...buckets);
    return { busy: Boolean(this.status.busy || this.status.cliBusy), bars: buckets.map((n) => n / max) };
  }

  person(role) {
    return this.people[role] ?? this.people.claude;
  }

  setStatus(status) {
    this.status = status;
    const roles = status.activeRoles ?? [];
    for (const role of new Set(roles)) {
      const p = this.person(role);
      p.agentCount = Math.max(p.agentCount, roles.filter((r) => r === role).length);
    }
  }

  /** Where someone stands up to raise a hand for an approval. */
  askSpot(p) {
    return DESKS[p.id]?.ask ?? { x: p.seat.x, y: p.seat.y + 8 };
  }

  restorePending(approval) {
    const p = this.person(approval.role);
    const spot = this.askSpot(p);
    p.asking = true;
    p.seated = false;
    p.x = spot.x;
    p.y = spot.y;
    p.facing = 'down';
    p.plan = [];
    p.task = approval.label;
    if (approval.kind === 'question' || approval.kind === 'plan') this.waitingUser = true;
  }

  /** Apply one server event. `live=false` replays history without animations. */
  handle(evt, live = true) {
    const p = this.person(evt.role);
    const now = performance.now();
    const board = this.board;
    switch (evt.kind) {
      case 'prompt':
        board.goal = evt.label;
        board.items = [];
        board.todoMode = false;
        if (live) this.spawnVisitor(evt.label);
        break;
      case 'board':
        board.items = evt.items ?? [];
        board.todoMode = true;
        break;
      case 'delegate':
        if (!board.todoMode) board.items.push({ content: evt.label, status: 'in_progress', role: evt.role });
        if (!live) break;
        p.agentCount++;
        p.task = evt.label;
        p.screen = ROLE_SCREEN[p.id];
        {
          // Whoever issued the Agent call walks over: the boss, or a specialist delegating onward.
          const from = this.person(evt.from ?? 'claude');
          if (from !== p) {
            from.delegations.push({ target: p, label: evt.label, at: now });
            if (from.headingHome()) from.plan = []; // turn around now instead of sitting down first
          }
        }
        if (now > p.errandUntil) p.goHome();
        break;
      case 'agent_stop': {
        const item = board.items.findLast((i) => i.role === evt.role && i.status === 'in_progress');
        if (item && !board.todoMode) item.status = 'completed';
        if (!live) break;
        p.agentCount = Math.max(0, p.agentCount - 1);
        p.busyUntil = now + 1500;
        p.setIcon(evt.failed ? 'cross' : 'check', 1600);
        const to = this.person(evt.from ?? 'claude');
        if (to !== p && !p.asking) p.report(to, evt);
        else p.say(evt.failed ? 'Ada kendala, cek chat.' : 'Selesai ✓', evt.failed ? 'error' : 'ok', 3000);
        break;
      }
      default:
        if (live) this.animate(evt, p, now);
    }
  }

  animate(evt, p, now) {
    switch (evt.kind) {
      case 'say':
        p.say(evt.text, 'normal', 5000);
        break;
      case 'think':
        if (!p.bubble) p.setIcon('think', 2500);
        break;
      case 'tool_start':
        this.toolTimes.push(now);
        p.work(evt.label, evt.screen);
        if (evt.tool === 'TodoWrite' && p.id === 'pm' && !p.asking) {
          p.go([{ type: 'walk', ...SPOTS.board }, { type: 'face', dir: 'up' }, { type: 'wait', ms: 2200 }, ...p.homePlan()]);
        }
        break;
      case 'tool_end':
        p.busyUntil = Math.max(p.busyUntil, now + 3000);
        if (['Edit', 'Write', 'Bash', 'PowerShell'].includes(evt.tool)) p.setIcon('check', 900);
        break;
      case 'tool_fail':
        p.flashUntil = now + 1600;
        p.scratchUntil = now + 2000;
        p.worriedUntil = now + 3500;
        p.setIcon('cross', 2500);
        p.say(`Gagal: ${evt.label}`, 'error', 4500);
        this.smoke(DESKS[p.id] ?? DESKS.claude);
        break;
      case 'ask': {
        p.asking = true;
        p.task = evt.label;
        p.go([{ type: 'walk', ...this.askSpot(p) }, { type: 'face', dir: 'down' }]);
        // A question or a plan blocks the whole turn: the office waits for you (no wandering off).
        if (evt.ask === 'question' || evt.ask === 'plan') this.waitingUser = true;
        const text = evt.ask === 'question' ? `❓ ${evt.label.replace(/^Bertanya: /, '')}` : evt.ask === 'plan' ? '📋 Rencana siap. Setujui?' : `Boleh? ${evt.label}`;
        p.say(text, 'ask', 8000);
        break;
      }
      case 'ask_done':
        this.waitingUser = false;
        p.asking = false;
        p.say(evt.allowed ? 'Makasih! 👍' : 'Oke, tidak jadi.', evt.allowed ? 'ok' : 'normal', 2500);
        if (evt.allowed) p.setIcon('heart', 1200);
        p.go(p.homePlan());
        break;
      case 'tests':
        this.testResult(evt, p, now);
        break;
      case 'huddle':
        this.huddle(evt);
        break;
      case 'stop':
        this.waitingUser = false;
        for (const person of Object.values(this.people)) {
          // Background agents keep working past the end of the turn.
          person.agentCount = (evt.activeRoles ?? []).filter((r) => r === person.id).length;
          if (person.seated) person.cheerUntil = now + 2200;
        }
        this.people.claude.say('Beres! Kerja bagus, tim 🎉', 'ok', 4500);
        this.confetti();
        break;
      case 'halt':
        this.waitingUser = false;
        for (const person of Object.values(this.people)) {
          person.agentCount = 0;
          person.busyUntil = 0;
        }
        p.say('Oke, berhenti dulu. ✋', 'normal', 3000);
        break;
      case 'error':
        p.setIcon('cross', 3000);
        p.worriedUntil = now + 3000;
        p.say('Ada kendala, cek chat ya.', 'error', 4500);
        break;
      case 'session_start':
        p.say('Halo tim! 👋', 'normal');
        break;
    }
  }

  /** Test run finished: green → the runner cheers; red → QA carries the bug to the last developer. */
  testResult(evt, p, now) {
    if (!evt.failed) {
      p.cheerUntil = now + 2200;
      p.setIcon('check', 1600);
      p.say(`✅ ${evt.label}`, 'ok', 3500);
      return;
    }
    p.worriedUntil = now + 3000;
    const dev = evt.to && this.people[evt.to];
    // A QA *subagent* cannot talk to a developer: its finding goes back in its report to the lead,
    // who delegates the fix. Only main-thread test runs are walked straight to the developer.
    if (p.id !== 'qa' || !dev || dev === p || p.asking || p.agentCount > 0) {
      p.say(`🐞 ${evt.label}`, 'error', 4000);
      return;
    }
    p.holding = 'paper';
    p.errand(dev, [
      { type: 'call', fn: () => p.say(`🐞 ${evt.label}, tolong dicek ya`, 'error', 3500) },
      { type: 'wait', ms: 2200 },
      { type: 'call', fn: () => ((dev.worriedUntil = performance.now() + 2000), dev.say('Oke, saya cek sekarang!', 'normal', 2600)) },
      { type: 'wait', ms: 1000 },
    ]);
  }

  /** Planning: the people involved meet on the open floor, talk it through, then go back. */
  huddle(evt) {
    const lines = ['Kita sepakati scope-nya dulu.', 'Saya cek dampak teknisnya.', 'Aturan bisnisnya saya catat.'];
    (evt.roles ?? []).forEach((role, i) => {
      const m = this.people[role];
      const spot = SPOTS[MEET_SPOTS[i]];
      if (!m || !spot || m.asking) return;
      m.errandUntil = performance.now() + ERRAND_MS;
      m.go([
        { type: 'walk', x: spot.x, y: spot.y },
        { type: 'face', dir: spot.face },
        { type: 'wait', ms: 600 + i * 1600 },
        { type: 'call', fn: () => m.say(i === 0 ? evt.label : lines[i] ?? lines[1], 'normal', 3000) },
        { type: 'wait', ms: 5200 - i * 1600 },
        { type: 'call', fn: () => (m.errandUntil = 0) },
        ...m.homePlan(),
      ]);
    });
  }

  spawnVisitor(prompt) {
    const claude = this.people.claude;
    const v = this.visitor ?? new Person(this, 'visitor', VISITOR, null, { ...DOOR });
    v.facing = 'down';
    v.holding = 'paper';
    const visit = DESKS.claude.visit; // in front of the boss's desk
    v.go([
      { type: 'walk', x: visit.x, y: visit.y },
      { type: 'face', dir: 'up' },
      { type: 'call', fn: () => v.say(prompt, 'visitor', 4200) },
      { type: 'wait', ms: 2600 },
      { type: 'call', fn: () => ((v.holding = null), claude.say('Siap, saya atur timnya 👍', 'ok', 3200)) },
      { type: 'wait', ms: 1600 },
      { type: 'walk', x: DOOR.x, y: DOOR.y },
      { type: 'call', fn: () => (this.visitor = null) },
    ]);
    this.visitor = v;
  }

  confetti() {
    const colors = ROLE_ORDER.map((id) => CAST[id].color);
    for (let i = 0; i < 90; i++) {
      this.particles.push({ kind: 'confetti', x: rand(20, 400), y: rand(-20, 30), vx: rand(-25, 25), vy: rand(10, 50), life: rand(2.5, 4), color: pick(colors) });
    }
  }

  smoke(desk) {
    for (let i = 0; i < 8; i++) this.particles.push({ kind: 'smoke', x: desk.cx + rand(-6, 6), y: desk.y - 10, vx: rand(-4, 4), vy: rand(-14, -6), life: rand(1, 1.8), size: 2 });
  }

  // ---------- frame ----------

  update(dt, now) {
    const actors = this.actors();
    for (const a of actors) a.update(dt, now);
    this.doorOpen = actors.some((a) => Math.abs(a.x - DOOR.x) < 14 && a.y < DOOR.y + 14);
    this.updateCat(dt, now);
    if (now < this.coffeeUntil && Math.random() < 0.3) {
      this.particles.push({ kind: 'steam', x: 341 + rand(-1, 1), y: 40, vx: rand(-2, 2), vy: rand(-10, -6), life: 1.2 });
    }
    for (const part of this.particles) {
      part.life -= dt;
      part.x += part.vx * dt;
      part.y += part.vy * dt;
      if (part.kind === 'confetti') part.vy = Math.min(part.vy + 30 * dt, 60);
    }
    this.particles = this.particles.filter((part) => part.life > 0 && part.y < 260);
  }

  updateCat(dt, now) {
    const cat = this.cat;
    if (cat.path?.length) {
      const wp = cat.path[0];
      const dx = wp.x - cat.x;
      const dy = wp.y - cat.y;
      const dist = Math.hypot(dx, dy);
      const move = 28 * dt;
      cat.state = 'walk';
      if (Math.abs(dx) > 0.5) cat.flip = dx > 0;
      if (dist <= move) {
        cat.x = wp.x;
        cat.y = wp.y;
        cat.path.shift();
        if (!cat.path.length) {
          cat.state = cat.target.sleep ? 'sleep' : 'sit';
          cat.until = now + rand(cat.target.sleep ? 25000 : 8000, cat.target.sleep ? 45000 : 15000);
        }
      } else {
        cat.x += (dx / dist) * move;
        cat.y += (dy / dist) * move;
      }
    } else if (now > cat.until) {
      cat.target = pick(CAT_SPOTS);
      cat.path = findPath(cat, cat.target);
    }
  }

  actors() {
    const list = Object.values(this.people);
    if (this.visitor) list.push(this.visitor);
    return list;
  }

  /** Depth-sorted draw list for the stage. */
  drawables(now) {
    const items = [];
    for (const [role, desk] of Object.entries(DESKS)) {
      const owner = this.people[role];
      items.push({ y: desk.y + 17, draw: (g, t) => this.drawWorkstation(g, t, now, desk, owner) });
      if (desk.boss) items.push({ y: desk.seat.y - 0.5, draw: (g) => drawBossChair(g, desk.seat) });
      else items.push({ y: desk.seat.y + 0.5, draw: (g) => drawChair(g, desk.seat, owner.seated) });
    }
    for (const a of this.actors()) items.push({ y: a.y, draw: (g) => a.draw(g, now) });
    const cat = this.cat;
    const frame = Math.floor(now / 160) % 2;
    items.push({ y: cat.y, draw: (g) => g.drawImage(catSprite(cat.state, frame, cat.flip), Math.round(cat.x) - 8, Math.round(cat.y) - 11) });
    if (cat.state === 'sleep' && Math.floor(now / 1200) % 2) {
      items.push({ y: 999, draw: (g) => g.drawImage(iconSprite('zzz'), Math.round(cat.x) + 2, Math.round(cat.y) - 18) });
    }
    return items;
  }

  screenMode(owner, now) {
    if (now < owner.flashUntil) return 'error';
    if (owner.seated && owner.isBusy(now)) return owner.screen ?? ROLE_SCREEN[owner.id];
    return owner.seated ? 'idle' : 'off';
  }

  drawWorkstation(g, t, now, desk, owner) {
    if (desk.boss) {
      drawBossDesk(g, desk, owner.seated && owner.isBusy(now), t);
      return;
    }
    drawDesk(g, desk, t);
    drawMonitors(g, desk, this.screenMode(owner, now), t, desk.x);
  }

  monitorGlows(now) {
    const glows = [];
    for (const [role, desk] of Object.entries(DESKS)) {
      const mode = this.screenMode(this.people[role], now);
      if (mode === 'off') continue;
      const color = mode === 'error' ? 'rgba(240,82,74,.45)' : mode === 'idle' ? 'rgba(120,140,255,.12)' : 'rgba(150,200,255,.32)';
      glows.push({ x: desk.cx, y: desk.y - 4, color });
    }
    return glows;
  }

  drawEffects(g, now) {
    const r = rectFn(g);
    for (const part of this.particles) {
      if (part.kind === 'confetti') r(part.x, part.y, 2, 2, part.color);
      else if (part.kind === 'steam') r(part.x, part.y, 1, 2, `rgba(255,255,255,${Math.min(0.7, part.life)})`);
      else if (part.kind === 'smoke') {
        const s = Math.round(4 - part.life * 2);
        r(part.x, part.y, s, s, `rgba(90,90,100,${Math.min(0.6, part.life / 2)})`);
      }
    }
    for (const a of this.actors()) {
      const name = a.asking ? 'ask' : a.icon?.name;
      if (!name || (a.bubble && name === 'think')) continue;
      const icon = iconSprite(name);
      const bob = Math.round(Math.sin(now / 160) * 1.5);
      g.drawImage(icon, Math.round(a.x) + 5, Math.round(a.headTop()) - icon.height + bob);
    }
  }
}
