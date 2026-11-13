import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ObjectStorage } from "../../ports/store.ts";

/**
 * 로컬 디스크 오브젝트 스토리지.
 *
 * 임시 객체: <root>/tmp/<sessionId>.part
 * 최종 객체: <root>/objects/<key>
 *
 * 실제 서비스에서는 S3 등으로 교체한다(같은 ObjectStorage 포트).
 */
export class LocalDiskStorage implements ObjectStorage {
  readonly kind = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private tmpPath(sessionId: string): string {
    return path.join(this.root, "tmp", `${sessionId}.part`);
  }

  private objectPath(key: string): string {
    return path.join(this.root, "objects", key);
  }

  async startSession(sessionId: string): Promise<void> {
    await mkdir(path.join(this.root, "tmp"), { recursive: true });
    await writeFile(this.tmpPath(sessionId), Buffer.alloc(0));
  }

  async appendChunk(sessionId: string, offset: number, chunk: Buffer): Promise<number> {
    const file = this.tmpPath(sessionId);
    const info = await stat(file);
    if (info.size !== offset) {
      throw new Error(`offset mismatch: file=${info.size} offset=${offset}`);
    }
    await appendFile(file, chunk);
    return info.size + chunk.length;
  }

  async commitSession(sessionId: string, destinationKey: string): Promise<{ size: number; sha256: string }> {
    const file = this.tmpPath(sessionId);
    const info = await stat(file);
    const sha256 = await sha256File(file);
    const destination = this.objectPath(destinationKey);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(file, destination);
    return { size: info.size, sha256 };
  }

  async abortSession(sessionId: string): Promise<void> {
    await rm(this.tmpPath(sessionId), { force: true });
  }

  async delete(key: string): Promise<void> {
    const file = this.objectPath(key);
    await rm(file, { force: true });
    // 빈 디렉터리만 정리한다. 다른 객체가 있으면 rmdir 이 실패하고 무시된다.
    await rmdir(path.dirname(file)).catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.objectPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.objectPath(key));
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}
