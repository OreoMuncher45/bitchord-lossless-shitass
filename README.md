# Auris Lossless Addons

Lossless streaming modules for the **Auris** music player.

> **This addon is only compatible with Auris.**
> Any other module host is refused before it can add the source, and again at module load, with:
> `This addon is only compatible with Auris. Find it on GitHub or at https://auris.shehriyar.ink`

Auris: [auris.shehriyar.ink](https://auris.shehriyar.ink) · [GitHub](https://github.com/OreoMuncher45/BitChordNext)

---

## Install in Auris

Add this source URL in Auris:

```text
https://auris.shehriyar.ink/this-addon-is-only-compatible-with-auris-find-it-at-auris.shehriyar.ink
```

Auris sends its host identity with the request. Any other app gets HTTP 403 and cannot add the source. The raw GitHub `index.json` is intentionally a refusal stub, not an install URL.

This requires an Auris build that sends the host identity (the same builds that carry the in-sandbox key check).

---

## Included modules

- **Auris Addon** — fast lossless streaming.
- **Auris Hi-Res Lossless Addon** — Hi-Res lossless streaming.
- **Internet Archive FLAC (archive.org)** — live and bootleg lossless.

## Lock

Two layers:

1. The index endpoint returns 403 to a host that does not present the Auris identity, so a foreign app cannot add the source at all.
2. If a module file is copied anyway, it checks the host identity at load and on every search and stream call, and refuses with the message above.

The shipped JavaScript is compiled, not the readable source. The source is kept private.

---

## Verification

```bash
python3 test_contract.py   # public stub and shipped-file checks
AURIS_KEY=... node test_gate.js   # runtime gate and export checks
```
