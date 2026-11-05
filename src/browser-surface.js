'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { normalizeClientProfile } = require('./client-profile');

/**
 * The machine a page can measure, derived from the account's profile.
 *
 * The Sentinel sandbox used to answer these from constants, which made them a
 * shared fingerprint: every account in a batch returned the same canvas
 * digest, the same text metrics and the same GPU limits, which ties those
 * accounts together as surely as a shared IP would. Worse, several of the
 * constants contradicted the browser the profile claimed to be — a Firefox
 * that reported ANGLE strings where Firefox reports `Mozilla`, and one that
 * advertised a PDF viewer while reporting no plugins at all.
 *
 * Everything here is a pure function of the profile, so an account measures
 * the same machine on every session and no two accounts measure the same one.
 */

/**
 * What Firefox reports for the masked WebGL strings.
 *
 * The real vendor and renderer are only available through
 * `WEBGL_debug_renderer_info`; `getParameter(VENDOR)` and
 * `getParameter(RENDERER)` answer with the browser, not the card. Returning
 * the ANGLE strings for both is a Chrome-shaped answer from a Firefox.
 */
const MASKED_WEBGL_VENDOR = 'Mozilla';
const MASKED_WEBGL_RENDERER = 'Mozilla';

const WEBGL_VERSION = 'WebGL 1.0';
const WEBGL_SHADING_LANGUAGE_VERSION = 'WebGL GLSL ES 1.0';

/** The WebGL enums a fingerprinting script actually reads. */
const GL = Object.freeze({
  VENDOR: 0x1F00,
  RENDERER: 0x1F01,
  VERSION: 0x1F02,
  SHADING_LANGUAGE_VERSION: 0x1F03,
  ALIASED_POINT_SIZE_RANGE: 0x846D,
  ALIASED_LINE_WIDTH_RANGE: 0x846E,
  MAX_TEXTURE_SIZE: 0x0D33,
  MAX_VIEWPORT_DIMS: 0x0D3A,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
  MAX_RENDERBUFFER_SIZE: 0x84E8,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
  MAX_VARYING_VECTORS: 0x8DFC,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
  MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF,
  UNMASKED_VENDOR_WEBGL: 0x9245,
  UNMASKED_RENDERER_WEBGL: 0x9246,
});

/**
 * Limits that follow the card, because a script can read them and compare.
 *
 * Everything on this list is fixed by the D3D11 feature level ANGLE targets
 * except the texture and viewport ceilings and the anisotropy limit, which is
 * where an integrated part and a discrete one actually differ.
 */
const ANGLE_D3D11_LIMITS = Object.freeze({
  MAX_VERTEX_ATTRIBS: 16,
  MAX_VERTEX_UNIFORM_VECTORS: 4096,
  MAX_VARYING_VECTORS: 30,
  MAX_FRAGMENT_UNIFORM_VECTORS: 1024,
  MAX_TEXTURE_IMAGE_UNITS: 16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  ALIASED_LINE_WIDTH_RANGE: [1, 1],
  ALIASED_POINT_SIZE_RANGE: [1, 1024],
  MAX_VIEWPORT_DIMS: [32767, 32767],
});

/** Per-card ceilings, keyed by the family named in the renderer string. */
const GPU_CEILINGS = Object.freeze([
  Object.freeze({ match: /Intel\(R\) UHD/, maxTexture: 16384, anisotropy: 16 }),
  Object.freeze({ match: /Intel\(R\) Iris/, maxTexture: 16384, anisotropy: 16 }),
  Object.freeze({ match: /GeForce RTX/, maxTexture: 32768, anisotropy: 16 }),
  Object.freeze({ match: /GeForce GTX/, maxTexture: 32768, anisotropy: 16 }),
  Object.freeze({ match: /Radeon/, maxTexture: 16384, anisotropy: 16 }),
]);

/**
 * The five PDF viewer entries the HTML spec pins `navigator.plugins` to.
 *
 * They are the same five in every browser that can display a PDF, and their
 * presence is tied to `pdfViewerEnabled`: a browser that answers `true` there
 * and returns an empty plugin list has contradicted itself, which is what the
 * sandbox did.
 */
const PDF_PLUGIN_NAMES = Object.freeze([
  'PDF Viewer',
  'Chrome PDF Viewer',
  'Chromium PDF Viewer',
  'Microsoft Edge PDF Viewer',
  'WebKit built-in PDF',
]);
const PDF_MIME_TYPES = Object.freeze([
  Object.freeze({ type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }),
  Object.freeze({ type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }),
]);

/**
 * Advance widths for a 16px sans-serif, in CSS pixels.
 *
 * A linear `length × constant` is the giveaway the previous stub carried: real
 * text measurement depends on which glyphs are in the string, so `iiii` and
 * `WWWW` came back identical. These are the proportions of a Helvetica-class
 * face, which is what the Windows default sans resolves to for this purpose.
 */
const GLYPH_WIDTHS = Object.freeze({
  ' ': 4.45, '!': 4.45, '"': 5.68, '#': 8.9, $: 8.9, '%': 14.24, '&': 10.67, "'": 3.06,
  '(': 5.34, ')': 5.34, '*': 6.23, '+': 9.34, ',': 4.45, '-': 5.34, '.': 4.45, '/': 4.45,
  ':': 4.45, ';': 4.45, '<': 9.34, '=': 9.34, '>': 9.34, '?': 8.9, '@': 16.24,
  '[': 4.45, '\\': 4.45, ']': 4.45, '^': 7.52, _: 8.9, '`': 5.34,
  '{': 5.34, '|': 4.16, '}': 5.34, '~': 9.34,
});
const DIGIT_WIDTH = 8.9;
const LOWER_WIDTHS = Object.freeze({
  f: 4.45, i: 3.56, j: 3.56, l: 3.56, m: 13.35, r: 5.34, t: 4.45, w: 11.57,
});
const UPPER_WIDTHS = Object.freeze({
  I: 3.56, J: 6.67, M: 13.35, W: 12.46,
});
const DEFAULT_LOWER_WIDTH = 8.9;
const DEFAULT_UPPER_WIDTH = 10.67;
const DEFAULT_OTHER_WIDTH = 9.79;

function glyphWidth(character) {
  if (Object.hasOwn(GLYPH_WIDTHS, character)) return GLYPH_WIDTHS[character];
  if (character >= '0' && character <= '9') return DIGIT_WIDTH;
  if (Object.hasOwn(LOWER_WIDTHS, character)) return LOWER_WIDTHS[character];
  if (Object.hasOwn(UPPER_WIDTHS, character)) return UPPER_WIDTHS[character];
  if (character >= 'a' && character <= 'z') return DEFAULT_LOWER_WIDTH;
  if (character >= 'A' && character <= 'Z') return DEFAULT_UPPER_WIDTH;
  return DEFAULT_OTHER_WIDTH;
}

function pngChunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed) >>> 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * A real PNG, not a truncated signature.
 *
 * The stub used to answer `toDataURL()` with eleven base64 characters that
 * decode to a PNG header and nothing else. Anything that tried to read the
 * image back — or simply checked its length — saw a canvas that cannot exist.
 * The pixels come from the profile, so the digest separates two accounts the
 * way two machines' rasterizers would.
 */
function canvasPng(seed, size = 16) {
  const noise = crypto.createHash('sha256').update(`canvas\u0000${seed}`).digest();
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) % noise.length;
      raw[offset] = noise[index];
      raw[offset + 1] = noise[(index + 7) % noise.length];
      raw[offset + 2] = noise[(index + 13) % noise.length];
      raw[offset + 3] = 255;
      offset += 4;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Exactly what the sandbox presented before any of this, for accounts that
 * were registered against it.
 *
 * Every value below is wrong in the same way the corrected surface fixes —
 * masked WebGL strings that answer like Chrome, a PDF viewer with no plugins
 * behind it, a canvas that decodes to a header and nothing else, a text width
 * that is linear in character count. They stay anyway. An account that has
 * been signing in with this machine for months does not benefit from having
 * it corrected underneath it; what it presents becoming *different* is the
 * risk, whichever direction the change runs in.
 *
 * So the corrections apply to accounts registered from here on, and this is
 * frozen. It is pinned by a golden test rather than described in a comment,
 * because "unchanged" is a claim that has to be checked.
 */
const LEGACY_SURFACE = Object.freeze({
  gpuVendor: 'Google Inc. (Intel)',
  gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
  appVersion: '5.0 (Windows)',
  productSub: '20100101',
  storageQuotaBytes: 274877906944,
  historyLength: 3,
  glyphWidth: 7.25,
  canvasDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  fontFamily: 'Arial',
  fontSize: '16px',
});

/**
 * The surface an account registered before the pool keeps presenting.
 *
 * `oscpu` and `buildID` are absent rather than empty: the sandbox never
 * defined them, and `undefined` is what a script reading them saw.
 */
function legacySurface() {
  const debug = { UNMASKED_VENDOR_WEBGL: GL.UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL: GL.UNMASKED_RENDERER_WEBGL };
  return {
    coherent: false,
    appVersion: LEGACY_SURFACE.appVersion,
    productSub: LEGACY_SURFACE.productSub,
    oscpu: undefined,
    buildId: undefined,
    storageQuotaBytes: LEGACY_SURFACE.storageQuotaBytes,
    historyLength: LEGACY_SURFACE.historyLength,
    computedStyle: { fontFamily: LEGACY_SURFACE.fontFamily, fontSize: LEGACY_SURFACE.fontSize },
    plugins: [],
    // One array served as both `navigator.plugins` and `navigator.mimeTypes`.
    sharesPluginArray: true,
    measureText: (value) => String(value || '').length * LEGACY_SURFACE.glyphWidth,
    canvasDataUrl: () => LEGACY_SURFACE.canvasDataUrl,
    webgl: {
      enums: { VENDOR: GL.VENDOR, RENDERER: GL.RENDERER },
      getExtension: (name) => (name === 'WEBGL_debug_renderer_info' ? debug : null),
      getSupportedExtensions: undefined,
      getParameter(parameter) {
        if (parameter === GL.UNMASKED_VENDOR_WEBGL || parameter === GL.VENDOR) return LEGACY_SURFACE.gpuVendor;
        if (parameter === GL.UNMASKED_RENDERER_WEBGL || parameter === GL.RENDERER) return LEGACY_SURFACE.gpuRenderer;
        return 0;
      },
    },
  };
}

function gpuCeilings(renderer) {
  return GPU_CEILINGS.find((entry) => entry.match.test(renderer)) || { maxTexture: 16384, anisotropy: 16 };
}

/** The extensions Firefox exposes over ANGLE on Windows, in its own order. */
const WEBGL_EXTENSIONS = Object.freeze([
  'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float', 'EXT_float_blend',
  'EXT_frag_depth', 'EXT_shader_texture_lod', 'EXT_sRGB', 'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic', 'OES_element_index_uint',
  'OES_fbo_render_mipmap', 'OES_standard_derivatives', 'OES_texture_float', 'OES_texture_float_linear',
  'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object',
  'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers',
  'WEBGL_lose_context',
]);

/** The machine a pooled profile describes, answered the way Firefox answers. */
function coherentSurface(profile) {
  const seed = crypto.createHash('sha256').update(JSON.stringify(profile)).digest();
  const ceilings = gpuCeilings(profile.gpu.renderer);
  // A hair either side of the nominal metrics, the way two machines' font
  // rasterizers differ. Wide enough to separate accounts, far too small to be
  // an implausible width.
  const textScale = 1 + ((seed[0] % 21) - 10) / 2000;
  const dataUrl = `data:image/png;base64,${canvasPng(seed.toString('hex')).toString('base64')}`;

  const parameters = new Map([
    [GL.VENDOR, MASKED_WEBGL_VENDOR],
    [GL.RENDERER, MASKED_WEBGL_RENDERER],
    [GL.VERSION, WEBGL_VERSION],
    [GL.SHADING_LANGUAGE_VERSION, WEBGL_SHADING_LANGUAGE_VERSION],
    [GL.UNMASKED_VENDOR_WEBGL, profile.gpu.vendor],
    [GL.UNMASKED_RENDERER_WEBGL, profile.gpu.renderer],
    [GL.MAX_TEXTURE_SIZE, ceilings.maxTexture],
    [GL.MAX_CUBE_MAP_TEXTURE_SIZE, ceilings.maxTexture],
    [GL.MAX_RENDERBUFFER_SIZE, ceilings.maxTexture],
    [GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT, ceilings.anisotropy],
    [GL.MAX_VERTEX_ATTRIBS, ANGLE_D3D11_LIMITS.MAX_VERTEX_ATTRIBS],
    [GL.MAX_VERTEX_UNIFORM_VECTORS, ANGLE_D3D11_LIMITS.MAX_VERTEX_UNIFORM_VECTORS],
    [GL.MAX_VARYING_VECTORS, ANGLE_D3D11_LIMITS.MAX_VARYING_VECTORS],
    [GL.MAX_FRAGMENT_UNIFORM_VECTORS, ANGLE_D3D11_LIMITS.MAX_FRAGMENT_UNIFORM_VECTORS],
    [GL.MAX_TEXTURE_IMAGE_UNITS, ANGLE_D3D11_LIMITS.MAX_TEXTURE_IMAGE_UNITS],
    [GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS, ANGLE_D3D11_LIMITS.MAX_VERTEX_TEXTURE_IMAGE_UNITS],
    [GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS, ANGLE_D3D11_LIMITS.MAX_COMBINED_TEXTURE_IMAGE_UNITS],
    [GL.ALIASED_LINE_WIDTH_RANGE, ANGLE_D3D11_LIMITS.ALIASED_LINE_WIDTH_RANGE],
    [GL.ALIASED_POINT_SIZE_RANGE, ANGLE_D3D11_LIMITS.ALIASED_POINT_SIZE_RANGE],
    [GL.MAX_VIEWPORT_DIMS, ANGLE_D3D11_LIMITS.MAX_VIEWPORT_DIMS],
  ]);

  return {
    coherent: true,
    appVersion: profile.appVersion,
    productSub: profile.productSub,
    oscpu: profile.oscpu,
    buildId: profile.buildId,
    storageQuotaBytes: profile.storageQuotaBytes,
    // A visit history deep enough to have arrived from somewhere, shallow
    // enough for a sign-in flow.
    historyLength: 2 + (seed[1] % 5),
    // An unstyled document in Firefox computes to the default serif at 16px.
    computedStyle: { fontFamily: 'serif', fontSize: '16px' },
    plugins: PDF_PLUGIN_NAMES.map((name) => ({
      name,
      description: 'Portable Document Format',
      filename: 'internal-pdf-viewer',
      mimeTypes: PDF_MIME_TYPES.map((mime) => ({ ...mime, enabledPlugin: name })),
    })),
    sharesPluginArray: false,
    measureText(value) {
      let width = 0;
      for (const character of String(value || '')) width += glyphWidth(character);
      return Math.round(width * textScale * 100) / 100;
    },
    canvasDataUrl: () => dataUrl,
    webgl: {
      enums: GL,
      getSupportedExtensions: () => [...WEBGL_EXTENSIONS],
      getExtension(name) {
        if (name === 'WEBGL_debug_renderer_info') {
          return { UNMASKED_VENDOR_WEBGL: GL.UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL: GL.UNMASKED_RENDERER_WEBGL };
        }
        if (name === 'EXT_texture_filter_anisotropic') {
          return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT, TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE };
        }
        return WEBGL_EXTENSIONS.includes(name) ? {} : null;
      },
      // An enum the surface does not describe answers `null`, which is what a
      // real context does for a parameter it has no value for.
      getParameter(parameter) {
        const value = parameters.get(parameter);
        if (value === undefined) return null;
        return Array.isArray(value) ? new Int32Array(value) : value;
      },
    },
  };
}

/**
 * The machine a page can measure, for one account.
 *
 * Which surface an account gets is decided by the profile it was registered
 * with and never changes afterwards, so no account's machine moves under it.
 *
 * @param {object} profile  the account's client profile, of either schema.
 */
function createDeviceSurface(profile) {
  const normalized = normalizeClientProfile(profile);
  return Number(normalized.schemaVersion || 1) >= 2 ? coherentSurface(normalized) : legacySurface();
}

module.exports = {
  createDeviceSurface,
};
