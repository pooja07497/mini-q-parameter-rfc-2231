// Core RFC 2231 parameter encoding and decoding.
//
// RFC 2231 extends MIME parameters with two mechanisms:
//
//   1. Charset parameters: `name*=utf-8''%E2%82%AC`
//   2. Continuations:       `name*0*=utf-8''%E2%82%AC; name*1*=...`
//
// This module implements both.  The public API is intentionally small:
// `encodeParam` turns a value into a list of `name*=...` segments, and
// `decodeParam` reassembles a value from a set of parameters that may or may
// not use the extended syntax.

/**
 * Percent-encode a byte according to RFC 2231.
 *
 * RFC 2231 uses the same `attr-char` set as RFC 5987: ALPHA / DIGIT /
 * "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_" / "`" / "|" /
 * "~".  Everything else is percent-encoded.  We keep the implementation
 * explicit rather than relying on `encodeURIComponent` because the two
 * differ: `encodeURIComponent` leaves `'` and `*` unescaped, both of which
 * must be escaped here.
 */
function pctEncodeByte(byte) {
  if (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x21 || // !
    byte === 0x23 || // #
    byte === 0x24 || // $
    byte === 0x26 || // &
    byte === 0x2b || // +
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5e || // ^
    byte === 0x5f || // _
    byte === 0x60 || // `
    byte === 0x7c || // |
    byte === 0x7e // ~
  ) {
    return String.fromCharCode(byte);
  }
  return '%' + byte.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Percent-encode a UTF-8 string into an RFC 2231 `ext-value` body.
 *
 * The leading `charset'language'` prefix is NOT included here; callers add
 * that separately so that the same encoder can be reused for the plain
 * (non-charset) continuation form.
 */
function pctEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let out = '';
  for (const b of bytes) {
    out += pctEncodeByte(b);
  }
  return out;
}

/**
 * Decode an RFC 2231 `ext-value` body (the part after `charset'lang'`).
 *
 * Throws if the input contains a malformed percent escape.  We prefer to
 * throw rather than silently drop bytes because a corrupted parameter is
 * worse than a visible error during development.
 */
function pctDecode(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '%') {
      if (i + 2 >= str.length) {
        throw new Error(`truncated percent escape at index ${i}`);
      }
      const hex = str.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        throw new Error(`invalid percent escape "%${hex}" at index ${i}`);
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      // RFC 2231 only allows attr-char unescaped, but be liberal in what we
      // accept: any ASCII byte that is not `%` can pass through.  This
      // matches the behaviour of common mail libraries.
      const code = ch.charCodeAt(0);
      if (code > 0x7f) {
        // Non-ASCII in the encoded form is technically invalid, but we
        // handle it by UTF-8 encoding the character so that callers who
        // pass through a partially decoded string still get sane output.
        const encoded = new TextEncoder().encode(ch);
        for (const b of encoded) bytes.push(b);
      } else {
        bytes.push(code);
      }
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Encode a single parameter value as one or more RFC 2231 segments.
 *
 * Returns an array of `[name, value]` pairs.  For a value that fits in one
 * segment and needs no charset, the result is `[[name, value]]` using the
 * plain form.  For a value that needs a charset or is too long, the result
 * uses the `name*` or `name*N*` forms.
 *
 * The `maxSegmentLength` argument controls how long each encoded segment is
 * allowed to be.  RFC 2231 does not mandate a limit, but many real-world
 * parsers have line-length limits, so splitting at 60 characters is a safe
 * default.
 */
export function encodeParam(name, value, options = {}) {
  const charset = options.charset || 'utf-8';
  const language = options.language || '';
  const maxSegmentLength = options.maxSegmentLength || 60;

  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('name must be a non-empty string');
  }
  if (typeof value !== 'string') {
    throw new TypeError('value must be a string');
  }

  // Fast path: ASCII-only, no special characters, fits in one segment.
  // This is the common case and produces the cleanest header.
  const isAscii = /^[\x20-\x7e]*$/.test(value);
  const hasSpecial = /[^\x20-\x7e]/.test(value);
  if (isAscii && !hasSpecial && value.length <= maxSegmentLength) {
    return [[name, value]];
  }

  // Encode the value as UTF-8 percent-encoded bytes.
  const encoded = pctEncode(value);
  const prefix = `${charset}'${language}'`;
  const full = prefix + encoded;

  // If it fits in one segment, use the `name*=` form.
  if (full.length <= maxSegmentLength) {
    return [[`${name}*`, full]];
  }

  // Otherwise split into continuations.  The first segment carries the
  // charset prefix; subsequent segments carry only encoded data.  We use
  // `name*0*=`, `name*1*=`, etc.
  const segments = [];
  let rest = encoded;
  let index = 0;
  while (rest.length > 0) {
    const isFirst = index === 0;
    const segPrefix = isFirst ? prefix : '';
    // Reserve room for the prefix on the first segment.
    const available = maxSegmentLength - segPrefix.length;
    if (available <= 0) {
      throw new Error('maxSegmentLength too small for charset prefix');
    }
    let chunk;
    if (rest.length <= available) {
      chunk = rest;
      rest = '';
    } else {
      // Split at a percent-escape boundary so we never cut a `%XX` in half.
      let cut = available;
      // Walk back to a position that is not in the middle of a percent
      // escape.  A percent escape is `%` followed by two hex digits.
      while (cut > 0 && rest[cut - 1] === '%') {
        cut--;
      }
      // Also ensure we don't cut right after a `%` that starts an escape.
      // If the character at `cut` is a hex digit and the two before it form
      // `%XX`, we are fine; otherwise move back.
      while (cut > 0 && cut < rest.length) {
        const before = rest.slice(0, cut);
        const lastPct = before.lastIndexOf('%');
        if (lastPct !== -1 && cut - lastPct < 3) {
          cut = lastPct;
        } else {
          break;
        }
      }
      if (cut === 0) {
        throw new Error('maxSegmentLength too small to hold a single escape');
      }
      chunk = rest.slice(0, cut);
      rest = rest.slice(cut);
    }
    const segName = isFirst ? `${name}*0*` : `${name}*${index}*`;
    segments.push([segName, segPrefix + chunk]);
    index++;
  }
  return segments;
}

/**
 * Decode a parameter value from a map of parameter names to values.
 *
 * The map may contain plain `name`, extended `name*`, or continuation
 * `name*0*`, `name*1*` entries.  Returns the decoded string, or `undefined`
 * if no matching parameter is present.
 *
 * This function is deliberately tolerant: if a continuation is missing a
 * segment, it stops at the gap rather than throwing.  Real-world headers are
 * frequently truncated by gateways, and returning partial data is more
 * useful than an exception in that case.
 */
export function decodeParam(params, name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('name must be a non-empty string');
  }
  if (!(params instanceof Map)) {
    throw new TypeError('params must be a Map');
  }

  const plain = params.get(name);
  const extended = params.get(`${name}*`);

  // Plain form takes precedence if present and no extended form exists.
  if (plain !== undefined && extended === undefined) {
    // Check for continuations with the plain name.
    const cont = collectContinuations(params, name, false);
    if (cont !== undefined) return cont;
    return plain;
  }

  // Extended single-segment form.
  if (extended !== undefined) {
    return decodeExtValue(extended);
  }

  // Extended continuation form.
  const cont = collectContinuations(params, name, true);
  if (cont !== undefined) return cont;

  return undefined;
}

/**
 * Collect `name*0*`, `name*1*`, ... segments and decode them.
 *
 * If `extended` is true, the first segment is expected to carry the
 * `charset'language'` prefix.  If false, the segments are treated as plain
 * concatenated text (the non-extended continuation form).
 */
function collectContinuations(params, name, extended) {
  const segments = [];
  let index = 0;
  let anyExtended = false;
  while (true) {
    const extKey = `${name}*${index}*`;
    const plainKey = `${name}*${index}`;
    const extVal = params.get(extKey);
    const plainVal = params.get(plainKey);
    if (extVal === undefined && plainVal === undefined) break;
    if (extVal !== undefined) {
      anyExtended = true;
      segments.push(extVal);
    } else {
      segments.push(plainVal);
    }
    index++;
  }
  if (segments.length === 0) return undefined;

  if (!extended && !anyExtended) {
    return segments.join('');
  }

  // First segment must contain the charset'language' prefix.
  const first = segments[0];
  const firstQuote = first.indexOf("'");
  if (firstQuote === -1) {
    // No charset prefix; treat the whole thing as raw encoded data.
    return pctDecode(segments.join(''));
  }
  const secondQuote = first.indexOf("'", firstQuote + 1);
  if (secondQuote === -1) {
    return pctDecode(segments.join(''));
  }
  const encoded = first.slice(secondQuote + 1) + segments.slice(1).join('');
  return pctDecode(encoded);
}

/**
 * Decode a single `ext-value` string of the form `charset'language'data`.
 *
 * If the string does not contain two single quotes, it is treated as raw
 * percent-encoded data with no charset declaration.  This matches the
 * behaviour of several mail clients that omit the charset prefix.
 */
function decodeExtValue(value) {
  const firstQuote = value.indexOf("'");
  if (firstQuote === -1) {
    return pctDecode(value);
  }
  const secondQuote = value.indexOf("'", firstQuote + 1);
  if (secondQuote === -1) {
    return pctDecode(value);
  }
  const encoded = value.slice(secondQuote + 1);
  return pctDecode(encoded);
}
