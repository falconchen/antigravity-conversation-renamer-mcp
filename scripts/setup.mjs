#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map((n) => Number.parseInt(n, 10));
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(
      `需要 Node.js >= 22.5.0（内置 node:sqlite），当前版本为 v${process.versions.node}。请升级 Node 后重试。`,
    );
  }
}

function writeFileAtomic(targetPath, content) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // 忽略临时文件清理失败
    }
    throw err;
  }
}

export function runSetup(options = {}) {
  assertNodeVersion();

  const configDir = path.resolve(
    options.configDir ??
      process.env.ANTIGRAVITY_CONFIG_DIR ??
      path.join(os.homedir(), ".gemini", "config"),
  );
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const nodeBin = options.nodeBin ?? process.execPath;
  const installRule = options.installRule ?? true;
  const installSkill = options.installSkill ?? true;
  const skipBuild = options.skipBuild ?? false;
  const skipTest = options.skipTest ?? false;

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  if (!skipBuild) {
    execFileSync(npmCmd, ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
  }
  if (!skipTest) {
    execFileSync(npmCmd, ["test"], { cwd: projectRoot, stdio: "inherit" });
  }

  const distEntry = path.join(projectRoot, "dist", "src", "index.js");
  if (!fs.existsSync(distEntry)) {
    throw new Error(`未找到编译产物 ${distEntry}，请先执行 npm run build`);
  }

  // 1. 增量更新 mcp_config.json（完整保留用户已有 MCP 配置）
  fs.mkdirSync(configDir, { recursive: true });
  const mcpConfigPath = path.join(configDir, "mcp_config.json");
  let mcpConfig = { mcpServers: {} };
  if (fs.existsSync(mcpConfigPath)) {
    const raw = fs.readFileSync(mcpConfigPath, "utf8").trim();
    if (raw.length > 0) {
      mcpConfig = JSON.parse(raw);
      if (!mcpConfig || typeof mcpConfig !== "object" || Array.isArray(mcpConfig)) {
        throw new Error(`${mcpConfigPath} 格式异常：顶层必须是 JSON 对象`);
      }
      if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== "object") {
        mcpConfig.mcpServers = {};
      }
    }
  }

  mcpConfig.mcpServers["conversation-renamer"] = {
    command: nodeBin,
    args: [distEntry],
  };
  writeFileAtomic(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);

  // 2. 可选部署混合模式自动触发规则
  let rulePath = null;
  if (installRule) {
    const ruleSrc = path.join(projectRoot, "templates", "conversation-auto-rename.md");
    rulePath = path.join(configDir, "rules", "conversation-auto-rename.md");
    writeFileAtomic(rulePath, fs.readFileSync(ruleSrc, "utf8"));
  }

  // 3. 可选部署 /rename 斜杠命令 Skill
  let skillPath = null;
  if (installSkill) {
    const skillSrc = path.join(projectRoot, "templates", "skills", "rename", "SKILL.md");
    skillPath = path.join(configDir, "skills", "rename", "SKILL.md");
    writeFileAtomic(skillPath, fs.readFileSync(skillSrc, "utf8"));
  }

  return {
    nodeBin,
    distEntry,
    mcpConfigPath,
    rulePath,
    skillPath,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const result = runSetup({
    installRule: !args.has("--no-rule"),
    installSkill: !args.has("--no-skill"),
    skipBuild: args.has("--skip-build"),
    skipTest: args.has("--skip-test"),
  });

  console.log("\n[conversation-renamer-mcp] 安装配置完成：");
  console.log(`- Node 路径: ${result.nodeBin}`);
  console.log(`- MCP 入口:  ${result.distEntry}`);
  console.log(`- MCP 配置:  ${result.mcpConfigPath}`);
  if (result.rulePath) console.log(`- 触发规则:  ${result.rulePath}`);
  if (result.skillPath) console.log(`- /rename:   ${result.skillPath}`);
  console.log("\n请重启 Antigravity（或在 Additional Options (...) -> MCP Servers 中刷新）即可生效。");
}
