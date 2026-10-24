# Auris Lossless Addons

Credentialless lossless modules for the **Auris** music player.

> **This addon is only compatible with Auris.**
> Any other module host is refused at load time with:
> `This addon is only compatible with Auris. Find it on GitHub or at https://auris.shehriyar.ink`

Auris: [auris.shehriyar.ink](https://auris.shehriyar.ink) · [GitHub](https://github.com/OreoMuncher45/BitChordNext)

---

## Install in Auris

Add a source and paste one of these raw JSON URLs:

```text
https://raw.githubusercontent.com/OreoMuncher45/bitchord-lossless-shitass/main/index.json
https://raw.githubusercontent.com/OreoMuncher45/bitchord-lossless-shitass/main/manifest.json
https://cdn.jsdelivr.net/gh/OreoMuncher45/bitchord-lossless-shitass@main/index.json
```

Auris detects the module index and asks for it like any other source. Use `raw.githubusercontent.com` or jsDelivr, not a `github.com/.../blob/...` page — that returns GitHub's web-app JSON and is rejected as unrecognised.

---

## Why it is locked

These modules carry the same playback logic as Auris's built-in Tidal and Hi-Res sources, which is tuned to Auris's module runtime: synchronous sandbox `fetch`, response headers exposed for file measurement, and an app identity object passed to every module call.

The lock is deliberately narrow rather than security theatre:

- At load, a module checks the host-provided `__spine_app` identity and throws if it is missing or not Auris.
- On every search and stream call, the module also checks the `app` object in its `context` argument.
- The failure message is the one above, with the `auris.shehriyar.ink` link, so someone who tries the addon elsewhere is told where to find Auris rather than left with a silent empty search.

## Included modules

### 1. Auris Addon (`bitchord-tidal-flac`) — 2.0.0

Genuine lossless Tidal FLAC, credentialless.

- **Parallel instance probing.** The bundled instance pool is hashed at once and the first healthy instance wins, instead of walking the pool one host at a time.
- **Per-instance protocol memo.** Each instance is remembered for the protocol it actually speaks: the tracks protocol (`/search/tracks`, direct `/track/{id}` bytes) is preferred, hifi-api v2 (`/search/?s=`, base64 manifests) is the fallback.
- **Measured, not claimed.** A 4-byte `Range` request proves the file starts with `fLaC`; when it can, it also measures size over duration and refuses a rendition that is not actually lossless.
- **Fast failure.** Health checks are cached for 30 minutes, and a dead instance is dropped from the walk rather than retried on every track.

### 2. Auris Hi-Res Lossless Addon (`auris-hi-res-lossless`) — 1.0.0

Direct FLAC files from an open catalogue, with no converter and no waiting.

- **Title and modifier matching.** Search rows are filtered against the asked-for title and qualifiers, so a live take is not handed over for a studio request.
- **Every stream measured.** A 1-byte range request proves the `fLaC` signature, and file size over track duration yields the average bitrate. Anything under 300 kbps is refused rather than played as "lossless".
- **Retries only on 5xx.** Timeouts fail fast; transient server errors retry briefly.

### 3. Internet Archive FLAC (`archive-flac`) — 1.1.0

Live tapes and bootlegs that a studio catalogue will never hold.

- **Credentialless.** `advancedsearch.php` + parallel `metadata/{id}` fan-out + `/download/{id}/{file}`.
- **Measured.** The same 4-byte `fLaC` check before any rendition is claimed.
- **Complements the studio modules.** It wins when Tidal is slow or the track only exists as a live recording, and loses cleanly when it has nothing.

---

## Contract verification

`index.json` and `manifest.json` are checked against the module contract, including the Auris-only gate and the actual exported functions:

```bash
python3 test_contract.py
```
