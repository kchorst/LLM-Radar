declare const require: any;

const QRCode = require('../../tools/vendor/QRCode');

export type QrMatrix = boolean[][];

export function buildQrMatrix(payload: string): QrMatrix {
  const text = String(payload || '').trim();
  if (!text) return [];
  const qr = new QRCode(0, 1);
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const matrix: boolean[][] = [];
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col += 1) line.push(!!qr.isDark(row, col));
    matrix.push(line);
  }
  return matrix;
}
