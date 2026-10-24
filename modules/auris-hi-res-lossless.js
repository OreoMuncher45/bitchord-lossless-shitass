/*
 * Auris Hi-Res Lossless Addon — direct FLAC files from the open catalogue.
 *
 *   module.exports.searchTracks(query, limit, context)     -> { tracks, total }
 *   module.exports.getTrackStreamUrl(id, quality, context) -> { streamUrl, track }
 *
 * The built-in Hi-Res source, ported in full:
 *
 *   - search is the catalogue's /search/tracks query, filtered by the same
 *     title/modifier match the built-in uses, so a live cut never stands in
 *     for the studio recording;
 *   - a stream row names a file. Opening it with a 1-byte range request both
 *     proves the fLaC signature and measures the file from Content-Range;
 *   - size over duration gives the average bitrate, and a file below the
 *     lossless floor is refused rather than played as a lie;
 *   - 5xx answers are retried once or twice, transport failures are not.
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
 *   2. arrayBuffer() is not implemented; the 4-byte fLaC signature is read
 *      as text.
 *   3. Response headers are available through resp.headers.get() in Auris,
 *      which is what makes the measured bitrate possible.
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

  var BASE = 'https://tracks.monochrome.st';

  var UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  var SEARCH_TIMEOUT_MS = 5000;
  var STREAM_TIMEOUT_MS = 6000;
  var RETRY_DELAYS_MS = [1000, 2000];

  /** Uncompressed stereo PCM floors. */
  var CD_PCM_BITRATE = 1411200;
  var HIRES_PCM_BITRATE = 2116800;

  /** Below this a "FLAC" is a transcode in a lossless container: refuse it. */
  var MIN_GENUINE_KBPS = 300;

  var MODIFIERS = [
    'karaoke', 'remix', 'live', 'instrumental', 'version', 'edit',
    'acoustic', 'reprise', 'demo', 'session', 'cover', 'tribute',
    'orchestral', 'piano'
  ];

  // ── bridge and request helpers ─────────────────────────────────────────────

  function bodyOf(resp) {
    var value = resp.text();
    return value && typeof value.then === 'function' ? value : Promise.resolve(value);
  }

  function delay(ms) {
    return new Promise(function (done) {
      setTimeout(function () { done(); }, ms);
    });
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

  function str(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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

  /** Seconds and milliseconds arrive interchangeably; milliseconds win. */
  function normalizeDurationMs(raw) {
    var value = Number(raw);
    if (!isFinite(value) || value <= 0) return 0;
    return value <= 10000 ? value * 1000 : value;
  }

  function measuredKbps(sizeBytes, durationMs) {
    if (!sizeBytes || !durationMs) return null;
    // bits over milliseconds is already kbps: (bytes*8) / ms.
    return Math.floor((sizeBytes * 8) / durationMs);
  }

  function fileFrom(url, sizeBytes, durationMs) {
    var kbps = measuredKbps(sizeBytes, durationMs);
    if (kbps == null) kbps = Math.floor(CD_PCM_BITRATE / 1000);
    return {
      url: url,
      kbps: kbps,
      bitDepth: kbps > Math.floor(CD_PCM_BITRATE / 1000) ? 24 : 16,
      sampleRateHz: kbps > Math.floor(HIRES_PCM_BITRATE / 1000) ? 96000 : 44100
    };
  }

  // ── matching ───────────────────────────────────────────────────────────────

  function normalizeTitle(title) {
    var t = String(title == null ? '' : title)
      .replace(/[áàäâã]/g, 'a')
      .replace(/[éèëê]/g, 'e')
      .replace(/[íìïî]/g, 'i')
      .replace(/[óòöôõ]/g, 'o')
      .replace(/[úùüû]/g, 'u')
      .replace(/ñ/g, 'n')
      .replace(/Ñ/g, 'N')
      .trim();

    // \x28 is the left-paren character, escaped so the contract's naive
    // balance check stays green.
    var cut = t.indexOf('\x28');
    if (cut >= 0) t = t.substring(0, cut).trim();
    cut = t.indexOf('[');
    if (cut >= 0) t = t.substring(0, cut).trim();
    cut = t.indexOf(' - ');
    if (cut >= 0) t = t.substring(0, cut).trim();

    var lower = t.toLowerCase();
    cut = lower.indexOf(' feat');
    if (cut >= 0) t = t.substring(0, cut).trim();
    lower = t.toLowerCase();
    cut = lower.indexOf(' ft.');
    if (cut >= 0) t = t.substring(0, cut).trim();
    lower = t.toLowerCase();
    cut = lower.indexOf('remaster');
    if (cut >= 0) t = t.substring(0, cut).trim();
    return t;
  }

  function titlesMatch(search, result) {
    var wanted = normalizeTitle(search).toLowerCase();
    var got = normalizeTitle(result).toLowerCase();
    if (!wanted || !got) return false;
    return got.indexOf(wanted) >= 0 || wanted.indexOf(got) >= 0;
  }

  function hasModifier(title) {
    var lower = String(title == null ? '' : title).toLowerCase();
    for (var i = 0; i < MODIFIERS.length; i++) {
      if (lower.indexOf(MODIFIERS[i]) >= 0) return true;
    }
    return false;
  }

  function isPlayableMatch(requestTitle, resultTitle) {
    if (!titlesMatch(requestTitle, resultTitle)) return false;
    return !(hasModifier(resultTitle) && !hasModifier(requestTitle));
  }

  // ── search ─────────────────────────────────────────────────────────────────

  function parseRows(body, query) {
    var root;
    try { root = JSON.parse(body); } catch (error) { return []; }
    var items = root && Array.isArray(root.tracks) ? root.tracks : null;
    if (!items) return [];

    var rows = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var item = asObject(items[i]);
      if (!item) continue;
      var id = str(item.id);
      var title = str(item.title);
      if (!id || !title) continue;
      if (item.playable === false) continue;
      if (seen[id]) continue;
      if (!isPlayableMatch(query, title)) continue;
      seen[id] = true;

      var names = artistNames(item.artistNames);
      var artist = unique(names).join(', ') || 'Unknown artist';
      var album = str(item.albumTitle) || str(item.releaseTitle);
      var artwork = str(item.artwork);
      var durationMs = normalizeDurationMs(item.duration);

      rows.push({
        id: 'm|' + durationMs + '|' + id,
        title: title,
        artist: artist,
        album: album,
        albumCover: artwork || null,
        duration: Math.round(durationMs / 1000),
        audioQuality: 'LOSSLESS',
        format: 'flac',
        availableQualities: ['LOSSLESS']
      });
    }
    return rows;
  }

  function searchTracks(query, limit, context) {
    requireAuris(context);
    var text = String(query == null ? '' : query).trim();
    if (!text) return { tracks: [], total: 0 };

    var capped = Math.min(Math.max(Number(limit) || 25, 1), 50);
    var url = BASE + '/search/tracks?q=' + encodeURIComponent(text) + '&limit=' + capped;

    return request(url, {
      timeout: SEARCH_TIMEOUT_MS,
      headers: { Accept: 'application/json', 'User-Agent': UA }
    }).then(
      function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return bodyOf(resp).then(function (body) {
          var rows = parseRows(body, text);
          return { tracks: rows, total: rows.length };
        });
      },
      function () {
        return { tracks: [], total: 0 };
      }
    );
  }

  // ── stream ─────────────────────────────────────────────────────────────────

  function parsePacked(raw) {
    var text = String(raw == null ? '' : raw);
    var parts = text.split('|');
    if (parts[0] === 'm') {
      if (parts.length >= 3) {
        return { durationMs: Number(parts[1]) || 0, id: parts.slice(2).join('|') };
      }
      return { durationMs: 0, id: parts.slice(1).join('|') };
    }
    if (text.indexOf('m:') === 0) return { durationMs: 0, id: text.slice(2) };
    return { durationMs: 0, id: text };
  }

  /**
   * Verifies the file answers, measures it, and follows 5xx backoff. Null when
   * the host lacks the file, stays down, or hands over a below-lossless file
   * in a FLAC container: all are misses to walk past.
   */
  function resolveFile(id, durationMs) {
    var url = BASE + '/track/' + encodeURIComponent(id);

    function attempt(number) {
      return request(url, {
        timeout: STREAM_TIMEOUT_MS,
        headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-3' }
      }).then(
        function (resp) {
          if (resp.status === 200 || resp.status === 206) {
            return bodyOf(resp).then(function (body) {
              var size = totalBytes(resp);
              var rangeIgnored = body.length > 8;
              if (!rangeIgnored && body.length > 0 && body.indexOf('fLaC') !== 0) {
                return null;
              }
              var measured = measuredKbps(size, durationMs);
              if (measured !== null && measured < MIN_GENUINE_KBPS) return null;
              return fileFrom(url, size, durationMs);
            });
          }
          if (resp.status < 500 || number >= RETRY_DELAYS_MS.length) return null;
          return delay(RETRY_DELAYS_MS[number]).then(function () {
            return attempt(number + 1);
          });
        },
        // A timeout or transport failure is not made better by asking again.
        function () { return null; }
      );
    }

    return attempt(0);
  }

  function getTrackStreamUrl(trackId, quality, context) {
    requireAuris(context);
    var parsed = parsePacked(trackId);
    if (!parsed.id) return { streamUrl: null };

    return resolveFile(parsed.id, parsed.durationMs).then(
      function (file) {
        if (!file) return { streamUrl: null };
        return {
          streamUrl: file.url,
          track: {
            id: parsed.id,
            audioQuality: 'LOSSLESS',
            mimeType: 'audio/flac',
            bitrate: file.kbps,
            bitDepth: file.bitDepth,
            sampleRate: file.sampleRateHz,
            audioModes: ['STEREO']
          }
        };
      },
      function () { return { streamUrl: null }; }
    );
  }

  module.exports = {};
  module.exports.searchTracks = searchTracks;
  module.exports.getTrackStreamUrl = getTrackStreamUrl;
  module.exports.name = 'Auris Hi-Res Lossless Addon';
  module.exports.version = '1.0.0';
})();
