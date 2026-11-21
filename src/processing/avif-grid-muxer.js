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
  const workers = Math.max(1, Math.min(6, Math.floor(Number(workerCount) || 1)));

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
  if (workers >= 6 && safeW * safeH >= 3_500_000 && safeW >= 1200 && safeH >= 1200) {
    if (safeW >= safeH) {
      cols = 3;
      rows = 2;
    } else {
      cols = 2;
      rows = 3;
    }
  } else if (workers >= 4 && safeW >= 768 && safeH >= 768) {
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

/**
 * Parse seq_profile and seq_level_idx_0 from the Sequence Header OBU (obu_type === 1)
 * inside a raw AV1 keyframe bitstream produced by WebCodecs VideoEncoder.
 */
export function parseAv1SequenceHeaderInfo(obuBytes) {
  const bytes =
    obuBytes instanceof Uint8Array
      ? obuBytes
      : obuBytes instanceof ArrayBuffer
      ? new Uint8Array(obuBytes)
      : ArrayBuffer.isView(obuBytes)
      ? new Uint8Array(obuBytes.buffer, obuBytes.byteOffset, obuBytes.byteLength)
      : null;
  if (!bytes || bytes.byteLength < 6) return null;

  let pos = 0;
  while (pos < bytes.byteLength) {
    const header = bytes[pos++];
    if (header & 0x80) return null; // obu_forbidden_bit must be 0
    const obuType = (header >> 3) & 0x0f;
    const hasExtension = (header & 0x04) !== 0;
    const hasSizeField = (header & 0x02) !== 0;
    if (hasExtension) {
      if (pos >= bytes.byteLength) return null;
      pos++;
    }
    let payloadSize = bytes.byteLength - pos;
    if (hasSizeField) {
      let val = 0;
      let shift = 0;
      while (pos < bytes.byteLength && shift < 35) {
        const b = bytes[pos++];
        val |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      payloadSize = val;
    }
    if (pos + payloadSize > bytes.byteLength) return null;

    if (obuType === 1 && payloadSize >= 4) {
      // Bit-level read of Sequence Header OBU:
      // seq_profile (3), still_picture (1), reduced_still_picture_header (1)
      const b0 = bytes[pos];
      const seqProfile = (b0 >> 5) & 0x07;
      const reducedHeader = (b0 >> 3) & 0x01;
      if (reducedHeader) {
        // Next 5 bits across b0[2..0] and b1[7..6]
        const seqLevelIdx0 = ((b0 & 0x07) << 2) | ((bytes[pos + 1] >> 6) & 0x03);
        return { seqProfile, seqLevelIdx0, seqTier0: 0 };
      }
      // Full sequence header: skip timing/decoder_model/initial_display flags when absent
      // Bits 5..7 of b0: timing_info_present_flag (bit 2), initial_display_delay_present_flag (bit 1),
      // operating_points_cnt_minus_1 (5 bits starting at bit 0 of b0 -> b1[7..4])
      const timingPresent = (b0 >> 2) & 0x01;
      if (!timingPresent) {
        // b0 bit 1 = initial_display_delay_present_flag, bit 0 + b1[7..4] = operating_points_cnt_minus_1
        // Followed by operating_point_idc[0] (12 bits) then seq_level_idx[0] (5 bits)
        // Bit offset from start of payload: 3+1+1+1+1+5+12 = 24 bits -> starts cleanly at bytes[pos + 3] MSB!
        const seqLevelIdx0 = (bytes[pos + 3] >> 3) & 0x1f;
        const seqTier0 = seqLevelIdx0 > 7 ? (bytes[pos + 3] >> 2) & 0x01 : 0;
        return { seqProfile, seqLevelIdx0, seqTier0 };
      }
      return { seqProfile, seqLevelIdx0: null, seqTier0: 0 };
    }
    pos += payloadSize;
  }
  return null;
}

/**
 * Wrap a single raw AV1 keyframe OBU (e.g., from WebCodecs VideoEncoder) into a strictly
 * spec-compliant ISO/IEC 23008-12 & AVIF v1.1.0 image container.
 */
export function muxAv1ObuToAvif({
  obuBytes,
  width,
  height,
  profile = 1,
  levelIdx = 8,
  chromaSubsampling = '444',
  colorSpace = null,
}) {
  const obu =
    obuBytes instanceof Uint8Array
      ? obuBytes
      : obuBytes instanceof ArrayBuffer
      ? new Uint8Array(obuBytes)
      : ArrayBuffer.isView(obuBytes)
      ? new Uint8Array(obuBytes.buffer, obuBytes.byteOffset, obuBytes.byteLength)
      : null;
  if (!obu || obu.byteLength < 8 || width < 2 || height < 2) return null;

  const parsedSeq = parseAv1SequenceHeaderInfo(obu);
  const seqProfile = parsedSeq?.seqProfile ?? profile;
  const seqLevelIdx = parsedSeq?.seqLevelIdx0 ?? levelIdx;
  const seqTier = parsedSeq?.seqTier0 ?? 0;
  const is444 = seqProfile === 1 || chromaSubsampling === '444';

  const strBytes = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const makeFullBox = (type, version, flags, parts) => {
    const hdr = new Uint8Array(4);
    hdr[0] = version & 0xff;
    hdr[1] = (flags >> 16) & 0xff;
    hdr[2] = (flags >> 8) & 0xff;
    hdr[3] = flags & 0xff;
    return makeBox(type, [hdr, ...parts]);
  };

  // ftyp box
  const ftyp = makeBox('ftyp', [
    strBytes('avif'),
    new Uint8Array(4),
    strBytes('avif'),
    strBytes('mif1'),
    strBytes('miaf'),
    strBytes(is444 ? 'MA1H' : 'MA1B'),
  ]);

  // hdlr box (pict)
  const hdlrPayload = new Uint8Array(21);
  hdlrPayload.set(strBytes('pict'), 4);
  const hdlr = makeFullBox('hdlr', 0, 0, [hdlrPayload]);

  // pitm box (primary item = 1)
  const pitmPayload = new Uint8Array(2);
  writeU16BE(pitmPayload, 0, 1);
  const pitm = makeFullBox('pitm', 0, 0, [pitmPayload]);

  // iinf box with 1 infe ('av01')
  const infePayload = new Uint8Array(9);
  writeU16BE(infePayload, 0, 1);
  writeU16BE(infePayload, 2, 0);
  infePayload.set(strBytes('av01'), 4);
  infePayload[8] = 0;
  const infe = makeFullBox('infe', 2, 0, [infePayload]);
  const iinfCount = new Uint8Array(2);
  writeU16BE(iinfCount, 0, 1);
  const iinf = makeFullBox('iinf', 0, 0, [iinfCount, infe]);

  // ipco properties: 1=ispe, 2=pixi, 3=av1C (essential), 4=colr
  const ispePayload = new Uint8Array(8);
  writeU32BE(ispePayload, 0, Math.round(width));
  writeU32BE(ispePayload, 4, Math.round(height));
  const ispe = makeFullBox('ispe', 0, 0, [ispePayload]);

  const pixi = makeFullBox('pixi', 0, 0, [new Uint8Array([3, 8, 8, 8])]);

  // av1C (4-byte AV1CodecConfigurationRecord)
  const av1cFlags = ((seqTier & 1) << 7) | (is444 ? 0x00 : 0x0c);
  const av1C = makeBox('av1C', [
    new Uint8Array([0x81, ((seqProfile & 0x07) << 5) | (seqLevelIdx & 0x1f), av1cFlags, 0x00]),
  ]);

  // colr (nclx): preserve encoder color space (BT.709 primaries, sRGB transfer, matching matrix & range)
  const primMap = { bt709: 1, bt470bg: 5, smpte170m: 6 };
  const xferMap = { bt709: 1, smpte170m: 6, linear: 8, 'iec61966-2-1': 13 };
  const matMap = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6 };
  const primaries = primMap[colorSpace?.primaries] ?? 1;
  const transfer = xferMap[colorSpace?.transfer] ?? 13;
  const matrix = matMap[colorSpace?.matrix] ?? 1;
  const fullRangeByte = colorSpace?.fullRange === false ? 0x00 : 0x80;
  const colrPayload = new Uint8Array(11);
  colrPayload.set(strBytes('nclx'), 0);
  writeU16BE(colrPayload, 4, primaries);
  writeU16BE(colrPayload, 6, transfer);
  writeU16BE(colrPayload, 8, matrix);
  colrPayload[10] = fullRangeByte;
  const colr = makeBox('colr', [colrPayload]);

  const ipco = makeBox('ipco', [ispe, pixi, av1C, colr]);

  // ipma: 1 item (id=1) referencing properties 1, 2, 3 (essential), 4
  const ipmaPayload = new Uint8Array(11);
  writeU32BE(ipmaPayload, 0, 1);
  writeU16BE(ipmaPayload, 4, 1);
  ipmaPayload[6] = 4;
  ipmaPayload[7] = 0x01;
  ipmaPayload[8] = 0x02;
  ipmaPayload[9] = 0x83; // essential av1C
  ipmaPayload[10] = 0x04;
  const ipma = makeFullBox('ipma', 0, 0, [ipmaPayload]);
  const iprp = makeBox('iprp', [ipco, ipma]);

  // iloc: 1 item, offset_size=4, length_size=4
  const buildIloc = (dataOffset) => {
    const buf = new Uint8Array(18);
    buf[0] = 0x44;
    buf[1] = 0x00;
    writeU16BE(buf, 2, 1);
    writeU16BE(buf, 4, 1);
    writeU16BE(buf, 6, 0);
    writeU16BE(buf, 8, 1);
    writeU32BE(buf, 10, dataOffset);
    writeU32BE(buf, 14, obu.byteLength);
    return makeFullBox('iloc', 0, 0, [buf]);
  };

  const ilocSize = 8 + 4 + 18;
  const metaSize = 8 + 4 + hdlr.byteLength + pitm.byteLength + ilocSize + iinf.byteLength + iprp.byteLength;
  const mdatPayloadStart = ftyp.byteLength + metaSize + 8;

  const iloc = buildIloc(mdatPayloadStart);
  const meta = makeFullBox('meta', 0, 0, [hdlr, pitm, iloc, iinf, iprp]);
  const mdat = makeBox('mdat', [obu]);

  return concatUint8Arrays([ftyp, meta, mdat]);
}
