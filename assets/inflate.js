/*
 * Raw DEFLATE decoder (RFC 1951), used only as a fallback for browsers
 * without DecompressionStream. Canonical-Huffman decoding follows the
 * approach of zlib's `puff` reference implementation.
 */
(function (global) {
  'use strict';

  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function buildHuffman(lengths) {
    var counts = new Int32Array(16);
    var i;
    for (i = 0; i < lengths.length; i++) counts[lengths[i]]++;
    counts[0] = 0;

    var offsets = new Int32Array(16);
    for (i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];

    var symbols = new Int32Array(lengths.length);
    for (i = 0; i < lengths.length; i++) {
      if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
    }
    return { counts: counts, symbols: symbols };
  }

  var FIXED_LIT = null;
  var FIXED_DIST = null;

  function fixedTables() {
    if (!FIXED_LIT) {
      var lit = new Uint8Array(288);
      var i;
      for (i = 0; i < 144; i++) lit[i] = 8;
      for (; i < 256; i++) lit[i] = 9;
      for (; i < 280; i++) lit[i] = 7;
      for (; i < 288; i++) lit[i] = 8;
      FIXED_LIT = buildHuffman(lit);

      var dist = new Uint8Array(30);
      for (i = 0; i < 30; i++) dist[i] = 5;
      FIXED_DIST = buildHuffman(dist);
    }
    return [FIXED_LIT, FIXED_DIST];
  }

  function inflateRaw(source) {
    var src = source;
    var pos = 0;      // byte position
    var bitBuf = 0;   // bit accumulator
    var bitCnt = 0;   // bits held in the accumulator

    var out = new Uint8Array(Math.max(1024, src.length * 4));
    var len = 0;

    function grow(extra) {
      if (len + extra <= out.length) return;
      var size = out.length;
      while (size < len + extra) size *= 2;
      var next = new Uint8Array(size);
      next.set(out.subarray(0, len));
      out = next;
    }

    function bits(need) {
      while (bitCnt < need) {
        if (pos >= src.length) throw new Error('unexpected end of deflate stream');
        bitBuf |= src[pos++] << bitCnt;
        bitCnt += 8;
      }
      var value = bitBuf & ((1 << need) - 1);
      bitBuf >>>= need;
      bitCnt -= need;
      return value;
    }

    function decode(table) {
      var code = 0, first = 0, index = 0;
      for (var length = 1; length <= 15; length++) {
        code |= bits(1);
        var count = table.counts[length];
        if (code - first < count) return table.symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
      }
      throw new Error('invalid huffman code');
    }

    function codeLengths(litCount, distCount, clenTable) {
      var lengths = new Uint8Array(litCount + distCount);
      var i = 0;
      while (i < lengths.length) {
        var symbol = decode(clenTable);
        if (symbol < 16) {
          lengths[i++] = symbol;
        } else {
          var value = 0, repeat;
          if (symbol === 16) {
            if (i === 0) throw new Error('no previous code length to repeat');
            value = lengths[i - 1];
            repeat = 3 + bits(2);
          } else if (symbol === 17) {
            repeat = 3 + bits(3);
          } else {
            repeat = 11 + bits(7);
          }
          if (i + repeat > lengths.length) throw new Error('too many code lengths');
          while (repeat--) lengths[i++] = value;
        }
      }
      return lengths;
    }

    for (;;) {
      var last = bits(1);
      var type = bits(2);

      if (type === 0) {
        // stored block
        bitBuf = 0;
        bitCnt = 0;
        if (pos + 4 > src.length) throw new Error('unexpected end of stored block');
        var storedLen = src[pos] | (src[pos + 1] << 8);
        var check = src[pos + 2] | (src[pos + 3] << 8);
        pos += 4;
        if ((storedLen ^ 0xffff) !== check) throw new Error('corrupt stored block');
        if (pos + storedLen > src.length) throw new Error('unexpected end of stored data');
        grow(storedLen);
        out.set(src.subarray(pos, pos + storedLen), len);
        len += storedLen;
        pos += storedLen;
      } else if (type === 1 || type === 2) {
        var litTable, distTable;
        if (type === 1) {
          var fixed = fixedTables();
          litTable = fixed[0];
          distTable = fixed[1];
        } else {
          var litCount = bits(5) + 257;
          var distCount = bits(5) + 1;
          var clenCount = bits(4) + 4;
          var clens = new Uint8Array(19);
          for (var c = 0; c < clenCount; c++) clens[CLEN_ORDER[c]] = bits(3);
          var clenTable = buildHuffman(clens);
          var all = codeLengths(litCount, distCount, clenTable);
          litTable = buildHuffman(all.subarray(0, litCount));
          distTable = buildHuffman(all.subarray(litCount));
        }

        for (;;) {
          var sym = decode(litTable);
          if (sym < 256) {
            grow(1);
            out[len++] = sym;
          } else if (sym === 256) {
            break;
          } else {
            sym -= 257;
            if (sym >= LEN_BASE.length) throw new Error('invalid length code');
            var copyLen = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
            var dsym = decode(distTable);
            if (dsym >= DIST_BASE.length) throw new Error('invalid distance code');
            var dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
            if (dist > len) throw new Error('distance too far back');
            grow(copyLen);
            var from = len - dist;
            for (var k = 0; k < copyLen; k++) out[len + k] = out[from + k];
            len += copyLen;
          }
        }
      } else {
        throw new Error('invalid block type');
      }

      if (last) break;
    }

    return out.slice(0, len);
  }

  global.inflateRaw = inflateRaw;
})(typeof globalThis !== 'undefined' ? globalThis : this);
