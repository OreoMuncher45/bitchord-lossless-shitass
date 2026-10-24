"""
Validates the shipped addon.

The public index is intentionally a refusal stub: the real index is served by
the Auris-gated endpoint, which is the only place a foreign host can be
stopped before any module code runs. This test also checks that every shipped
module stays opaque and that retired readable sources are gone.

Run:  python3 test_contract.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
LOCK_TEXT = "This addon is only compatible with Auris"
LOCK_LINK = "https://auris.shehriyar.ink"
GATED_INDEX = "https://auris.shehriyar.ink/this-addon-is-only-compatible-with-auris-find-it-at-auris.shehriyar.ink"

MODULES = {
    "modules/ax4.js": ("Auris Addon", "3.0.1"),
    "modules/ax2.js": ("Auris Hi-Res Lossless Addon", "2.0.0"),
    "modules/ax3.js": ("Internet Archive FLAC (archive.org)", "2.0.0"),
}
RETIRED = [
    "modules/bitchord-tidal-flac.js",
    "modules/ax1.js",
    "modules/auris-hi-res-lossless.js",
    "modules/archive-flac.js",
    "modules/monochrome-tidal.js",
    "modules/qobuz-official.js",
]

docs = {}
for filename in ["index.json", "manifest.json"]:
    doc_path = ROOT / filename
    assert doc_path.exists(), f"File {filename} does not exist"
    data = json.loads(doc_path.read_text())
    docs[filename] = data

    assert LOCK_TEXT in data.get("description", ""), \
        f"{filename} description must carry the lock text"
    assert LOCK_LINK in data.get("description", ""), \
        f"{filename} description must carry the Auris link"
    assert data.get("install") == GATED_INDEX, \
        f"{filename} must point installers at the gated endpoint"

    # The public file must not list a module. A host that fetches it can only
    # report that the index has nothing, which means the source cannot be
    # added without the Auris header.
    assert not data.get("category:music"), \
        f"{filename} must not list modules publicly"
    assert data.get("error"), f"{filename} must explain the refusal"

for download, (name, version) in MODULES.items():
    source_path = ROOT / download
    assert source_path.exists(), f"JS source not found: {source_path}"
    source = source_path.read_text()
    assert len(source) > 10_000, f"{download}: shipped file is suspiciously small"

    for leak in (
        LOCK_TEXT,
        LOCK_LINK,
        "__spine_app",
        "searchTracks",
        "getTrackStreamUrl",
        "module.exports",
        "requireAuris",
    ):
        assert leak not in source, f"{download}: leaked {leak!r} in shipped file"

    assert re.search(r"function [A-Za-z0-9_]+\(", source), \
        f"{download}: no obfuscated function table found"
    assert "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=" in source, \
        f"{download}: expected encoded string table"

    print(f"  ✓ {download} ({name} {version}) shipped opaque")

for retired in RETIRED:
    assert not (ROOT / retired).exists(), f"retired source still published: {retired}"

assert docs["index.json"]["version"] == docs["manifest.json"]["version"], \
    "index.json and manifest.json versions differ"

print("\nPublic index: refusal stub only.")
print(f"Real index: {GATED_INDEX} (Auris header required).")
print("Opaque modules verified; runtime gate is covered by test_gate.js.")
