/**
 * 이미지 형식·크기를 파일 내용(매직 바이트)으로 판별
 * - 확장자·Content-Type 헤더는 믿지 않는다 (사용자가 바꿀 수 있음)
 * - PNG·JPEG·WebP 만 허용. SVG 는 스크립트를 품을 수 있어 받지 않는다
 * - 외부 라이브러리 없이 헤더만 읽는다 (픽셀 디코딩 안 함)
 */
export interface SniffedImage {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  ext: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

export function sniffImage(buf: Buffer): SniffedImage | null {
  return sniffPng(buf) ?? sniffJpeg(buf) ?? sniffWebp(buf);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffPng(buf: Buffer): SniffedImage | null {
  // 시그니처(8) + IHDR 길이(4) + "IHDR"(4) + 가로(4) + 세로(4)
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return valid({
    mime: 'image/png',
    ext: 'png',
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  });
}

/** SOF(프레임 시작) 마커 — 여기에 가로·세로가 있다. C4(DHT)·C8(JPG)·CC(DAC)는 SOF 가 아님 */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function sniffJpeg(buf: Buffer): SniffedImage | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i += 1; // 채움 바이트
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // 길이 없는 마커
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // SOF 전에 끝/스캔 시작 → 비정상
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (SOF.has(marker)) {
      if (i + 9 > buf.length) return null;
      return valid({
        mime: 'image/jpeg',
        ext: 'jpg',
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
      });
    }
    i += 2 + len;
  }
  return null;
}

function sniffWebp(buf: Buffer): SniffedImage | null {
  if (
    buf.length < 30 ||
    buf.toString('latin1', 0, 4) !== 'RIFF' ||
    buf.toString('latin1', 8, 12) !== 'WEBP'
  )
    return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // 프레임 시작 코드 9D 01 2A 다음에 14비트 가로·세로
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return valid({
      mime: 'image/webp',
      ext: 'webp',
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    });
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return valid({
      mime: 'image/webp',
      ext: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    });
  }
  if (chunk === 'VP8X') {
    return valid({
      mime: 'image/webp',
      ext: 'webp',
      width: buf.readUIntLE(24, 3) + 1,
      height: buf.readUIntLE(27, 3) + 1,
    });
  }
  return null;
}

const valid = (img: SniffedImage) => (img.width > 0 && img.height > 0 ? img : null);
