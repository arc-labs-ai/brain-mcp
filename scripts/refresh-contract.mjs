// The contract lives in a sibling repo that CI does not check out, so the
// committed copy is what CI compares against, and this script is how it is updated.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(repoRoot, "../brain-sdk/contract/http-routes.json");
const snapshotPath = resolve(repoRoot, "contract/brain-routes.json");

let sourceText;
try {
  sourceText = await readFile(sourcePath, "utf8");
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error(
      "Cannot refresh the Brain route snapshot: the brain-sdk checkout must be a sibling directory to refresh it.",
    );
  } else {
    console.error(`Cannot read the Brain route contract at ${sourcePath}:`, error);
  }
  process.exitCode = 1;
}

if (sourceText === undefined) process.exit();

const contract = JSON.parse(sourceText);
const routes = contract.routes.map(({ method, path }) => ({
  method,
  path: path.replace(/\{[^}]+\}/g, "{id}"),
}));

routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const fields = new Set();
for (const route of contract.routes) {
  for (const dtoName of [route.request_body, route.query]) {
    if (dtoName === null) continue;
    for (const field of contract.dtos[dtoName].fields) fields.add(field.name);
  }
}

const snapshot = {
  source: "../brain-sdk/contract/http-routes.json",
  generated_from: routes.length,
  routes,
  fields: [...fields].sort(),
};

await mkdir(dirname(snapshotPath), { recursive: true });
await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
