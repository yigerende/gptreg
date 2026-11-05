"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { parseFragment, serialize } = require("parse5");
const { fail } = require("./security");
const defaultIcon = fs.readFileSync(path.join(__dirname, "assets/gptreg-icon.svg"));
const brandDefaults = {
  english_name: "GPTREG",
  tagline: "按需注册 · 清晰交付",
  support_url: "",
  terms: "下单时预留积分，完整交付后扣费。未交付部分在失败或取消后退回。账号凭据请妥善保管，使用服务时请遵守适用法律及相关平台条款。",
  icon: "",
};
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function validatePng(bytes) {
  fail(bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "PNG 文件无效");
  let pos = 8, header = false, ended = false;
  const pixels = [];
  while (pos + 12 <= bytes.length) {
    const n = bytes.readUInt32BE(pos), type = bytes.toString("ascii", pos + 4, pos + 8);
    fail(n <= bytes.length - pos - 12, "PNG 数据不完整");
    fail(crc32(bytes.subarray(pos + 4, pos + 8 + n)) === bytes.readUInt32BE(pos + 8 + n), "PNG 校验失败");
    if (!header) {
      fail(type === "IHDR" && n === 13, "PNG 缺少文件头");
      const width = bytes.readUInt32BE(pos + 8), height = bytes.readUInt32BE(pos + 12);
      fail(width >= 16 && height >= 16 && width <= 1024 && height <= 1024, "图标尺寸须为 16～1024 像素");
      header = true;
    } else fail(type !== "IHDR", "PNG 文件头重复");
    fail(!["acTL", "fcTL", "fdAT"].includes(type), "请上传静态 PNG");
    if (type === "IDAT") pixels.push(bytes.subarray(pos + 8, pos + 8 + n));
    pos += n + 12;
    if (type === "IEND") { fail(n === 0, "PNG 结束标记无效"); ended = true; break; }
  }
  fail(ended && pos === bytes.length && pixels.length, "PNG 数据不完整");
  try { zlib.inflateSync(Buffer.concat(pixels), { maxOutputLength: 9 * 1024 * 1024 }); }
  catch { fail(false, "PNG 图像数据无效"); }
}
function validateIcon(value) {
  fail(typeof value === "string", "图标格式不正确");
  if (!value) return "";
  const m = /^data:(image\/(?:png|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  fail(m && value.length <= 350000, "图标仅支持 PNG 或静态 SVG");
  let bytes = Buffer.from(m[2], "base64");
  fail(bytes.toString("base64") === m[2], "图标编码无效");
  if (m[1] === "image/png") {
    fail(bytes.length <= 256 * 1024, "PNG 不能超过 256 KB");
    validatePng(bytes);
  } else {
    fail(bytes.length <= 20 * 1024, "SVG 不能超过 20 KB");
    const svg = bytes.toString("utf8");
    fail(!/[<!?]\?|<!|&/.test(svg), "SVG 不支持声明、实体或注释");
    const tree = parseFragment(svg);
    const roots = tree.childNodes.filter(n => n.nodeName !== "#text" || n.value.trim());
    fail(roots.length === 1 && roots[0].tagName === "svg", "SVG 根元素无效");
    const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "title", "desc"]);
    const attrs = new Set("xmlns viewBox width height fill stroke stroke-width stroke-linecap stroke-linejoin fill-rule clip-rule opacity fill-opacity stroke-opacity d x y x1 x2 y1 y2 cx cy r rx ry points transform id offset stop-color stop-opacity gradientUnits gradientTransform fx fy fr spreadMethod".split(" "));
    function visit(n, depth = 0) {
      fail(depth < 32, "SVG 层级过深");
      if (n.nodeName === "#text") return;
      fail(tags.has(n.tagName) && n.namespaceURI === "http://www.w3.org/2000/svg", "SVG 包含不支持的元素");
      for (const a of n.attrs) {
        fail(attrs.has(a.name) && !a.prefix, "SVG 包含不支持的属性");
        fail(!/[<>\\]/.test(a.value), "SVG 属性无效");
        if (a.name === "xmlns") fail(a.value === "http://www.w3.org/2000/svg", "SVG 命名空间无效");
        else fail(!/[:@]|(?:https?|data|javascript)\s*\(/i.test(a.value), "SVG 不允许外部资源");
        if (/url\s*\(/i.test(a.value)) fail(/^url\(#[A-Za-z][\w-]*\)$/.test(a.value), "SVG 仅支持内部渐变引用");
      }
      (n.childNodes || []).forEach(c => visit(c, depth + 1));
    }
    visit(roots[0]);
    bytes = Buffer.from(serialize(tree));
  }
  return `data:${m[1]};base64,${bytes.toString("base64")}`;
}
function validateBrand(value) {
  fail(value && typeof value === "object" && !Array.isArray(value), "品牌设置格式不正确");
  fail(Object.keys(value).every(k => Object.hasOwn(brandDefaults, k)), "存在不支持的品牌设置");
  const b = { ...brandDefaults, ...value };
  for (const [key, max] of Object.entries({ english_name: 80, tagline: 200, support_url: 2048, terms: 10000 })) {
    fail(typeof b[key] === "string" && b[key].length <= max, "品牌字段格式错误或超长");
    b[key] = b[key].trim();
  }
  if (b.support_url) {
    let u; try { u = new URL(b.support_url); } catch {}
    fail(u && ["https:", "http:"].includes(u.protocol) && !u.username && !u.password, "客服链接须为 http 或 https 地址");
  }
  b.icon = validateIcon(b.icon);
  return b;
}
function siteIcon(brand) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(brand?.icon || "");
  const bytes = m ? Buffer.from(m[2], "base64") : defaultIcon;
  return { bytes, mime: m ? m[1] : "image/svg+xml", hash: crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
}
function publicBrand(value) {
  const { icon, ...b } = { ...brandDefaults, ...value };
  return { ...b, icon_url: `/site-icon?v=${siteIcon({ icon }).hash}` };
}
module.exports = { brandDefaults, validateBrand, validateIcon, siteIcon, publicBrand };
