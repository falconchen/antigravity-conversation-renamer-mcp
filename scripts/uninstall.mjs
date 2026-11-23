#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
      // 忽略清理失败
    }
    throw err;
  }
}

export function runUninstall(options = {}) {
  const configDir = path.resolve(
    options.configDir ??
      process.env.ANTIGRAVITY_CONFIG_DIR ??
      path.join(os.homedir(), ".gemini", "config"),
  );

  let removedMcpEntry = false;
  const mcpConfigPath = path.join(configDir, "mcp_config.json");
  if (fs.existsSync(mcpConfigPath)) {
    const raw = fs.readFileSync(mcpConfigPath, "utf8").trim();
    if (raw.length > 0) {
      const mcpConfig = JSON.parse(raw);
      if (
        mcpConfig &&
        typeof mcpConfig === "object" &&
        mcpConfig.mcpServers &&
        Object.prototype.hasOwnProperty.call(mcpConfig.mcpServers, "conversation-renamer")
      ) {
        delete mcpConfig.mcpServers["conversation-renamer"];
        writeFileAtomic(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
        removedMcpEntry = true;
      }
    }
  }

  let removedRule = false;
  const rulePath = path.join(configDir, "rules", "conversation-auto-rename.md");
  if (fs.existsSync(rulePath)) {
    fs.unlinkSync(rulePath);
    removedRule = true;
  }

  let removedSkill = false;
  const skillDir = path.join(configDir, "skills", "rename");
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removedSkill = true;
  }

  return {
    mcpConfigPath,
    removedMcpEntry,
    removedRule,
    removedSkill,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runUninstall();
  console.log("[conversation-renamer-mcp] 卸载清理完成（不会影响已有对话记录与标题）：");
  console.log(`- 已移除 mcp_config.json 中的 conversation-renamer: ${result.removedMcpEntry}`);
  console.log(`- 已移除自动触发规则: ${result.removedRule}`);
  console.log(`- 已移除 /rename Skill: ${result.removedSkill}`);
  console.log("\n请重启 Antigravity（或刷新 MCP Servers）完成生效；如需清理源码目录可手动删除本项目文件夹。");
}
