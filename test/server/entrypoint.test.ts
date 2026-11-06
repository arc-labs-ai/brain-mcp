/**
 * The package has to start when it is started the way it is installed.
 *
 * npm puts a `bin` on PATH as a symlink, so every documented client config —
 * `npx -y @brain-db/mcp --stdio` — reaches `dist/index.js` through a link. The
 * old entrypoint guard compared `import.meta.url` to a `file://` string built
 * from `process.argv[1]`, which is the LINK, not the target it resolves to. It
 * never matched, `main()` never ran, and the process exited 0 having done
 * nothing.
 *
 * Nothing inside the module can see that, which is why this is an end-to-end
 * test over a real child process. The bug lives entirely in how the process
 * was invoked: a test that imported the module and called `main()` would have
 * passed the whole time it was broken.
 *
 * It runs against `dist/`, the artifact that ships — not against `src/`,
 * because the bug is in how the PROCESS is invoked and importing the module
 * would prove nothing.
 *
 * It FAILS rather than skips when there is no build. `describe.skipIf` was
 * the obvious reading of "this needs dist", and it made the guard for the
 * worst bug this package has had conditional on somebody having run `tsc`
 * first — a green run on a machine with no `dist/` looked identical to a green
 * run that had actually checked. `pretest` builds, so an absent `dist/` now
 * means the build failed, which is worth failing for.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
const built = existsSync(entry);

/**
 * Start the server over stdio with stdin already at EOF, so it comes up, finds
 * no frames and exits on its own rather than needing to be killed.
 *
 * The backend is a closed port: this asserts that the process STARTS, and
 * reaching a real Brain is not part of that.
 */
function run(invokedAs: string): { stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [invokedAs, "--stdio"], {
    env: {
      ...process.env,
      BRAIN_MCP_BACKEND_URL: "http://127.0.0.1:1",
      BRAIN_MCP_API_KEY: "brain_test",
    },
    input: "",
    encoding: "utf8",
    timeout: 15_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("entrypoint detection", () => {
  it("has something to test", () => {
    expect(
      built,
      `no build at ${entry} — run \`npm run build\`. This test asserts how the shipped artifact behaves when invoked, so without one it proves nothing.`,
    ).toBe(true);
  });

  it("starts when run directly", () => {
    expect(run(entry).stderr).toMatch(/brain-mcp on stdio/);
  });

  it("starts when run through a bin symlink, the way npm installs it", () => {
    const link = join(mkdtempSync(join(tmpdir(), "brain-mcp-bin-")), "brain-mcp");
    symlinkSync(entry, link);
    expect(run(link).stderr).toMatch(/brain-mcp on stdio/);
  });

  it("says nothing on stdout, where a stray line is a protocol parse error", () => {
    expect(run(entry).stdout).toBe("");
  });
});
