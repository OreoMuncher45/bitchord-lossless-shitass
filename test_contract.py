"""
Validates that the shipped addon index, manifest, and obfuscated modules stay
consistent and do not leak the lock or the host key in readable form.

Run:  python3 test_contract.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
LOCK_TEXT = "This addon is only compatible with Auris"
LOCK_LINK = "https://auris.shehriyar.ink"
LOCKED = {
    "ax-4": ("Auris Addon", "3.0.1", "modules/ax4.js"),
    "ax-2": ("Auris Hi-Res Lossless Addon", "2.0.0", "modules/ax2.js"),
    "ax-3": ("Internet Archive FLAC (archive.org)", "2.0.0", "modules/ax3.js"),
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

    assert "category:music" in data, f"{filename} must contain 'category:music'"
    modules = data["category:music"]
    assert isinstance(modules, list), f"'category:music' in {filename} must be a list"
    assert len(modules) == len(LOCKED), \
        f"Expected {len(LOCKED)} modules in {filename}, got {len(modules)}"

    assert data.get("id"), f"{filename} missing 'id'"
    assert data.get("name"), f"{filename} missing 'name'"
    assert data.get("version"), f"{filename} missing 'version'"
    assert "resources" in data, f"{filename} missing 'resources'"
    assert "search" in data["resources"] and "stream" in data["resources"], \
        f"{filename} must advertise search and stream"

    # The lock is stated where a host reads it before running any code.
    assert LOCK_TEXT in data.get("description", ""), \
        f"{filename} description must carry the lock text"
    assert LOCK_LINK in data.get("description", ""), \
        f"{filename} description must carry the Auris link"

    listed = {module.get("id"): module for module in modules}
    assert set(listed) == set(LOCKED), \
        f"{filename} module ids differ: {sorted(listed)}"

    for module_id, (name, version, download) in LOCKED.items():
        module = listed[module_id]
        assert module.get("name") == name, \
            f"{module_id}: name must be {name!r}, got {module.get('name')!r}"
        assert module.get("version") == version, \
            f"{module_id}: version must be {version}, got {module.get('version')}"
        assert module.get("download") == download, \
            f"{module_id}: download must be {download!r}, got {module.get('download')!r}"
        assert "AURIS ONLY" in module.get("tags", []), \
            f"{module_id}: missing 'AURIS ONLY' tag"
        assert isinstance(module.get("code", 0), int), \
            f"code must be an integer: {module_id}"

        source_path = ROOT / download
        assert source_path.exists(), f"JS source not found: {source_path}"
        source = source_path.read_text()
        assert len(source) > 10_000, f"{module_id}: shipped file is suspiciously small"

        # The served file is compiled. None of the readable gate, exports, or
        # endpoints may survive as plain text.
        for leak in (
            LOCK_TEXT,
            LOCK_LINK,
            "__spine_app",
            "searchTracks",
            "getTrackStreamUrl",
            "module.exports",
            "requireAuris",
        ):
            assert leak not in source, f"{module_id}: leaked {leak!r} in shipped file"

        # Obfuscation must actually be present: the decoder takes a numeric
        # offset and the string table is encoded.
        assert re.search(r"function [A-Za-z0-9_]+\(", source), \
            f"{module_id}: no obfuscated function table found"
        assert "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=" in source, \
            f"{module_id}: expected encoded string table"

        print(f"  ✓ [{filename}] {module_id} ({module['version']}) shipped opaque")

# Retired readable sources must not remain reachable by an old cached index.
for retired in RETIRED:
    assert not (ROOT / retired).exists(), f"retired source still published: {retired}"

# The two documents must describe the same addon.
assert docs["index.json"]["version"] == docs["manifest.json"]["version"], \
    "index.json and manifest.json versions differ"
for module_id, (_, version, download) in LOCKED.items():
    a = next(m for m in docs["index.json"]["category:music"] if m["id"] == module_id)
    b = next(m for m in docs["manifest.json"]["category:music"] if m["id"] == module_id)
    assert a["download"] == b["download"] == download, \
        f"{module_id}: download paths differ"
    assert a["version"] == b["version"] == version, \
        f"{module_id}: index/manifest versions differ"

print("\nAuris module contract & manifest: valid in all files.")
print(f"Opaque modules; lock ({LOCK_LINK}) enforced at runtime by test_gate.js.")
