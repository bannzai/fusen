import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** A file under `.fusen/` that could not be read as the record its directory holds. */
export interface InvalidFusenFile {
  /** Absolute path of the file. */
  path: string;
  /** Why the file was rejected. */
  message: string;
}

// Identifiers become file names, so they are limited to characters that cannot escape the directory.
export const fusenIdPattern = /^[A-Za-z0-9_-]+$/;
const fusenFileExtension = ".json";

/** Returns the path of the file named after `id` in `directoryPath`. Throws for an id that could escape the directory. */
export function fusenFilePath(directoryPath: string, id: string): string {
  if (!fusenIdPattern.test(id)) {
    throw new Error(`Invalid id: ${JSON.stringify(id)}`);
  }
  return path.join(directoryPath, `${id}${fusenFileExtension}`);
}

/**
 * Reads every `<id>.json` file in `directoryPath` with `parse`, sorted by file name.
 * A file that `parse` rejects, or whose `id` does not match its file name, is returned in `invalidFiles`
 * instead of failing the whole read, so one broken file does not hide the others.
 */
export async function readFusenDirectory<T extends { id: string }>(
  directoryPath: string,
  parse: (value: unknown) => T,
): Promise<{ values: T[]; invalidFiles: InvalidFusenFile[] }> {
  const fileNames = await readdir(directoryPath).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const values: T[] = [];
  const invalidFiles: InvalidFusenFile[] = [];
  for (const fileName of fileNames.filter((name) => name.endsWith(fusenFileExtension)).sort()) {
    const filePath = path.join(directoryPath, fileName);
    try {
      const value = parse(JSON.parse(await readFile(filePath, "utf8")));
      if (`${value.id}${fusenFileExtension}` !== fileName) {
        throw new Error(`Id ${value.id} does not match the file name`);
      }
      values.push(value);
    } catch (error) {
      invalidFiles.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { values, invalidFiles };
}

/**
 * Writes `value` as pretty-printed JSON to `filePath`, replacing any previous content.
 * The content goes to a temporary file first and is renamed into place,
 * so a reader in another process never sees a half-written file.
 */
export async function writeFusenFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryFilePath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryFilePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryFilePath, filePath);
}

/** Returns whether a file exists at `filePath`. Errors other than a missing file are thrown. */
export async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    (error: unknown) => {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
}

/** Returns whether `value` is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns whether `error` is a Node.js system error that carries a `code`. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
