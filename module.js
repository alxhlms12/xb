/*
 * 8SPINE TIDAL HiFi Module
 * Version: 1.3.7
 * Authors: @blurrymilke, @._.alx.
 *
 * Follows the existing 8SPINE resolver-module pattern:
 *   - searchTracks(query, limit, context)
 *   - getTrackStreamUrl(trackId, preferredQuality, context)
 *   - returned module object with id, name, author, version, description
 *   - playback result includes streamUrl as the primary contract
 *
 * Uses the configured TIDAL-compatible Worker. Playback requests the
 * highest quality selected automatically by hifi-api, without a formats
 * override. Dolby Atmos releases are separate TIDAL releases and must be
 * selected manually through Manual Match. Playback resolves a fresh HLS
 * manifest each time because its URI can be signed and expire.
 */

var TIDAL_API = "https://xb-tidal.xander12.workers.dev";
var SUPPORTED_FORMATS = ["EAC3_JOC", "FLAC_HIRES", "FLAC", "AACLC", "HEAACV1"];
var SEARCH_CACHE_MAX = 60;
var searchCache = Object.create(null);
var pendingSearches = Object.create(null);
var trackMap = Object.create(null);

function cleanString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function boundedSet(cache, key, value, max) {
  cache[key] = value;
  var keys = Object.keys(cache);
  while (keys.length > max) delete cache[keys[0]];
  return value;
}

function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data?.items)) return body.data.items;
  if (Array.isArray(body?.data?.data?.items)) return body.data.data.items;
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.tracks)) return body.tracks;
  return [];
}

function normalizeIsrc(value) {
  var isrc = cleanString(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : "";
}

function tagList(track) {
  var sources = [
    track?.mediaMetadata?.tags,
    track?.media_metadata?.tags,
    track?.mediaMetadata?.audioModes,
    track?.media_metadata?.audioModes,
    track?.mediaMetadata?.formats,
    track?.media_metadata?.formats,
    track?.tags,
    track?.audioModes,
    track?.audio_modes,
    track?.audioQuality,
    track?.audio_quality,
    track?.format
  ];
  var tags = [];
  sources.forEach(function(source) {
    if (Array.isArray(source)) tags = tags.concat(source);
    else if (source !== null && source !== undefined) tags.push(source);
  });
  return tags.map(function(tag) {
    if (tag && typeof tag === "object") {
      return cleanString(tag.name || tag.value || tag.tag || tag.id).toUpperCase();
    }
    return cleanString(tag).toUpperCase();
  }).filter(Boolean);
}

function qualityEvidence(track) {
  var tags = tagList(track);
  var audioQuality = cleanString(
    track?.audioQuality || track?.audio_quality ||
    track?.quality || track?.qualityLabel || track?.format
  ).toUpperCase().replace(/[\s-]+/g, "_");
  var formats = [];
  [track?.formats, track?.mediaMetadata?.formats, track?.media_metadata?.formats].forEach(function(source) {
    if (Array.isArray(source)) formats = formats.concat(source);
    else if (source) formats.push(source);
  });
  formats = formats.map(function(x) { return cleanString(x).toUpperCase().replace(/[\s-]+/g, "_"); });

  var bits = Number(track?.bitDepth || track?.bit_depth || track?.audioInfo?.bitDepth ||
    track?.audio_info?.bitDepth || track?.mediaMetadata?.bitDepth || 0);
  var rate = Number(track?.sampleRate || track?.sample_rate || track?.audioInfo?.sampleRate ||
    track?.audio_info?.sampleRate || track?.mediaMetadata?.sampleRate || 0);
  if (rate >= 1000) rate /= 1000;

  // Dolby Atmos is a distinct presentation, not a bit-depth tier.
  if (tags.some(function(x) { return /DOLBY.?ATMOS|EAC3?_JOC3?/.test(x); }) ||
      formats.some(function(x) { return /EAC3?_JOC3?/.test(x); }) ||
      /DOLBY.?ATMOS|EAC3?_JOC3?/.test(audioQuality)) return "DOLBY ATMOS";

  // Catalog tags describe what is available. Test Hi-Res before generic LOSSLESS,
  // because a Hi-Res item commonly advertises both tags.
  if (
    tags.some(function(x) { return /HI.?RES.?LOSSLESS|HIRES_LOSSLESS|FLAC_HIRES/.test(x); }) ||
    formats.some(function(x) { return /HI.?RES|FLAC_HIRES/.test(x); }) ||
    /HI.?RES|HIRES|FLAC_HIRES|24BIT/.test(audioQuality) ||
    bits > 16 || rate > 48
  ) return "HI-RES";

  if (
    tags.some(function(x) { return x === "LOSSLESS" || x === "FLAC"; }) ||
    formats.some(function(x) { return x === "FLAC"; }) ||
    audioQuality === "LOSSLESS" || audioQuality === "FLAC" || audioQuality === "CD" ||
    bits === 16 || rate === 44.1
  ) return "CD";

  if (
    tags.some(function(x) { return /AAC|HEAAC|HIGH|LOW|LOSSY/.test(x); }) ||
    formats.some(function(x) { return /AAC|HEAAC/.test(x); }) ||
    /AAC|HEAAC|HIGH|LOW|LOSSY/.test(audioQuality)
  ) return "LOSSY";

  return "UNKNOWN";
}

function classifySearchQuality(track) {
  return qualityEvidence(track);
}

function artistName(track) {
  if (typeof track?.artist === "string") return track.artist;
  if (track?.artist?.name) return track.artist.name;
  if (Array.isArray(track?.artists)) {
    return track.artists.map(function(a) {
      return typeof a === "string" ? a : cleanString(a?.name);
    }).filter(Boolean).join(", ");
  }
  return cleanString(track?.artistName || track?.artist_name) || "Unknown Artist";
}

function albumName(track) {
  if (typeof track?.album === "string") return track.album;
  return cleanString(track?.album?.title || track?.albumTitle || track?.album_name);
}

function coverUrl(track) {
  var cover = cleanString(track?.album?.cover || track?.albumCover || track?.cover);
  if (!cover) return null;
  if (/^https?:\/\//i.test(cover)) return cover;
  // TIDAL cover IDs are UUID-like strings. Build the standard image URL.
  if (/^[0-9a-f-]{20,}$/i.test(cover)) {
    return "https://resources.tidal.com/images/" +
      cover.replace(/-/g, "/") + "/640x640.jpg";
  }
  return null;
}

function normalizeTrack(track, manualMatch) {
  var id = cleanString(track?.id || track?.trackId || track?.track_id);
  // Keep catalog-derived quality labels on normal search results, as in the
  // earlier module revisions. Manual Match replaces these with manifest data.
  var quality = classifySearchQuality(track);
  var isrc = normalizeIsrc(track?.isrc || track?.ISRC || track?.externalIds?.isrc);
  var result = {
    id: id,
    title: cleanString(track?.title || track?.name) || "Unknown Track",
    artist: artistName(track),
    album: albumName(track),
    albumCover: coverUrl(track),
    duration: Number(track?.duration) || 0,
    isrc: isrc || null,
    explicit: Boolean(track?.explicit),
    quality: quality,
    audioQuality: quality,
    qualityLabel: quality,
    bitDepth: Number(track?.bitDepth || track?.bit_depth || 0) || null,
    sampleRate: Number(track?.sampleRate || track?.sample_rate || 0) || null,
    source: "tidal",
    url: Array.isArray(track?.url) ? track.url[0] : (track?.url || null)
  };
  if (manualMatch) {
    result.manualMatchQuality = quality;
  }
  if (id) trackMap[id] = result;
  if (isrc) trackMap["isrc:" + isrc] = result;
  return result;
}

async function fetchJson(url, label) {
  var response = await fetch(url, {
    headers: { "Accept": "application/json" }
  });
  if (!response.ok) {
    throw new Error((label || "Request") + " failed with HTTP " + response.status);
  }
  return response.json();
}

async function searchTracks(query, limit, context) {
  query = cleanString(query);
  limit = Math.max(1, Math.min(Number(limit) || 15, 50));

  if (!query) return { tracks: [], total: 0 };

  var manualMatch = Boolean(context?.manualMatch || context?.isManualMatch || context?.purpose === "manual-match");
  var key = query.toLowerCase() + "|" + limit + "|" + (manualMatch ? "manual" : "normal");
  if (searchCache[key]) return searchCache[key];
  if (pendingSearches[key]) return pendingSearches[key];

  pendingSearches[key] = (async function() {
    try {
      var url = TIDAL_API + "/search/?s=" + encodeURIComponent(query);
      var body = await fetchJson(url, "TIDAL search");
      // Intentionally do not deduplicate search results. TIDAL can expose
      // distinct release IDs for stereo, Hi-Res, and Dolby Atmos; keep every
      // returned release in its original order so Manual Match can select them.
      var rawItems = extractItems(body).filter(function(track) {
        return track && typeof track === "object" &&
          (track.id || track.trackId || track.track_id);
      });
      var selectedItems = rawItems.slice(0, limit);
      var tracks;
      if (manualMatch) {
        // Manual Match is the only surface that receives quality metadata.
        // Probe each actual release so its label reflects trackManifests rather
        // than generic catalog tags. Dolby is a distinct release, so request its
        // format explicitly only for catalog entries marked as Dolby Atmos.
        tracks = await Promise.all(selectedItems.map(async function(track) {
          var normalized = normalizeTrack(track, true);
          try {
            var manifest = await fetchManualMatchManifest(track);
            var actual = deriveManifestQuality(manifest, track);
            normalized.quality = actual.quality;
            normalized.qualityLabel = actual.qualityLabel;
            normalized.manualMatchQuality = actual.quality;
            normalized.format = actual.actualFormat || null;
            normalized.bitDepth = actual.bitDepth;
            normalized.sampleRate = actual.sampleRate;
          } catch (_) {
            // Keep catalog evidence as a graceful fallback if manifest probing
            // is temporarily unavailable. Never block search on one failed probe.
          }
          return normalized;
        }));
      } else {
        // Normal search keeps catalog-derived quality labels from TIDAL metadata.
        // Manual Match additionally probes trackManifests for actual format details.
        tracks = selectedItems.map(function(track) { return normalizeTrack(track, false); });
      }
      var payload = {
        tracks: tracks,
        total: Number(body?.data?.totalNumberOfItems ?? body?.totalNumberOfItems) || tracks.length
      };
      return boundedSet(searchCache, key, payload, SEARCH_CACHE_MAX);
    } finally {
      delete pendingSearches[key];
    }
  })();

  return pendingSearches[key];
}

function readFirstNumber(objects, names) {
  for (var i = 0; i < objects.length; i++) {
    var object = objects[i];
    if (!object || typeof object !== "object") continue;
    for (var j = 0; j < names.length; j++) {
      var value = Number(object[names[j]]);
      if (Number.isFinite(value) && value > 0) {
        // TIDAL APIs may expose sample rate in Hz or kHz.
        if (/sample.?rate|sampling.?rate/i.test(names[j]) && value >= 1000) {
          value = value / 1000;
        }
        return value;
      }
    }
  }
  return null;
}

function getManifestData(body) {
  return body?.data?.data ||
    body?.data?.trackManifest ||
    body?.trackManifest ||
    body?.data ||
    body;
}

function normalizeFormat(value) {
  return cleanString(typeof value === "object" ? (value.id || value.name || value.format) : value)
    .toUpperCase().replace(/[\s-]+/g, "_");
}

function formatQuality(format, bitDepth, sampleRate) {
  if (/^EAC3?_JOC3?$/.test(format)) return { quality: "DOLBY ATMOS", label: "Dolby Atmos" };
  if (format === "FLAC_HIRES") {
    return { quality: "HI-RES", label: bitDepth && sampleRate ? bitDepth + "-bit / " + sampleRate + " kHz" : "Hi-Res FLAC" };
  }
  if (format === "FLAC") {
    return { quality: "CD", label: bitDepth && sampleRate ? bitDepth + "-bit / " + sampleRate + " kHz" : "FLAC (CD quality)" };
  }
  if (format === "AACLC") return { quality: "LOSSY", label: "320 kbps AAC" };
  if (format === "HEAACV1") return { quality: "LOSSY", label: "96 kbps AAC" };
  return { quality: "UNKNOWN", label: "Quality unavailable" };
}

function deriveManifestQuality(body, cachedTrack) {
  var data = getManifestData(body);
  var attributes = data?.attributes || body?.data?.data?.attributes || {};
  var formats = attributes?.formats || data?.formats || body?.formats || [];
  if (!Array.isArray(formats)) formats = formats ? [formats] : [];
  var upperFormats = formats.map(normalizeFormat).filter(Boolean);

  var candidates = [attributes, attributes?.audioInfo, attributes?.audio_info,
    data, data?.audioInfo, data?.audio_info, body?.data, body];
  var bitDepth = readFirstNumber(candidates, ["bitDepth", "bit_depth", "bitsPerSample", "bits_per_sample", "audioBitDepth"]);
  var sampleRate = readFirstNumber(candidates, ["sampleRate", "sample_rate", "samplingRate", "sampling_rate", "audioSampleRate"]);

  // The format reported by trackManifests is the playback evidence. Catalog
  // tags are used only if the response omitted format metadata entirely.
  var actualFormat = upperFormats[0] || "";
  var dolbyFormat = upperFormats.find(function(x) { return /^EAC3?_JOC3?$/.test(x); });
  if (dolbyFormat) actualFormat = dolbyFormat;
  else if (!actualFormat) actualFormat = "";
  var result = formatQuality(actualFormat, bitDepth, sampleRate);
  if (!actualFormat && cachedTrack) {
    var catalog = qualityEvidence(cachedTrack);
    if (catalog === "DOLBY ATMOS") result = { quality: catalog, label: "Dolby Atmos (catalog metadata)" };
    else if (catalog === "HI-RES") result = { quality: catalog, label: "Hi-Res FLAC (catalog metadata)" };
    else if (catalog === "CD") result = { quality: catalog, label: "FLAC (catalog metadata)" };
    else if (catalog === "LOSSY") result = { quality: catalog, label: "Lossy audio (catalog metadata)" };
  }
  return {
    quality: result.quality,
    qualityLabel: result.label,
    bitDepth: bitDepth,
    sampleRate: sampleRate,
    formats: upperFormats,
    actualFormat: actualFormat
  };
}

async function fetchManualMatchManifest(track) {
  var id = getTrackId(track);
  if (!id) throw new Error("TIDAL search result has no track ID.");
  var tags = tagList(track);
  var isDolby = tags.some(function(tag) {
    return /DOLBY.?ATMOS|EAC3?_JOC3?/.test(tag);
  });
  var url = TIDAL_API + "/trackManifests/?id=" + encodeURIComponent(id) +
    "&manifestType=HLS&usage=PLAYBACK&uriScheme=HTTPS" +
    (isDolby ? "&formats=EAC3_JOC" : "");
  return fetchJson(url, "TIDAL Manual Match quality probe");
}

function extractTrackItems(body) {
  return extractItems(body).filter(function(item) {
    return item && typeof item === "object" && (item.id || item.trackId || item.track_id);
  });
}

function normalizeMatchText(value) {
  return cleanString(value).toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function getTrackIsrc(track) {
  return normalizeIsrc(track?.isrc || track?.ISRC || track?.externalIds?.isrc);
}

function getTrackId(track) {
  return cleanString(track?.id || track?.trackId || track?.track_id);
}

function findBestTrackMatch(body, targetIsrc, targetTitle, targetArtist) {
  var items = extractTrackItems(body);
  var wantedIsrc = normalizeIsrc(targetIsrc);

  // ISRC is authoritative. Never fall through to the first search result
  // when the caller explicitly supplied an ISRC.
  if (wantedIsrc) {
    for (var i = 0; i < items.length; i++) {
      if (getTrackIsrc(items[i]) === wantedIsrc && getTrackId(items[i])) return items[i];
    }
  }

  if (targetTitle && targetArtist) {
    var wantedTitle = normalizeMatchText(targetTitle);
    var wantedArtist = normalizeMatchText(targetArtist);
    for (var j = 0; j < items.length; j++) {
      var title = normalizeMatchText(items[j]?.title || items[j]?.name);
      var artist = normalizeMatchText(artistName(items[j]));
      if (title === wantedTitle &&
          (artist === wantedArtist || artist.includes(wantedArtist) || wantedArtist.includes(artist)) &&
          getTrackId(items[j])) return items[j];
    }
  }

  if (!wantedIsrc && items.length) return items[0];
  return null;
}

async function resolveTidalTrackId(trackId, cachedTrack) {
  var raw = cleanString(trackId);
  // Numeric TIDAL IDs are already canonical. Only run ISRC search when
  // the caller actually supplied an ISRC rather than a numeric track ID.
  var isrc = normalizeIsrc(raw);
  if (!isrc) return raw;

  // Prefer an already-known exact ISRC match from the current search result.
  var known = trackMap["isrc:" + isrc];
  if (known && known.id) return known.id;

  var query = cachedTrack && cachedTrack.title && cachedTrack.artist
    ? cachedTrack.artist + " " + cachedTrack.title
    : isrc;
  var url = TIDAL_API + "/search/?s=" + encodeURIComponent(query);
  var body = await fetchJson(url, "TIDAL ISRC resolution");
  var match = findBestTrackMatch(body, isrc, cachedTrack?.title || "", cachedTrack?.artist || "");
  if (!match) throw new Error("No exact TIDAL match found for ISRC " + isrc);

  var normalized = normalizeTrack(match);
  if (getTrackIsrc(match) !== isrc) {
    throw new Error("TIDAL search did not return the requested ISRC " + isrc);
  }
  return normalized.id;
}

async function getTrackStreamUrl(trackId, preferredQuality, context) {
  var suppliedId = cleanString(trackId);
  if (!suppliedId) throw new Error("A TIDAL track ID or ISRC is required for playback.");

  var cachedTrack = trackMap[suppliedId] ||
    trackMap["isrc:" + normalizeIsrc(suppliedId)] ||
    context?.track || context?.currentTrack || null;

  // ISRC-aware resolution copied in spirit from the existing TIDAL/Qobuz
  // resolver: exact ISRC first, metadata matching only as a guarded fallback.
  var id = await resolveTidalTrackId(suppliedId, cachedTrack);

  // Do not pass formats=: hifi-api automatically chooses its highest
  // available quality. Dolby Atmos is a separate release and must be chosen
  // explicitly in Manual Match rather than being treated as a quality tier.
  var endpoint = TIDAL_API + "/trackManifests/?id=" +
    encodeURIComponent(id) + "&manifestType=HLS&usage=PLAYBACK&uriScheme=HTTPS";
  var body = await fetchJson(endpoint, "TIDAL track manifest");

  var data = getManifestData(body);
  var attributes = data?.attributes || body?.data?.data?.attributes || {};
  var uri = attributes?.uri || data?.uri || body?.uri;
  var streamUrl = Array.isArray(uri) ? uri[0] : uri;

  if (typeof streamUrl !== "string" || !/^https?:\/\//i.test(streamUrl)) {
    throw new Error("TIDAL did not return a playable HLS manifest URI.");
  }

  var resolvedTrack = trackMap[id] || cachedTrack;
  var hostTrack = context?.track || context?.currentTrack || context?.current || null;
  [resolvedTrack, hostTrack].forEach(function(track) {
    if (!track || typeof track !== "object") return;
    try { track.streamUrl = streamUrl; } catch (_) { /* immutable host object */ }
  });

  return { streamUrl: streamUrl };

}

return {
  id: "tidal-hifi",
  name: "TIDAL HiFi",
  author: "@blurrymilke, @._.alx.",
  authors: ["@blurrymilke", "@._.alx."],
  version: "1.3.7",
  description: "Hi-Res => FLAC, Dolby releases will have to be manually selected in Manual Match.",
  searchTracks: searchTracks,
  getTrackStreamUrl: getTrackStreamUrl
};
