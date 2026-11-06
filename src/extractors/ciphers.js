// unpack Dean Edwards packed JS: eval(function(p,a,c,k,e,d){...})
function unpackDeanEdwards(html) {
  let unpackedChunks = '';
  const packedRegex = /eval\(function\(p,a,c,k,e,[dr]\)\{[\s\S]*?\}\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\.split\('\Vert{}'\)/gi;
  let match;
  while ((match = packedRegex.exec(html)) !== null) {
    try {
      let payload = match[1];
      const radix = parseInt(match[2], 10);
      let count = parseInt(match[3], 10);
      const symtab = match[4].split('|');

      const encodeBase = (num) => {
        const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        if (num < radix) {
          return num < 36 ? num.toString(36) : chars[num];
        }
        return encodeBase(Math.floor(num / radix)) + encodeBase(num % radix);
      };

      while (count--) {
        if (symtab[count]) {
          const token = encodeBase(count);
          payload = payload.replace(new RegExp(`\\b${token}\\b`, 'g'), symtab[count]);
        }
      }
      unpackedChunks += '\n' + payload;
    } catch {}
  }
  return unpackedChunks;
}

// decode Base64 strings inside atob("...") or base64_decode("...")
function decodeInlineBase64Urls(text) {
  let decodedExtras = '';
  const b64Regex = /(?:atob|base64_decode)\(\s*['"]([A-Za-z0-9+/=]{20,})['"]\s*\)/gi;
  let m;
  while ((m = b64Regex.exec(text)) !== null) {
    try {
      const dec = Buffer.from(m[1], 'base64').toString('utf8');
      if (/https?:\/\/|\.mp4|\.m3u8|\/get_file\//i.test(dec)) {
        decodedExtras += '\n' + dec;
      }
    } catch {}
  }
  return decodedExtras;
}

// decode KVS (kt_player) "function/0/..." obfuscated URLs
function decodeKvsUrl(rawUrl, licenseCode) {
  if (!rawUrl) return '';
  if (!rawUrl.startsWith('function/0/')) return rawUrl;

  const realUrl = rawUrl.slice('function/0/'.length);
  if (!licenseCode) return realUrl;

  try {
    const cleanLicense = String(licenseCode).replace(/^\$/, '');
    let c = '';
    for (let i = 0; i < cleanLicense.length; i++) {
      c += cleanLicense[i] === '0' ? '1' : cleanLicense[i];
    }

    const s = Math.floor(c.length / 2);
    const k1 = parseInt(c.substring(0, s + 1), 10);
    const k2 = parseInt(c.substring(s), 10);
    const diff = Math.abs(k2 - k1) * 4;
    const diffStr = String(diff);
    const iLen = s + 1;

    const swapTable = [];
    for (let g = 0; g < iLen; g++) {
      for (let h = 1; h <= 4; h++) {
        const d1 = parseInt(cleanLicense[g + h - 1], 10) || 0;
        const d2 = parseInt(diffStr[g % diffStr.length], 10) || 0;
        let sum = d1 + d2;
        if (sum >= 10) sum -= 10;
        swapTable.push(sum);
      }
    }

    const urlParts = realUrl.split('/');
    const tokenIdx = urlParts.findIndex(seg => /^[0-9a-f]{32}/i.test(seg));
    if (tokenIdx === -1) return realUrl;

    const origSeg = urlParts[tokenIdx];
    const hashChars = origSeg.slice(0, 32).split('');
    for (let k = 31; k >= 0; k--) {
      const swapPos = (k + (swapTable[k] || 0)) % 32;
      const tmp = hashChars[k];
      hashChars[k] = hashChars[swapPos];
      hashChars[swapPos] = tmp;
    }

    urlParts[tokenIdx] = hashChars.join('') + origSeg.slice(32);
    return urlParts.join('/');
  } catch {
    return realUrl;
  }
}

module.exports = {
  unpackDeanEdwards,
  decodeInlineBase64Urls,
  decodeKvsUrl
};