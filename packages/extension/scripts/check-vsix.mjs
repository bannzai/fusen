// Checks that the packaged VSIX runs on its own: the extension entry point must contain the bundled fusen-core code
// and must not require any module other than `vscode` and Node built-ins, because the VSIX ships no node_modules.
// Also checks that the VSIX holds the icon and the license, and no sources, source maps, tests or build settings.
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
  // esbuild renames bundled declarations that collide with other names by appending a number
  // (`async function readThreads2(`), so the definition and the module export are matched with an optional suffix.
  const isDefined = new RegExp(`\\bfunction ${functionName}\\d*\\(`).test(entrySource);
  const isExported = new RegExp(`\\bexports\\d*\\.${functionName} = ${functionName}\\d*;`).test(entrySource);
  if (!isDefined || !isExported) {
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

const entryNames = execFileSync("unzip", ["-Z1", vsixPath], { encoding: "utf8" }).split("\n").filter(Boolean);
// vsce stores a license file without an extension as LICENSE.txt.
const requiredEntries = [`extension/${manifest.icon}`, "extension/LICENSE.txt"];
for (const requiredEntry of requiredEntries) {
  if (!entryNames.includes(requiredEntry)) {
    failures.push(`the VSIX does not contain ${requiredEntry}`);
  }
}
const unwantedEntryPattern = /(\.map|\.ts|\.test\.[cm]?js|\/tsconfig\.json)$|^extension\/(src|scripts|node_modules)\//;
for (const entryName of entryNames.filter((name) => unwantedEntryPattern.test(name))) {
  failures.push(`the VSIX contains ${entryName}, which the extension does not need at run time`);
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
console.log(`${vsixPath} contains:\n${entryNames.map((entryName) => `  ${entryName}`).join("\n")}`);
