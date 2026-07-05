/** vitest 用スタブ。import が通ることだけ保証し、呼んだら throw。 */
export const BaseDirectory = { AppData: 1 } as const;

function unavailable(name: string): never {
  throw new Error(`unit テストから ${name} は呼べません (スタブ)`);
}

export async function readFile(): Promise<Uint8Array> {
  unavailable("readFile");
}
export async function writeFile(): Promise<void> {
  unavailable("writeFile");
}
export async function mkdir(): Promise<void> {
  unavailable("mkdir");
}
export async function exists(): Promise<boolean> {
  unavailable("exists");
}
export async function readDir(): Promise<unknown[]> {
  unavailable("readDir");
}
export async function remove(): Promise<void> {
  unavailable("remove");
}
