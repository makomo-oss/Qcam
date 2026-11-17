import {
  VERTEX_SHADER_SOURCE,
  STANDARD_FRAGMENT_SHADER,
  HQ_FRAGMENT_SHADER,
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

function createProgram(gl, vertSrc, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program');
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  return program;
}

/**
 * Reusable WebGL image processor (works on HTMLCanvasElement or OffscreenCanvas).
 */
export class WebGLImageProcessor {
  constructor(canvas) {
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
    this.standardProgram = createProgram(gl, VERTEX_SHADER_SOURCE, STANDARD_FRAGMENT_SHADER);
    this.hqProgram = createProgram(gl, VERTEX_SHADER_SOURCE, HQ_FRAGMENT_SHADER);

    // Full-screen quad: (x, y, u, v)
    // Note: With UNPACK_FLIP_Y_WEBGL = false, image row 0 (top) is at v = 0.
    // Top-left (-1, +1) -> (0, 0), Bottom-left (-1, -1) -> (0, 1).
    const quadData = new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
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

  _bindQuad(program) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const posLoc = gl.getAttribLocation(program, 'aPosition');
    const texLoc = gl.getAttribLocation(program, 'aTexCoord');
    if (posLoc >= 0) {
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    }
    if (texLoc >= 0) {
      gl.enableVertexAttribArray(texLoc);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 16, 8);
    }
  }

  processStandard(source, { outWidth, outHeight, cropNorm, mirrorX = false, exposureEv = 0 }) {
    const gl = this.gl;
    this.canvas.width = outWidth;
    this.canvas.height = outHeight;
    gl.viewport(0, 0, outWidth, outHeight);

    const srcW = source.width || outWidth;
    const srcH = source.height || outHeight;
    const tex = this._uploadTexture(0, source);

    try {
      gl.useProgram(this.standardProgram);
      this._bindQuad(this.standardProgram);

      gl.uniform1i(gl.getUniformLocation(this.standardProgram, 'uTexture'), 0);
      gl.uniform2f(
        gl.getUniformLocation(this.standardProgram, 'uTexelSize'),
        1 / srcW,
        1 / srcH
      );
      gl.uniform4f(
        gl.getUniformLocation(this.standardProgram, 'uCropRect'),
        cropNorm.x,
        cropNorm.y,
        cropNorm.w,
        cropNorm.h
      );
      gl.uniform1f(
        gl.getUniformLocation(this.standardProgram, 'uMirrorX'),
        mirrorX ? 1.0 : 0.0
      );
      gl.uniform1f(gl.getUniformLocation(this.standardProgram, 'uSharpen'), 0.55);
      gl.uniform1f(gl.getUniformLocation(this.standardProgram, 'uContrast'), 0.14);
      gl.uniform1f(gl.getUniformLocation(this.standardProgram, 'uExposureEv'), exposureEv);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.flush();
    } finally {
      gl.deleteTexture(tex);
    }
  }

  processHQ(frames, { outWidth, outHeight, cropNorm, mirrorX = false, exposureEv = 0 }) {
    const gl = this.gl;
    this.canvas.width = outWidth;
    this.canvas.height = outHeight;
    gl.viewport(0, 0, outWidth, outHeight);

    const limitedFrames = frames.slice(0, 4);
    const srcW = limitedFrames[0].width || outWidth;
    const srcH = limitedFrames[0].height || outHeight;
    const textures = limitedFrames.map((frame, i) => this._uploadTexture(i, frame));

    try {
      gl.useProgram(this.hqProgram);
      this._bindQuad(this.hqProgram);

      for (let i = 0; i < 4; i++) {
        gl.uniform1i(
          gl.getUniformLocation(this.hqProgram, `uFrame${i}`),
          Math.min(i, textures.length - 1)
        );
      }

      gl.uniform1f(
        gl.getUniformLocation(this.hqProgram, 'uFrameCount'),
        limitedFrames.length
      );
      gl.uniform2f(
        gl.getUniformLocation(this.hqProgram, 'uTexelSize'),
        1 / srcW,
        1 / srcH
      );
      gl.uniform4f(
        gl.getUniformLocation(this.hqProgram, 'uCropRect'),
        cropNorm.x,
        cropNorm.y,
        cropNorm.w,
        cropNorm.h
      );
      gl.uniform1f(
        gl.getUniformLocation(this.hqProgram, 'uMirrorX'),
        mirrorX ? 1.0 : 0.0
      );
      gl.uniform1f(gl.getUniformLocation(this.hqProgram, 'uShadowLift'), 0.78);
      gl.uniform1f(gl.getUniformLocation(this.hqProgram, 'uHighlightRoll'), 0.65);
      gl.uniform1f(gl.getUniformLocation(this.hqProgram, 'uSharpen'), 0.42);
      gl.uniform1f(gl.getUniformLocation(this.hqProgram, 'uExposureEv'), exposureEv);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.flush();
    } finally {
      for (const tex of textures) {
        gl.deleteTexture(tex);
      }
    }
  }

  /**
   * Read the current WebGL framebuffer as a tightly packed top-down RGBA8 buffer.
   * Flips bottom-up gl.readPixels rows vertically in place using one row scratch buffer
   * to avoid doubling full-frame memory allocation on mobile devices.
   */
  readRgbaTopDown() {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const rowBytes = width * 4;
    const pixels = new Uint8Array(rowBytes * height);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

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

    return { data: pixels, width, height };
  }

  dispose() {
    const gl = this.gl;
    if (!gl) return;
    if (this.standardProgram) gl.deleteProgram(this.standardProgram);
    if (this.hqProgram) gl.deleteProgram(this.hqProgram);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
  }
}
