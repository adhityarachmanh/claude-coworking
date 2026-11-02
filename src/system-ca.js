// Trust the operating system's certificate store too, like browsers do.
// Networks with TLS inspection (Zscaler, corporate proxies, antivirus HTTPS scanning) re-sign every HTTPS site with
// a root that IT installs in Windows/macOS. Node only trusts its bundled list, so without this every outgoing fetch
// (Spotify login, web push, …) failed with UNABLE_TO_GET_ISSUER_CERT_LOCALLY while the browser worked fine.
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

// Compared by fingerprint: Node re-wraps the PEM text of certificates it has stored, so the same root reads differently.
export const fingerprint = (pem) => new X509Certificate(pem).fingerprint256;

/**
 * Adds the system root certificates to Node's default trust list (verification stays on).
 * @returns {number} certificates added; 0 when this Node version can't (needs ≥ 22.19 / 24.5) or nothing was new
 */
export function trustSystemCertificates() {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return 0;
  try {
    const current = tls.getCACertificates('default');
    const known = new Set(current.map(fingerprint));
    // The system list repeats roots found in several Windows stores: keep each one once.
    const extra = tls.getCACertificates('system').filter((cert) => {
      const fp = fingerprint(cert);
      if (known.has(fp)) return false;
      known.add(fp);
      return true;
    });
    if (extra.length) tls.setDefaultCACertificates([...current, ...extra]);
    return extra.length;
  } catch {
    return 0; // an unreadable system store must never stop the server from starting
  }
}
