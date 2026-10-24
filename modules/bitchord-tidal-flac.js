/*
 * Auris Addon — Tidal FLAC through hifi-api / tracks-protocol instances.
 *
 *   module.exports.searchTracks(query, limit, context)     -> { tracks, total }
 *   module.exports.getTrackStreamUrl(id, quality, context) -> { streamUrl, track }
 *
 * This is the fast path from Auris's built-in "Auris Addon", ported into the
 * module sandbox in full:
 *
 *   - every candidate instance is probed in parallel, never walked in series;
 *   - the tracks protocol (/search/tracks + direct /track/{id}) is preferred,
 *     with hifi-api v2 (/search/?s= + base64 manifests) as fallback;
 *   - the protocol that answered an instance is remembered, so the doomed
 *     first attempt is paid once, not every track;
 *   - a search on the primary instance starts immediately while the rest of
 *     the pool is probed in the background;
 *   - direct files get the same best-effort size guard as the built-in:
 *     a 1-byte range request measures the file and refuses a "FLAC" whose
 *     bytes imply a transcode. A failed probe is a miss, not a refusal.
 *
 * ── Auris only ──────────────────────────────────────────────────────────────
 *
 * The module refuses to initialise unless the host exposes Auris's
 * __spine_app marker, and every export also requires the app identity in the
 * context object. Other module hosts get the error below instead of a source.
 *
 * ── Sandbox constraints ─────────────────────────────────────────────────────
 *
 *   1. text()/json() are synchronous in Auris's bridge — bodyOf handles both.
 *   2. arrayBuffer() is not implemented; FLAC is verified as 4 ASCII bytes.
 *   3. Response headers are available through resp.headers.get() in Auris;
 *      other hosts never get this far because of the gate.
 *   4. No URLSearchParams, no Buffer.
 */

(function () {
  'use strict';

  var AURIS_ERROR =
    'This addon is only compatible with Auris. Find it on GitHub or at https://auris.shehriyar.ink';

  function hasAurisHost() {
    return typeof __spine_app !== 'undefined' && __spine_app && __spine_app.id === 'auris';
  }

  if (!hasAurisHost()) throw new Error(AURIS_ERROR);

  function requireAuris(context) {
    if (context && context.app && context.app.id === 'auris') return;
    throw new Error(AURIS_ERROR);
  }

  /**
   * The bundled pool, in the built-in's order. tracks.monochrome.st is the
   * live-verified primary; the rest are candidates that the on-device probe
   * decides, not this list.
   */
  var BUNDLED = [
    'https://tracks.monochrome.st',
    'https://api.monochrome.tf',
    'https://wolf.qqdl.site',
    'https://maus.qqdl.site',
    'https://vogel.qqdl.site',
    'https://katze.qqdl.site',
    'https://hund.qqdl.site',
    'https://tidal.kinoplus.online'
  ];

  /** The curated list Auris refreshes daily; used only if every bundled host fails. */
  var REMOTE_URL =
    'https://raw.githubusercontent.com/OreoMuncher45/BitChordNext/main/tidal-instances.json';

  var UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  var SEARCH_TIMEOUT_MS = 4500;
  var PROBE_TIMEOUT_MS = 2500;
  var STREAM_TIMEOUT_MS = 6000;
  var REMOTE_TIMEOUT_MS = 2000;
  var HEALTH_TTL_MS = 30 * 60 * 1000;
  var REMOTE_TTL_MS = 24 * 60 * 60 * 1000;

  /** CD's own quietest hour still averages several times this; below it is a transcode. */
  var MIN_GENUINE_KBPS = 300;

  var health = {};
  var protocolMemo = {};
  var remotePool = [];
  var remoteAt = 0;

  // ── settings and small helpers ─────────────────────────────────────────────

  function setting(context, key) {
    if (!context || !context.settings) return '';
    var entry = context.settings[key];
    if (entry == null) return '';
    if (typeof entry === 'object' && entry.value != null) return String(entry.value);
    if (typeof entry === 'string') return entry;
    return '';
  }

  function wantedTier(quality, context) {
    var raw = String(quality || setting(context, 'quality') || '').toLowerCase();
    if (!raw) return 'LOSSLESS';
    if (/lossless|flac|hi-?res|hires|max|best/.test(raw)) return 'LOSSLESS';
    if (/low|96|128|min/.test(raw)) return 'LOW';
    return 'HIGH';
  }

  function str(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function normalizeBase(raw) {
    var value = String(raw == null ? '' : raw).trim();
    if (!/^https?:\/\//i.test(value)) return '';
    return value.replace(/\/+$/, '');
  }

  function unique(values) {
    var seen = {};
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (!value || seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    return out;
  }

  function artistNames(value) {
    var names = [];
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var entry = value[i];
        if (typeof entry === 'string') names.push(entry);
        else if (entry && typeof entry === 'object') names.push(str(entry.name));
      }
    } else if (typeof value === 'string') {
      names.push(value);
    }
    var cleaned = [];
    for (var j = 0; j < names.length; j++) {
      var name = String(names[j] == null ? '' : names[j]).trim();
      if (name) cleaned.push(name);
    }
    return unique(cleaned);
  }

  function normalizeDurationSec(raw) {
    var value = Number(raw);
    if (!isFinite(value) || value <= 0) return 0;
    return value > 10000 ? Math.round(value / 1000) : Math.round(value);
  }

  function isLossless(label) {
    return /LOSSLESS|HI_RES|HIRES|FLAC/i.test(String(label == null ? '' : label));
  }

  function coverUrl(slug) {
    var value = String(slug == null ? '' : slug);
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    return 'https://resources.tidal.com/images/' + value.replace(/-/g, '/') + '/640x640.jpg';
  }

  // ── the bridge's two shapes ────────────────────────────────────────────────

  function bodyOf(resp) {
    var value = resp.text();
    return value && typeof value.then === 'function' ? value : Promise.resolve(value);
  }

  function header(resp, name) {
    try {
      return resp.headers && resp.headers.get ? resp.headers.get(name) : null;
    } catch (error) {
      return null;
    }
  }

  function totalBytes(resp) {
    var range = header(resp, 'content-range');
    if (range) {
      var match = String(range).match(/\/(\d+)\s*$/);
      if (match) return Number(match[1]);
    }
    var length = Number(header(resp, 'content-length'));
    return isFinite(length) && length > 0 ? length : 0;
  }

  /**
   * One request with a deadline. The host's fetch has no timeout of its own,
   * so a volunteer that accepts a connection and then says nothing must not
   * hold the whole source-resolution slot.
   */
  function request(url, options) {
    var opts = options || {};
    var timeout = opts.timeout || SEARCH_TIMEOUT_MS;
    var settled = false;

    var guard = new Promise(function (_, reject) {
      setTimeout(function () {
        if (!settled) reject(new Error('timeout after ' + timeout + 'ms'));
      }, timeout);
    });

    var call = fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || { 'User-Agent': UA, Accept: 'application/json' },
      body: opts.body
    }).then(
      function (value) { settled = true; return value; },
      function (error) { settled = true; throw error; }
    );

    return Promise.race([call, guard]);
  }

  // ── protocol and health memory ─────────────────────────────────────────────

  function noteProtocol(base, protocol) { protocolMemo[base] = protocol; }

  function knownProtocol(base) { return protocolMemo[base] || null; }

  function forgetProtocol(base) { delete protocolMemo[base]; }

  function noteHealth(base, ok) { health[base] = { ok: !!ok, at: Date.now() }; }

  function healthOf(base) {
    var entry = health[base];
    if (!entry) return null;
    if (Date.now() - entry.at >= HEALTH_TTL_MS) return null;
    return entry.ok;
  }

  // ── parsing ────────────────────────────────────────────────────────────────

  /**
   * Tracks-protocol rows, or null when the body is not that shape. An
   * empty-but-shaped answer is a real empty result, not a protocol mismatch.
   */
  function parseTracksSearch(body, base) {
    var root;
    try { root = JSON.parse(body); } catch (error) { return null; }
    if (!root || !Array.isArray(root.tracks)) return null;

    var rows = [];
    var seen = {};
    for (var i = 0; i < root.tracks.length; i++) {
      var track = asObject(root.tracks[i]);
      if (!track) continue;
      var id = str(track.trackId) || str(track.id);
      var title = str(track.title);
      if (!id || !title) continue;
      // A catalogue entry with no file behind it costs a /track call to
      // learn nothing.
      if (track.playable === false) continue;
      if (seen[id]) continue;
      seen[id] = true;

      var names = artistNames(track.artistNames);
      var fromArtists = artistNames(track.artists);
      var artist = unique(names.concat(fromArtists)).join(', ') || 'Unknown Artist';
      var durationSec = normalizeDurationSec(track.duration);
      var art = str(track.artwork) || str(track.cover) || str(track.image);

      rows.push({
        id: base + '|t|' + durationSec + '|' + id,
        title: title,
        artist: artist,
        album: str(track.albumTitle) || str(track.releaseTitle),
        albumCover: art || null,
        duration: durationSec,
        audioQuality: 'LOSSLESS',
        format: 'flac',
        availableQualities: ['LOSSLESS']
      });
    }
    return rows;
  }

  /** hifi-api v2 rows. A malformed answer is an empty result, as in the built-in. */
  function parseHifiSearch(body, base) {
    var root;
    try { root = JSON.parse(body); } catch (error) { return []; }
    var data = asObject(root && root.data);
    var items = data && Array.isArray(data.items) ? data.items : null;
    if (!items) return [];

    var rows = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var item = asObject(items[i]);
      if (!item) continue;
      var id = str(item.id);
      var title = str(item.title);
      if (!id || !title) continue;
      if (seen[id]) continue;
      seen[id] = true;

      var names = artistNames(item.artists);
      var artistObj = asObject(item.artist);
      if (artistObj && str(artistObj.name)) names.push(str(artistObj.name));
      var artist = unique(names).join(', ') || 'Unknown Artist';
      var album = asObject(item.album);
      var albumTitle = album ? str(album.title) : '';
      var cover = album ? str(album.cover) : '';
      var quality = str(item.audioQuality);
      var durationSec = normalizeDurationSec(item.duration);

      rows.push({
        id: base + '|h|' + id,
        title: title,
        artist: artist,
        album: albumTitle,
        albumCover: cover ? coverUrl(cover) : null,
        duration: durationSec,
        audioQuality: quality,
        format: isLossless(quality) ? 'flac' : '',
        availableQualities: quality && isLossless(quality) ? [quality] : []
      });
    }
    return rows;
  }

  // ── instance pool ──────────────────────────────────────────────────────────

  function candidateBases(context) {
    var list = [];
    var preferred = normalizeBase(setting(context, 'preferredBaseUrl'));
    if (preferred) list.push(preferred);
    for (var i = 0; i < remotePool.length; i++) {
      var remote = normalizeBase(remotePool[i]);
      if (remote) list.push(remote);
    }
    for (var j = 0; j < BUNDLED.length; j++) list.push(BUNDLED[j]);
    return unique(list);
  }

  /**
   * Tracks protocol first — the live standard — but only fall through to a
   * hifi root probe when the tracks answer was a real HTTP/shape mismatch.
   * A timeout is the host itself being slow, so spending the second timeout
   * on the same host just multiplies the wait.
   */
  function probe(base) {
    return request(base + '/search/tracks?q=a&limit=1', { timeout: PROBE_TIMEOUT_MS }).then(
      function (resp) {
        if (resp.ok) {
          return bodyOf(resp).then(function (body) {
            if (parseTracksSearch(body, base) !== null) {
              noteProtocol(base, 'TRACKS');
              return true;
            }
            return probeHifi(base);
          });
        }
        if (resp.status === 429 || resp.status >= 500) return false;
        return probeHifi(base);
      },
      function () { return false; }
    );
  }

  function probeHifi(base) {
    return request(base + '/', { timeout: PROBE_TIMEOUT_MS }).then(
      function (resp) {
        if (!resp.ok) return false;
        return bodyOf(resp).then(function (body) {
          var root;
          try { root = JSON.parse(body); } catch (error) { return false; }
          var version = str(root && root.version);
          if (version.indexOf('2.') !== 0) return false;
          noteProtocol(base, 'HIFI');
          return true;
        });
      },
      function () { return false; }
    );
  }

  function probeAll(bases) {
    var jobs = [];
    for (var i = 0; i < bases.length; i++) {
      (function (base) {
        var cached = healthOf(base);
        if (cached !== null) {
          jobs.push(Promise.resolve({ base: base, ok: cached }));
          return;
        }
        jobs.push(probe(base).then(
          function (ok) {
            noteHealth(base, ok);
            return { base: base, ok: ok };
          },
          function () {
            noteHealth(base, false);
            return { base: base, ok: false };
          }
        ));
      })(bases[i]);
    }
    return Promise.all(jobs).then(function (results) {
      var live = [];
      for (var i = 0; i < results.length; i++) {
        if (results[i].ok) live.push(results[i].base);
      }
      return live;
    });
  }

  /** Last resort only: the curated remote list replaces the bundled candidates. */
  function refreshRemotePool() {
    if (remotePool.length && Date.now() - remoteAt < REMOTE_TTL_MS) {
      return Promise.resolve(remotePool);
    }
    return request(REMOTE_URL, {
      timeout: REMOTE_TIMEOUT_MS,
      headers: { Accept: 'application/json', 'User-Agent': UA }
    }).then(
      function (resp) {
        if (!resp.ok) return remotePool;
        return bodyOf(resp).then(function (body) {
          var root;
          try { root = JSON.parse(body); } catch (error) { return remotePool; }
          var entries = root && Array.isArray(root.instances) ? root.instances : [];
          var urls = [];
          for (var i = 0; i < entries.length; i++) {
            var url = normalizeBase(asObject(entries[i]) ? entries[i].url : '');
            if (url) urls.push(url);
          }
          if (urls.length) {
            remotePool = urls;
            remoteAt = Date.now();
          }
          return remotePool;
        });
      },
      function () { return remotePool; }
    );
  }

  // ── search ─────────────────────────────────────────────────────────────────

  function hifiSearch(base, query, limit) {
    return request(
      base + '/search/?s=' + encodeURIComponent(query) + '&limit=' + encodeURIComponent(String(limit)),
      { timeout: SEARCH_TIMEOUT_MS }
    ).then(
      function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return bodyOf(resp).then(function (body) {
          noteProtocol(base, 'HIFI');
          return { base: base, rows: parseHifiSearch(body, base), protocol: 'HIFI' };
        });
      },
      function (error) {
        forgetProtocol(base);
        throw error;
      }
    );
  }

  /**
   * One instance: the memoized protocol goes first; a miss falls through to
   * the other one and re-memoizes, so drift costs one request, once.
   */
  function searchOne(base, query, limit) {
    var memo = knownProtocol(base);
    var tracksAttempt = memo === 'HIFI'
      ? Promise.resolve(null)
      : request(
          base + '/search/tracks?q=' + encodeURIComponent(query) +
            '&limit=' + encodeURIComponent(String(limit)),
          { timeout: SEARCH_TIMEOUT_MS }
        ).then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return bodyOf(resp).then(function (body) {
            var rows = parseTracksSearch(body, base);
            if (rows === null) throw new Error('not a tracks answer');
            noteProtocol(base, 'TRACKS');
            return { base: base, rows: rows, protocol: 'TRACKS' };
          });
        });

    return tracksAttempt.then(
      function (result) {
        if (result) return result;
        if (memo === 'TRACKS') return null;
        return hifiSearch(base, query, limit);
      },
      function () {
        if (memo === 'TRACKS') return null;
        return hifiSearch(base, query, limit);
      }
    );
  }

  /** The first non-empty answer from a set of live instances wins. */
  function searchAny(bases, query, limit) {
    if (!bases.length) return Promise.resolve({ base: null, rows: [] });
    return new Promise(function (resolve) {
      var remaining = bases.length;
      var settled = false;
      for (var i = 0; i < bases.length; i++) {
        (function (base) {
          searchOne(base, query, limit).then(
            function (result) {
              remaining--;
              if (!settled && result && result.rows && result.rows.length) {
                settled = true;
                resolve(result);
              } else if (remaining === 0 && !settled) {
                resolve({ base: null, rows: [] });
              }
            },
            function () {
              remaining--;
              if (remaining === 0 && !settled) resolve({ base: null, rows: [] });
            }
          );
        })(bases[i]);
      }
    });
  }

  function searchTracks(query, limit, context) {
    requireAuris(context);
    var text = String(query == null ? '' : query).trim();
    if (!text) return { tracks: [], total: 0 };

    var capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
    var bases = candidateBases(context);
    var primary = bases[0];
    var rest = bases.slice(1);

    // The primary starts answering immediately; the rest of the pool is
    // probed in parallel and only consulted if the primary has nothing.
    var primarySearch = searchOne(primary, text, capped);
    var restProbe = probeAll(rest);

    function fallback() {
      return restProbe.then(function (live) {
        if (live.length) return searchAny(live, text, capped);
        return refreshRemotePool().then(function () {
          var retry = candidateBases(context).slice(1);
          return probeAll(retry).then(function (retryLive) {
            return searchAny(retryLive.length ? retryLive : retry, text, capped);
          });
        });
      });
    }

    return primarySearch.then(
      function (found) {
        if (found && found.rows && found.rows.length) return found;
        return fallback();
      },
      function () { return fallback(); }
    ).then(function (found) {
      var rows = found && found.rows ? found.rows : [];
      return { tracks: rows, total: rows.length };
    });
  }

  // ── stream ─────────────────────────────────────────────────────────────────

  function parsePacked(raw) {
    var text = String(raw == null ? '' : raw);
    var parts = text.split('|');
    if (parts.length >= 2 && /^https?:\/\//i.test(parts[0])) {
      var base = normalizeBase(parts[0]);
      if (parts[1] === 't') {
        var durationSec = Number(parts[2]) || 0;
        var tracksId = parts.slice(3).join('|');
        if (tracksId) {
          return { base: base, protocol: 'TRACKS', durationSec: durationSec, id: tracksId };
        }
      }
      if (parts[1] === 'h') {
        var hifiId = parts.slice(2).join('|');
        if (hifiId) return { base: base, protocol: 'HIFI', durationSec: 0, id: hifiId };
      }
      // Rows minted by the previous module were `base|id`.
      var legacy = parts.slice(1).join('|');
      if (legacy) return { base: base, protocol: 'TRACKS', durationSec: 0, id: legacy };
    }
    return { base: null, protocol: 'TRACKS', durationSec: 0, id: text };
  }

  function streamBases(parsed, context) {
    var all = candidateBases(context);
    var ordered = parsed.base ? [parsed.base] : [];
    for (var i = 0; i < all.length; i++) {
      if (all[i] !== parsed.base) ordered.push(all[i]);
    }
    var live = [];
    for (var j = 0; j < ordered.length; j++) {
      if (healthOf(ordered[j]) === true) live.push(ordered[j]);
    }
    return live.length ? live : ordered;
  }

  /**
   * Best-effort direct-file check. A 200/206 is measured through the range
   * headers; anything else is a probe miss, and the URL is still handed over
   * exactly as the built-in does. A measured file below the lossless floor,
   * or a clear non-FLAC signature, is refused.
   */
  function rangeProbe(url, durationSec) {
    return request(url, {
      timeout: STREAM_TIMEOUT_MS,
      headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-3' }
    }).then(
      function (resp) {
        if (resp.status !== 200 && resp.status !== 206) return null;
        return bodyOf(resp).then(function (body) {
          var size = totalBytes(resp);
          var rangeIgnored = body.length > 8;
          var signatureOk = body.length > 0 && body.length <= 8 && body.indexOf('fLaC') === 0;

          if (!rangeIgnored && body.length > 0 && !signatureOk) {
            return { refused: true, reason: 'no fLaC signature' };
          }

          var kbps = 0;
          if (size > 0 && durationSec > 60) {
            kbps = Math.round((size * 8) / durationSec / 1000);
            if (kbps < MIN_GENUINE_KBPS) {
              return { refused: true, reason: 'below the lossless floor' };
            }
          }
          return { ok: true, kbps: kbps, sizeBytes: size, signatureOk: signatureOk };
        });
      },
      function () { return null; }
    );
  }

  function tracksStream(parsed, context) {
    var base = parsed.base || candidateBases(context)[0] || BUNDLED[0];
    var url = base + '/track/' + encodeURIComponent(parsed.id);
    return rangeProbe(url, parsed.durationSec).then(function (check) {
      if (check && check.refused) throw new Error(check.reason || 'refused');
      var track = {
        id: parsed.id,
        audioQuality: 'LOSSLESS',
        mimeType: 'audio/flac',
        audioModes: ['STEREO']
      };
      if (check && check.kbps > 0) track.bitrate = check.kbps;
      return { streamUrl: url, track: track };
    });
  }

  function tiersFor(quality, context) {
    var tier = wantedTier(quality, context);
    if (tier === 'LOSSLESS') return ['HI_RES_LOSSLESS', 'LOSSLESS'];
    if (tier === 'LOW') return ['LOW'];
    return ['HIGH'];
  }

  function pickStream(body) {
    var root;
    try { root = JSON.parse(body); } catch (error) { return null; }
    var data = asObject(root && root.data);
    if (!data) return null;
    var encoded = str(data.manifest);
    if (!encoded) return null;

    var manifest;
    try {
      var decoded = atob(String(encoded).replace(/\s+/g, ''));
      manifest = JSON.parse(decoded);
    } catch (error) {
      return null;
    }
    if (!manifest) return null;

    var encryption = str(manifest.encryptionType);
    if (encryption && encryption !== 'NONE') return null;

    var urls = Array.isArray(manifest.urls) ? manifest.urls : [];
    var url = '';
    for (var i = 0; i < urls.length; i++) {
      var candidate = str(urls[i]);
      if (candidate) { url = candidate; break; }
    }
    if (!url) return null;

    return {
      streamUrl: url,
      track: {
        id: '',
        audioQuality: str(data.audioQuality),
        mimeType: str(manifest.mimeType) || str(manifest.codecs) || null,
        audioModes: ['STEREO']
      }
    };
  }

  function hifiStreamOn(base, id, tiers) {
    function tryTier(index) {
      if (index >= tiers.length) return Promise.resolve(null);
      var url = base + '/track/?id=' + encodeURIComponent(id) +
        '&quality=' + encodeURIComponent(tiers[index]);
      return request(url, {
        timeout: STREAM_TIMEOUT_MS,
        headers: { Accept: 'application/json', 'User-Agent': UA }
      }).then(
        function (resp) {
          if (resp.status === 429 || resp.status === 502 ||
              resp.status === 503 || resp.status === 504) {
            throw new Error('instance overloaded (HTTP ' + resp.status + ')');
          }
          if (!resp.ok) return tryTier(index + 1);
          return bodyOf(resp).then(function (body) {
            var answer = pickStream(body);
            if (answer) return answer;
            return tryTier(index + 1);
          });
        },
        function (error) { throw error; }
      );
    }
    return tryTier(0);
  }

  function hifiStream(parsed, context, quality) {
    var bases = streamBases(parsed, context);
    var tiers = tiersFor(quality, context);
    function tryBase(index) {
      if (index >= bases.length) return Promise.resolve(null);
      return hifiStreamOn(bases[index], parsed.id, tiers).then(
        function (answer) {
          if (answer) return answer;
          return tryBase(index + 1);
        },
        function () { return tryBase(index + 1); }
      );
    }
    return tryBase(0);
  }

  function getTrackStreamUrl(trackId, quality, context) {
    requireAuris(context);
    var parsed = parsePacked(trackId);
    if (!parsed.id) return { streamUrl: null };

    if (parsed.protocol === 'TRACKS') {
      return tracksStream(parsed, context).then(
        function (answer) { return answer; },
        function () { return { streamUrl: null }; }
      );
    }

    return hifiStream(parsed, context, quality).then(
      function (answer) {
        if (!answer) return { streamUrl: null };
        answer.track.id = parsed.id;
        return answer;
      },
      function () { return { streamUrl: null }; }
    );
  }

  module.exports = {};
  module.exports.searchTracks = searchTracks;
  module.exports.getTrackStreamUrl = getTrackStreamUrl;
  module.exports.name = 'Auris Addon';
  module.exports.version = '2.0.0';
})();
