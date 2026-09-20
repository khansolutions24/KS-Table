// Renders build/icon.png (512 px) and build/icon.ico (16-256 px) from the KS Table logo.
// Run: node_modules/electron/dist/electron.exe scripts/make-icon.cjs

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'logo.png');
const OUT = path.join(__dirname, '..', 'build');

function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((x) => x.png)]);
}

app.whenReady().then(() => {
  fs.mkdirSync(OUT, { recursive: true });
  const src = nativeImage.createFromPath(SOURCE);
  if (src.isEmpty()) {
    console.error('could not read', SOURCE);
    app.exit(1);
    return;
  }
  const big = src.resize({ width: 512, height: 512, quality: 'best' });
  fs.writeFileSync(path.join(OUT, 'icon.png'), big.toPNG());

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => ({ size, png: big.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(images));

  console.log('icons written to', OUT);
  app.quit();
});
