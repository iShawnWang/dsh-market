/**
 * Just enough HTML handling for ZenTao's article bodies.
 *
 * The bodies are rendered inside the DSH panel, so everything that could run
 * code or leak the session is removed; what survives is a small allowlist of
 * formatting tags. ZenTao's own CSS and JS never come along.
 */

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * Decode the entity set ZenTao actually emits.
 * @param {string} text - text with entities.
 * @returns {string} decoded text.
 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (match) => ENTITIES[match])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/**
 * Text content of a fragment, with scripts and styles dropped first.
 * @param {string} html - fragment.
 * @returns {string} whitespace-collapsed text.
 */
export function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'hr', 'i',
  'img', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

const ALLOWED_ATTRIBUTES = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  span: new Set([]),
  div: new Set([]),
  p: new Set(['data-zt-step']),
};

const SAFE_URL = /^(https?:\/\/|\/|#|data:image\/(png|jpe?g|gif|webp);base64,)/i;

/**
 * Rewrite attributes of one raw tag.
 * @param {string} raw - the complete tag text, `<…>`.
 * @returns {string} safe tag text, or '' to drop it.
 */
function cleanTag(raw) {
  const match = /^<\s*(\/?)\s*([a-zA-Z0-9]+)([\s\S]*?)(\/?)>$/.exec(raw);
  if (!match) return '';
  const [, closing, rawName, , selfClosing] = match;
  const name = rawName.toLowerCase();
  if (!ALLOWED_TAGS.has(name)) return '';
  if (closing) return `</${name}>`;
  const allowed = ALLOWED_ATTRIBUTES[name] ?? new Set([]);
  const parts = [];
  const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const attribute of match[3].matchAll(attributePattern)) {
    const key = attribute[1].toLowerCase();
    if (!allowed.has(key)) continue;
    const value = attribute[3] ?? attribute[4] ?? attribute[5] ?? '';
    if ((key === 'href' || key === 'src') && !SAFE_URL.test(value.trim())) continue;
    parts.push(`${key}="${value.replace(/"/g, '&quot;')}"`);
  }
  const tail = selfClosing || name === 'br' || name === 'img' || name === 'hr' ? ' /' : '';
  return `<${name}${parts.length ? ` ${parts.join(' ')}` : ''}${tail}>`;
}

/**
 * Sanitize a ZenTao article body for rendering in the panel.
 *
 * ZenTao marks the reproduction sections with `class="stepTitle"`; that single
 * class is translated into `data-zt-step` so the panel can style the headings
 * without pulling in the site stylesheet.
 * @param {string} html - raw fragment.
 * @returns {string} sanitized fragment.
 */
export function sanitizeArticle(html) {
  const source = String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<p[^>]*class=["'][^"']*stepTitle[^"']*["'][^>]*>/gi, '<p data-zt-step="1">')
    .replace(/\son[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, '');
  return source.replace(/<[^>]+>/g, (tag) => cleanTag(tag)).trim();
}

/**
 * Absolute-ize and collect the images an article references, so the host can
 * fetch them with the session cookie and inline them as data URLs.
 * @param {string} html - sanitized fragment.
 * @returns {string[]} `src` values as they appear.
 */
export function imageSources(html) {
  return [...String(html ?? '').matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Read the pixel size out of an image header, so the panel can reserve the
 * space before the bitmap decodes. Anything unparseable yields null and the
 * image simply flows in as before.
 * @param {Buffer} buffer - encoded image bytes.
 * @returns {{width: number, height: number}|null} intrinsic size.
 */
export function imageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  // PNG: IHDR is always the first chunk.
  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // GIF: little-endian logical screen size.
  const head = buffer.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // WebP: VP8X / VP8 / VP8L each store the size differently.
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = buffer.subarray(12, 16).toString('latin1');
    if (kind === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (kind === 'VP8 ') {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (kind === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG: walk the segments until a start-of-frame carries the size.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}

/**
 * Replace every `<img>` with a placeholder the panel fills in later.
 *
 * The panel renders the article long before its screenshots finish
 * downloading, so each picture is reduced to an empty box with the exact
 * footprint the bitmap will take. Without the size the article would reflow
 * every time a picture lands; with it, the text never moves.
 * @param {string} html - sanitized fragment.
 * @param {Map<string, {width: number, height: number}>} [sizes] - probed intrinsic sizes.
 * @returns {string} fragment whose images are placeholders.
 */
export function pendingImages(html, sizes = new Map()) {
  return String(html ?? '').replace(/<img\b[^>]*>/g, (tag) => {
    const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
    if (!src) return '';
    const alt = /\balt="([^"]*)"/.exec(tag)?.[1] ?? '';
    const size = sizes.get(src);
    /* Mirror what the finished <img> occupies: capped at 420px tall, so the
       width that goes with that height is `420 * w / h`. A span rather than an
       img, because an img without src draws a broken-image glyph. */
    const box = size?.width && size?.height
      ? ` style="aspect-ratio: ${size.width} / ${size.height}; width: min(100%, ${Math.round((420 * size.width) / size.height)}px)"`
      : ' style="width: min(100%, 240px); height: 420px"';
    return `<span data-zt-src="${src.replace(/"/g, '&quot;')}" data-zt-pending="1" role="img" aria-label="${alt}"${box}></span>`;
  });
}
