// ⏰ Tugas terjadwal: list / add / edit / delete / enable. Laptop + Tailscale only (not on the plain-WiFi allowlist).
// The scheduler (src/routines.js) only enqueues; the queue still decides when the turn actually runs.
import { cleanRoutine, nextRunAt, RoutineError, ROUTINE_MAX, routineWhen } from '../routines.js';
import { json } from './http.js';

export function register(router) {
  router.post('/api/routines', list, { maxBody: 1024 });
  router.post('/api/routines/save', save, { maxBody: 8192 });
  router.post('/api/routines/delete', remove, { maxBody: 1024 });
  router.post('/api/routines/toggle', toggle, { maxBody: 1024 });
}

const all = (hub) => (Array.isArray(hub.persisted?.routines) ? hub.persisted.routines : []);

function list({ hub }, req, res) {
  return json(res, 200, { routines: all(hub).map((r) => ({ ...r, when: routineWhen(r) })) });
}

function save({ hub }, req, res, params, body) {
  try {
    const project = hub.projects.get(String(body.projectId ?? ''));
    if (!project || project.virtual) throw new RoutineError('Pilih project nyata untuk jadwal ini.');
    const now = Date.now();
    const stored = body.id ? all(hub).find((r) => r.id === body.id) : null;
    if (body.id && !stored) throw new RoutineError('Jadwal tidak ditemukan.', 404);
    const routine = cleanRoutine(
      {
        ...(stored ?? {}),
        projectId: project.id,
        prompt: body.prompt,
        frequency: body.frequency,
        time: body.time,
        weekday: body.weekday,
        date: body.date,
        enabled: body.enabled !== false,
        nextRun: null, // the schedule changed: recompute from now
      },
      now,
    );
    if (!routine) throw new RoutineError('Jadwal belum lengkap: project, prompt, waktu, dan tanggal/hari harus valid.');
    if (routine.frequency === 'once' && (!routine.nextRun || routine.nextRun <= now)) throw new RoutineError('Tanggal dan jam “sekali” sudah lewat. Pilih waktu berikutnya.');
    if (!routine.nextRun) routine.nextRun = nextRunAt(routine, now);
    if (!routine.nextRun) throw new RoutineError('Waktu jadwal tidak valid.');
    const list = all(hub);
    if (stored) list[list.indexOf(stored)] = routine;
    else {
      if (list.length >= ROUTINE_MAX) throw new RoutineError(`Maksimal ${ROUTINE_MAX} jadwal. Hapus yang tidak dipakai dulu.`);
      list.push(routine);
    }
    hub.persisted.routines = list;
    hub.save();
    hub.broadcast('routines', list.map((r) => ({ ...r, when: routineWhen(r) })));
    return json(res, 200, { routines: list.map((r) => ({ ...r, when: routineWhen(r) })) });
  } catch (err) {
    return json(res, err.status ?? 400, { error: err.message });
  }
}

function remove({ hub }, req, res, params, body) {
  const list = all(hub);
  const index = list.findIndex((r) => r.id === body.id);
  if (index === -1) return json(res, 404, { error: 'Jadwal tidak ditemukan.' });
  list.splice(index, 1);
  hub.save();
  hub.broadcast('routines', list.map((r) => ({ ...r, when: routineWhen(r) })));
  return json(res, 200, { routines: list.map((r) => ({ ...r, when: routineWhen(r) })) });
}

function toggle({ hub }, req, res, params, body) {
  const routine = all(hub).find((r) => r.id === body.id);
  if (!routine) return json(res, 404, { error: 'Jadwal tidak ditemukan.' });
  routine.enabled = body.enabled !== false;
  routine.nextRun = routine.enabled ? nextRunAt(routine, Date.now()) : null;
  routine.error = null;
  hub.save();
  hub.broadcast('routines', all(hub).map((r) => ({ ...r, when: routineWhen(r) })));
  return json(res, 200, { routines: all(hub).map((r) => ({ ...r, when: routineWhen(r) })) });
}
