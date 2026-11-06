// Regenerate the PWA icons and Android launcher artwork from the same SVG.
// Run: node scripts/render-icons.mjs (after ./setup.sh).
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import domino from '@mixmark-io/domino';
import sharp from 'sharp';
const source = new URL('../public/icon.svg', import.meta.url);
const svg = domino.createDocument(await readFile(source, 'utf8')).querySelector('svg');
const mark = svg.querySelector('g');
// Map the SVG's 192-unit canvas onto Android's central 72dp viewport within
// its 108dp layers. Keep the mark's proportions and leave the masking margins.
assert.equal(svg.getAttribute('viewBox'), '0 0 192 192');
assert.equal(mark.getAttribute('transform'), 'translate(24 24) scale(6)');
assert.equal(mark.getAttribute('fill'), 'none');
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const color = value => value.replace(/^#([a-f\d])([a-f\d])([a-f\d])$/i, '#$1$1$2$2$3$3');
const background = color(svg.querySelector('rect').getAttribute('fill'));
const resources = new URL('../android/app/src/main/res/', import.meta.url);
await Promise.all(['values/', 'drawable/'].map(directory => mkdir(new URL(directory, resources), { recursive: true })));
await writeFile(new URL('values/stow_icon.xml', resources), `<!-- Generated from public/icon.svg by scripts/render-icons.mjs. -->
<resources><color name="stow_icon_background">${xml(background)}</color></resources>
`);
await writeFile(new URL('drawable/ic_stow_foreground.xml', resources), `<!-- Generated from public/icon.svg by scripts/render-icons.mjs. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
    <group android:translateX="27" android:translateY="27" android:scaleX="2.25" android:scaleY="2.25">
${Array.from(mark.querySelectorAll('path'), path => `        <path android:fillColor="#00000000" android:strokeColor="${xml(color(mark.getAttribute('stroke')))}" android:strokeWidth="${xml(mark.getAttribute('stroke-width'))}" android:strokeLineCap="${xml(mark.getAttribute('stroke-linecap'))}" android:strokeLineJoin="${xml(mark.getAttribute('stroke-linejoin'))}" android:pathData="${xml(path.getAttribute('d'))}" />`).join('\n')}
    </group>
</vector>
`);
for (const size of [192, 512]) {
  await sharp(source.pathname, { density: 384 }).resize(size, size).png()
    .toFile(new URL(`../public/icon-${size}.png`, import.meta.url).pathname);
}
// The existing white mark fits within the central 40%-radius safe circle.
// Extend its yellow background to the edges for Android's launcher masks.
await sharp(source.pathname, { density: 384 }).resize(512, 512)
  .flatten({ background }).png()
  .toFile(new URL('../public/icon-maskable-512.png', import.meta.url).pathname);
