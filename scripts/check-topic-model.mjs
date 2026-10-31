import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jar = process.env.TLA2TOOLS_JAR;
const java = process.env.JAVA || "java";
const caseTimeoutMs = 300_000;
const pinnedSha256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const cases = new Map([
  ["safety", null],
  ["stale-ack", "Invariant ConfirmationEvidence is violated."],
  ["goal-notice", "Invariant ConfirmationEvidence is violated."],
  ["liveness", null],
  ["missing-lease", "Temporal properties were violated."],
  ["stored-name", "Temporal properties were violated."],
]);
const selected = process.argv.slice(2);
if (!jar) throw new Error("Set TLA2TOOLS_JAR to the official TLC v1.7.4 tla2tools.jar.");
if (selected.some((name) => !cases.has(name))) {
  throw new Error(`Expected model cases: ${[...cases.keys()].join(", ")}`);
}
const actualSha256 = createHash("sha256").update(await readFile(jar)).digest("hex");
if (actualSha256 !== pinnedSha256) {
  throw new Error(`TLC v1.7.4 SHA256 mismatch: expected ${pinnedSha256}, received ${actualSha256}`);
}
const work = await mkdtemp(join(tmpdir(), "topic-reconciliation-tlc-"));
// The requested source filename has hyphens; TLA+ module identifiers cannot.
await copyFile(join(root, "formal/topic-reconciliation.tla"), join(work, "TopicReconciliation.tla"));
console.log(`TLC v1.7.4; full unmodified checker logs and states: ${work}`);
console.log("Finite scope: safety 2 values / 2 generations / 2 never-reused requests; liveness 2 / 1 / 3. Liveness is conditional on remaining repair capacity, fair admission/timeouts/needed expiry, and eventual application-or-rejection; not an unbounded retry theorem.");
let failed = false;
for (const name of selected.length ? selected : cases.keys()) {
  const config = `topic-reconciliation-${name}.cfg`;
  await copyFile(join(root, "formal", config), join(work, config));
  const args = ["-Xmx1024m", "-cp", resolve(jar), "tlc2.TLC", "-workers", "1", "-config", config,
    "-metadir", join(work, `${name}-states`), "TopicReconciliation"];
  console.log(`\nChecking ${name}: ${JSON.stringify([java, ...args])}`);
  const log = createWriteStream(join(work, `${name}.log`));
  let output = "";
  let timedOut = false;
  const code = await new Promise((accept, reject) => {
    const child = spawn(java, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`TLC ${name} exceeded ${caseTimeoutMs}ms; terminating. Original checker output remains intact.`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, caseTimeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      log.end(() => reject(error));
    });
    child.stdout.on("data", (data) => { output += data; process.stdout.write(data); log.write(data); });
    child.stderr.on("data", (data) => { output += data; process.stderr.write(data); log.write(data); });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      log.end(() => signal && !timedOut
        ? reject(new Error(`TLC terminated by ${signal}`)) : accept(status));
    });
  });
  const expected = cases.get(name);
  const errors = [...output.matchAll(/^Error: (.*)$/gm)].map((match) => match[1]);
  const intendedErrorsOnly = errors.every((message) => message === expected
    || message === "The behavior up to this point is:"
    || message === "The following behavior constitutes a counter-example:");
  const passed = !timedOut && (expected === null
    ? code === 0 && output.includes("Model checking completed. No error has been found.")
    : code !== 0 && output.includes(expected) && intendedErrorsOnly
      && (output.includes("The behavior up to this point is:")
        || output.includes("The following behavior constitutes a counter-example:")));
  if (!passed) {
    failed = true;
    console.error(`Unexpected TLC result for ${name}: exit ${code}; expected ${expected ?? "successful exhaustive check"}. Original output retained above and in ${work}.`);
  } else {
    console.log(`${name}: ${expected === null ? "exhaustive check passed" : "intended counterexample found"}`);
  }
}
if (failed) process.exitCode = 1;
