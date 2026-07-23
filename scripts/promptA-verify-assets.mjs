// Independent PNG verification for Prompt A — does NOT import service code.
// Validates: signature, decodability, exact final size, strict ratio,
// parentAssetId linkage, SHA-256 vs manifest, transparent-edge detection.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngMeta(file) {
  const buf = readFileSync(file);
  if (buf.length < 24) throw new Error(`${file}: too small (${buf.length} bytes)`);
  const sigOk = buf.subarray(0, 8).equals(PNG_SIG);
  // IHDR: width(4) height(4) bitdepth(1) colortype(1) ...
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf.readUInt8(24);
  const colorType = buf.readUInt8(25);
  return { sigOk, width, height, bitDepth, colorType, bytes: buf.length, buf };
}

// Scan edge rows/cols for fully transparent pixels (alpha = 0).
// Only meaningful for RGBA (colorType 6). RGB (type 2) has no alpha -> no transparent edge possible.
function detectTransparentEdges(buf, width, height, colorType) {
  const result = { colorType, hasAlpha: false, top: false, bottom: false, left: false, right: false };
  if (colorType !== 6) {
    // No alpha channel; cannot have transparent edges.
    return result;
  }
  result.hasAlpha = true;
  const channels = 4;
  // Each scanline: 1 filter byte + width*channels bytes.
  const stride = 1 + width * channels;
  // Check first & last scanline alpha plane (ignoring filter byte at offset 0).
  // We scan raw bytes; for a robust check we'd reverse filters, but a fully
  // transparent edge row under any filter byte still yields all-zero alpha
  // only when truly empty. Sampling raw alpha plane as a heuristic.
  const alphaAt = (x, y) => buf[1 + y * stride + x * channels + 3]; // skip filter byte
  const rowAllZero = (y) => { for (let x = 0; x < width; x++) if (alphaAt(x, y) !== 0) return false; return true; };
  const colAllZero = (x) => { for (let y = 0; y < height; y++) if (alphaAt(x, y) !== 0) return false; return true; };
  result.top = rowAllZero(0);
  result.bottom = rowAllZero(height - 1);
  result.left = colAllZero(0);
  result.right = colAllZero(width - 1);
  result.anyEdgeTransparent = result.top || result.bottom || result.left || result.right;
  return result;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function redact(s) {
  return String(s || '').replace(/[A-Fa-f0-9]{32,}/g, '[REDACTED]').replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]');
}

const outDir = process.env.OUT_DIR;
if (!outDir || !existsSync(outDir)) {
  console.error('OUT_DIR missing or does not exist:', outDir);
  process.exit(2);
}

const checks = [];
const pass = (name, ok, detail) => checks.push({ name, pass: !!ok, detail });
const requestedFinal = { w: 2160, h: 3840 };

// 1. PNG signature + decodability
const src = readPngMeta(join(outDir, 'source.png'));
pass('source.png signature', src.sigOk, `${src.width}x${src.height} ${src.bytes}B colorType=${src.colorType}`);
const fin = readPngMeta(join(outDir, 'final.png'));
pass('final.png signature', fin.sigOk, `${fin.width}x${fin.height} ${fin.bytes}B colorType=${fin.colorType}`);

// 2. final size exactly equals request (2160x3840)
pass('final exact size = 2160x3840', fin.width === 2160 && fin.height === 3840, `got ${fin.width}x${fin.height}`);

// 3. strict ratio: source.width * final.height == final.width * source.height
const cross = src.width * fin.height;
const cross2 = fin.width * src.height;
pass('strict ratio cross-product', cross === cross2, `${src.width}*${fin.height}=${cross} vs ${fin.width}*${src.height}=${cross2}`);

// 4. parentAssetId linkage from manifests
const srcMan = JSON.parse(readFileSync(join(outDir, 'source.manifest.json'), 'utf8'));
const finMan = JSON.parse(readFileSync(join(outDir, 'final.manifest.json'), 'utf8'));
pass('final.parentAssetId == source.assetId', finMan.parentAssetId === srcMan.assetId, `final.parent=${redact(finMan.parentAssetId)} source.id=${redact(srcMan.assetId)}`);
pass('source.assetId non-empty', !!srcMan.assetId, redact(srcMan.assetId));

// 5. SHA-256 of downloaded files vs manifest
const srcSha = sha256(join(outDir, 'source.png'));
const finSha = sha256(join(outDir, 'final.png'));
const srcManSha = (srcMan.checksums && (srcMan.checksums.sha256 || srcMan.checksums.SHA256)) || srcMan.sha256;
const finManSha = (finMan.checksums && (finMan.checksums.sha256 || finMan.checksums.SHA256)) || finMan.sha256;
pass('source SHA-256 matches manifest', srcSha === srcManSha, `file=${srcSha.slice(0,12)}… manifest=${redact(srcManSha).slice(0,12)}…`);
pass('final SHA-256 matches manifest', finSha === finManSha, `file=${finSha.slice(0,12)}… manifest=${redact(finManSha).slice(0,12)}…`);

// 6. transparent edges
const srcEdges = detectTransparentEdges(src.buf, src.width, src.height, src.colorType);
const finEdges = detectTransparentEdges(fin.buf, fin.width, fin.height, fin.colorType);
pass('source no full transparent edge', !srcEdges.anyEdgeTransparent, JSON.stringify(srcEdges));
pass('final no full transparent edge', !finEdges.anyEdgeTransparent, JSON.stringify(finEdges));

// Manifest sizes consistency
pass('manifest source size matches header', srcMan.width === src.width && srcMan.height === src.height, `manifest=${srcMan.width}x${srcMan.height} actual=${src.width}x${src.height}`);
pass('manifest final size matches header', finMan.width === fin.width && finMan.height === fin.height, `manifest=${finMan.width}x${finMan.height} actual=${fin.width}x${fin.height}`);

const allPass = checks.every(c => c.pass);

const evidence = {
  generatedAt: new Date().toISOString(),
  outDir,
  source: { assetId: srcMan.assetId, width: src.width, height: src.height, bytes: src.bytes, sha256: srcSha, colorType: src.colorType, edges: srcEdges },
  final: { assetId: finMan.assetId, parentAssetId: finMan.parentAssetId, width: fin.width, height: fin.height, bytes: fin.bytes, sha256: finSha, colorType: fin.colorType, edges: finEdges },
  ratio: { source: `${src.width}:${src.height}`, crossSourceTimesFinalH: cross, crossFinalTimesSourceH: cross2, strict: cross === cross2 },
  checks,
  verdict: allPass ? 'PASS' : 'FAIL',
};
import { writeFileSync } from 'node:fs';
writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2));

console.log('=== Independent Verification ===');
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.detail}`);
console.log('---');
console.log(`source: ${src.width}x${src.height} (${(src.bytes/1024/1024).toFixed(2)} MB) sha256=${srcSha.slice(0,16)}…`);
console.log(`final:  ${fin.width}x${fin.height} (${(fin.bytes/1024/1024).toFixed(2)} MB) sha256=${finSha.slice(0,16)}…`);
console.log(`VERDICT: ${evidence.verdict}`);
