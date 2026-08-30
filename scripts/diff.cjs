const {spawnSync} = require('node:child_process');
const env = {...process.env, APP_ENV: process.argv[2]};
const synth = spawnSync('pnpm',['run','synth'],{env,stdio:'inherit'});
if (synth.error || synth.status !== 0) process.exit(synth.status || 2);
const diff = spawnSync('kubectl',['diff','-f','dist/'],{stdio:'inherit'});
process.exit(diff.error || diff.status === null ? 2 : diff.status <= 1 ? 0 : diff.status);
