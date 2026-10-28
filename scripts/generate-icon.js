'use strict';

/**
 * Génère build/icon.ico (multi-résolutions) et build/icon.png sans dépendance
 * externe : rasterisation simple + encodeur PNG/ICO minimal.
 *
 * Le dessin est volontairement géométrique (jauge circulaire + flèche) pour
 * rester lisible à 16 px dans la barre des tâches.
 *
 * Usage : npm run icon
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'build');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const COLORS = {
  bgTop: [22, 36, 58],
  bgBottom: [6, 10, 17],
  glow: [70, 255, 190],
  border: [90, 240, 200],
  track: [27, 42, 63],
  arcStart: [86, 255, 192],
  arcEnd: [53, 183, 255],
  arrow: [242, 251, 255]
};

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function sdRoundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - radius;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : clamp01((apx * abx + apy * aby) / lengthSq);
  const x = ax + abx * t;
  const y = ay + aby * t;
  return Math.hypot(px - x, py - y);
}

/** Rendu en RGBA non prémultiplié, à une résolution donnée. */
function render(size) {
  const data = new Uint8ClampedArray(size * size * 4);
  const cx = size * 0.5;
  const cy = size * 0.5;
  const rectCx = size * 0.5;
  const rectCy = size * 0.5;
  const rectHalf = size * 0.47;
  const rectRadius = size * 0.215;

  const ringRadius = size * 0.3;
  const ringThickness = size * 0.095;
  const arcLength = Math.PI * 1.42; // ~255°
  const startAngle = -Math.PI / 2;
  const arrowWidth = size * 0.078;
  const arrowPoints = [
    [size * 0.35, size * 0.565],
    [size * 0.5, size * 0.405],
    [size * 0.65, size * 0.565]
  ];

  const capRadius = ringThickness / 2;
  const arcStartPoint = [
    cx + Math.cos(startAngle) * ringRadius,
    cy + Math.sin(startAngle) * ringRadius
  ];
  const endAngle = startAngle + arcLength;
  const arcEndPoint = [
    cx + Math.cos(endAngle) * ringRadius,
    cy + Math.sin(endAngle) * ringRadius
  ];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const index = (y * size + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      const bgDistance = sdRoundedRect(px, py, rectCx, rectCy, rectHalf, rectHalf, rectRadius);
      if (bgDistance <= 0) {
        const vertical = clamp01((py - size * 0.03) / (size * 0.94));
        const base = mixColor(COLORS.bgTop, COLORS.bgBottom, vertical);
        const glowDistance = Math.hypot(px - size * 0.3, py - size * 0.18) / (size * 0.85);
        const glowStrength = Math.max(0, 1 - glowDistance) ** 2 * 0.16;
        r = lerp(base[0], COLORS.glow[0], glowStrength);
        g = lerp(base[1], COLORS.glow[1], glowStrength);
        b = lerp(base[2], COLORS.glow[2], glowStrength);
        a = 255;

        // Liseré intérieur discret
        if (bgDistance > -size * 0.007) {
          r = lerp(r, COLORS.border[0], 0.22);
          g = lerp(g, COLORS.border[1], 0.22);
          b = lerp(b, COLORS.border[2], 0.22);
        }
      }

      if (a > 0) {
        const distance = Math.hypot(px - cx, py - cy);

        // Piste complète
        if (Math.abs(distance - ringRadius) <= ringThickness / 2) {
          r = lerp(r, COLORS.track[0], 0.92);
          g = lerp(g, COLORS.track[1], 0.92);
          b = lerp(b, COLORS.track[2], 0.92);
        }

        // Arc de progression
        let angle = Math.atan2(py - cy, px - cx) - startAngle;
        angle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const onRing = Math.abs(distance - ringRadius) <= ringThickness / 2;
        const onStartCap = Math.hypot(px - arcStartPoint[0], py - arcStartPoint[1]) <= capRadius;
        const onEndCap = Math.hypot(px - arcEndPoint[0], py - arcEndPoint[1]) <= capRadius;
        if ((onRing && angle <= arcLength) || onStartCap || onEndCap) {
          const t = clamp01(angle / arcLength);
          const color = mixColor(COLORS.arcStart, COLORS.arcEnd, t);
          r = color[0];
          g = color[1];
          b = color[2];
        }

        // Flèche vers le haut
        const d1 = distanceToSegment(px, py, ...arrowPoints[0], ...arrowPoints[1]);
        const d2 = distanceToSegment(px, py, ...arrowPoints[1], ...arrowPoints[2]);
        if (Math.min(d1, d2) <= arrowWidth / 2) {
          r = COLORS.arrow[0];
          g = COLORS.arrow[1];
          b = COLORS.arrow[2];
        }
      }

      data[index] = Math.round(r);
      data[index + 1] = Math.round(g);
      data[index + 2] = Math.round(b);
      data[index + 3] = a;
    }
  }

  return data;
}

/** Rendu supersample puis réduction (anticrénelage). */
function renderSmooth(size, factor = 4) {
  const bigSize = size * factor;
  const big = render(bigSize);
  const out = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const index = ((y * factor + sy) * bigSize + (x * factor + sx)) * 4;
          const alpha = big[index + 3] / 255;
          r += big[index] * alpha;
          g += big[index + 1] * alpha;
          b += big[index + 2] * alpha;
          a += alpha;
        }
      }
      const samples = factor * factor;
      const outIndex = (y * size + x) * 4;
      if (a > 0) {
        out[outIndex] = Math.round(r / a);
        out[outIndex + 1] = Math.round(g / a);
        out[outIndex + 2] = Math.round(b / a);
        out[outIndex + 3] = Math.round((a / samples) * 255);
      }
    }
  }

  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // profondeur
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    rows[rowOffset] = 0; // filtre None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(rows, rowOffset + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** DIB 32 bits + masque AND, au format attendu dans un fichier ICO. */
function encodeIcoBmp(rgba, size) {
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const maskSize = maskRowBytes * size;
  const pixelSize = size * size * 4;
  const header = Buffer.alloc(40);

  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(pixelSize + maskSize, 20);
  header.writeInt32LE(0, 24);
  header.writeInt32LE(0, 28);
  header.writeUInt32LE(0, 32);
  header.writeUInt32LE(0, 36);

  const pixels = Buffer.alloc(pixelSize);
  for (let y = 0; y < size; y += 1) {
    const sourceRow = size - 1 - y; // lignes BMP de bas en haut
    for (let x = 0; x < size; x += 1) {
      const source = (sourceRow * size + x) * 4;
      const target = (y * size + x) * 4;
      pixels[target] = rgba[source + 2];
      pixels[target + 1] = rgba[source + 1];
      pixels[target + 2] = rgba[source];
      pixels[target + 3] = rgba[source + 3];
    }
  }

  return Buffer.concat([header, pixels, Buffer.alloc(maskSize)]);
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0;
    directory[base + 3] = 0;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const entries = [];
  for (const size of SIZES) {
    const rgba = renderSmooth(size, size <= 64 ? 4 : 3);
    // BMP 32 bits pour toutes les tailles : compatibilité maximale avec
    // l'Explorateur, les raccourcis et l'installation NSIS. Le PNG 256 reste
    // utilisé pour l'aperçu (build/icon.png).
    entries.push({ size, data: encodeIcoBmp(rgba, size) });
  }

  const ico = buildIco(entries);
  const icoPath = path.join(OUT_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);

  const png512 = renderSmooth(512, 2);
  const pngPath = path.join(OUT_DIR, 'icon.png');
  fs.writeFileSync(pngPath, encodePng(png512, 512));

  // Icône utilisée par la fenêtre en mode développement.
  fs.writeFileSync(path.join(OUT_DIR, 'icon-256.png'), encodePng(renderSmooth(256, 2), 256));

  // Logo affiché dans l'interface (chemins relatifs, compatible asar).
  const rendererAssets = path.resolve(__dirname, '..', 'src', 'renderer', 'assets');
  fs.mkdirSync(rendererAssets, { recursive: true });
  fs.writeFileSync(path.join(rendererAssets, 'logo.png'), encodePng(renderSmooth(256, 2), 256));

  console.log(`Icône générée : ${icoPath} (${SIZES.join(', ')} px, ${ico.length} octets)`);
  console.log(`Aperçu : ${pngPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { renderSmooth, encodePng, encodeIcoBmp, buildIco };
