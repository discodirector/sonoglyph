/**
 * MP4 generation for the Sonoglyph atlas. Pairs the per-token OG PNG
 * (rendered by og.ts) with the descent's pinned audio to produce a single
 * still-image video — what Facebook / Discord / Telegram render inline
 * from `og:video`, and what manual sharers download to attach to a tweet
 * directly (Twitter's video card path is gated behind approval, so the
 * user-uploads-the-mp4 fallback is what actually gets visible playback
 * on X today).
 *
 * Pipeline
 * --------
 *   1. Ensure the OG PNG for the token exists on disk (re-rendering via
 *      og.ts if missing). We don't share the buffer in memory — passing
 *      ffmpeg a file path is simpler and lets the renderer stream input
 *      without buffering the whole image.
 *   2. Fetch the descent audio from the Pinata gateway. We download once
 *      to a temp file rather than piping URL → ffmpeg → output, because
 *      the gateway occasionally drops mid-stream and ffmpeg's HTTP retry
 *      is noisier than re-running the whole step.
 *   3. Spawn ffmpeg with `-loop 1 -i image -i audio` + libx264 + AAC.
 *      `-shortest` cuts at the audio end so we don't sit on a still frame
 *      after silence.
 *   4. Write to `<CACHE_DIR>/<version>-<id>.mp4` and return the bytes.
 *
 * Cache
 * -----
 * Same shape as og.ts: keyed on (tokenId, OG_CACHE_VERSION). The video
 * file is the dominant cost (~300 KB-1 MB per token), so we lean hard on
 * the disk cache. With 250 tokens at ~500 KB average we sit at ~125 MB
 * total — comfortable on the 80 GB VPS.
 *
 * Concurrency
 * -----------
 * If two crawlers hit /video/:id.mp4 simultaneously we'd otherwise spawn
 * two parallel ffmpeg processes against the same target file. The
 * in-flight map below collapses concurrent requests for the same id onto
 * one render promise, mirroring the /collection cache-stampede guard.
 *
 * Why not pre-render at mint time
 * --------------------------------
 * Doable, but blocks the mint response on ffmpeg (~3-8 s) and adds a path
 * where the mint succeeds on-chain but the video render fails — leaving
 * the token visible without a share asset. Lazy keeps mint fast and
 * surfaces video issues only on the share path.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrRenderOgPng, type AtlasTokenMeta } from './og.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR =
  process.env.OG_CACHE_DIR ?? path.resolve(HERE, '../../cache/og');
// Same version key as og.ts so a calibration freeze invalidates both PNGs
// and MP4s in one bump.
const CACHE_VERSION = process.env.OG_CACHE_VERSION ?? 'v1';
// Pinata gateway is where the bridge pins audio at mint; using it here
// matches the URL the contract recorded in audioCid. Fallback to a public
// gateway via OG_AUDIO_GATEWAY for ops experimentation.
const AUDIO_GATEWAY =
  process.env.OG_AUDIO_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/';
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';

export interface VideoInput extends AtlasTokenMeta {
  audioCid: string;
}

function videoPath(tokenId: number): string {
  return path.join(CACHE_DIR, `${CACHE_VERSION}-${tokenId}.mp4`);
}

function pngPath(tokenId: number): string {
  return path.join(CACHE_DIR, `${CACHE_VERSION}-${tokenId}.png`);
}

const inflight = new Map<number, Promise<Buffer>>();

/** Public entry — disk cache, in-flight coalescing, then render. */
export async function getOrRenderVideo(input: VideoInput): Promise<Buffer> {
  // Cheap path: file already on disk.
  try {
    return await readFile(videoPath(input.tokenId));
  } catch {
    /* fall through */
  }
  // Coalesce concurrent renders for the same id onto one promise.
  const pending = inflight.get(input.tokenId);
  if (pending) return pending;
  const work = renderAndCache(input).finally(() => {
    inflight.delete(input.tokenId);
  });
  inflight.set(input.tokenId, work);
  return work;
}

async function renderAndCache(input: VideoInput): Promise<Buffer> {
  await mkdir(CACHE_DIR, { recursive: true });
  // 1. Ensure PNG is on disk (renders if missing). We read the bytes back
  //    after writing because getOrRenderOgPng already handles its own
  //    cache; we just need the file path.
  await getOrRenderOgPng({ tokenId: input.tokenId, glyph: input.glyph });
  const imagePath = pngPath(input.tokenId);
  // Sanity check — getOrRenderOgPng could in theory fall back to in-memory
  // if disk write failed. If so, write the PNG explicitly here.
  try {
    await stat(imagePath);
  } catch {
    const buf = await getOrRenderOgPng({
      tokenId: input.tokenId,
      glyph: input.glyph,
    });
    await writeFile(imagePath, buf);
  }

  // 2. Pull audio from the gateway to a sibling temp file. We keep the
  //    .webm extension because the descent recordings are MediaRecorder
  //    output (opus-in-webm); ffmpeg auto-detects but a hint never hurts.
  const audioPath = path.join(
    CACHE_DIR,
    `${CACHE_VERSION}-${input.tokenId}.src.webm`,
  );
  const audioUrl = AUDIO_GATEWAY.replace(/\/+$/, '/') + input.audioCid;
  await fetchToFile(audioUrl, audioPath);

  // 3. Probe audio duration. We use this as an explicit -t cap rather
  //    than trusting -shortest alone: with -loop 1 on the image input,
  //    ffmpeg's stream-end accounting occasionally leaks a few seconds of
  //    silent video past the audio end (a known interaction). Hard cap
  //    fixes that and also gives us a predictable file length for
  //    Open Graph consumers that read `og:video:duration`.
  const duration = await probeDuration(audioPath);

  // 4. Spawn ffmpeg. Flags chosen for OG-compatible MP4:
  //    -loop 1                 — make the image into a loopable video
  //    -tune stillimage        — H.264 tuning for static frames (smaller)
  //    -framerate 2            — minimal source framerate; cheap to
  //                              encode but high enough to dodge a known
  //                              issue where 1 fps + AAC ends up with
  //                              mistimed packets in some players
  //    -t <duration>           — hard cap so video doesn't outrun audio
  //    -c:v libx264            — broadly compatible video codec
  //    -preset veryfast        — speed/size tradeoff favouring speed;
  //                              static image is mostly already optimal
  //    -crf 28                 — quality knob; high for a still image
  //                              because there's no detail to preserve
  //                              past the first frame
  //    -pix_fmt yuv420p        — required for QuickTime / Twitter Player
  //    -c:a aac / -b:a 96k     — re-encode to AAC. 96k is plenty for
  //                              composed-audio fidelity and halves the
  //                              file vs 192k (audio dominates the size
  //                              of these MP4s at ~200 s descents).
  //    -movflags +faststart    — move moov atom to file start so the
  //                              crawler can begin playback before full
  //                              download
  const outPath = videoPath(input.tokenId);
  await runFfmpeg([
    '-y',
    '-loop',
    '1',
    '-framerate',
    '2',
    '-i',
    imagePath,
    '-i',
    audioPath,
    '-t',
    duration.toFixed(3),
    '-c:v',
    'libx264',
    '-tune',
    'stillimage',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    // Pad to ensure even dimensions (libx264 requires even width/height
    // with yuv420p). Our 1200x630 is already even but this guards us
    // against any future image-size change.
    'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    outPath,
  ]);

  // 4. Drop the audio temp file. Best-effort: a residual .webm on disk
  //    only burns space, doesn't affect correctness.
  try {
    await unlink(audioPath);
  } catch {
    /* ignore */
  }

  return readFile(outPath);
}

/**
 * Read the `format.duration` field from an audio file via ffprobe. Used
 * to set an explicit -t cap on the MP4 encode, so video doesn't outrun
 * audio when -loop 1 + -shortest disagree by a few frames.
 *
 * Falls back to 60 s if ffprobe can't parse the file — that's a safe
 * lower bound for any Sonoglyph descent (the minimum recording window is
 * 60 s by design) and avoids 0-length output on a probe failure.
 */
async function probeDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
    });
    child.on('close', () => {
      const n = Number.parseFloat(out.trim());
      if (Number.isFinite(n) && n > 0) {
        resolve(n);
      } else {
        console.warn(`[video] probe duration fallback: raw="${out.trim()}"`);
        resolve(60);
      }
    });
    child.on('error', () => resolve(60));
  });
}

/**
 * Spawn ffmpeg with the given args and resolve when it exits cleanly.
 * Rejects with the last 1 KB of stderr when the exit code is non-zero so
 * the operator can see WHY a render failed without sifting through the
 * whole encoder log. We pipe stdout to /dev/null because we read the file
 * from disk after ffmpeg finishes; the binary's stdout is empty unless we
 * pass `-f mp4 -` (which we don't, since we want -movflags +faststart and
 * that requires seekable output).
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep only the tail — ffmpeg is verbose and we don't want to buffer
      // MBs of progress lines per render.
      stderr += chunk.toString('utf-8');
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg exited with code ${code ?? 'null'}\n${stderr.slice(-1024)}`,
          ),
        );
      }
    });
  });
}

/**
 * Download a URL to a local file. We use fetch + stream-to-buffer rather
 * than piping the response body because the audio files are small enough
 * (~5 MB max) that the simplicity is worth it, and a single buffered
 * write avoids partial-file-on-disk states if the connection drops.
 */
async function fetchToFile(url: string, target: string): Promise<void> {
  const res = await fetch(url, {
    // Pinata sometimes returns 504s under load; one quick retry is enough
    // in practice. AbortSignal.timeout uses the runtime's built-in, which
    // is supported on Node 18+ (we're on 20 in prod).
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `gateway fetch failed for ${url}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(target, buf);
}

/** Whether the cached MP4 exists on disk. Used by og.ts to decide whether
 *  to include og:video meta tags in the crawler HTML for a given token. */
export async function videoExistsOnDisk(tokenId: number): Promise<boolean> {
  try {
    await stat(videoPath(tokenId));
    return true;
  } catch {
    return false;
  }
}
