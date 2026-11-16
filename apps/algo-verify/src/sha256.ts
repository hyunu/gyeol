/** SHA-256 hex. Secure context에서는 Web Crypto, 아니면 JS 폴백(HTTP 외부 접속 대응). */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const hash = await subtle.digest("SHA-256", buffer);
    return toHex(new Uint8Array(hash));
  }
  return sha256Fallback(new Uint8Array(buffer));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// --- pure JS SHA-256 (FIPS 180-4) ---
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
function rotr(n: number, x: number){ return (x>>>n)|(x<<(32-n)); }
function sha256Fallback(msg: Uint8Array): string {
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const bitLen = msg.length * 8;
  const withOne = msg.length + 1;
  const padLen = (withOne % 64 <= 56 ? 56 - (withOne % 64) : 56 + 64 - (withOne % 64));
  const total = withOne + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  // length in bits as 64-bit big-endian
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  view.setUint32(total - 8, hi, false);
  view.setUint32(total - 4, lo, false);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i=0;i<16;i++) w[i]=view.getUint32(off + i*4, false);
    for (let i=16;i<64;i++){
      const s0=(rotr(7,w[i-15])^rotr(18,w[i-15])^(w[i-15]>>>3))>>>0;
      const s1=(rotr(17,w[i-2])^rotr(19,w[i-2])^(w[i-2]>>>10))>>>0;
      w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i=0;i<64;i++){
      const S1=(rotr(6,e)^rotr(11,e)^rotr(25,e))>>>0;
      const ch=((e&f)^(~e&g))>>>0;
      const t1=(h+S1+ch+K[i]+w[i])>>>0;
      const S0=(rotr(2,a)^rotr(13,a)^rotr(22,a))>>>0;
      const maj=((a&b)^(a&c)^(b&c))>>>0;
      const t2=(S0+maj)>>>0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  dv.setUint32(0,h0,false); dv.setUint32(4,h1,false); dv.setUint32(8,h2,false); dv.setUint32(12,h3,false);
  dv.setUint32(16,h4,false); dv.setUint32(20,h5,false); dv.setUint32(24,h6,false); dv.setUint32(28,h7,false);
  return toHex(out);
}
