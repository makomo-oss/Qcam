/**
 * Pure ISO/IEC 23008-12 & AVIF v1.1.0 Baseline Profile Grid (`grid`) tile planner,
 * edge-clamped RGBA tile extractor, and zero-dependency ISOBMFF Grid AVIF muxer.
 *
 * Enables multi-Worker parallel AVIF encoding without SharedArrayBuffer / COOP / COEP,
 * preserving identical per-tile quantization, chroma subsampling, SharpYUV, and color metadata.
 */

function writeU16BE(dst, offset, value) {
  dst[offset] = (value >>> 8) & 0xff;
  dst[offset + 1] = value & 0xff;
}

function writeU32BE(dst, offset, value) {
  dst[offset] = (value >>> 24) & 0xff;
  dst[offset + 1] = (value >>> 16) & 0xff;
  dst[offset + 2] = (value >>> 8) & 0xff;
  dst[offset + 3] = value & 0xff;
}

function readU16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32BE(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readType4(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

function bytesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function makeBox(type, payloadParts) {
  const parts = Array.isArray(payloadParts) ? payloadParts : [payloadParts];
  let payloadSize = 0;
  for (const p of parts) {
    payloadSize += p.byteLength;
  }
  const totalSize = 8 + payloadSize;
  const out = new Uint8Array(totalSize);
  writeU32BE(out, 0, totalSize);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  let cursor = 8;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.byteLength;
  }
  return out;
}

function concatUint8Arrays(parts) {
  let total = 0;
  for (const p of parts) {
    total += p.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/**
 * Plan AVIF Grid tiling aligned to AV1 64x64 superblock boundaries so parallel workers
 * encode independent tiles with zero boundary quality loss and strict AVIF spec compliance.
 */
export function planAvifGrid(width, height, workerCount = 1) {
  const safeW = Math.round(Number(width) || 0);
  const safeH = Math.round(Number(height) || 0);
  const workers = Math.max(1, Math.min(4, Math.floor(Number(workerCount) || 1)));

  // Small images finish quickly on a single worker; avoid tiling overhead.
  if (
    workers < 2 ||
    safeW < 512 ||
    safeH < 512 ||
    safeW * safeH < 360_000 ||
    safeW > 65535 ||
    safeH > 65535
  ) {
    return { cols: 1, rows: 1, tileWidth: safeW, tileHeight: safeH };
  }

  let cols = 1;
  let rows = 1;
  if (workers >= 4 && safeW >= 768 && safeH >= 768) {
    cols = 2;
    rows = 2;
  } else if (safeW >= safeH) {
    cols = 2;
    rows = 1;
  } else {
    cols = 1;
    rows = 2;
  }

  const alignUp = (val, align) => Math.ceil(val / align) * align;
  let tileWidth = cols > 1 ? alignUp(Math.ceil(safeW / cols), 64) : safeW;
  let tileHeight = rows > 1 ? alignUp(Math.ceil(safeH / rows), 64) : safeH;

  if (cols > 1 && tileWidth * (cols - 1) >= safeW) {
    tileWidth = alignUp(Math.ceil(safeW / cols), 16);
  }
  if (rows > 1 && tileHeight * (rows - 1) >= safeH) {
    tileHeight = alignUp(Math.ceil(safeH / rows), 16);
  }

  // Enforce ISO/IEC 23008-12 & AVIF 4:2:0 constraints:
  // - every tile >= 64px in each dimension
  // - even dimensions for YUV 4:2:0 chroma alignment
  // - tileDim * (count - 1) < outputDim <= tileDim * count
  const validCols =
    cols === 1
      ? (tileWidth & 1) === 0
      : tileWidth >= 64 &&
        (tileWidth & 1) === 0 &&
        tileWidth * (cols - 1) < safeW &&
        tileWidth * cols >= safeW;
  const validRows =
    rows === 1
      ? (tileHeight & 1) === 0
      : tileHeight >= 64 &&
        (tileHeight & 1) === 0 &&
        tileHeight * (rows - 1) < safeH &&
        tileHeight * rows >= safeH;

  if (!validCols || !validRows) {
    return { cols: 1, rows: 1, tileWidth: safeW, tileHeight: safeH };
  }

  return { cols, rows, tileWidth, tileHeight };
}

/**
 * Extract row-major RGBA8 tile buffers with edge-clamped padding on right/bottom overhang
 * so AV1 4:2:0 chroma & transform blocks never introduce border ringing.
 */
export function extractAvifGridTiles(rgbaPixels, width, height, grid) {
  const { cols, rows, tileWidth, tileHeight } = grid;
  const srcStride = width * 4;
  const tileStride = tileWidth * 4;
  const tiles = [];

  for (let r = 0; r < rows; r++) {
    const sy0 = r * tileHeight;
    for (let c = 0; c < cols; c++) {
      const sx0 = c * tileWidth;
      const copyW = Math.min(tileWidth, width - sx0);
      const copyBytes = copyW * 4;
      const tileBuf = new Uint8Array(tileStride * tileHeight);

      for (let ty = 0; ty < tileHeight; ty++) {
        const sy = sy0 + ty < height ? sy0 + ty : height - 1;
        const srcOff = sy * srcStride + sx0 * 4;
        const dstOff = ty * tileStride;
        tileBuf.set(rgbaPixels.subarray(srcOff, srcOff + copyBytes), dstOff);

        if (copyW < tileWidth) {
          const lastOff = dstOff + copyBytes - 4;
          const lr = tileBuf[lastOff];
          const lg = tileBuf[lastOff + 1];
          const lb = tileBuf[lastOff + 2];
          const la = tileBuf[lastOff + 3];
          for (let tx = copyW; tx < tileWidth; tx++) {
            const p = dstOff + tx * 4;
            tileBuf[p] = lr;
            tileBuf[p + 1] = lg;
            tileBuf[p + 2] = lb;
            tileBuf[p + 3] = la;
          }
        }
      }

      tiles.push({
        index: tiles.length,
        col: c,
        row: r,
        width: tileWidth,
        height: tileHeight,
        rgba: tileBuf,
      });
    }
  }

  return tiles;
}

/**
 * Parse a single-image AVIF emitted by libavif to extract its raw AV1 OBU payload
 * and exact codec/color property boxes (`ftyp`, `pixi`, `av1C`, `colr`).
 */
export function parseSingleTileAvif(input) {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : null;

  if (!bytes || bytes.byteLength < 32) return null;

  let ftyp = null;
  let pixi = null;
  let av1C = null;
  let colr = null;
  let primaryItemId = 1;
  let hasAlpha = false;
  const itemLocations = new Map();

  let pos = 0;
  while (pos + 8 <= bytes.byteLength) {
    let size = readU32BE(bytes, pos);
    const type = readType4(bytes, pos + 4);
    if (size === 0) size = bytes.byteLength - pos;
    if (size < 8 || pos + size > bytes.byteLength) return null;
    const end = pos + size;

    if (type === 'ftyp') {
      ftyp = bytes.slice(pos, end);
    } else if (type === 'meta') {
      let mp = pos + 12; // FullBox header (8 + 4)
      while (mp + 8 <= end) {
        const ms = readU32BE(bytes, mp);
        const mt = readType4(bytes, mp + 4);
        if (ms < 8 || mp + ms > end) return null;
        const me = mp + ms;

        if (mt === 'pitm' && ms >= 14) {
          const ver = bytes[mp + 8];
          primaryItemId = ver === 0 ? readU16BE(bytes, mp + 12) : readU32BE(bytes, mp + 12);
        } else if (mt === 'iloc' && ms >= 16) {
          const ver = bytes[mp + 8];
          const offSize = bytes[mp + 12] >> 4;
          const lenSize = bytes[mp + 12] & 0x0f;
          const baseOffSize = bytes[mp + 13] >> 4;
          const idxSize = ver === 1 || ver === 2 ? bytes[mp + 13] & 0x0f : 0;
          let p = mp + 14;
          const itemCount = ver < 2 ? readU16BE(bytes, p) : readU32BE(bytes, p);
          p += ver < 2 ? 2 : 4;

          const readSized = (sz) => {
            if (sz === 0) return 0;
            if (sz === 4) {
              const v = readU32BE(bytes, p);
              p += 4;
              return v;
            }
            let acc = 0;
            for (let k = 0; k < sz; k++) {
              acc = acc * 256 + bytes[p++];
            }
            return acc;
          };

          for (let i = 0; i < itemCount && p < me; i++) {
            const itemId = ver < 2 ? readU16BE(bytes, p) : readU32BE(bytes, p);
            p += ver < 2 ? 2 : 4;
            let constructionMethod = 0;
            if (ver === 1 || ver === 2) {
              constructionMethod = readU16BE(bytes, p) & 0x0f;
              p += 2;
            }
            p += 2; // data_reference_index
            const baseOff = readSized(baseOffSize);
            const extCount = readU16BE(bytes, p);
            p += 2;
            const extents = [];
            for (let e = 0; e < extCount; e++) {
              if (idxSize > 0) readSized(idxSize);
              const extOff = readSized(offSize);
              const extLen = readSized(lenSize);
              extents.push({ offset: baseOff + extOff, length: extLen });
            }
            if (constructionMethod === 0 && extents.length > 0) {
              itemLocations.set(itemId, extents);
            }
          }
        } else if (mt === 'iprp') {
          let rp = mp + 8;
          while (rp + 8 <= me) {
            const rs = readU32BE(bytes, rp);
            const rt = readType4(bytes, rp + 4);
            if (rs < 8 || rp + rs > me) return null;
            const re = rp + rs;
            if (rt === 'ipco') {
              let cp = rp + 8;
              while (cp + 8 <= re) {
                const cs = readU32BE(bytes, cp);
                const ct = readType4(bytes, cp + 4);
                if (cs < 8 || cp + cs > re) return null;
                const ce = cp + cs;
                if (ct === 'pixi' && !pixi) pixi = bytes.slice(cp, ce);
                else if (ct === 'av1C' && !av1C) av1C = bytes.slice(cp, ce);
                else if (ct === 'colr' && !colr) colr = bytes.slice(cp, ce);
                else if (ct === 'auxC') hasAlpha = true;
                cp = ce;
              }
            }
            rp = re;
          }
        }
        mp = me;
      }
    }

    pos = end;
  }

  const primaryExtents = itemLocations.get(primaryItemId);
  if (!ftyp || !av1C || !primaryExtents || primaryExtents.length === 0) {
    return null;
  }

  const obuChunks = [];
  for (const ext of primaryExtents) {
    if (ext.offset < 0 || ext.length <= 0 || ext.offset + ext.length > bytes.byteLength) {
      return null;
    }
    obuChunks.push(bytes.subarray(ext.offset, ext.offset + ext.length));
  }
  const obu = obuChunks.length === 1 ? new Uint8Array(obuChunks[0]) : concatUint8Arrays(obuChunks);

  return { ftyp, pixi, av1C, colr, obu, hasAlpha };
}

/**
 * Mux N encoded single-tile AVIF images into a single standards-compliant AVIF Grid container.
 * Returns null if any tile cannot be parsed cleanly or has an auxiliary alpha plane, allowing
 * callers to fall back safely to single-frame encoding.
 */
export function muxAvifGrid({
  outputWidth,
  outputHeight,
  tileWidth,
  tileHeight,
  cols,
  rows,
  tileAvifs,
}) {
  const expectedTiles = cols * rows;
  if (
    !Array.isArray(tileAvifs) ||
    tileAvifs.length !== expectedTiles ||
    expectedTiles < 2 ||
    outputWidth > 65535 ||
    outputHeight > 65535
  ) {
    return null;
  }

  const parsed = [];
  for (let i = 0; i < tileAvifs.length; i++) {
    const info = parseSingleTileAvif(tileAvifs[i]);
    if (!info || info.hasAlpha || !info.obu || info.obu.byteLength === 0) {
      return null;
    }
    parsed.push(info);
  }

  const first = parsed[0];
  const ftyp = first.ftyp;
  const tileCount = parsed.length;
  const itemCount = 1 + tileCount;

  // ISO/IEC 23008-12 ImageGrid payload (version=0, flags=0 -> 16-bit output_width/height)
  const gridPayload = new Uint8Array(8);
  gridPayload[0] = 0; // version
  gridPayload[1] = 0; // flags (0 = 16-bit dimensions)
  gridPayload[2] = rows - 1;
  gridPayload[3] = cols - 1;
  writeU16BE(gridPayload, 4, outputWidth);
  writeU16BE(gridPayload, 6, outputHeight);

  // hdlr box ('pict')
  const hdlrPayload = new Uint8Array(32);
  // pre_defined(4)=0, handler_type='pict'
  hdlrPayload[8] = 0x70; // 'p'
  hdlrPayload[9] = 0x69; // 'i'
  hdlrPayload[10] = 0x63; // 'c'
  hdlrPayload[11] = 0x74; // 't'
  // name = "libavif\0"
  const handlerName = 'libavif';
  for (let i = 0; i < handlerName.length; i++) {
    hdlrPayload[24 + i] = handlerName.charCodeAt(i);
  }
  const hdlr = makeBox('hdlr', hdlrPayload);

  // pitm box: primary item_ID = 1 (the derived 'grid' item)
  const pitmPayload = new Uint8Array(6);
  writeU16BE(pitmPayload, 4, 1);
  const pitm = makeBox('pitm', pitmPayload);

  // iinf box: item 1 = 'grid' (visible), items 2..N+1 = 'av01' (hidden, flags=1)
  const infeBoxes = [];
  {
    const p = new Uint8Array(18);
    p[0] = 2; // version 2
    writeU16BE(p, 4, 1); // item_ID = 1
    p[8] = 0x67; // 'g'
    p[9] = 0x72; // 'r'
    p[10] = 0x69; // 'i'
    p[11] = 0x64; // 'd'
    // item_name = "Color\0"
    p[12] = 0x43;
    p[13] = 0x6f;
    p[14] = 0x6c;
    p[15] = 0x6f;
    p[16] = 0x72;
    p[17] = 0x00;
    infeBoxes.push(makeBox('infe', p));
  }
  for (let i = 0; i < tileCount; i++) {
    const p = new Uint8Array(13);
    p[0] = 2; // version 2
    p[3] = 1; // flags = 1 (item_hidden)
    writeU16BE(p, 4, 2 + i);
    p[8] = 0x61; // 'a'
    p[9] = 0x76; // 'v'
    p[10] = 0x30; // '0'
    p[11] = 0x31; // '1'
    p[12] = 0x00; // empty item_name
    infeBoxes.push(makeBox('infe', p));
  }
  const iinfHeader = new Uint8Array(6);
  writeU16BE(iinfHeader, 4, itemCount);
  const iinf = makeBox('iinf', [iinfHeader, ...infeBoxes]);

  // iref box: dimg reference from grid (item 1) -> tile items [2..N+1] in row-major order
  const dimgPayload = new Uint8Array(4 + tileCount * 2);
  writeU16BE(dimgPayload, 0, 1); // from_item_ID = 1
  writeU16BE(dimgPayload, 2, tileCount);
  for (let i = 0; i < tileCount; i++) {
    writeU16BE(dimgPayload, 4 + i * 2, 2 + i);
  }
  const dimg = makeBox('dimg', dimgPayload);
  const iref = makeBox('iref', [new Uint8Array(4), dimg]);

  // ipco box:
  //   1: ispe (outputWidth x outputHeight)
  //   2: ispe (tileWidth x tileHeight)
  //   optional pixi, deduplicated av1C boxes, optional colr
  const ispeOutPayload = new Uint8Array(12);
  writeU32BE(ispeOutPayload, 4, outputWidth);
  writeU32BE(ispeOutPayload, 8, outputHeight);
  const ispeOut = makeBox('ispe', ispeOutPayload);

  const ispeTilePayload = new Uint8Array(12);
  writeU32BE(ispeTilePayload, 4, tileWidth);
  writeU32BE(ispeTilePayload, 8, tileHeight);
  const ispeTile = makeBox('ispe', ispeTilePayload);

  const ipcoProps = [ispeOut, ispeTile];
  let pixiIdx = 0;
  if (first.pixi) {
    ipcoProps.push(first.pixi);
    pixiIdx = ipcoProps.length;
  }

  const av1CEntries = [];
  const tileAv1CIndices = new Array(tileCount);
  for (let i = 0; i < tileCount; i++) {
    const candidate = parsed[i].av1C;
    let foundIdx = 0;
    for (let k = 0; k < av1CEntries.length; k++) {
      if (bytesEqual(av1CEntries[k].bytes, candidate)) {
        foundIdx = av1CEntries[k].propIndex;
        break;
      }
    }
    if (!foundIdx) {
      ipcoProps.push(candidate);
      foundIdx = ipcoProps.length;
      av1CEntries.push({ bytes: candidate, propIndex: foundIdx });
    }
    tileAv1CIndices[i] = foundIdx;
  }

  let colrIdx = 0;
  if (first.colr) {
    ipcoProps.push(first.colr);
    colrIdx = ipcoProps.length;
  }

  // ipma assumes 7-bit property indices (< 128), which is always true for <= 4 tiles
  if (ipcoProps.length >= 127) return null;
  const ipco = makeBox('ipco', ipcoProps);

  // ipma box
  const ipmaParts = [];
  const ipmaHeader = new Uint8Array(8);
  writeU32BE(ipmaHeader, 4, itemCount);
  ipmaParts.push(ipmaHeader);

  const gridPropIndices = [1];
  if (pixiIdx) gridPropIndices.push(pixiIdx);
  if (colrIdx) gridPropIndices.push(colrIdx);
  {
    const entry = new Uint8Array(3 + gridPropIndices.length);
    writeU16BE(entry, 0, 1);
    entry[2] = gridPropIndices.length;
    for (let i = 0; i < gridPropIndices.length; i++) {
      entry[3 + i] = gridPropIndices[i];
    }
    ipmaParts.push(entry);
  }

  for (let i = 0; i < tileCount; i++) {
    const props = [2];
    if (pixiIdx) props.push(pixiIdx);
    props.push(0x80 | tileAv1CIndices[i]); // av1C is essential (MSB = 1)
    if (colrIdx) props.push(colrIdx);
    const entry = new Uint8Array(3 + props.length);
    writeU16BE(entry, 0, 2 + i);
    entry[2] = props.length;
    for (let k = 0; k < props.length; k++) {
      entry[3 + k] = props[k];
    }
    ipmaParts.push(entry);
  }

  const ipma = makeBox('ipma', ipmaParts);
  const iprp = makeBox('iprp', [ipco, ipma]);

  // iloc box (version=0, offset_size=4, length_size=4, base_offset_size=0)
  // Header: 8 bytes + 14 bytes per item
  const buildIloc = (mdatPayloadStart) => {
    const buf = new Uint8Array(8 + itemCount * 14);
    buf[4] = 0x44; // offset_size=4, length_size=4
    buf[5] = 0x00; // base_offset_size=0
    writeU16BE(buf, 6, itemCount);

    let p = 8;
    let dataCursor = mdatPayloadStart;
    // Item 1: grid payload
    writeU16BE(buf, p, 1);
    writeU16BE(buf, p + 2, 0);
    writeU16BE(buf, p + 4, 1);
    writeU32BE(buf, p + 6, dataCursor);
    writeU32BE(buf, p + 10, gridPayload.byteLength);
    p += 14;
    dataCursor += gridPayload.byteLength;

    // Items 2..N+1: tile AV1 OBUs
    for (let i = 0; i < tileCount; i++) {
      const len = parsed[i].obu.byteLength;
      writeU16BE(buf, p, 2 + i);
      writeU16BE(buf, p + 2, 0);
      writeU16BE(buf, p + 4, 1);
      writeU32BE(buf, p + 6, dataCursor);
      writeU32BE(buf, p + 10, len);
      p += 14;
      dataCursor += len;
    }
    return makeBox('iloc', buf);
  };

  const metaFixedSize =
    8 + // meta box header
    4 + // meta FullBox version+flags
    hdlr.byteLength +
    pitm.byteLength +
    (8 + 8 + itemCount * 14) + // iloc exact byte length
    iinf.byteLength +
    iref.byteLength +
    iprp.byteLength;
  const mdatPayloadStart = ftyp.byteLength + metaFixedSize + 8;

  const iloc = buildIloc(mdatPayloadStart);
  const meta = makeBox('meta', [new Uint8Array(4), hdlr, pitm, iloc, iinf, iref, iprp]);
  const mdat = makeBox('mdat', [gridPayload, ...parsed.map((p) => p.obu)]);

  return concatUint8Arrays([ftyp, meta, mdat]);
}
