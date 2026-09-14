// Regenerate the checked-in Android install assets from the existing SVG logo.
// Run: node scripts/render-icons.mjs (after ./setup.sh).
import sharp from 'sharp';
const source = new URL('../public/icon.svg', import.meta.url);
for (const size of [192, 512]) {
  await sharp(source.pathname, { density: 384 }).resize(size, size).png()
    .toFile(new URL(`../public/icon-${size}.png`, import.meta.url).pathname);
}
// The existing white mark fits within the central 40%-radius safe circle.
// Extend its yellow background to the edges for Android's launcher masks.
await sharp(source.pathname, { density: 384 }).resize(512, 512)
  .flatten({ background: '#fbbc04' }).png()
  .toFile(new URL('../public/icon-maskable-512.png', import.meta.url).pathname);
