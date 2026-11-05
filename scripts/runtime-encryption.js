"use strict";
// Run with the engine stopped. Works in either direction for safe rollback;
// never restores an old snapshot over newly created business data.
const fs = require("node:fs");
const path = require("node:path");
const { loadSecrets } = require("../src/platform/security");
const runtimeSecrets = require("../src/platform/runtime-secrets");
const { atomicWriteText } = require("../src/ui-server/utils");
function migrate(cwd, mode = "encrypt") {
  if (!["encrypt", "decrypt"].includes(mode))
    throw new Error("Expected encrypt or decrypt");
  process.env.GPTREG_RUNTIME_MASTER_KEY = loadSecrets(cwd).master;
  const config = JSON.parse(
    fs.readFileSync(path.join(cwd, ".runtime", "gpt-re.config.json"), "utf8"),
  );
  const stateRoot = path.resolve(cwd, config.output.stateDir),
    cpaRoot = path.resolve(cwd, config.output.cpaDir);
  const files = new Set();
  function walk(dir, accept) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, accept);
      else if (entry.isFile() && accept(p)) files.add(p);
    }
  }
  walk(
    stateRoot,
    (p) =>
      /^run-.+\.json(?:\.bak)?$/.test(path.basename(p)) ||
      /^asset-.+\.json(?:\.bak)?$/.test(path.basename(p)),
  );
  walk(cpaRoot, (p) => /\.json(?:\.bak)?$/.test(p));
  let changed = 0;
  for (const file of files) {
    const original = fs.readFileSync(file, "utf8");
    let raw;
    try {
      raw = JSON.parse(original);
    } catch {
      throw new Error(`Invalid runtime JSON: ${path.basename(file)}`);
    }
    const decoded = runtimeSecrets.unprotect(raw),
      value = mode === "encrypt" ? runtimeSecrets.protect(decoded) : decoded;
    if (JSON.stringify(raw) === JSON.stringify(value)) continue;
    atomicWriteText(file, JSON.stringify(value) + "\n");
    fs.chmodSync(file, 0o600);
    changed++;
  }
  return { mode, checked: files.size, changed };
}
if (require.main === module)
  console.log(
    JSON.stringify(migrate(process.cwd(), process.argv[2] || "encrypt")),
  );
module.exports = { migrate };
