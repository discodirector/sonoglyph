/**
 * IPFS pinning via Pinata.
 *
 * Why Pinata: free tier covers our needs (1 GB storage, no per-upload
 * limit), classic JWT auth that just goes in `Authorization: Bearer …`
 * (no SDK lock-in, no email-delegation flow), and the API has been
 * stable since 2017. Node 22's native fetch + FormData + Blob mean we
 * don't need any additional dependencies.
 *
 * Why server-side (here) and not direct from the browser:
 *   - JWT stays out of the bundle.
 *   - One audit trail: every pin goes through this file's logging.
 *   - CORS-free since the bridge already serves the browser.
 *
 * Scope: audio recordings only. The journal and ASCII glyph are short
 * enough to live directly in contract storage on Monad testnet and be
 * assembled into tokenURI on-chain — pinning them too would add an
 * indirection without a benefit.
 */

const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs';

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

export interface PinResult {
  /** Bare CID — usable as `ipfs://<cid>` for the on-chain audioCid field. */
  cid: string;
  /** Public HTTPS gateway URL — handy for verification + sharing. */
  gatewayUrl: string;
  /** Bytes pinned (Pinata-reported). Useful for /health debugging. */
  size: number;
}

function getJwt(): string {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error(
      'PINATA_JWT not set. Add it to .env and restart the bridge.',
    );
  }
  return jwt;
}

/**
 * Pin a binary buffer (typically the descent's WebM recording) to IPFS
 * via Pinata. Returns the bare CID + gateway URL.
 *
 * @param data       File bytes. Accepts Uint8Array, ArrayBuffer, or Buffer.
 * @param fileName   Human-readable name. Shows up in the Pinata dashboard
 *                   and as the multipart file name. Defaults to `pin.bin`.
 * @param contentType MIME type baked into the multipart Blob. Pinata uses
 *                    it for content-addressable serving from the gateway.
 * @param sessionCode Optional 6-char descent code, used both as part of
 *                    `pinataMetadata.name` and in the keyvalues map so we
 *                    can correlate later (search/filter from the dashboard).
 */
export async function pinFileToPinata(
  data: ArrayBuffer | Uint8Array | Buffer,
  fileName: string = 'pin.bin',
  contentType: string = 'application/octet-stream',
  sessionCode?: string,
): Promise<PinResult> {
  const jwt = getJwt();

  // Normalize to a Blob so FormData works regardless of input type.
  // Note: `Buffer extends Uint8Array`, so checking ArrayBuffer first then
  // falling through to the Uint8Array branch covers both Buffer and raw
  // typed arrays in one go.
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const blob = new Blob([bytes], { type: contentType });

  const form = new FormData();
  form.append('file', blob, fileName);

  // pinataMetadata is the dashboard-visible label. Name MUST be a string —
  // keyvalues is for searchable tags, restricted to scalar values.
  const metadataName = sessionCode
    ? `sonoglyph-${sessionCode}-${fileName}`
    : `sonoglyph-${fileName}`;
  form.append(
    'pinataMetadata',
    JSON.stringify({
      name: metadataName,
      keyvalues: {
        app: 'sonoglyph',
        ...(sessionCode ? { sessionCode } : {}),
      },
    }),
  );

  // cidVersion=1 — base32 CIDs (modern, future-proof). Default would be v0
  // (Qm…) which still works but is harder to bridge into newer tooling.
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

  const res = await fetch(PINATA_PIN_FILE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(
      `pinata pin failed: ${res.status} ${res.statusText} — ${text.slice(0, 400)}`,
    );
  }

  const json = (await res.json()) as PinataResponse;
  return {
    cid: json.IpfsHash,
    gatewayUrl: `${PINATA_GATEWAY}/${json.IpfsHash}`,
    size: json.PinSize,
  };
}
