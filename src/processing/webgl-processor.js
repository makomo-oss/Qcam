import {
  VERTEX_SHADER_SOURCE,
  PASSTHROUGH_VERTEX_SHADER,
  MERGE_FRAGMENT_SHADER,
  ALIGN_SAMPLE_FRAGMENT_SHADER,
  LUM_DOWNSAMPLE_FRAGMENT_SHADER,
  LUM_BILATERAL_FRAGMENT_SHADER,
  DENOISE_FRAGMENT_SHADER,
  TONEMAP_FRAGMENT_SHADER,
  OUTPUT_CAS_FRAGMENT_SHADER,
  buildShaderSource,
} from './glsl-shaders.js';

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function createProgram(gl, vertSrc, fragSrc, { bindTexCoord = false } = {}) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program');
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.bindAttribLocation(program, 0, 'aPosition');
  if (bindTexCoord) {
    gl.bindAttribLocation(program, 1, 'aTexCoord');
  }
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  return { program, uniforms: new Map() };
}

function getUniformLoc(gl, progObj, name) {
  if (progObj.uniforms.has(name)) {
    return progObj.uniforms.get(name);
  }
  const loc = gl.getUniformLocation(progObj.program, name);
  progObj.uniforms.set(name, loc);
  return loc;
}

/**
 * 5-Pass Pro Computational Photography WebGL ISP Processor.
 * Works on both HTMLCanvasElement and Worker OffscreenCanvas with automatic
 * WebGL2 native RGBA16F linear float FBOs or sqrt-packed RGBA8 HDR fallback.
 */
export class WebGLImageProcessor {
  constructor(canvas, { forcePackedHdr = false } = {}) {
    this.canvas = canvas;
    const opts = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    };
    this.gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
    if (!this.gl) {
      throw new Error('WebGL context unavailable');
    }

    const gl = this.gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    this.hdrConfig = this._initHdrSupport({ forcePackedHdr });
    this.usingPackedHdr = this.hdrConfig.packedHdr;
    const packed = this.hdrConfig.packedHdr;

    this.mergeProgram = createProgram(
      gl,
      VERTEX_SHADER_SOURCE,
      buildShaderSource(MERGE_FRAGMENT_SHADER, { packedHdr: packed }),
      { bindTexCoord: true }
    );
    this.alignSampleProgram = createProgram(
      gl,
      PASSTHROUGH_VERTEX_SHADER,
      ALIGN_SAMPLE_FRAGMENT_SHADER
    );
    this.lumDownProgram = createProgram(
      gl,
      PASSTHROUGH_VERTEX_SHADER,
      buildShaderSource(LUM_DOWNSAMPLE_FRAGMENT_SHADER, { packedHdr: packed })
    );
    this.lumBilateralProgram = createProgram(
      gl,
      PASSTHROUGH_VERTEX_SHADER,
      buildShaderSource(LUM_BILATERAL_FRAGMENT_SHADER, { packedHdr: packed })
    );
    this.denoiseProgram = createProgram(
      gl,
      PASSTHROUGH_VERTEX_SHADER,
      buildShaderSource(DENOISE_FRAGMENT_SHADER, { packedHdr: packed })
    );
    this.tonemapProgram = createProgram(
      gl,
      PASSTHROUGH_VERTEX_SHADER,
      buildShaderSource(TONEMAP_FRAGMENT_SHADER, { packedHdr: packed })
    );
    this.outputCasProgram = createProgram(
      gl,
      PASSTHROUGH_VERTEX_SHADER,
      buildShaderSource(OUTPUT_CAS_FRAGMENT_SHADER, { packedHdr: packed })
    );

    // Full-screen quad: (x, y, u, v)
    // With UNPACK_FLIP_Y_WEBGL = false, image row 0 (top) is uploaded at v = 0.
    // Pass 1 renders to FBOs where NDC y=+1 corresponds to top of image (FBO v=1).
    // Passes 2..5 use PASSTHROUGH_VERTEX_SHADER (aPosition * 0.5 + 0.5) preserving top-up orientation.
    const quadData = new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);

    this._fboPool = null;
    this._lastOutputFlippedY = false;
  }

  _initHdrSupport({ forcePackedHdr = false } = {}) {
    const gl = this.gl;
    const isWebGL2 =
      typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

    if (!forcePackedHdr && isWebGL2) {
      const hasHalf = Boolean(gl.getExtension('EXT_color_buffer_half_float'));
      const hasFloat = Boolean(gl.getExtension('EXT_color_buffer_float'));
      if (hasHalf || hasFloat) {
        const testTex = gl.createTexture();
        const testFbo = gl.createFramebuffer();
        try {
          gl.bindTexture(gl.TEXTURE_2D, testTex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, testFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, testTex, 0);
          const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
          if (status === gl.FRAMEBUFFER_COMPLETE) {
            return {
              packedHdr: false,
              internalFormat: gl.RGBA16F,
              format: gl.RGBA,
              type: gl.HALF_FLOAT,
            };
          }
        } catch {
          // Fall back cleanly to packed RGBA8 HDR
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.deleteFramebuffer(testFbo);
          gl.deleteTexture(testTex);
        }
      }
    }

    return {
      packedHdr: true,
      internalFormat: gl.RGBA,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    };
  }

  _uploadTexture(unitIndex, source) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unitIndex);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return tex;
  }

  _createRenderTarget(width, height, { internalFormat, format, type }) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { fbo, tex, width, height };
  }

  _unbindTextureUnits(count = 4) {
    const gl = this.gl;
    for (let i = 0; i < count; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  _bindQuad({ useTexCoord = false } = {}) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    if (useTexCoord) {
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    } else {
      gl.disableVertexAttribArray(1);
    }
  }

  /**
   * Explicitly destroy intermediate FBOs & textures to minimize peak mobile VRAM
   * right before WASM AVIF allocation.
   */
  releaseWorkingBuffers() {
    const gl = this.gl;
    if (!gl || !this._fboPool) return;
    for (const target of this._fboPool) {
      if (target) {
        try {
          if (target.fbo) gl.deleteFramebuffer(target.fbo);
          if (target.tex) gl.deleteTexture(target.tex);
        } catch {
          // ignore
        }
      }
    }
    this._fboPool = null;
  }

  /**
   * Pre-warm backend GPU pipeline states (Metal/Vulkan/ANGLE JIT) on a tiny 4x4 texture
   * during idle camera startup so the very first photo incurs zero shader-compile stall.
   */
  warmup() {
    if (this._warmedUp) return;
    this._warmedUp = true;
    const gl = this.gl;
    if (!gl) return;
    let tex = null;
    try {
      tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const px = new Uint8Array(4 * 4 * 4).fill(128);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const t = { tex, width: 4, height: 4 };
      // Pass a 4-frame dry run with active denoise so all 6 main ISP programs compile backend pipelines
      this.processHQ([t], {
        outWidth: 4,
        outHeight: 4,
        cropNorm: { x: 0, y: 0, w: 1, h: 1 },
        developProfile: { noiseSigma: 0.02, denoiseStrength: 0.5 },
        flipOutputY: false,
        preUploadedTextures: [t],
      });
      // processHQ took ownership of and deleted `tex`
      tex = null;
      this.canvas.width = 1;
      this.canvas.height = 1;
    } catch {
      if (tex) {
        try {
          gl.deleteTexture(tex);
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Upload burst frames once as GPU textures and provide zero-stall GPU downsampling (<=560px)
   * and derotated native patch extraction (84x84), then hand over selected textures directly
   * to processHQ() with zero redundant uploads.
   */
  createFrameTextureSession(frames) {
    const gl = this.gl;
    const rgbaSpec = {
      internalFormat: gl.RGBA,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
    };
    const entries = frames.map((frame) => ({
      tex: this._uploadTexture(0, frame),
      width: frame.width || 1,
      height: frame.height || 1,
    }));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    let medTarget = null;
    let patchTarget = null;
    let patchPixels = null;
    let disposed = false;

    const releaseScratchTargets = () => {
      if (medTarget) {
        try {
          if (medTarget.fbo) gl.deleteFramebuffer(medTarget.fbo);
          if (medTarget.tex) gl.deleteTexture(medTarget.tex);
        } catch {
          // ignore
        }
        medTarget = null;
      }
      if (patchTarget) {
        try {
          if (patchTarget.fbo) gl.deleteFramebuffer(patchTarget.fbo);
          if (patchTarget.tex) gl.deleteTexture(patchTarget.tex);
        } catch {
          // ignore
        }
        patchTarget = null;
      }
      patchPixels = null;
    };

    const downsampleRgba = (frameIdx, dstW, dstH) => {
      const entry = entries[frameIdx];
      if (!entry || !entry.tex) return null;
      if (!medTarget || medTarget.width !== dstW || medTarget.height !== dstH) {
        if (medTarget) {
          gl.deleteFramebuffer(medTarget.fbo);
          gl.deleteTexture(medTarget.tex);
        }
        medTarget = this._createRenderTarget(dstW, dstH, rgbaSpec);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, medTarget.fbo);
      gl.viewport(0, 0, dstW, dstH);
      gl.useProgram(this.alignSampleProgram.program);
      this._bindQuad({ useTexCoord: false });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.uniform1i(getUniformLoc(gl, this.alignSampleProgram, 'uSrcTex'), 0);
      gl.uniform1f(getUniformLoc(gl, this.alignSampleProgram, 'uFullFrame'), 1.0);
      gl.uniform2f(getUniformLoc(gl, this.alignSampleProgram, 'uSrcSize'), entry.width, entry.height);
      gl.uniform2f(getUniformLoc(gl, this.alignSampleProgram, 'uDstSize'), dstW, dstH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      const pixels = new Uint8Array(dstW * dstH * 4);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.readPixels(0, 0, dstW, dstH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return pixels;
    };

    const extractPatchRgba = (frameIdx, centerX, centerY, patchSize, angleRad = 0, srcScale = 1) => {
      const entry = entries[frameIdx];
      if (!entry || !entry.tex) return null;
      if (!patchTarget || patchTarget.width !== patchSize || patchTarget.height !== patchSize) {
        if (patchTarget) {
          gl.deleteFramebuffer(patchTarget.fbo);
          gl.deleteTexture(patchTarget.tex);
        }
        patchTarget = this._createRenderTarget(patchSize, patchSize, rgbaSpec);
        patchPixels = new Uint8Array(patchSize * patchSize * 4);
      }
      const s = srcScale || 1;
      const cosA = angleRad ? Math.cos(angleRad) : 1;
      const sinA = angleRad ? Math.sin(angleRad) : 0;

      gl.bindFramebuffer(gl.FRAMEBUFFER, patchTarget.fbo);
      gl.viewport(0, 0, patchSize, patchSize);
      gl.useProgram(this.alignSampleProgram.program);
      this._bindQuad({ useTexCoord: false });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.uniform1i(getUniformLoc(gl, this.alignSampleProgram, 'uSrcTex'), 0);
      gl.uniform1f(getUniformLoc(gl, this.alignSampleProgram, 'uFullFrame'), 0.0);
      gl.uniform2f(
        getUniformLoc(gl, this.alignSampleProgram, 'uCenterNorm'),
        centerX / entry.width,
        centerY / entry.height
      );
      gl.uniform2f(
        getUniformLoc(gl, this.alignSampleProgram, 'uSrcSize'),
        entry.width,
        entry.height
      );
      gl.uniform2f(
        getUniformLoc(gl, this.alignSampleProgram, 'uDstSize'),
        patchSize,
        patchSize
      );
      gl.uniform4f(
        getUniformLoc(gl, this.alignSampleProgram, 'uAffineMat'),
        s * cosA,
        -s * sinA,
        s * sinA,
        s * cosA
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.readPixels(0, 0, patchSize, patchSize, gl.RGBA, gl.UNSIGNED_BYTE, patchPixels);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return patchPixels;
    };

    /**
     * Render all uploaded frames stacked vertically into a single strip FBO and read back once.
     * Each returned Uint8Array is a contiguous top-down RGBA view of frame i.
     */
    const downsampleAllRgba = (dstW, dstH) => {
      const count = entries.length;
      if (count === 0) return [];
      const stripH = dstH * count;
      if (stripH > this.maxTextureSize) {
        return entries.map((_, idx) => downsampleRgba(idx, dstW, dstH));
      }
      if (!medTarget || medTarget.width !== dstW || medTarget.height !== stripH) {
        if (medTarget) {
          gl.deleteFramebuffer(medTarget.fbo);
          gl.deleteTexture(medTarget.tex);
        }
        medTarget = this._createRenderTarget(dstW, stripH, rgbaSpec);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, medTarget.fbo);
      gl.useProgram(this.alignSampleProgram.program);
      this._bindQuad({ useTexCoord: false });
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(getUniformLoc(gl, this.alignSampleProgram, 'uSrcTex'), 0);
      gl.uniform1f(getUniformLoc(gl, this.alignSampleProgram, 'uFullFrame'), 1.0);
      gl.uniform2f(getUniformLoc(gl, this.alignSampleProgram, 'uDstSize'), dstW, dstH);

      const uSrcSizeLoc = getUniformLoc(gl, this.alignSampleProgram, 'uSrcSize');
      for (let i = 0; i < count; i++) {
        const entry = entries[i];
        if (!entry || !entry.tex) continue;
        gl.viewport(0, i * dstH, dstW, dstH);
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        gl.uniform2f(uSrcSizeLoc, entry.width, entry.height);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      const frameBytes = dstW * dstH * 4;
      const stripPixels = new Uint8Array(frameBytes * count);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.readPixels(0, 0, dstW, stripH, gl.RGBA, gl.UNSIGNED_BYTE, stripPixels);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const views = new Array(count);
      for (let i = 0; i < count; i++) {
        views[i] = stripPixels.subarray(i * frameBytes, (i + 1) * frameBytes);
      }
      return views;
    };

    /**
     * Render multiple derotated native patches into a single vertical strip FBO and read back once.
     */
    const extractPatchesBatch = (requests, patchSize) => {
      const count = requests?.length || 0;
      if (count === 0) return [];
      const stripH = patchSize * count;
      if (stripH > this.maxTextureSize) {
        return requests.map((r) =>
          extractPatchRgba(r.frameIdx, r.centerX, r.centerY, patchSize, r.angleRad || 0, r.srcScale || 1)
        );
      }
      if (!patchTarget || patchTarget.width !== patchSize || patchTarget.height !== stripH) {
        if (patchTarget) {
          gl.deleteFramebuffer(patchTarget.fbo);
          gl.deleteTexture(patchTarget.tex);
        }
        patchTarget = this._createRenderTarget(patchSize, stripH, rgbaSpec);
        patchPixels = new Uint8Array(patchSize * stripH * 4);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, patchTarget.fbo);
      gl.useProgram(this.alignSampleProgram.program);
      this._bindQuad({ useTexCoord: false });
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(getUniformLoc(gl, this.alignSampleProgram, 'uSrcTex'), 0);
      gl.uniform1f(getUniformLoc(gl, this.alignSampleProgram, 'uFullFrame'), 0.0);
      gl.uniform2f(getUniformLoc(gl, this.alignSampleProgram, 'uDstSize'), patchSize, patchSize);

      const uCenterLoc = getUniformLoc(gl, this.alignSampleProgram, 'uCenterNorm');
      const uSrcSizeLoc = getUniformLoc(gl, this.alignSampleProgram, 'uSrcSize');
      const uAffineLoc = getUniformLoc(gl, this.alignSampleProgram, 'uAffineMat');

      for (let i = 0; i < count; i++) {
        const req = requests[i];
        const entry = entries[req.frameIdx];
        if (!entry || !entry.tex) continue;
        const s = req.srcScale || 1;
        const cosA = req.angleRad ? Math.cos(req.angleRad) : 1;
        const sinA = req.angleRad ? Math.sin(req.angleRad) : 0;

        gl.viewport(0, i * patchSize, patchSize, patchSize);
        gl.bindTexture(gl.TEXTURE_2D, entry.tex);
        gl.uniform2f(uCenterLoc, req.centerX / entry.width, req.centerY / entry.height);
        gl.uniform2f(uSrcSizeLoc, entry.width, entry.height);
        gl.uniform4f(uAffineLoc, s * cosA, -s * sinA, s * sinA, s * cosA);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.readPixels(0, 0, patchSize, stripH, gl.RGBA, gl.UNSIGNED_BYTE, patchPixels);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const patchBytes = patchSize * patchSize * 4;
      const views = new Array(count);
      for (let i = 0; i < count; i++) {
        views[i] = patchPixels.subarray(i * patchBytes, (i + 1) * patchBytes);
      }
      return views;
    };

    const takeSelectedTextures = (selectedIndices) => {
      releaseScratchTargets();
      const keepSet = new Set(selectedIndices);
      for (let i = 0; i < entries.length; i++) {
        if (!keepSet.has(i) && entries[i]?.tex) {
          try {
            gl.deleteTexture(entries[i].tex);
          } catch {
            // ignore
          }
          entries[i].tex = null;
        }
      }
      const out = [];
      for (const idx of selectedIndices) {
        if (entries[idx]?.tex) {
          out.push(entries[idx]);
          entries[idx] = { tex: null, width: 0, height: 0 };
        }
      }
      return out;
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      releaseScratchTargets();
      for (const e of entries) {
        if (e?.tex) {
          try {
            gl.deleteTexture(e.tex);
          } catch {
            // ignore
          }
          e.tex = null;
        }
      }
    };

    return {
      downsampleRgba,
      downsampleAllRgba,
      extractPatchRgba,
      extractPatchesBatch,
      takeSelectedTextures,
      dispose,
    };
  }

  processStandard(source, options = {}) {
    return this.processHQ([source], {
      ...options,
      frameAlignments: null,
      preMergedCoverage: -1.0,
    });
  }

  processHQ(
    frames,
    {
      outWidth,
      outHeight,
      cropNorm,
      mirrorX = false,
      exposureEv = 0,
      frameAlignments = null,
      developProfile = null,
      patchTol2,
      sharpen,
      preMergedCoverage = -1.0,
      flipOutputY = false,
      preUploadedTextures = null,
    }
  ) {
    const gl = this.gl;
    this.canvas.width = outWidth;
    this.canvas.height = outHeight;
    this._lastOutputFlippedY = Boolean(flipOutputY);

    const usePreUploaded = Array.isArray(preUploadedTextures) && preUploadedTextures.length > 0;
    const limitedFrames = usePreUploaded ? preUploadedTextures.slice(0, 4) : frames.slice(0, 4);
    const srcW = limitedFrames[0].width || outWidth;
    const srcH = limitedFrames[0].height || outHeight;
    const sourceTextures = [];
    const createdTargets = [];

    const prof = developProfile || {};
    const wbGains = Array.isArray(prof.wbGains) && prof.wbGains.length === 3 ? prof.wbGains : [1, 1, 1];
    const noiseSigma = Number.isFinite(prof.noiseSigma) ? prof.noiseSigma : 0.01;
    const sceneMidLogL = Number.isFinite(prof.sceneMidLogL) ? prof.sceneMidLogL : -2.4;
    const autoExposureEv = Number.isFinite(prof.autoExposureEv) ? prof.autoExposureEv : 0;
    const localHdrStrength = Number.isFinite(prof.localHdrStrength) ? prof.localHdrStrength : 0.34;
    const shadowLift = Number.isFinite(prof.shadowLift) ? prof.shadowLift : 0.42;
    const highlightRoll = Number.isFinite(prof.highlightRoll) ? prof.highlightRoll : 0.58;
    const clarity = Number.isFinite(prof.clarity) ? prof.clarity : 0.12;
    const denoiseStrength = Number.isFinite(prof.denoiseStrength) ? prof.denoiseStrength : 0.28;
    const effectiveSharpen = Number.isFinite(sharpen)
      ? sharpen
      : Number.isFinite(prof.sharpen)
      ? prof.sharpen
      : 0.6;
    const effectivePatchTol2 = Number.isFinite(patchTol2)
      ? patchTol2
      : Number.isFinite(prof.patchTol2)
      ? prof.patchTol2
      : 0.0016;
    const vibrance = Number.isFinite(prof.vibrance) ? prof.vibrance : 0.14;
    const saturation = Number.isFinite(prof.saturation) ? prof.saturation : 1.02;
    const contrast = Number.isFinite(prof.contrast) ? prof.contrast : 1.04;
    const filmFade = Number.isFinite(prof.filmFade) ? prof.filmFade : 0.0;
    const warmth = Number.isFinite(prof.warmth) ? prof.warmth : 0.0;

    try {
      this.releaseWorkingBuffers();

      const hdrSpec = this.hdrConfig;
      const rtA = this._createRenderTarget(outWidth, outHeight, hdrSpec);
      createdTargets.push(rtA);

      // Upload source frame textures (or take ownership of pre-uploaded GPU textures) and delete right after Pass 1
      if (usePreUploaded) {
        for (let i = 0; i < limitedFrames.length; i++) {
          sourceTextures.push(limitedFrames[i].tex);
        }
      } else {
        for (let i = 0; i < limitedFrames.length; i++) {
          sourceTextures.push(this._uploadTexture(i, limitedFrames[i]));
        }
      }

      // Pass 1: Merge + Bicubic + linear-light ghost rejection -> rtA
      gl.bindFramebuffer(gl.FRAMEBUFFER, rtA.fbo);
      gl.viewport(0, 0, outWidth, outHeight);
      gl.useProgram(this.mergeProgram.program);
      this._bindQuad({ useTexCoord: true });

      for (let i = 0; i < 4; i++) {
        const unit = Math.min(i, sourceTextures.length - 1);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, sourceTextures[unit]);
        gl.uniform1i(getUniformLoc(gl, this.mergeProgram, `uFrame${i}`), unit);
      }

      const alignDefaults = {
        uvMatrix: { mat: [1, 0, 0, 1], shift: [0, 0] },
        weight: 1.0,
        lumaGain: 1.0,
      };
      const entryFor = (idx) => {
        if (idx >= limitedFrames.length) {
          return { uvMatrix: { mat: [1, 0, 0, 1], shift: [0, 0] }, weight: 0.0, lumaGain: 1.0 };
        }
        return (Array.isArray(frameAlignments) && frameAlignments[idx]) || alignDefaults;
      };
      const e1 = entryFor(1);
      const e2 = entryFor(2);
      const e3 = entryFor(3);

      const toGainLin = (g) => {
        const v = Number.isFinite(g) ? g : 1.0;
        return Math.abs(v - 1.0) > 0.005 ? Math.pow(Math.max(v, 0.05), 2.2) : 1.0;
      };
      const g1Lin = toGainLin(e1.lumaGain);
      const g2Lin = toGainLin(e2.lumaGain);
      const g3Lin = toGainLin(e3.lumaGain);

      const resampledW = Math.abs(cropNorm.w * srcW - outWidth) > 2;
      const resampledH = Math.abs(cropNorm.h * srcH - outHeight) > 2;
      const resampled = resampledW || resampledH;
      const needsBicubicFor = (entry) => {
        if (resampled) return 1.0;
        const a = entry.a ?? 1;
        const b = entry.b ?? 0;
        const tx = entry.tx ?? 0;
        const ty = entry.ty ?? 0;
        if (
          Math.abs(a - 1) < 1e-4 &&
          Math.abs(b) < 1e-4 &&
          Math.abs(tx - Math.round(tx)) < 0.02 &&
          Math.abs(ty - Math.round(ty)) < 0.02
        ) {
          return 0.0;
        }
        return 1.0;
      };

      gl.uniform4fv(getUniformLoc(gl, this.mergeProgram, 'uAlignMat1'), e1.uvMatrix?.mat || [1, 0, 0, 1]);
      gl.uniform2fv(getUniformLoc(gl, this.mergeProgram, 'uAlignShift1'), e1.uvMatrix?.shift || [0, 0]);
      gl.uniform4fv(getUniformLoc(gl, this.mergeProgram, 'uAlignMat2'), e2.uvMatrix?.mat || [1, 0, 0, 1]);
      gl.uniform2fv(getUniformLoc(gl, this.mergeProgram, 'uAlignShift2'), e2.uvMatrix?.shift || [0, 0]);
      gl.uniform4fv(getUniformLoc(gl, this.mergeProgram, 'uAlignMat3'), e3.uvMatrix?.mat || [1, 0, 0, 1]);
      gl.uniform2fv(getUniformLoc(gl, this.mergeProgram, 'uAlignShift3'), e3.uvMatrix?.shift || [0, 0]);
      gl.uniform3f(
        getUniformLoc(gl, this.mergeProgram, 'uFrameWeights'),
        e1.weight ?? 1.0,
        e2.weight ?? 1.0,
        e3.weight ?? 1.0
      );
      gl.uniform3f(
        getUniformLoc(gl, this.mergeProgram, 'uFrameGainsLin'),
        g1Lin,
        g2Lin,
        g3Lin
      );
      gl.uniform3f(
        getUniformLoc(gl, this.mergeProgram, 'uFrameSqrtGains'),
        Math.sqrt(g1Lin),
        Math.sqrt(g2Lin),
        Math.sqrt(g3Lin)
      );
      gl.uniform3f(
        getUniformLoc(gl, this.mergeProgram, 'uUseBicubicFrames'),
        needsBicubicFor(e1),
        needsBicubicFor(e2),
        needsBicubicFor(e3)
      );
      gl.uniform1f(getUniformLoc(gl, this.mergeProgram, 'uPatchTol2'), effectivePatchTol2);
      gl.uniform1f(getUniformLoc(gl, this.mergeProgram, 'uNoiseSigma'), noiseSigma);
      gl.uniform1f(
        getUniformLoc(gl, this.mergeProgram, 'uPreMergedCoverage'),
        preMergedCoverage >= 0 ? preMergedCoverage : -1.0
      );
      gl.uniform1f(getUniformLoc(gl, this.mergeProgram, 'uFrameCount'), limitedFrames.length);
      gl.uniform2f(getUniformLoc(gl, this.mergeProgram, 'uTexelSize'), 1 / srcW, 1 / srcH);
      gl.uniform2f(getUniformLoc(gl, this.mergeProgram, 'uSrcSize'), srcW, srcH);
      gl.uniform4f(
        getUniformLoc(gl, this.mergeProgram, 'uCropRect'),
        cropNorm.x,
        cropNorm.y,
        cropNorm.w,
        cropNorm.h
      );
      gl.uniform1f(getUniformLoc(gl, this.mergeProgram, 'uMirrorX'), mirrorX ? 1.0 : 0.0);
      gl.uniform1f(
        getUniformLoc(gl, this.mergeProgram, 'uUseBicubic0'),
        resampled ? 1.0 : 0.0
      );

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this._unbindTextureUnits(4);

      // Immediately release source textures before creating Pass 2/3 buffers
      for (const tex of sourceTextures) {
        gl.deleteTexture(tex);
      }
      sourceTextures.length = 0;

      // Pass 2a: Stratified log2 luminance downsample -> rtLum1 (<=160px long edge)
      const lumScale = Math.min(1, 160 / Math.max(outWidth, outHeight));
      const lumW = Math.max(8, Math.round(outWidth * lumScale));
      const lumH = Math.max(8, Math.round(outHeight * lumScale));
      const rtLum1 = this._createRenderTarget(lumW, lumH, hdrSpec);
      const rtLum2 = this._createRenderTarget(lumW, lumH, hdrSpec);
      createdTargets.push(rtLum1, rtLum2);

      gl.bindFramebuffer(gl.FRAMEBUFFER, rtLum1.fbo);
      gl.viewport(0, 0, lumW, lumH);
      gl.useProgram(this.lumDownProgram.program);
      this._bindQuad({ useTexCoord: false });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rtA.tex);
      gl.uniform1i(getUniformLoc(gl, this.lumDownProgram, 'uHdrTex'), 0);
      gl.uniform2f(getUniformLoc(gl, this.lumDownProgram, 'uLumTexelSize'), 1 / lumW, 1 / lumH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this._unbindTextureUnits(2);

      // Pass 2b (H): Separable bilateral log-luminance smoothing -> rtLum2
      gl.bindFramebuffer(gl.FRAMEBUFFER, rtLum2.fbo);
      gl.viewport(0, 0, lumW, lumH);
      gl.useProgram(this.lumBilateralProgram.program);
      this._bindQuad({ useTexCoord: false });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rtLum1.tex);
      gl.uniform1i(getUniformLoc(gl, this.lumBilateralProgram, 'uLumTex'), 0);
      gl.uniform2f(getUniformLoc(gl, this.lumBilateralProgram, 'uDirection'), 1 / lumW, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this._unbindTextureUnits(2);

      // Pass 2b (V): -> rtLum1
      gl.bindFramebuffer(gl.FRAMEBUFFER, rtLum1.fbo);
      gl.viewport(0, 0, lumW, lumH);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rtLum2.tex);
      gl.uniform1i(getUniformLoc(gl, this.lumBilateralProgram, 'uLumTex'), 0);
      gl.uniform2f(getUniformLoc(gl, this.lumBilateralProgram, 'uDirection'), 0, 1 / lumH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this._unbindTextureUnits(2);

      const runDenoisePass = noiseSigma * denoiseStrength > 0.0018;
      const rtB = this._createRenderTarget(outWidth, outHeight, hdrSpec);
      createdTargets.push(rtB);

      let hdrInputForTonemap = rtA;
      let tonemapTarget = rtB;
      let srgbForCas = rtB;

      if (runDenoisePass) {
        // Pass 3: Adaptive Joint Bilateral Denoise -> rtB
        gl.bindFramebuffer(gl.FRAMEBUFFER, rtB.fbo);
        gl.viewport(0, 0, outWidth, outHeight);
        gl.useProgram(this.denoiseProgram.program);
        this._bindQuad({ useTexCoord: false });
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, rtA.tex);
        gl.uniform1i(getUniformLoc(gl, this.denoiseProgram, 'uHdrTex'), 0);
        gl.uniform2f(getUniformLoc(gl, this.denoiseProgram, 'uTexelSize'), 1 / outWidth, 1 / outHeight);
        gl.uniform1f(getUniformLoc(gl, this.denoiseProgram, 'uNoiseSigma'), noiseSigma);
        gl.uniform1f(getUniformLoc(gl, this.denoiseProgram, 'uDenoiseStrength'), denoiseStrength);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this._unbindTextureUnits(2);
        hdrInputForTonemap = rtB;
        tonemapTarget = rtA;
        srgbForCas = rtA;
      }

      // Pass 4: WB + Auto Exposure + Local HDR/Clarity + AgX Highlight Shoulder + Look -> tonemapTarget (sRGB)
      gl.bindFramebuffer(gl.FRAMEBUFFER, tonemapTarget.fbo);
      gl.viewport(0, 0, outWidth, outHeight);
      gl.useProgram(this.tonemapProgram.program);
      this._bindQuad({ useTexCoord: false });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hdrInputForTonemap.tex);
      gl.uniform1i(getUniformLoc(gl, this.tonemapProgram, 'uHdrTex'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, rtLum1.tex);
      gl.uniform1i(getUniformLoc(gl, this.tonemapProgram, 'uLumTex'), 1);

      const exposureScale = Math.abs(exposureEv) > 0.001 ? Math.pow(2, exposureEv) : 1.0;
      gl.uniform3f(getUniformLoc(gl, this.tonemapProgram, 'uWbGains'), wbGains[0], wbGains[1], wbGains[2]);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uExposureScale'), exposureScale);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uAutoExposureEv'), autoExposureEv);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uSceneMidLogL'), sceneMidLogL);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uLocalHdrStrength'), localHdrStrength);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uShadowLift'), shadowLift);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uHighlightRoll'), highlightRoll);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uClarity'), clarity);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uVibrance'), vibrance);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uSaturation'), saturation);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uContrast'), contrast);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uFilmFade'), filmFade);
      gl.uniform1f(getUniformLoc(gl, this.tonemapProgram, 'uWarmth'), warmth);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this._unbindTextureUnits(2);

      // Release consumed input FBO and luminance pyramid prior to Pass 5
      gl.deleteFramebuffer(hdrInputForTonemap.fbo);
      gl.deleteTexture(hdrInputForTonemap.tex);
      hdrInputForTonemap.fbo = null;
      hdrInputForTonemap.tex = null;
      gl.deleteFramebuffer(rtLum1.fbo);
      gl.deleteTexture(rtLum1.tex);
      rtLum1.fbo = null;
      rtLum1.tex = null;
      gl.deleteFramebuffer(rtLum2.fbo);
      gl.deleteTexture(rtLum2.tex);
      rtLum2.fbo = null;
      rtLum2.tex = null;

      // Pass 5: 8-neighbor AMD FidelityFX-style CAS Sharpen + TPDF dither -> Default Canvas Framebuffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, outWidth, outHeight);
      gl.useProgram(this.outputCasProgram.program);
      this._bindQuad({ useTexCoord: false });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srgbForCas.tex);
      gl.uniform1i(getUniformLoc(gl, this.outputCasProgram, 'uSrgbTex'), 0);
      gl.uniform2f(getUniformLoc(gl, this.outputCasProgram, 'uTexelSize'), 1 / outWidth, 1 / outHeight);
      gl.uniform1f(getUniformLoc(gl, this.outputCasProgram, 'uSharpen'), effectiveSharpen);
      gl.uniform1f(getUniformLoc(gl, this.outputCasProgram, 'uNoiseSigma'), noiseSigma);
      gl.uniform1f(getUniformLoc(gl, this.outputCasProgram, 'uFlipY'), flipOutputY ? 1.0 : 0.0);
      gl.uniform1f(getUniformLoc(gl, this.outputCasProgram, 'uOutHeight'), outHeight);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this._unbindTextureUnits(2);

      if (!flipOutputY) {
        gl.flush();
      }
    } finally {
      for (const tex of sourceTextures) {
        try {
          gl.deleteTexture(tex);
        } catch {
          // ignore
        }
      }
      this._fboPool = createdTargets;
      this.releaseWorkingBuffers();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  /**
   * Read the current WebGL framebuffer as a tightly packed top-down RGBA8 buffer.
   * When Pass 5 rendered with `flipOutputY: true`, gl.readPixels returns rows directly in top-down
   * order with zero CPU row reversal; otherwise flips in place using a single row scratch buffer.
   */
  readRgbaTopDown() {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const rowBytes = width * 4;
    const pixels = new Uint8Array(rowBytes * height);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    if (!this._lastOutputFlippedY) {
      const rowScratch = new Uint8Array(rowBytes);
      const halfHeight = Math.floor(height / 2);
      for (let topRow = 0; topRow < halfHeight; topRow++) {
        const bottomRow = height - 1 - topRow;
        const topOffset = topRow * rowBytes;
        const bottomOffset = bottomRow * rowBytes;
        rowScratch.set(pixels.subarray(topOffset, topOffset + rowBytes));
        pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowBytes);
        pixels.set(rowScratch, bottomOffset);
      }
    }

    return { data: pixels, width, height };
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    this.releaseWorkingBuffers();
    const programs = [
      this.mergeProgram,
      this.alignSampleProgram,
      this.lumDownProgram,
      this.lumBilateralProgram,
      this.denoiseProgram,
      this.tonemapProgram,
      this.outputCasProgram,
    ];
    for (const p of programs) {
      if (p?.program) gl.deleteProgram(p.program);
    }
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
  }
}
