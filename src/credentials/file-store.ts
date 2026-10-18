import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CredentialStore, OAuthCredentials } from '../types.js';
import { OpenAIOAuthError } from '../errors.js';

type Records = Record<string, OAuthCredentials>;

/**
 * A local JSON credential store. The caller chooses its path and record key.
 * Writes are serialized across processes, but OAuth refresh itself is only
 * serialized within one OpenAIOAuth instance.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(readonly path: string) {}

  async load(key: string): Promise<OAuthCredentials | null> {
    return (await this.read())[key] ?? null;
  }

  async save(key: string, credentials: OAuthCredentials): Promise<void> {
    await this.withLock(async () => {
      const records = await this.read();
      records[key] = credentials;
      await this.write(records);
    });
  }

  async delete(key: string): Promise<void> {
    await this.withLock(async () => {
      const records = await this.read();
      delete records[key];
      await this.write(records);
    });
  }

  private async read(): Promise<Records> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new OpenAIOAuthError(`Credential store is corrupt: expected a JSON object at ${this.path}.`);
      }
      return parsed as Records;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      if (error instanceof SyntaxError) {
        throw new OpenAIOAuthError(`Credential store is corrupt and was not modified: ${this.path}.`, { cause: error });
      }
      throw error;
    }
  }

  private async write(records: Records): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    await mkdir(dirname(this.path), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { handle = await open(lockPath, 'wx', 0o600); break; }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!handle) throw new Error(`Timed out waiting for credential lock: ${lockPath}`);
    try { return await operation(); }
    finally { await handle.close(); await rm(lockPath, { force: true }); }
  }
}
