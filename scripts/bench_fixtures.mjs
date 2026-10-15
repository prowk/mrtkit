import { mkdirSync, writeFileSync, createWriteStream, createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { cat, u16, u32, attr, mrt, attributes, bgpUpdate } from './fixtures.mjs';

const directory = resolve(process.argv[2] ?? '.validation/bench');
mkdirSync(directory, {recursive: true});
const entries = [];
async function file(name, recipe, generate) {
  const path = join(directory, name);
  const stream = createWriteStream(path);
  const write = async bytes => {if (!stream.write(bytes)) await once(stream, 'drain');};
  await generate(write);
  stream.end(); await once(stream, 'finish');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  entries.push({file: name, recipe, bytes: statSync(path).size, sha256: digest.digest('hex'), collector: 'synthetic', kind: 'benchmark'});
}
await file('duplicates.mrt', '100000 identical announcements; 64 COMMUNITY and 64 Large Community members; one route', async write => {
  const ordinary = cat(...Array.from({length: 64}, (_, i) => u32(64 - i)));
  const large = cat(...Array.from({length: 64}, (_, i) => cat(u32(64512), u32(64 - i), u32(i))));
  const record = bgpUpdate(Buffer.from([24, 203, 0, 113]), undefined,
    cat(attributes([64512, 1]), attr(8, ordinary, 192), attr(32, large, 192)), 100);
  for (let i = 0; i < 100; i++) await write(cat(...Array(1000).fill(record)));
});
await file('session-resets.mrt', '400 peers times 200 routes, followed by 400 peer resets; all times ordered', async write => {
  for (let peer = 0; peer < 400; peer++) {
    const records = [];
    for (let route = 0; route < 200; route++) {
      const record = bgpUpdate(Buffer.from([24, 10, 0, route]), undefined, attributes([64512 + peer, 1]), 100);
      record.writeUInt32BE(64512 + peer, 12); records.push(record);
    }
    await write(cat(...records));
  }
  for (let peer = 0; peer < 400; peer++) await write(mrt(16, 5, cat(u32(64512 + peer), u32(64513),
    u16(0), u16(1), Buffer.from([192, 0, 2, 1, 192, 0, 2, 2]), u16(6), u16(1)), 200));
});
await file('fragmented-record.mrt', 'one 4 MiB unknown MRT payload, library feed chunks of 256 bytes', async write => {
  await write(mrt(99, 0, Buffer.alloc(4 * 1024 * 1024), 100));
});
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(entries, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(entries) + '\n');
