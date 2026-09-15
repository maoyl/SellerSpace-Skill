import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AnalysisError } from "./analysis-core.mjs";
export async function withProjectLock(outputDir, operation, create = false) {
  if (create) await mkdir(outputDir, { recursive: true });
  const lockPath = path.join(outputDir, ".review-analysis.lock");
  const recoveryPath = `${lockPath}.recovery`;
  const owner = { pid: process.pid, token: randomUUID(), created_at: new Date().toISOString() };
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "ENOENT") throw new AnalysisError("PROJECT_NOT_FOUND", "输出目录不存在");
    if (error.code !== "EEXIST") throw error;
    // Serialize stale-owner recovery. Never remove a lock held by a live process.
    let recovery;
    try { recovery = await open(recoveryPath, "wx"); }
    catch (recoveryError) {
      if (recoveryError.code !== "EEXIST") throw recoveryError;
      throw new AnalysisError("PROJECT_BUSY", "另一个进程正在恢复项目锁");
    }
    try {
      let previous;
      try { previous = await readJsonIfExists(lockPath); }
      catch (readError) {
        if (readError.code !== "INVALID_JSON_FILE") throw readError;
        throw new AnalysisError("PROJECT_BUSY", "项目锁尚未完成初始化，请稍后重试");
      }
      if (!previous || !Number.isInteger(previous.pid)) throw new AnalysisError("PROJECT_BUSY", "项目锁尚未完成初始化，请稍后重试");
      try {
        process.kill(previous.pid, 0);
        throw new AnalysisError("PROJECT_BUSY", "另一个进程正在操作此项目", { pid: previous.pid });
      } catch (pidError) { if (pidError.code !== "ESRCH") throw pidError; }
      await rm(lockPath);
      try { handle = await open(lockPath, "wx"); }
      catch (acquireError) {
        if (acquireError.code !== "EEXIST") throw acquireError;
        throw new AnalysisError("PROJECT_BUSY", "项目锁已由另一个进程取得");
      }
    } finally {
      await recovery.close();
      await rm(recoveryPath, { force: true });
    }
  }
  try {
    await handle.writeFile(JSON.stringify(owner), "utf8");
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function readJsonIfExists(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new AnalysisError("INVALID_JSON_FILE", `无法读取 JSON：${filePath}`); }
}
export async function writeAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, value, "utf8"); await rename(temp, filePath); }
  finally { await rm(temp, { force: true }); }
}
export const writeJson = (filePath, value) => writeAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
