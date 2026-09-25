// Checks that the packaged VSIX runs on its own: the extension entry point must contain the bundled fusen-core code
// and must not require any module other than `vscode` and Node built-ins, because the VSIX ships no node_modules.
//
// Usage: node scripts/check-vsix.mjs [path/to/fusen-<version>.vsix]
// Default path: fusen-<version>.vsix in the current directory, named after package.json like `vsce package` does.
// Exits 0 when the checks pass and 1 with the reasons when they fail. Requires `unzip`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const vsixPath = process.argv[2] ?? `${manifest.name}-${manifest.version}.vsix`;
const entryPath = `extension/${manifest.main.replace(/^\.\//, "")}`;
const entrySource = execFileSync("unzip", ["-p", vsixPath, entryPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Functions that the extension imports from fusen-core; their definitions must be in the bundle.
const fusenCoreFunctions = ["readThreads", "writeThread", "deleteThread", "createFusenId"];
const allowedModules = new Set(["vscode", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const failures = [];
for (const functionName of fusenCoreFunctions) {
  if (!new RegExp(`function ${functionName}\\(`).test(entrySource)) {
    const mentions = entrySource
      .split("\n")
      .filter((line) => line.includes(functionName))
      .slice(0, 3)
      .map((line) => `\n  ${line.trim().slice(0, 160)}`)
      .join("");
    failures.push(`${entryPath} does not define ${functionName} from fusen-core; lines mentioning it:${mentions || " none"}`);
  }
}
const requiredModules = new Set(
  [...entrySource.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]),
);
for (const moduleName of requiredModules) {
  if (!allowedModules.has(moduleName)) {
    failures.push(`${entryPath} requires "${moduleName}", which is not in the VSIX`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`error: ${failure}`);
  }
  process.exit(1);
}
console.log(
  `${vsixPath}: ${entryPath} bundles ${fusenCoreFunctions.join(", ")} and requires only ${[...requiredModules].sort().join(", ")}`,
);
