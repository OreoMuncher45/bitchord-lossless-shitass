"""
Validates that the module index and manifest match the Auris module contract.

Run:  python3 test_contract.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).parent
LOCK_TEXT = "This addon is only compatible with Auris"
LOCK_LINK = "https://auris.shehriyar.ink"
LOCKED_IDS = {
    "bitchord-tidal-flac": ("Auris Addon", "2.0.0"),
    "auris-hi-res-lossless": ("Auris Hi-Res Lossless Addon", "1.0.0"),
    "archive-flac": ("Internet Archive FLAC (archive.org)", "1.1.0"),
}

docs = {}
for filename in ["index.json", "manifest.json"]:
    doc_path = ROOT / filename
    assert doc_path.exists(), f"File {filename} does not exist"
    data = json.loads(doc_path.read_text())
    docs[filename] = data

    # ── Index structure ──────────────────────────────────────────────────
    assert "category:music" in data, f"{filename} must contain 'category:music'"
    modules = data["category:music"]
    assert isinstance(modules, list), f"'category:music' in {filename} must be a list"
    assert len(modules) == len(LOCKED_IDS), \
        f"Expected {len(LOCKED_IDS)} modules in {filename}, got {len(modules)}"

    # Addon manifest compatibility fields
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
    assert set(listed) == set(LOCKED_IDS), \
        f"{filename} module ids differ: {sorted(listed)}"

    for module_id, (name, version) in LOCKED_IDS.items():
        module = listed[module_id]

        # Required fields
        assert module.get("id"), f"Module missing 'id': {module}"
        assert module.get("name") == name, \
            f"{module_id}: name must be {name!r}, got {module.get('name')!r}"
        assert module.get("version") == version, \
            f"{module_id}: version must be {version}, got {module.get('version')}"
        assert module.get("download", "").startswith("modules/"), \
            f"download must start with 'modules/': {module_id}"

        # Tags should be a list and must mark the lock
        tags = module.get("tags", [])
        assert isinstance(tags, list), f"tags must be a list: {module_id}"
        assert "AURIS ONLY" in tags, f"{module_id}: missing 'AURIS ONLY' tag"

        # Code field present (integer version)
        assert isinstance(module.get("code", 0), int), \
            f"code must be an integer: {module_id}"

        # ── JS source validation ─────────────────────────────────────────
        source_path = ROOT / module["download"]
        assert source_path.exists(), f"JS source not found: {source_path}"
        source = source_path.read_text()

        # Real exports, not mentions in a header comment: either a direct
        # assignment or a property in the object literal.
        def exported(fn):
            return (
                re.search(rf"module\.exports\.{fn}\s*=\s*\w", source)
                or re.search(rf"module\.exports\s*=\s*\{{[\s\S]*?\b{fn}\s*:", source)
            )

        assert exported("searchTracks"), \
            f"{module_id}: missing searchTracks export"
        assert exported("getTrackStreamUrl"), \
            f"{module_id}: missing getTrackStreamUrl export"

        # The Auris gate must exist in its three places: the message, the
        # load-time identity check, and the per-call context check.
        assert LOCK_TEXT in source, f"{module_id}: missing lock text"
        assert LOCK_LINK in source, f"{module_id}: missing Auris link"
        assert "__spine_app" in source, f"{module_id}: missing host marker check"
        assert "requireAuris(context)" in source, \
            f"{module_id}: missing per-call Auris check"
        assert source.count("requireAuris(context)") >= 2, \
            f"{module_id}: both exports must call requireAuris(context)"

        # Balanced braces and parentheses
        assert source.count("{") == source.count("}"), \
            f"{module_id}: unbalanced braces"
        assert source.count("(") == source.count(")"), \
            f"{module_id}: unbalanced parentheses"

        # No hardcoded credentials
        assert not re.search(
            r"(api[_-]?secret|auth[_-]?token)\s*[:=]\s*[\"'][^\"']+[\"']",
            source, re.I
        ), f"{module_id}: contains hardcoded credentials"

        # Must use the sandbox fetch(), not XMLHttpRequest or other
        assert "XMLHttpRequest" not in source, \
            f"{module_id}: must use fetch(), not XMLHttpRequest"

        print(f"  ✓ [{filename}] {module_id} ({module['version']}) locked")

# The two documents must describe the same addon.
assert docs["index.json"]["version"] == docs["manifest.json"]["version"], \
    "index.json and manifest.json versions differ"
for module_id, (_, version) in LOCKED_IDS.items():
    a = next(m for m in docs["index.json"]["category:music"] if m["id"] == module_id)
    b = next(m for m in docs["manifest.json"]["category:music"] if m["id"] == module_id)
    assert a["download"] == b["download"], f"{module_id}: download paths differ"
    assert a["version"] == b["version"] == version, \
        f"{module_id}: index/manifest versions differ"

print(f"\nAuris module contract & manifest: valid in all files.")
print(f"Auris-only gate ({LOCK_LINK}) present in every module.")
