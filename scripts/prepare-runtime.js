import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Checksums from the official Node.js release. Ship only node and its notices.
const version = '24.21.0';
const host = process.platform;
const arch = process.env.RELAY_ARCH || process.arch;
const hashes = {
  'darwin-arm64': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
  'darwin-x64': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'linux-x64': 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  'win32-x64': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
};
const expected = hashes[host + '-' + arch];
if (!expected) throw Error('Unsupported runtime target: ' + host + '/' + arch);
const root = fileURLToPath(new URL('../', import.meta.url));
const dest = join(root, 'src-tauri/runtime');
const binary = host === 'win32' ? 'node.exe' : 'node';
const name = 'node-v' + version + '-' + (host === 'win32' ? 'win' : host) + '-' + arch;
const ext = host === 'win32' ? '.zip' : host === 'darwin' ? '.tar.gz' : '.tar.xz';
const tmp = await mkdtemp(join(tmpdir(), 'naparnik-build-'));
try {
  const blob = join(tmp, name + ext);
  execFileSync(host === 'win32' ? 'curl.exe' : 'curl', ['-fLsS', '--retry', '3', '-o', blob, 'https://nodejs.org/dist/v' + version + '/' + name + ext], {stdio:'inherit'});
  if (createHash('sha256').update(await readFile(blob)).digest('hex') !== expected) throw Error('Runtime checksum mismatch');
  const file = host === 'win32' ? 'node.exe' : 'bin/node';
  execFileSync('tar', ['-xf', blob, '-C', tmp, name + '/' + file, name + '/LICENSE']);
  await mkdir(dest,{recursive:true});
  await copyFile(join(tmp,name,file),join(dest,binary));
  await chmod(join(dest,binary),0o755);
  await copyFile(join(tmp,name,'LICENSE'), join(dest,'NODE-LICENSE'));
  for (const f of ['bridge.js','formats.js','server.js','state.js','tool-monitor.js','session-titles.js','desktop-server.js']) await copyFile(join(root,f), join(dest,f));
  await cp(join(root,'public'),join(dest,'public'),{recursive:true});
  await writeFile(join(dest,'package.json'),JSON.stringify({type:'module'}));
} finally { await rm(tmp,{recursive:true,force:true}); }
