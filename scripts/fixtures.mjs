import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

// 独立编码器生成可复现的协议样本，测试不依赖解析实现。
export const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
export const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
export const cat = (...parts) => Buffer.concat(parts);
export function mrt(type, subtype, body, timestamp = 1700000000) {
  return cat(u32(timestamp), u16(type), u16(subtype), u32(body.length), body);
}
export function attr(code, body, flags = 0x40) {
  const extended = Boolean(flags & 16) || body.length > 255;
  return cat(Buffer.from([flags | (extended ? 16 : 0), code]), extended ? u16(body.length) : Buffer.from([body.length]), body);
}
export function attributes(asns) {
  return cat(attr(1, Buffer.from([0])), attr(2, cat(Buffer.from([2, asns.length]), ...asns.map(u32))), attr(3, Buffer.from([192, 0, 2, 1])));
}
export function bgpUpdate(announcements = Buffer.alloc(0), withdrawn = Buffer.alloc(0), attrs = Buffer.alloc(0), timestamp = 1700000001) {
  const body = cat(u16(withdrawn.length), withdrawn, u16(attrs.length), attrs, announcements);
  const message = cat(Buffer.alloc(16, 255), u16(19 + body.length), Buffer.from([2]), body);
  return mrt(16, 4, cat(u32(64512), u32(64513), u16(0), u16(1), Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]), message), timestamp);
}
export function demo() {
  const prefix = Buffer.from([24, 203, 0, 113]);
  const peers = mrt(13, 1, cat(u32(0xc0000201), u16(0), u16(1), Buffer.from([2]), u32(0xc0000201), Buffer.from([192, 0, 2, 1]), u32(64512)));
  const attrs = attributes([64512, 65536]);
  const rib = mrt(13, 2, cat(u32(0), prefix, u16(1), u16(0), u32(1699999999), u16(attrs.length), attrs));
  const v6 = Buffer.from('2020010db8', 'hex');
  const hop = Buffer.from('20010db8000000000000000000000001', 'hex');
  const mp = attr(14, cat(u16(2), Buffer.from([1, 16]), hop, Buffer.from([0]), v6), 0x80);
  const v6attrs = cat(attributes([64512, 65536]), mp);
  return cat(peers, rib,
    bgpUpdate(prefix, undefined, attributes([64512, 65537]), 1700000001),
    bgpUpdate(undefined, prefix, undefined, 1700000002),
    bgpUpdate(prefix, undefined, attributes([64512, 65537]), 1700000003),
    bgpUpdate(undefined, undefined, v6attrs, 1700000004),
    bgpUpdate(undefined, undefined, attr(15, cat(u16(2), Buffer.from([1]), v6), 0x80), 1700000005),
    mrt(99, 0, Buffer.from('unknown'), 1700000006));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = new URL('../fixtures/', import.meta.url);
  mkdirSync(directory, { recursive: true });
  const data = demo();
  writeFileSync(new URL('demo.mrt', directory), data);
  writeFileSync(new URL('demo.mrt.gz', directory), gzipSync(data));
  console.log(`已生成 ${fileURLToPath(directory)}demo.mrt (${data.length} 字节)`);
}
