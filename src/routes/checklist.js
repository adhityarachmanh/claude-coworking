// ✅ Checklist project: what a project still misses to be comfortable to work in (read-only, file names only).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { json } from './http.js';
import { withProject } from './project.js';

/** JSON of a file, or null (a broken file is simply "not found" here). */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const has = (dir, ...names) => names.some((name) => existsSync(path.join(dir, name)));

export function register(router) {
  router.post(
    '/api/projects/:id/checklist',
    withProject(({ hub }, req, res, { project }) => {
      const dir = project.path;
      const pkg = readJson(path.join(dir, 'package.json'));
      const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
      const settings = hub.settingsFor(project.id);
      const checks = [
        { id: 'readme', label: 'README', ok: has(dir, 'README.md', 'README.MD', 'readme.md', 'Readme.md'), hint: 'Tambahkan README.md berisi cara menjalankan project.' },
        { id: 'agents', label: 'Panduan untuk AI (AGENTS.md / CLAUDE.md)', ok: has(dir, 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'), hint: 'Tulis aturan project di AGENTS.md atau CLAUDE.md.' },
        { id: 'package', label: 'package.json', ok: Boolean(pkg), hint: 'Belum ada package.json (project non-JS boleh dilewati).' },
        { id: 'test', label: 'Perintah test', ok: typeof scripts.test === 'string' && Boolean(scripts.test.trim()), hint: 'Tambahkan "test" di scripts package.json.' },
        { id: 'build', label: 'Perintah build', ok: typeof scripts.build === 'string' && Boolean(scripts.build.trim()), hint: 'Tambahkan "build" di scripts package.json (bila ada).' },
        { id: 'git', label: 'Repositori git', ok: existsSync(path.join(dir, '.git')), hint: 'Jalankan git init agar perubahan dan rewind bisa dilacak.' },
        { id: 'docs', label: 'Folder docs/', ok: existsSync(path.join(dir, 'docs')), hint: 'Dokumentasi tambahan bisa ditaruh di docs/.' },
        { id: 'env', label: '.env.example', ok: has(dir, '.env.example'), hint: 'Salin variabel yang dibutuhkan ke .env.example (tanpa nilai rahasia).' },
        { id: 'model', label: 'Model dipilih', ok: Boolean(settings.model || settings.modelAuto), hint: 'Pilih model di pengaturan giliran (atau nyalakan Model Auto).' },
      ];
      const done = checks.filter((c) => c.ok).length;
      return json(res, 200, { checks, score: { done, total: checks.length }, engine: hub.engineOf(project.id), model: settings.model || (settings.modelAuto ? 'auto' : '') });
    }),
  );

  // 🛠 Buat kerangka: only creates what is missing (never overwrites); the UI asks for confirmation first.
  router.post(
    '/api/projects/:id/checklist-scaffold',
    withProject(({ hub }, req, res, { project }, body) => {
      const dir = project.path;
      const wanted = new Set((Array.isArray(body.files) ? body.files : ['readme', 'agents', 'env', 'docs']).map(String));
      const created = [];
      const skipped = [];
      const failed = [];
      const write = (rel, text) => {
        try {
          writeFileSync(path.join(dir, rel), text, { flag: 'wx' });
          created.push(rel);
        } catch (err) {
          if (err?.code === 'EEXIST') skipped.push(rel);
          else failed.push(rel);
        }
      };
      if (wanted.has('readme') && !has(dir, 'README.md', 'README.MD', 'readme.md', 'Readme.md')) {
        write('README.md', `# ${project.name}\n\nProject ini dikelola dari Adhitron.\n\n## Menjalankan\n\nIsi perintah untuk memasang dependensi dan menjalankan project di sini.\n\n## Test\n\nIsi perintah test di sini.\n`);
      }
      if (wanted.has('agents') && !has(dir, 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md')) {
        write('AGENTS.md', `# Panduan untuk AI\n\n- Jelaskan perubahan yang akan dibuat sebelum mengedit banyak file.\n- Jalankan test/lint yang relevan sebelum menyatakan pekerjaan selesai.\n- Jangan menyimpan rahasia (token, kunci, kata sandi) di dalam repo.\n`);
      }
      if (wanted.has('env') && !existsSync(path.join(dir, '.env.example'))) {
        write('.env.example', '# Salin file ini menjadi .env lalu isi nilainya (jangan commit .env).\n# NAMA_VARIABEL=\n');
      }
      if (wanted.has('docs') && !existsSync(path.join(dir, 'docs'))) {
        try {
          mkdirSync(path.join(dir, 'docs'), { recursive: true });
        } catch {
          failed.push('docs/');
        }
        write('docs/README.md', `# Dokumentasi ${project.name}\n\nCatatan desain, keputusan, dan panduan operasional project ini.\n`);
      }
      return json(res, 200, { ok: !failed.length, created, skipped, failed, engine: hub.engineOf(project.id) });
    }),
  );
}
