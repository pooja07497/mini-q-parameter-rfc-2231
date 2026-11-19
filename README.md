# mini-q-parameter-rfc-2231

Encodes and decodes RFC 2231 continuation and charset parameters for MIME
header fields.

```js
import { encodeParam, decodeParam } from 'mini-q-parameter-rfc-2231';

// Encode a filename with a non-ASCII character.
const segments = encodeParam('filename', 'caf\u00e9.txt');
// => [['filename*', "utf-8''caf%C3%A9.txt"]]

// Decode it back from a Map of parameter names to values.
const params = new Map(segments);
const original = decodeParam(params, 'filename');
// => 'caf\u00e9.txt'
```

## Why this exists

MIME headers predate UTF-8.  RFC 2231 was written to let parameters carry
non-ASCII values and to split long values across multiple `name*N*`
segments.  Most email libraries handle the common cases but disagree on the
details: some emit `name*=` with a charset prefix, some emit `name*=utf-8''`
without a language tag, and some split continuations at arbitrary byte
boundaries.  This library picks one interpretation and sticks to it: values
are always encoded as UTF-8, the charset prefix is always
`charset'language'`, and continuations are split at percent-escape
boundaries so that no `%XX` sequence is ever cut in half.

The trade-off is that this library does not try to guess the charset of an
incoming value.  If a header uses `iso-8859-1`, you must tell the decoder
by passing the charset in the encoded string; the decoder trusts the
charset prefix and decodes the percent-encoded bytes as UTF-8 regardless.
This is a deliberate simplification: in practice nearly all modern mail
uses UTF-8, and guessing wrong is worse than requiring the sender to be
explicit.

## The awkward edge

RFC 2231 continuations are ordered by their numeric index, but the index is
part of the parameter name, not the value.  A header like:

```
filename*0*=utf-8''caf%C3%A9; filename*1*=.txt
```

must be reassembled in index order.  This library collects segments until a
missing index is found.  If a gateway drops `filename*1*` but leaves
`filename*2*`, the decoder stops at the gap and returns the partial value
rather than throwing.  That is a deliberate choice: partial data is more
useful than an exception when debugging a broken message.

## API

### `encodeParam(name, value, options?)`

Returns an array of `[name, value]` pairs.  The `options` object may contain
`charset` (default `'utf-8'`), `language` (default `''`), and
`maxSegmentLength` (default `60`).

### `decodeParam(params, name)`

Takes a `Map` of parameter names to values and a parameter name.  Returns the
decoded string, or `undefined` if the parameter is not present.  Throws if
`params` is not a `Map` or if a percent escape is malformed.
