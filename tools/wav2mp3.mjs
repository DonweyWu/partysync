import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Mp3Encoder } from '@breezystack/lamejs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'music');

function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a wav');
  }
  let pos = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22)
      };
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = size;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('bad wav');
  return { fmt, dataOff, dataLen };
}

function wavToMp3(file, bitrate) {
  const buf = fs.readFileSync(file);
  const { fmt, dataOff, dataLen } = readWav(buf);
  const bytes = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bytes * fmt.channels));

  const chL = new Int16Array(frames);
  const chR = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    const base = dataOff + i * bytes * fmt.channels;
    chL[i] = buf.readInt16LE(base);
    chR[i] = fmt.channels > 1 ? buf.readInt16LE(base + bytes) : chL[i];
  }

  const enc = new Mp3Encoder(2, fmt.sampleRate, bitrate);
  const block = 1152;
  const out = [];
  for (let i = 0; i < frames; i += block) {
    const l = chL.subarray(i, Math.min(i + block, frames));
    const r = chR.subarray(i, Math.min(i + block, frames));
    const b = enc.encodeBuffer(l, r);
    if (b.length > 0) out.push(Buffer.from(b));
  }
  const tail = enc.flush();
  if (tail.length > 0) out.push(Buffer.from(tail));

  const dest = file.replace(/\.wav$/i, '.mp3');
  fs.writeFileSync(dest, Buffer.concat(out));
  const inMb = fs.statSync(file).size / 1024 / 1024;
  const outMb = fs.statSync(dest).size / 1024 / 1024;
  console.log(
    path.basename(dest).padEnd(30) +
    inMb.toFixed(1) + ' MB -> ' + outMb.toFixed(2) + ' MB  (' +
    (frames / fmt.sampleRate).toFixed(1) + 's, ' + bitrate + 'kbps)'
  );
  return dest;
}

const targets = process.argv.slice(2);
const list = targets.length
  ? targets.map((t) => path.resolve(t))
  : fs.readdirSync(dir).filter((f) => /\.wav$/i.test(f)).map((f) => path.join(dir, f));

if (!list.length) {
  console.log('没有需要转换的 wav');
  process.exit(0);
}

for (const f of list) {
  try {
    wavToMp3(f, 192);
  } catch (e) {
    console.error(f, '失败:', e.message);
  }
}
