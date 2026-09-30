import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * sha256 of a file — the dedupe key for a SourceVersion.
 *
 * Streamed rather than read whole: the corpus already contains a 28MB scan, and
 * a user adding 100 documents at once should not need all of them in memory.
 */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => hash.update(c))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** sha256 of a buffer already in hand (an upload, say). */
export function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
