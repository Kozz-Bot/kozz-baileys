# Lottie Sticker Findings

This document summarizes what we learned while reverse-engineering WhatsApp `lottieStickerMessage` support in this repo.

## Message shape

- WhatsApp reply payloads can contain `lottieStickerMessage`.
- In Baileys, `lottieStickerMessage` is wrapped as a `FutureProofMessage`.
- The actual downloadable media still lives in the inner `stickerMessage`.
- Relevant fields on the inner sticker payload:
  - `mimetype: application/was`
  - `isAnimated: true`
  - `isLottie: true`
  - `mediaKey`
  - `directPath`

## Downloading

- `downloadMediaMessage(...)` does not work directly on the outer `lottieStickerMessage` wrapper.
- Downloading works when we unwrap the inner `stickerMessage` and call `downloadContentFromMessage(...)` directly.
- Raw `.was` files are ZIP archives.

## Valid `.was` bundle structure

A valid received `.was` contained:

1. `animation/animation.json`
2. `animation/animation.json.overridden_metadata`
3. `animation/animation.json.trust_token`
4. `animation/animation_secondary.json`
5. `animation/animation_secondary.json.trust_token`

## What each file appears to do

### `animation/animation.json`

- Main Lottie animation payload.
- Drives the normal in-chat sticker render.
- Contains the actual animation data: layers, transforms, timing, shapes, assets.

### `animation/animation.json.overridden_metadata`

- Sticker metadata, not render data.
- Observed fields:
  - `sticker-pack-id`
  - `sticker-pack-name`
  - `sticker-pack-publisher`
  - `accessibility-text`
  - `emojis`
  - `is-from-user-created-pack`

### `animation/animation.json.trust_token`

- ES256 JWT-like token.
- Payload contains:
  - `sticker_file_type`
  - `sticker_file_trusted_origin`
  - `sticker_file_sha256`
- For a valid incoming sticker, the declared SHA-256 matched the actual `animation.json` bytes exactly.

### `animation/animation_secondary.json`

- Second Lottie animation payload.
- Appears to drive the expanded / tap-open experience.
- This is where we successfully injected custom behavior while keeping the base sticker render intact.

### `animation/animation_secondary.json.trust_token`

- Same token shape as the primary trust token.
- Also declares a SHA-256 for the secondary animation payload.

## Rendering behavior

Observed behavior suggests WhatsApp uses two render modes:

1. Normal sticker render:
   - appears to use `animation.json`
2. Tap / expanded render:
   - appears to use `animation_secondary.json`

This did not look like a normal Lottie timeline switch. It behaved more like the WhatsApp client chooses between two separate compositions depending on UI state.

## What worked

The working experiment kept the base `.was` intact and replaced only `animation_secondary.json`.

That let us:

- keep the trusted primary animation untouched
- preserve in-chat rendering
- show a custom rotating quoted sticker when the sticker was opened

## What did not work

### Fully fresh `.was` bundles

Building a fully custom `.was` from scratch did not produce a usable sticker render.

### Modifying the primary animation

Changing `animation.json` caused rendering failures even when we recomputed the token payload SHA values.

This strongly suggests the trust token is not just informational:

- the JSON content hash matters
- the signature likely matters too

## Likely conclusion

Custom secondary scenes are feasible.

Custom primary scenes are probably blocked by trust validation unless the client accepts unsigned or differently signed payloads, which our tests did not support.

## Current command status

- `/lottie`:
  - supported
  - clones a valid `.was`
  - replaces only `animation_secondary.json`
  - uses the quoted regular sticker as a rotating custom expanded scene

- `/lottie2`:
  - removed
  - it was used for failed experiments around fresh bundles and modified primary payloads
