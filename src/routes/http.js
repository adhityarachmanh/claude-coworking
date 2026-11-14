// HTTP helpers shared by server.js and the route modules (src/routes/*.js).

/** An error whose message is meant for the user, sent with its own status (anything else becomes a generic 500). */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The JSON request body, refused (413) once it passes `limit` bytes. */
export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return; // drained, not kept; the socket is closed once the 413 is sent
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Data yang dikirim terlalu besar.'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Data JSON tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

/** Replies with what a Claude Code control request answered; a typed error keeps its own status (else a generic 400). */
export async function answer(res, promise) {
  try {
    return json(res, 200, (await promise) ?? {});
  } catch (err) {
    return json(res, Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : 400, { error: err.message });
  }
}

/** "pending" if any session restarts after its turn, else "restarted" if any did, else "none". */
export const appliedOf = (applied) => (applied.includes('pending') ? 'pending' : applied.includes('restarted') ? 'restarted' : 'none');
