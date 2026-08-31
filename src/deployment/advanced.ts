import * as fs from 'fs';
import { Project, ImageLock, readImageLock, writeImageLock, projectName } from './config';
import { renderCompose } from './render';
import { quote, run, ssh } from './remote';

const sshArgs=(p:Project)=>[...(process.env.GROMA_SSH_CONFIG ? ['-F',process.env.GROMA_SSH_CONFIG] : []),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','-p',String(p.host!.port ?? 22),'--',p.host!.ssh];
const directSsh=(p:Project,command:string,input?:string,capture=false)=>run('ssh',[...sshArgs(p),'bash -lc '+quote(command)],input,capture);
const encoded=(value:string)=>Buffer.from(value).toString('base64');
const durationRE=/^(?:\d+(?:s|m|h|d)|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)$/;

export function hostAdoptScript(p:Project):string {
  const user=p.host!.ssh.split('@')[0];
  return `set -eu
user=$(id -un)
group=$(id -gn)
sudo -n install -d -m 0750 -o "$user" -g "$group" /opt/groma
sudo -n install -d -m 0755 /etc/caddy/groma
command -v docker >/dev/null
docker info >/dev/null
docker compose version >/dev/null
command -v caddy >/dev/null
test -f /etc/caddy/Caddyfile
if ! grep -Fxq 'import /etc/caddy/groma/*.caddy' /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/groma/*.caddy\n' | sudo -n tee -a /etc/caddy/Caddyfile >/dev/null
fi
sudo -n caddy validate --config /etc/caddy/Caddyfile
sudo -n systemctl reload caddy
printf 'Shared host adopted for GROMa. Docker access verified for ${user}; firewall and unrelated proxy configuration were not changed.\n'
`;
}

export function streamLogs(p:Project,service:string|undefined,options:{follow:boolean;tail:number;since?:string}):void {
  if(service&&!Object.hasOwn(p.services,service)) throw new Error(`Unknown service: ${service}`);
  if(options.since&&!durationRE.test(options.since)) throw new Error('--since must be a Docker duration such as 30m/2h or an RFC3339 UTC timestamp');
  if(p.target==='kubernetes') {
    if(!service) throw new Error('Kubernetes logs requires a service name');
    const args=['--context',p.kubernetes!.context,'-n',projectName(p),'logs',`deployment/${service}`,`--tail=${options.tail}`];
    if(options.follow) args.push('--follow'); if(options.since) args.push(options.since.includes('T')?'--since-time':'--since',options.since);
    run('kubectl',args,undefined,false); return;
  }
  const root=`/opt/groma/${projectName(p)}`;
  const flags=['logs','--no-color',`--tail=${options.tail}`,...(options.follow?['--follow']:[]),...(options.since?['--since',options.since]:[]),...(service?[service]:[])];
  const command=`set -eu; root=${quote(root)}; test -f "$root/current/compose.yaml"; files=(-f "$root/current/compose.yaml"); [ ! -f "$root/current/images.lock.yaml" ] || files+=( -f "$root/current/images.lock.yaml" ); [ ! -f "$root/current/secret-env.override.json" ] || files+=( -f "$root/current/secret-env.override.json" ); exec docker compose --project-name ${quote(projectName(p))} --project-directory "$root/current" "\${files[@]}" ${flags.map(quote).join(' ')}`;
  directSsh(p,command,undefined,false);
}

export function readLogs(p:Project,service:string|undefined,options:{tail:number;since?:string}):string {
  if(service&&!Object.hasOwn(p.services,service)) throw new Error(`Unknown service: ${service}`);
  if(options.since&&!durationRE.test(options.since)) throw new Error('--since must be a Docker duration such as 30m/2h or an RFC3339 UTC timestamp');
  if(p.target==='kubernetes') {
    if(!service) throw new Error('Kubernetes logs requires a service name');
    const args=['--context',p.kubernetes!.context,'-n',projectName(p),'logs',`deployment/${service}`,`--tail=${options.tail}`];
    if(options.since) args.push(options.since.includes('T')?'--since-time':'--since',options.since); return run('kubectl',args,undefined,true);
  }
  const root=`/opt/groma/${projectName(p)}`; const flags=['logs','--no-color',`--tail=${options.tail}`,...(options.since?['--since',options.since]:[]),...(service?[service]:[])];
  const command=`set -eu; root=${quote(root)}; test -f "$root/current/compose.yaml"; files=(-f "$root/current/compose.yaml"); [ ! -f "$root/current/images.lock.yaml" ] || files+=( -f "$root/current/images.lock.yaml" ); [ ! -f "$root/current/secret-env.override.json" ] || files+=( -f "$root/current/secret-env.override.json" ); docker compose --project-name ${quote(projectName(p))} --project-directory "$root/current" "\${files[@]}" ${flags.map(quote).join(' ')}`;
  return directSsh(p,command,undefined,true);
}

export function execService(p:Project,service:string,args:string[]):void {
  if(!Object.hasOwn(p.services,service)) throw new Error(`Unknown service: ${service}`);
  if(!args.length) throw new Error('exec requires a command after --');
  if(args.some(v=>v.includes('\0'))) throw new Error('exec arguments cannot contain NUL');
  if(p.target==='kubernetes') { run('kubectl',['--context',p.kubernetes!.context,'-n',projectName(p),'exec','-i',`deployment/${service}`,'--',...args],undefined,false); return; }
  const root=`/opt/groma/${projectName(p)}`;
  const command=`set -eu; root=${quote(root)}; test -f "$root/current/compose.yaml"; files=(-f "$root/current/compose.yaml"); [ ! -f "$root/current/images.lock.yaml" ] || files+=( -f "$root/current/images.lock.yaml" ); [ ! -f "$root/current/secret-env.override.json" ] || files+=( -f "$root/current/secret-env.override.json" ); exec docker compose --project-name ${quote(projectName(p))} --project-directory "$root/current" "\${files[@]}" exec -T -- ${quote(service)} ${args.map(quote).join(' ')}`;
  directSsh(p,command,undefined,false);
}

export function secretSet(p:Project,name:string,value:Buffer):void {
  if(p.target!=='compose') throw new Error('secret set currently requires the Compose target; manage Kubernetes Secrets with your cluster secret workflow');
  const secret=p.secrets?.[name]; if(!secret?.file) throw new Error(`Unknown Compose secret: ${name}`);
  if(!value.length) throw new Error('Refusing to provision an empty secret');
  if(value.includes(0)) throw new Error('Secret values cannot contain NUL bytes');
  const directory=secret.file.slice(0,secret.file.lastIndexOf('/'))||'/';
  const command=`set -eu; umask 077; if [ ! -d ${quote(directory)} ]; then sudo -n install -d -m 700 -o "$(id -un)" -g "$(id -gn)" ${quote(directory)}; fi; test -w ${quote(directory)}; tmp=${quote(secret.file+'.tmp')}.$$; trap 'rm -f "$tmp"' EXIT; cat > "$tmp"; test -s "$tmp"; chmod 0400 "$tmp"; mv -f "$tmp" ${quote(secret.file)}; trap - EXIT`;
  directSsh(p,command,value.toString('utf8'),false);
}
export function secretList(p:Project):Array<{name:string;mode:string|null;mtime:string|null;missing:boolean}> {
  if(p.target!=='compose') throw new Error('secret list currently requires the Compose target');
  const items=Object.entries(p.secrets ?? {}).map(([name,value])=>({name,path:value.file}));
  const script=`set -eu\npython3 - ${quote(encoded(JSON.stringify(items)))} <<'PY'\nimport base64,json,os,stat,sys,time\nitems=json.loads(base64.b64decode(sys.argv[1],validate=True))\nout=[]\nfor item in items:\n p=item['path']\n try:\n  st=os.stat(p,follow_symlinks=False)\n  if not stat.S_ISREG(st.st_mode): raise OSError('not regular')\n  out.append({'name':item['name'],'mode':format(stat.S_IMODE(st.st_mode),'04o'),'mtime':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(st.st_mtime)),'missing':False})\n except OSError: out.append({'name':item['name'],'mode':None,'mtime':None,'missing':True})\nprint(json.dumps(out))\nPY\n`;
  return JSON.parse(ssh(p,script,true));
}

export function releaseHistory(p:Project):any[] {
  if(p.target!=='compose') throw new Error('releases currently requires the Compose target');
  const root=`/opt/groma/${projectName(p)}`;
  const script=`set -eu\npython3 - ${quote(root)} ${quote(projectName(p))} <<'PY'\nimport json,pathlib,sys\nroot=pathlib.Path(sys.argv[1]); project=sys.argv[2]\nreleases=root/'releases'\nif not releases.is_dir() or releases.is_symlink(): print('[]'); raise SystemExit\ndef pointer(name):\n p=root/name\n try: return p.resolve(strict=True).name if p.is_symlink() else None\n except OSError: return None\ncurrent,previous=pointer('current'),pointer('previous')\nout=[]\nfor directory in releases.iterdir():\n if directory.is_symlink() or not directory.is_dir(): continue\n try:\n  data=json.loads((directory/'release.json').read_text())\n  if data.get('project')!=project or data.get('release')!=directory.name: continue\n  out.append({'release':directory.name,'deployedAt':data.get('deployedAt'),'deployedBy':data.get('deployedBy','unknown'),'images':data.get('images',{}),'active':directory.name==current,'previous':directory.name==previous})\n except (OSError,ValueError): continue\nout.sort(key=lambda x:x['release'],reverse=True)\nprint(json.dumps(out))\nPY\n`;
  return JSON.parse(ssh(p,script,true));
}

export function resolveImages(p:Project):Record<string,string> {
  if(p.target==='kubernetes') {
    const result:Record<string,string>={};
    for(const [name,service] of Object.entries(p.services)) {
      if(/@sha256:[a-f0-9]{64}$/.test(service.image)) {result[name]=service.image;continue;}
      const output=run('docker',['buildx','imagetools','inspect',service.image],undefined,true);
      const digest=output.match(/^Digest:\s+(sha256:[a-f0-9]{64})$/m)?.[1];
      if(!digest) throw new Error(`Could not resolve image digest for ${name}; docker buildx imagetools inspect must be available`);
      result[name]=service.image.replace(/(?::[^/@]+)?$/, '')+'@'+digest;
    }
    return result;
  }
  const compose=renderCompose(p); const name=projectName(p);
  const script=`set -eu\ntmp=$(mktemp -d)\ntrap 'rm -rf "$tmp"' EXIT\nprintf '%s' ${quote(encoded(compose))} | base64 -d > "$tmp/compose.yaml"\ndocker compose --project-name ${quote(name)} --project-directory "$tmp" -f "$tmp/compose.yaml" config --lock-image-digests > "$tmp/lock.yaml"\ntest -s "$tmp/lock.yaml"\ndocker compose --project-name ${quote(name)} --project-directory "$tmp" -f "$tmp/compose.yaml" -f "$tmp/lock.yaml" config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); print(json.dumps({k:v["image"] for k,v in c["services"].items()}))'\n`;
  return JSON.parse(ssh(p,script,true));
}
export function makeImageLock(p:Project,resolved:Record<string,string>,now=new Date()):ImageLock {
  const timestamp=now.toISOString(); const services:ImageLock['services']={};
  for(const [name,service] of Object.entries(p.services)) services[name]={tag:service.image,image:resolved[name]??service.image,resolvedAt:timestamp};
  return {schemaVersion:1,environment:p.environment,generatedAt:timestamp,services};
}
export function pinImages(configFile:string,p:Project,check=false):{file:string;stale:string[];lock:ImageLock} {
  const resolved=resolveImages(p); const existing=readImageLock(configFile); const next=makeImageLock(p,resolved);
  const stale=Object.keys(p.services).filter(name=>!existing?.services[name]||existing.services[name].tag!==p.services[name].image||existing.services[name].image!==resolved[name]);
  const file=require('./config').imageLockPath(configFile) as string;
  if(!check) writeImageLock(configFile,next);
  return {file,stale,lock:next};
}
export function imageLockDrift(configFile:string,p:Project):string[] {
  const lock=readImageLock(configFile); if(!lock) return Object.values(p.services).some(service=>!/@sha256:[a-f0-9]{64}$/.test(service.image))?['image lockfile is missing']:[];
  const resolved=resolveImages(p); return Object.keys(p.services).filter(name=>lock.services[name]?.tag!==p.services[name].image||lock.services[name]?.image!==resolved[name]);
}

export function volumeAdoptionWarnings(p:Project):string[] {
  if(p.target!=='compose') return [];
  const candidates:Object[]=[];
  for(const [service,s] of Object.entries(p.services)) for(const volume of s.volumes ?? []) if(volume.mode==='persistent'&&!volume.external) candidates.push({key:`${service}-${volume.name}`,desired:`${projectName(p)}_${service}-${volume.name}`});
  if(!candidates.length) return [];
  const output=ssh(p,"set -eu\ndocker volume ls --format '{{.Name}}'\n",true); const existing=new Set(output.split(/\r?\n/).filter(Boolean)); const warnings:string[]=[];
  for(const item of candidates as Array<{key:string;desired:string}>) if(!existing.has(item.desired)) {
    const matches=[...existing].filter(name=>name===item.key||name.endsWith('_'+item.key));
    if(matches.length) warnings.push(`persistent volume ${item.key} will be created empty; possible existing volume(s): ${matches.join(', ')}. Set volumes[].external to adopt intentionally.`);
  }
  return warnings;
}
