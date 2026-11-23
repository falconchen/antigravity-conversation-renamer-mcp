import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

test("setup.mjs 与 uninstall.mjs 在沙盒配置目录中无损增量安装并干净卸载", async () => {
  const { runSetup } = (await import(path.join(PROJECT_ROOT, "scripts/setup.mjs"))) as {
    runSetup: (opts: Record<string, unknown>) => {
      nodeBin: string;
      distEntry: string;
      mcpConfigPath: string;
      rulePath: string | null;
      skillPath: string | null;
    };
  };
  const { runUninstall } = (await import(path.join(PROJECT_ROOT, "scripts/uninstall.mjs"))) as {
    runUninstall: (opts: Record<string, unknown>) => {
      removedMcpEntry: boolean;
      removedRule: boolean;
      removedSkill: boolean;
    };
  };

  const sandboxConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-setup-test-"));
  try {
    // 预置一个用户已有的 MCP 服务，验证安装与卸载均不破坏原有配置
    const mcpCfgPath = path.join(sandboxConfigDir, "mcp_config.json");
    fs.writeFileSync(
      mcpCfgPath,
      JSON.stringify(
        {
          mcpServers: {
            "existing-server": { command: "/usr/bin/env", args: ["echo"] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const setupRes = runSetup({
      configDir: sandboxConfigDir,
      projectRoot: PROJECT_ROOT,
      skipBuild: true,
      skipTest: true,
    });

    const installedCfg = JSON.parse(fs.readFileSync(mcpCfgPath, "utf8"));
    assert.deepEqual(installedCfg.mcpServers["existing-server"], {
      command: "/usr/bin/env",
      args: ["echo"],
    });
    assert.equal(installedCfg.mcpServers["conversation-renamer"].command, process.execPath);
    assert.equal(
      installedCfg.mcpServers["conversation-renamer"].args[0],
      path.join(PROJECT_ROOT, "dist", "src", "index.js"),
    );
    assert.ok(setupRes.rulePath && fs.existsSync(setupRes.rulePath));
    assert.ok(setupRes.skillPath && fs.existsSync(setupRes.skillPath));

    const uninstallRes = runUninstall({ configDir: sandboxConfigDir });
    assert.equal(uninstallRes.removedMcpEntry, true);
    assert.equal(uninstallRes.removedRule, true);
    assert.equal(uninstallRes.removedSkill, true);

    const afterUninstallCfg = JSON.parse(fs.readFileSync(mcpCfgPath, "utf8"));
    assert.equal(afterUninstallCfg.mcpServers["conversation-renamer"], undefined);
    assert.deepEqual(afterUninstallCfg.mcpServers["existing-server"], {
      command: "/usr/bin/env",
      args: ["echo"],
    });
    assert.equal(fs.existsSync(setupRes.rulePath!), false);
    assert.equal(fs.existsSync(setupRes.skillPath!), false);
  } finally {
    fs.rmSync(sandboxConfigDir, { recursive: true, force: true });
  }
});
