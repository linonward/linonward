import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * 只比较 `resolve()` 后的字符串挡不住工作区内的符号链接逃逸，
 * 因此调用方必须传入 `realpath()` 之后的工作区根目录与目标路径。
 */
export function assertInside(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("path_outside_workspace");
  }
}

export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  return realpath(resolve(cwd));
}

/** 解析一个已存在的对象；符号链接会先被展开，再检查它是否仍在真实根目录内。 */
export async function resolveExistingWorkspacePath(cwd: string, input: string): Promise<string> {
  const root = await realpath(resolve(cwd));

  let target: string;
  try {
    target = await realpath(resolve(root, input));
  } catch {
    throw new Error("path_not_found");
  }

  assertInside(root, target);
  return target;
}

/**
 * 补丁目标路径。已有文件复用 `realpath` 检查；创建文件时真实解析父目录，
 * 拒绝符号链接父级逃逸，再把新文件名拼回真实父目录。
 */
export async function resolvePatchTarget(
  cwd: string,
  inputPath: string,
  operation: "create" | "update" | "delete",
): Promise<string> {
  if (operation !== "create") return resolveExistingWorkspacePath(cwd, inputPath);

  const root = await realpath(resolve(cwd));
  const candidate = resolve(root, inputPath);

  let realParent: string;
  try {
    realParent = await realpath(dirname(candidate));
  } catch {
    throw new Error("path_not_found");
  }

  assertInside(root, realParent);
  return join(realParent, basename(candidate));
}
