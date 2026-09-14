# Synthetic interoperability fixtures

These are source test inputs, not saved user vaults or generated build output.

- `large.png`: 1600×900 opaque RGB, expected preview 512×288.
- `small.png`: 40×20 RGBA, expected preview 40×20 without enlargement.
- `rotated.jpg`: 800×400 RGB with EXIF orientation 6, expected oriented preview 256×512 without orientation metadata.
- `image.avif`: 600×300 RGB, expected preview 512×256.

The raster inputs were generated with Sharp 0.35.4; Rust tests use the native ImageMagick implementation. Keeping independent encoded inputs also checks codec interoperability.

`browser-owner.yjs` and `browser-obsolete.yjs` were generated with the browser's `Vault.createNote` and Yjs 13.6.27 at the `171ed6d` integration baseline. They contain only the synthetic “Existing owner note” and “Old shared server note” browser-test fixtures. The native fixture server seeds the owner account and shared directory independently, allowing browser tests to verify that shared content is never imported.
