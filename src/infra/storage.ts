/**
 * Default IStorage implementation using Node.js fs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, openSync, chmodSync, renameSync, rmSync } from 'fs';
import type { IStorage } from '../types/interfaces.js';

export class FileStorage implements IStorage {
  readFile(path: string, encoding: string): string {
    return readFileSync(path, encoding as BufferEncoding);
  }

  writeFile(path: string, data: string): void {
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(tempPath, data);
    try {
      renameSync(tempPath, path);
    } catch (error) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // best effort
      }
      throw error;
    }
  }

  chmod(path: string, mode: number): void {
    chmodSync(path, mode);
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  mkdirp(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  unlink(path: string): void {
    unlinkSync(path);
  }

  openSync(path: string, flags: string): number {
    return openSync(path, flags);
  }
}
