/**
 * Spawn an isolated Hermes process for one session ("shared agent" path).
 *
 * Flow:
 *   1. mkdir /tmp/sonoglyph-agents/<code>/.hermes/
 *   2. Copy global `.env` (creds) from the operator's user-level Hermes home
 *      (default /root/.hermes — bridge runs as root in systemd).
 *   3. Read operator's `config.yaml`, splice in our session-specific
 *      `mcp_servers.sonoglyph` block (URL embeds the session code), write
 *      the patched copy to the tmp dir.
 *   4. spawn `hermes --yolo --ignore-rules -Q -z "<initial prompt>"` with
 *      `HERMES_HOME=<tmp>`. The fresh HERMES_HOME means: agent reads our
 *      patched config (not the operator's live one), so concurrent sessions
 *      don't fight over a single global `mcp_servers.sonoglyph` entry.
 *   5. Tag stdout/stderr lines with the session code and forward to the
 *      bridge's stdout/stderr so logs stream into `journalctl -u sonoglyph-bridge`.
 *   6. On exit (natural — `wait_for_my_turn` returned `finished:true` — or
 *      forced kill), `rm -rf` the tmp dir.
 *
 * Why `-z` (not `-q`): `chat -q` closes the MCP transport via HTTP DELETE
 * after each model turn — that tears down the agent mid-game. `-z` runs the
 * full agent loop (multi-tool calls) in a single process invocation and
 * exits 0 only when our `wait_for_my_turn` returns `finished:true`. Verified
 * live on the deployed bridge — see HANDOFF.md for the test log.
 *
 * Why `--yolo`: skips per-tool approval prompts. The agent only ever calls
 * three of OUR tools (get_state, wait_for_my_turn, place_layer), all
 * server-mediated through the GameSession, so there's no privilege to leak.
 *
 * Why `--ignore-rules`: skips auto-injection of the operator's global
 * SOUL.md / AGENTS.md / .cursorrules into the system prompt. Spawned agents
 * are stateless personas — we want a clean slate for every session.
 *
 * Why `-Q`: programmatic mode, suppresses banner/spinner/tool previews so
 * journald logs stay readable.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

const SPAWN_BASE_DIR = '/tmp/sonoglyph-agents';

/**
 * Initial prompt handed to the spawned agent — identical to the one we
 * print in the browser for "bring your own Hermes" players (see
 * proxy/src/index.ts:hermesPrompt). Keeping the two strings the same means
 * spawned and BYO agents observe identical instructions and produce
 * comparable behavior — diverging them silently would make UX inconsistency
 * very hard to chase down.
 */
const INITIAL_PROMPT =
  "You are Hermes, co-composing Sonoglyph with me via the sonoglyph MCP server. " +
  "Read the server's initial instructions for the descent's musical key (root + mode). " +
  "Loop autonomously now: " +
  "(1) call wait_for_my_turn (it blocks ~10s for the cooldown). " +
  "(2) when it returns it_is_my_turn=true, immediately call place_layer(type, comment, intent). " +
  "(3) repeat from step 1. " +
  "Stop only when wait_for_my_turn returns finished=true. " +
  "Do not emit text between tool calls. " +
  "Layer types: drone, texture, pulse, glitch, breath, bell, drip, swell, chord. " +
  "Intent (optional but encouraged): tension | release | color | emphasis | hush — " +
  "this biases the pitch within the descent's scale. " +
  "Vary BOTH type and intent across the descent so the composition has a shape " +
  "(e.g. hush → color → tension → release). " +
  "Comment is one evocative line under 80 chars reacting to the music so far.";

export interface SpawnConfig {
  /** Path to operator's global Hermes home (creds + config source). */
  hermesHomePath: string;
  /** Hermes binary — name (resolved via PATH) or absolute path. */
  hermesBinPath: string;
  /** Local bridge port — used to build the in-process MCP URL. */
  bridgePort: number;
  /** Optional `model.default` override. Empty → use operator's config value. */
  modelOverride: string | null;
}

export interface SpawnedAgent {
  sessionCode: string;
  pid: number;
  startedAt: number;
  /** Gracefully terminate the process (SIGTERM, escalate to SIGKILL after 5s). */
  kill: () => Promise<void>;
  /** Resolves with the exit info once the process is gone. */
  exitPromise: Promise<{ code: number | null; signal: string | null }>;
}

export function loadSpawnConfig(): SpawnConfig {
  return {
    hermesHomePath: process.env.HERMES_HOME_PATH?.trim() || '/root/.hermes',
    hermesBinPath: process.env.HERMES_BIN_PATH?.trim() || 'hermes',
    bridgePort: Number(process.env.PROXY_PORT ?? 8787),
    modelOverride: process.env.SHARED_AGENT_MODEL_OVERRIDE?.trim() || null,
  };
}

export async function spawnHermesAgent(
  sessionCode: string,
  config: SpawnConfig,
): Promise<SpawnedAgent> {
  const tmpHome = join(SPAWN_BASE_DIR, sessionCode, '.hermes');
  await mkdir(tmpHome, { recursive: true });

  // ---- 1. Copy operator's .env (API keys, base URLs) ------------------------
  // Hermes resolves provider credentials from $HERMES_HOME/.env at startup.
  // If the file is missing we just warn — Hermes also falls back to ambient
  // process env, and the bridge inherits the operator's shell env via
  // systemd EnvironmentFile, so keys can still be present.
  try {
    await copyFile(
      join(config.hermesHomePath, '.env'),
      join(tmpHome, '.env'),
    );
  } catch (err) {
    console.warn(
      `[spawn ${sessionCode}] could not copy global .env (${(err as Error).message}); ` +
        `relying on process env for credentials`,
    );
  }

  // ---- 2. Read + patch config.yaml -----------------------------------------
  // We START from the operator's global config so model/provider/timeouts
  // match their own working setup, then OVERWRITE `mcp_servers.sonoglyph`
  // with our session-specific URL. Any other mcp_servers entries the
  // operator has globally (project_fs, stripe, etc.) come along for the
  // ride — usually harmless, since the agent's initial prompt only ever
  // calls sonoglyph tools.
  let userConfig: Record<string, unknown> = {};
  try {
    const text = await readFile(
      join(config.hermesHomePath, 'config.yaml'),
      'utf8',
    );
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === 'object') {
      userConfig = parsed as Record<string, unknown>;
    }
  } catch (err) {
    console.warn(
      `[spawn ${sessionCode}] could not read global config.yaml (${(err as Error).message}); ` +
        `proceeding with minimal config`,
    );
  }

  // Splice MCP server. Use 127.0.0.1 — no need to round-trip through Caddy
  // since the agent runs on the same box as the bridge.
  const sessionMcpUrl = `http://127.0.0.1:${config.bridgePort}/mcp?code=${sessionCode}`;
  const existingMcp =
    (userConfig.mcp_servers as Record<string, unknown> | undefined) ?? {};
  userConfig.mcp_servers = {
    ...existingMcp,
    sonoglyph: {
      url: sessionMcpUrl,
      enabled: true,
    },
  };

  // Optional model.default override — handy if you want shared agents on
  // a cheaper model than your dev account uses, without editing the global
  // config.
  if (config.modelOverride) {
    const existingModel =
      (userConfig.model as Record<string, unknown> | undefined) ?? {};
    userConfig.model = {
      ...existingModel,
      default: config.modelOverride,
    };
  }

  // Bump max_turns floor: a full descent is 15 layers × ~3 LLM rounds per
  // turn (wait_for_my_turn return → reason → place_layer) ≈ 45. Default of
  // 90 in stock config already covers it but the operator's may be lower.
  const existingAgent =
    (userConfig.agent as Record<string, unknown> | undefined) ?? {};
  const existingMaxTurns = Number(existingAgent.max_turns ?? 0);
  userConfig.agent = {
    ...existingAgent,
    max_turns: Math.max(60, existingMaxTurns),
  };

  await writeFile(
    join(tmpHome, 'config.yaml'),
    yaml.dump(userConfig, { lineWidth: 120, noRefs: true }),
    'utf8',
  );

  // ---- 3. Spawn -------------------------------------------------------------
  const args = ['--yolo', '--ignore-rules', '-Q', '-z', INITIAL_PROMPT];
  console.log(
    `[spawn ${sessionCode}] launching ${config.hermesBinPath} ` +
      `(HERMES_HOME=${tmpHome}, model=${config.modelOverride ?? 'inherited'})`,
  );

  const child: ChildProcess = spawn(config.hermesBinPath, args, {
    env: {
      ...process.env,
      HERMES_HOME: tmpHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // ---- 4. Stream stdout/stderr into bridge logs with session tag -----------
  tagStream(child.stdout, sessionCode, 'out');
  tagStream(child.stderr, sessionCode, 'err');

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => {
        console.log(
          `[spawn ${sessionCode}] hermes exited code=${code} signal=${signal}`,
        );
        // ---- 5. Cleanup -----------------------------------------------------
        // Async fire-and-forget — the agent dir is small (~few KB) and we
        // don't want to block the exit handler on filesystem latency.
        rm(join(SPAWN_BASE_DIR, sessionCode), {
          recursive: true,
          force: true,
        }).catch((err) => {
          console.warn(`[spawn ${sessionCode}] cleanup failed:`, err);
        });
        resolve({ code, signal });
      });
      child.once('error', (err) => {
        // 'error' is emitted when spawn itself fails (binary not found,
        // permission denied) — in that case 'exit' won't fire, so we
        // resolve here with a synthetic non-zero code.
        console.error(`[spawn ${sessionCode}] spawn error:`, err);
        resolve({ code: -1, signal: null });
      });
    },
  );

  const kill = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode) return;
    console.log(`[spawn ${sessionCode}] sending SIGTERM`);
    child.kill('SIGTERM');
    // 5 s grace; if still alive, escalate. Don't wait for `wait_for_my_turn`
    // to time out (120 s) — that would block the queue.
    const sigkill = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) {
        console.log(`[spawn ${sessionCode}] escalating to SIGKILL`);
        child.kill('SIGKILL');
      }
    }, 5_000);
    if (typeof sigkill.unref === 'function') sigkill.unref();
    await exitPromise;
  };

  return {
    sessionCode,
    pid: child.pid ?? 0,
    startedAt: Date.now(),
    kill,
    exitPromise: exitPromise as Promise<{
      code: number | null;
      signal: string | null;
    }>,
  };
}

/**
 * Line-buffer a readable stream and forward each line to the bridge's own
 * stdout/stderr with a session-code prefix. Without buffering, multi-line
 * tool outputs get interleaved with other agents' lines in journald and
 * become impossible to read.
 */
function tagStream(
  stream: NodeJS.ReadableStream | null,
  sessionCode: string,
  kind: 'out' | 'err',
): void {
  if (!stream) return;
  const sink = kind === 'err' ? process.stderr : process.stdout;
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      sink.write(`[hermes ${sessionCode}] ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      sink.write(`[hermes ${sessionCode}] ${buf}\n`);
      buf = '';
    }
  });
}
