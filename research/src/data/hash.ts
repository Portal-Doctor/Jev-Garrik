import { createHash } from "node:crypto";

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface HashedFile {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Root hash of the sorted file-hash list.
 * Input is UTF-8 lines `relativePath \\t sha256 \\n`, sorted by relative path.
 */
export function rootHash(files: readonly HashedFile[]): string {
  const lines = files
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\t${file.sha256}\n`)
    .join("");
  return sha256Text(lines);
}
