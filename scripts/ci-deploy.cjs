const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {loadProject}=require('../build/deployment/config');
const {normalize}=require('./ci-contract.cjs');

function collectImages(directory, requested) {
  const images=Object.create(null);
  for(const file of fs.readdirSync(directory)) {
    if(!file.endsWith('.json')) continue;
    const value=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
    if(!requested.includes(value.service)||Object.hasOwn(images,value.service)||!/^ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(value.image)) throw new Error('Invalid or duplicate image artifact');
    images[value.service]=value.image;
  }
  if(requested.some(service=>!images[service])) throw new Error('Missing image artifact');
  return images;
}
module.exports={collectImages};
if(require.main===module) {
  const input=normalize(JSON.parse(process.env.GROMA_INPUT));
  const images=collectImages(process.env.IMAGE_DIRECTORY,JSON.parse(input.services).map(s=>s.service));
  const config=path.resolve(process.env.APP_ROOT,input.config);
  const p=loadProject(config,input.overlay||undefined,images);
  if(p.target!=='compose'||p.host.ssh!==input.target||(input.environment==='production')!==(p.profile==='production')) throw new Error('Deployment target/profile mismatch');
  if(!process.env.GROMA_SSH_KEY||!process.env.GROMA_KNOWN_HOSTS) throw new Error('Set SSH_PRIVATE_KEY and SSH_KNOWN_HOSTS in the deployment environment');
  const secretDir=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'groma-ssh-'));
  fs.chmodSync(secretDir,0o700);
  const key=path.join(secretDir,'key'),known=path.join(secretDir,'known_hosts'),sshConfig=path.join(secretDir,'config');
  try {
    fs.writeFileSync(key,process.env.GROMA_SSH_KEY+'\n',{mode:0o600});
    fs.writeFileSync(known,process.env.GROMA_KNOWN_HOSTS+'\n',{mode:0o600});
    fs.writeFileSync(sshConfig,`Host *\n  IdentityFile "${key}"\n  IdentitiesOnly yes\n  UserKnownHostsFile "${known}"\n  StrictHostKeyChecking yes\n  BatchMode yes\n`,{mode:0o600});
    // Environment variable is an explicit local OpenSSH config path, not shell code.
    const env={...process.env,GROMA_SSH_CONFIG:sshConfig};
    delete env.GROMA_SSH_KEY;delete env.GROMA_KNOWN_HOSTS;
    const args=[path.resolve(__dirname,'../build/cli.js'),'deploy','--config',config,'--yes','--expect-target',input.target,'--json'];
    if(input.overlay)args.push('--env',input.overlay);
    for(const [service,image] of Object.entries(images))args.push('--image',`${service}=${image}`);
    const result=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:900000,maxBuffer:16*1024*1024});
    if(result.stdout)process.stdout.write(result.stdout);
    if(result.stderr)process.stderr.write(result.stderr);
    if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`GROMa deployment: **${result.status===0?'verified':'failed'}**. See job output for the redacted plan and verification report.\n`);
    if(result.error)throw result.error;
    process.exitCode=result.status===0?0:1;
  } finally {fs.rmSync(secretDir,{recursive:true,force:true});}
}
