import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  slackToken: process.env.SLACK_BOT_TOKEN || "",
  channel: process.env.SLACK_CHANNEL_ID || "",
  authorizedUser: process.env.AUTHORIZED_SLACK_USER_ID || "",
  stateFile: process.env.CAREEROPS_STATE_FILE || path.join(root, "data/aws-worker-state.json"),
  pollMs: positiveInt(process.env.POLL_INTERVAL_SECONDS, 300) * 1000,
  scanMs: positiveInt(process.env.SCAN_INTERVAL_SECONDS, 3600) * 1000,
  codexTimeoutMs: positiveInt(process.env.CODEX_TIMEOUT_SECONDS, 3300) * 1000,
  codexModel: process.env.CODEX_MODEL || "",
};

const promptTemplate = await fs.readFile(path.join(root, "deploy/agent-prompt.md"), "utf8");
const schemaPath = path.join(root, "deploy/careerops-response.schema.json");

if (process.argv.includes("--check")) {
  const requiredFiles = [
    "AGENTS.md", "cv.md", "config/profile.yml", "modes/_profile.md",
    "modes/_custom.md", "portals.yml", "deploy/agent-prompt.md",
    "deploy/careerops-response.schema.json",
  ];
  const missing = [];
  for (const file of requiredFiles) {
    try { await fs.access(path.join(root, file)); } catch { missing.push(file); }
  }
  if (missing.length) throw new Error(`Missing required files: ${missing.join(", ")}`);
  process.stdout.write("CareerOps AWS worker files are ready. Runtime secrets are checked at startup.\n");
  process.exit(0);
}

for (const [name, value] of [
  ["OPENAI_API_KEY", process.env.OPENAI_API_KEY],
  ["SLACK_BOT_TOKEN", env.slackToken],
  ["SLACK_CHANNEL_ID", env.channel],
  ["AUTHORIZED_SLACK_USER_ID", env.authorizedUser],
]) {
  if (!value) throw new Error(`${name} is required`);
}

await authenticateCodex();

let state = await readState();
let running = false;

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

log("worker started");
await tick();
const timer = setInterval(tick, env.pollMs);

async function tick() {
  if (running) return;
  running = true;
  try {
    await processSlackEvents();
    if (Date.now() - state.lastScanAt >= env.scanMs) {
      await runEvent({
        type: "hourly_discovery",
        current_time_iso: new Date().toISOString(),
        instruction: "Run one complete hourly market discovery cycle.",
      });
      state.lastScanAt = Date.now();
      await writeState();
    }
  } catch (error) {
    log(`tick failed: ${error.stack || error}`);
  } finally {
    running = false;
  }
}

async function authenticateCodex() {
  log("authenticating Codex with API key");
  await runProcess(
    "codex",
    ["login", "--with-api-key"],
    `${process.env.OPENAI_API_KEY}\n`,
    30_000,
  );
  await runProcess("codex", ["login", "status"], "", 30_000);
}

async function processSlackEvents() {
  const oldest = state.lastTopLevelTs || "0";
  const history = await slack("conversations.history", {
    channel: env.channel,
    oldest,
    inclusive: false,
    limit: 100,
  });
  const topLevel = [...(history.messages || [])].reverse();

  for (const message of topLevel) {
    if (message.thread_ts || message.subtype || message.bot_id) continue;
    state.lastTopLevelTs = maxTs(state.lastTopLevelTs, message.ts);
    if (message.user === env.authorizedUser) {
      await handleSlackMessage(message, null);
    }
    if (message.reply_count || state.threads[message.ts]) {
      state.threads[message.ts] ||= "0";
    }
    await writeState();
  }

  for (const threadTs of Object.keys(state.threads)) {
    let replies;
    try {
      replies = await slack("conversations.replies", {
        channel: env.channel,
        ts: threadTs,
        limit: 100,
      });
    } catch (error) {
      if (String(error.message).includes("invalid_arguments")) {
        log(`dropping invalid Slack thread cursor: ${threadTs}`);
        delete state.threads[threadTs];
        await writeState();
        continue;
      }
      throw error;
    }
    const cursor = state.threads[threadTs] || "0";
    for (const reply of replies.messages || []) {
      if (reply.ts === threadTs || Number(reply.ts) <= Number(cursor)) continue;
      state.threads[threadTs] = maxTs(state.threads[threadTs], reply.ts);
      if (reply.user === env.authorizedUser && !reply.subtype && !reply.bot_id) {
        await handleSlackMessage(reply, threadTs);
      }
      await writeState();
    }
  }
}

async function handleSlackMessage(message, threadTs) {
  const eventKey = `${message.ts}:${threadTs || "top"}`;
  if (state.processed[eventKey]) return;
  const replyThreadTs = threadTs || message.ts;
  state.threads[replyThreadTs] ||= "0";
  await runEvent({
    type: "slack_message",
    current_time_iso: new Date().toISOString(),
    channel_id: env.channel,
    authorized_user_id: env.authorizedUser,
    message_ts: message.ts,
    thread_ts: replyThreadTs,
    text: message.text || "",
  });
  state.processed[eventKey] = Date.now();
  pruneProcessed();
}

async function runEvent(event) {
  const runId = `${Date.now()}-${event.type}`;
  const outputFile = path.join("/tmp", `careerops-${runId}.json`);
  const prompt = `${promptTemplate}\n\nEVENT:\n${JSON.stringify(event, null, 2)}\n`;
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-schema", schemaPath,
    "--output-last-message", outputFile,
    "--cd", root,
  ];
  if (env.codexModel) args.push("--model", env.codexModel);
  args.push("-");

  log(`starting ${event.type}`);
  await runProcess("codex", args, prompt, env.codexTimeoutMs);
  const result = JSON.parse(await fs.readFile(outputFile, "utf8"));
  await fs.rm(outputFile, { force: true });
  for (const message of result.messages || []) {
    const posted = await postMessage(message);
    const parentTs = message.thread_ts || posted.ts;
    if (!message.thread_ts && posted.ts) state.threads[posted.ts] ||= "0";
    for (const file of message.files || []) await uploadFile(file, parentTs);
  }
  log(`completed ${event.type}: ${result.summary || "no summary"}`);
}

async function postMessage(message) {
  if (!message.text?.trim()) return {};
  return slack("chat.postMessage", {
    channel: env.channel,
    text: message.text,
    ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
}

async function uploadFile(file, threadTs) {
  const absolute = path.resolve(root, file.path);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe file path: ${file.path}`);
  const bytes = await fs.readFile(absolute);
  const ticket = await slack("files.getUploadURLExternal", {
    filename: path.basename(absolute),
    length: bytes.length,
  }, { form: true });
  const upload = await fetch(ticket.upload_url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!upload.ok) throw new Error(`Slack file upload failed: ${upload.status}`);
  await slack("files.completeUploadExternal", {
    files: [{ id: ticket.file_id, title: file.title }],
    channel_id: env.channel,
    thread_ts: threadTs,
  }, { form: true });
}

async function slack(method, body, { form = false } = {}) {
  const headers = { authorization: `Bearer ${env.slackToken}` };
  let payload;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded; charset=utf-8";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      params.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value),
      );
    }
    payload = params.toString();
  } else {
    headers["content-type"] = "application/json; charset=utf-8";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers,
    body: payload,
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const details = data.response_metadata?.messages?.join("; ");
    throw new Error(
      `Slack ${method}: ${data.error || response.status}${details ? ` (${details})` : ""}`,
    );
  }
  return data;
}

function runProcess(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ["pipe", "inherit", "inherit"] });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

async function readState() {
  try {
    return normalizeState(JSON.parse(await fs.readFile(env.stateFile, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      const legacy = JSON.parse(
        await fs.readFile(path.join(root, "data/slack-listener-state.json"), "utf8"),
      );
      return normalizeState({
        lastTopLevelTs: legacy.last_processed_user_message_ts || "0",
      });
    } catch (legacyError) {
      if (legacyError.code !== "ENOENT") {
        log(`ignoring unreadable legacy Slack state: ${legacyError.message}`);
      }
      return normalizeState({});
    }
  }
}

function normalizeState(value) {
  return {
    version: 1,
    lastScanAt: Number(value.lastScanAt || 0),
    lastTopLevelTs: String(value.lastTopLevelTs || "0"),
    threads: value.threads && typeof value.threads === "object" ? value.threads : {},
    processed: value.processed && typeof value.processed === "object" ? value.processed : {},
  };
}

async function writeState() {
  await fs.mkdir(path.dirname(env.stateFile), { recursive: true });
  const temporary = `${env.stateFile}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(temporary, env.stateFile);
}

function pruneProcessed() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [key, timestamp] of Object.entries(state.processed)) {
    if (timestamp < cutoff) delete state.processed[key];
  }
}

function maxTs(a = "0", b = "0") {
  return Number(a) >= Number(b) ? a : b;
}

function positiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

async function shutdown(code) {
  clearInterval(timer);
  if (running) log("waiting for active run to finish");
  await writeState().catch(() => {});
  process.exit(code);
}
