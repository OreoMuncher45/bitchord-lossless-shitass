# Auris Lossless Addons

Lossless streaming modules for the **Auris** music player.

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

Use `raw.githubusercontent.com` or jsDelivr, not a `github.com/.../blob/...` page — that returns GitHub's web-app JSON and is rejected as unrecognised.

---

## Included modules

- **Auris Addon** — fast lossless streaming.
- **Auris Hi-Res Lossless Addon** — Hi-Res lossless streaming.
- **Internet Archive FLAC (archive.org)** — live and bootleg lossless.

## Lock

The modules check the host identity at load and again on every search and stream call. A host that does not present the Auris identity is refused with the message above, which points to where Auris can be found.

The shipped JavaScript is compiled, not the readable source. The source is kept private.

---

## Verification

```bash
python3 test_contract.py   # index/manifest contract and shipped-file checks
node test_gate.js          # runtime gate and export checks
```
