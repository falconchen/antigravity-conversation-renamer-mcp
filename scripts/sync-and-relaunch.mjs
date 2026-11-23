#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectAntigravityPids() {
  if (process.platform === "win32") {
    return [];
  }
  const out = execFileSync("/bin/ps", ["-eo", "pid,command"], { encoding: "utf8" });
  const pids = new Set();
  const selfPid = process.pid;

  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const cmd = match[2];
    if (pid === selfPid) continue;

    // 严格保护自动审批工具与本 MCP / 同步脚本，绝不误伤
    if (
      cmd.includes("AntigravityAutoApprove") ||
      cmd.includes("Antigravity Auto Approve") ||
      cmd.includes("conversation-renamer-mcp") ||
      cmd.includes("sync-and-relaunch.mjs")
    ) {
      continue;
    }

    const isOfficialApp =
      cmd.includes("/Applications/Antigravity.app/") ||
      cmd === "Antigravity" ||
      cmd.startsWith("Antigravity ");
    const isLanguageServer =
      cmd.includes("language_server_macos") ||
      cmd.includes("language_server_linux") ||
      (cmd.includes("language_server") && cmd.includes("antigravity"));

    if (isOfficialApp || isLanguageServer) {
      pids.add(pid);
    }
  }
  return Array.from(pids);
}

async function stopOfficialAntigravityCold(log) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/IM", "Antigravity.exe"], { stdio: "ignore" });
    } catch {
      // 忽略未运行
    }
    await sleep(800);
    return;
  }

  const pids = collectAntigravityPids();
  log(`发现 ${pids.length} 个官方 Antigravity / language_server 进程，使用 SIGKILL 阻断退出脏写回...`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能已退出
    }
  }

  // 等待全部官方进程完全退出（最长 3 秒）
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const remaining = collectAntigravityPids();
    if (remaining.length === 0) break;
    await sleep(150);
  }
  await sleep(400);
}

function relaunchAntigravity(log) {
  if (process.platform === "darwin") {
    log("正在重新拉起 Antigravity 客户端...");
    try {
      execFileSync("/usr/bin/open", ["-b", "com.google.antigravity"], { stdio: "ignore" });
    } catch {
      execFileSync("/usr/bin/open", ["-a", "Antigravity"], { stdio: "ignore" });
    }
    return;
  }
  log("非 macOS 环境，请手动重新打开 Antigravity 客户端。");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const syncOnly = args.has("--sync-only");
  const noRelaunch = args.has("--no-relaunch");
  const detached = args.has("--detached");
  const isDetachedWorker = args.has("--detached-worker");

  const distSyncModule = path.join(PROJECT_ROOT, "dist", "src", "syncPbtxt.js");
  if (!fs.existsSync(distSyncModule)) {
    throw new Error(`未找到编译产物 ${distSyncModule}，请先执行 npm run build`);
  }

  // 若在 Antigravity 内部调用且传入 --detached，脱离父进程组在后台延迟执行，避免被父进程终止中断
  if (detached && !dryRun && !isDetachedWorker) {
    const logPath = path.join(os.homedir(), ".gemini", "antigravity", "conversation-renamer-sync.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const outFd = fs.openSync(logPath, "a");
    const childArgs = [fileURLToPath(import.meta.url), "--detached-worker"];
    if (syncOnly) childArgs.push("--sync-only");
    if (noRelaunch) childArgs.push("--no-relaunch");

    const child = spawn(process.execPath, childArgs, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: process.env,
    });
    child.unref();
    fs.closeSync(outFd);
    console.log(`已启动后台冷同步刷新任务 (PID=${child.pid})，日志见: ${logPath}`);
    return;
  }

  const log = (msg) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [sync-relaunch] ${msg}`);
  };

  if (isDetachedWorker) {
    log("后台冷同步任务已脱离父进程，等待 1 秒后开始...");
    await sleep(1000);
  }

  const { syncAllPbtxtToStore } = await import(distSyncModule);

  if (dryRun) {
    const preview = syncAllPbtxtToStore({ dryRun: true });
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  if (!syncOnly) {
    await stopOfficialAntigravityCold(log);
  }

  const result = syncAllPbtxtToStore({ dryRun: false, checkpointWal: true });
  log(
    `冷同步完成：扫描 ${result.scannedAnnotations} 个 .pbtxt，同步 ${result.syncedCount} 条对话（FTS5=${result.ftsUpdatedCount}，Proto缓存=${result.protoCacheUpdatedCount}）。`,
  );

  if (!syncOnly && !noRelaunch) {
    relaunchAntigravity(log);
  }
}

main().catch((err) => {
  console.error("[sync-relaunch] 执行失败:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
