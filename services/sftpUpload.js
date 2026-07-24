import { Client } from 'basic-ftp';
import path from 'path';
import { Readable } from 'stream';

// cPanel FTP connection + remote base path come from .env — see .env for the
// exact variable names. Nothing here is hardcoded on purpose, since
// credentials differ per environment (dev machine vs. production).
// NOTE: this is plain FTP/FTPS (port 21), not SFTP/SSH (port 22) — cPanel's
// "FTP Accounts" feature only grants the former unless SSH Access is
// separately enabled. basic-ftp defaults to explicit FTPS when available,
// falling back to plain FTP if the server doesn't support TLS.
function getConfig() {
  const {
    FTP_HOST,
    FTP_PORT,
    FTP_USER,
    FTP_PASSWORD,
    FTP_REMOTE_BASE, // e.g. /home/agreggac/vynox.progamesgears.com/screenshots
    FTP_SECURE, // "true" | "false" | "implicit" — defaults to explicit FTPS (true)
  } = process.env;

  if (!FTP_HOST || !FTP_USER || !FTP_PASSWORD || !FTP_REMOTE_BASE) {
    throw new Error(
      'FTP not configured — set FTP_HOST, FTP_USER, FTP_PASSWORD, FTP_REMOTE_BASE in .env'
    );
  }

  let secure = true;
  if (FTP_SECURE === 'false') secure = false;
  else if (FTP_SECURE === 'implicit') secure = 'implicit';

  return {
    host: FTP_HOST,
    port: Number(FTP_PORT) || 21,
    user: FTP_USER,
    password: FTP_PASSWORD,
    secure,
    remoteBase: FTP_REMOTE_BASE.replace(/\/$/, ''),
  };
}

async function connect() {
  const cfg = getConfig();
  const client = new Client(20000); // 20s timeout
  client.ftp.verbose = false;
  try {
    await client.access({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      secure: cfg.secure,
      secureOptions: { rejectUnauthorized: false }, // cPanel FTPS certs are often self-signed/shared
    });
  } catch (e) {
    // If explicit FTPS negotiation fails outright, retry once over plain FTP —
    // some cPanel/shared-hosting FTP servers don't support TLS on port 21 at all.
    if (cfg.secure !== false) {
      await client.access({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        secure: false,
      });
    } else {
      throw e;
    }
  }
  return { client, remoteBase: cfg.remoteBase };
}

/**
 * Uploads a single file buffer to the cPanel screenshots directory over FTP.
 * `relativePath` is something like "gentspair-com/home-20260724T081833.jpg" —
 * folders are created on the remote side automatically if they don't exist.
 * Returns the public URL, assuming FTP_REMOTE_BASE lives under public_html
 * and SCREENSHOT_PUBLIC_BASE_URL is the matching public HTTP(S) prefix.
 */
export async function uploadScreenshot(buffer, relativePath) {
  const publicBase = (process.env.SCREENSHOT_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const { client, remoteBase } = await connect();

  try {
    const remoteDir = path.posix.join(remoteBase, path.posix.dirname(relativePath));
    const fileName = path.posix.basename(relativePath);
    await client.ensureDir(remoteDir); // creates nested dirs as needed, cds into it
    await client.uploadFrom(Readable.from(buffer), fileName);
  } finally {
    client.close();
  }

  return {
    remotePath: path.posix.join(remoteBase, relativePath),
    publicUrl: publicBase ? `${publicBase}/${relativePath}` : null,
  };
}

/** Downloads a previously uploaded screenshot from cPanel into memory. Returns null if unavailable. */
export async function downloadScreenshot(relativePath) {
  const { client, remoteBase } = await connect();
  try {
    const remoteDir = path.posix.join(remoteBase, path.posix.dirname(relativePath));
    const fileName = path.posix.basename(relativePath);
    await client.cd(remoteDir);

    const chunks = [];
    const { Writable } = await import('stream');
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    await client.downloadTo(sink, fileName);
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    client.close();
  }
}

/** Deletes a previously uploaded screenshot from cPanel. Used for retention cleanup later, if needed. */
export async function deleteScreenshot(relativePath) {
  const { client, remoteBase } = await connect();
  try {
    const remoteFile = path.posix.join(remoteBase, relativePath);
    await client.remove(remoteFile);
  } catch {
    // already gone or never existed — fine
  } finally {
    client.close();
  }
}
