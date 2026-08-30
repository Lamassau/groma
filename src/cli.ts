#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { randomBytes } from 'crypto';
import { loadProject, Project, projectName, validateProject } from './deployment/config';
import { renderCompose, renderKubernetes, renderCaddy } from './deployment/render';
import { deployScript, doctorScript, operationScript, run, ssh } from './deployment/remote';
import { hostSetupScript } from './deployment/host';
import { guidedProject, starterProject, serializeProject, InitOptions } from './deployment/init';
import { verifyProject } from './deployment/verify';
import { snapshot, buildPlan, formatPlan, enforcePlan, remoteOperation } from './deployment/operations';

export const help = `GROMa — application deployment to Compose hosts or Kubernetes

  groma init [--interactive|--no-interactive] [--target compose|kubernetes]
  groma validate [--config groma.yaml] [--env dev]
  groma synth [--out dist]
  groma doctor
  groma verify [--wait 120] [--timeout 10] [--min-cert-days 7]
  groma apps [--host user@hostname]      Host-wide versions, URLs, health and resources
  groma plan                           Resolve image digests and preview changes
  groma deploy --yes --expect-target user@host|context
  groma start|stop --yes --expect-target user@host
  groma prune [--keep 5] [--min-age-hours 24]   Preview old release cleanup
  groma prune --execute --yes --expect-target user@host
  groma status
  groma logs [service]                  Last 100 lines; application output may contain secrets
  groma rollback --yes --expect-target user@host
  groma host setup [--execute --yes --expect-target user@host]

Common: --config PATH, --env NAME, --json, --image SERVICE=IMAGE (repeatable).
Deploy: --allow-service-removal, --allow-storage-change, --skip-verify (non-production only).
Stop: --allow-ephemeral-loss explicitly acknowledges tmpfs data loss.
Init: --name, --host, --ssh-port, --context, --domain, --port, --host-port, --replicas,
      --health-path, --health-command JSON, --database none|postgres|mysql,
      --storage ephemeral|persistent, --secret-file PATH.
No cloud provisioning or DNS changes. Secret values never belong in YAML.
`;
export function starter(target: string, name: string): string {
  return serializeProject(starterProject({target,name}));
}
function requireTarget(p: Project, values: Record<string, any>): void {
  const target = p.target === 'compose' ? p.host!.ssh : p.kubernetes!.context;
  if (!values.yes || values['expect-target'] !== target) throw new Error(`Mutation requires --yes --expect-target ${target}`);
}
function number(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) throw new Error(`Expected integer ${min}–${max}, received ${value}`);
  return Number(value);
}
function images(values: string[] | undefined): Record<string,string> {
  const result: Record<string,string> = Object.create(null);
  for (const value of values ?? []) {
    const equal=value.indexOf('=');
    if (equal<1 || equal===value.length-1) throw new Error('--image requires SERVICE=IMAGE');
    const service=value.slice(0,equal);
    if (Object.hasOwn(result,service)) throw new Error(`Duplicate image override: ${service}`);
    result[service]=value.slice(equal+1);
  }
  return result;
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const {values,positionals} = parseArgs({args:argv,allowPositionals:true,options:{
    config:{type:'string',default:'groma.yaml'},env:{type:'string'},out:{type:'string',default:'dist'},
    target:{type:'string',default:'compose'},name:{type:'string',default:'my-app'},yes:{type:'boolean'},execute:{type:'boolean'},
    'expect-target':{type:'string'},json:{type:'boolean'},help:{type:'boolean'},interactive:{type:'boolean'},'no-interactive':{type:'boolean'},
    host:{type:'string'},'ssh-port':{type:'string'},context:{type:'string'},image:{type:'string',multiple:true},domain:{type:'string'},
    port:{type:'string'},'host-port':{type:'string'},'health-path':{type:'string'},'health-command':{type:'string'},
    database:{type:'string'},storage:{type:'string'},'secret-file':{type:'string'},
    replicas:{type:'string'},
    wait:{type:'string'},timeout:{type:'string'},'min-cert-days':{type:'string'},keep:{type:'string'},'min-age-hours':{type:'string'},
    'allow-service-removal':{type:'boolean'},'allow-storage-change':{type:'boolean'},'skip-verify':{type:'boolean'},'allow-ephemeral-loss':{type:'boolean'},
  }});
  const command = positionals[0];
  if (!command || values.help) { console.log(help); return; }
  if (values.interactive && values['no-interactive']) throw new Error('Choose --interactive or --no-interactive');
  if (command === 'init') {
    if (fs.existsSync(values.config!)) throw new Error(`Refusing to overwrite ${values.config}`);
    const opts: InitOptions = {target:values.target,name:values.name,environment:values.env,host:values.host,context:values.context,
      sshPort:number(values['ssh-port'],22,1,65535),port:number(values.port,80,1,65535),hostPort:number(values['host-port'],18080,1024,65535),
      image:images(values.image).web,domain:values.domain,healthPath:values['health-path'],
      healthCommand:values['health-command'] ? JSON.parse(values['health-command']) : undefined,
      database:values.database,storage:values.storage,secretFile:values['secret-file'],replicas:number(values.replicas,1,1,1000)};
    const interactive=values.interactive || (!values['no-interactive'] && process.stdin.isTTY && process.stdout.isTTY && !values.json);
    const p=interactive ? await guidedProject(opts) : starterProject(opts);
    for (const service of Object.keys(images(values.image))) if(service!=='web') throw new Error('init supports --image web=IMAGE; add other services in the wizard or config');
    fs.writeFileSync(values.config!,serializeProject(p),{flag:'wx',mode:0o600});
    console.log(values.json ? JSON.stringify({created:values.config,project:projectName(p)}) : `Created ${values.config}. Provision secret files if selected, then run doctor, plan and deploy. Healthcheck executables must exist inside your image.`);
    return;
  }
  const p = command === 'apps' && values.host ? validateProject({schemaVersion:1,name:'host',environment:'dev',profile:'shared-dev',target:'compose',host:{ssh:values.host,port:number(values['ssh-port'],22,1,65535)},services:{placeholder:{image:'busybox:1.37'}}})
    : loadProject(values.config!,values.env,images(values.image));
  const target = p.target === 'compose' ? p.host!.ssh : p.kubernetes!.context;
  const report = {project:projectName(p),target,type:p.target,profile:p.profile,urls:Object.values(p.services).filter(s=>s.route).map(s=>`https://${s.route!.domain}`)};
  const emit = (data: unknown, human?: string) => console.log(values.json ? JSON.stringify(data) : human ?? JSON.stringify(data,null,2));
  const verificationOptions = {waitMs:number(values.wait,command==='verify' ? 0 : 120,0,600)*1000,
    timeoutMs:number(values.timeout,10,1,60)*1000,minCertificateDays:number(values['min-cert-days'],7,0,365)};
  if (values['skip-verify'] && p.profile === 'production') throw new Error('Production deployments cannot skip public verification');
  if (command === 'validate') { emit({...report,valid:true},`Valid: ${report.project} → ${target}`); return; }
  if (command === 'verify') {
    const verification=await verifyProject(p,verificationOptions);
    emit({...report,verification}); if(!verification.ok) process.exitCode=1; return;
  }
  if (command === 'host') {
    if (positionals[1] !== 'setup' || p.target !== 'compose') throw new Error('Use host setup with a Compose project');
    const script=hostSetupScript(p);
    if(values.execute) {requireTarget(p,values);ssh(p,script);} else console.log(script);
    return;
  }
  if(['apps','start','stop','prune'].includes(command)) {
    if(p.target!=='compose') throw new Error(`${command} currently requires the Compose target`);
    if(command==='start'||command==='stop'||command==='prune'&&values.execute) requireTarget(p,values);
    const data=remoteOperation(p,command,{execute:values.execute ?? false,keep:number(values.keep,5,2,1000),minAgeHours:number(values['min-age-hours'],24,0,87600),allowEphemeralLoss:values['allow-ephemeral-loss'] ?? false});
    if(command==='apps' && !values.json) {
      console.log(`Applications on ${target}`);
      if(data.host) console.log(`Host: ${data.host.cpus} CPUs | RAM available ${Math.round(data.host.memoryBytes.MemAvailable/1048576)} MiB | disk free ${Math.round(data.host.diskBytes.free/1073741824)} GiB`);
      for(const app of data.apps) {
        console.log(`\n${app.project} — ${app.error ?? app.release}`);
        if(app.urls) console.log(`  ${app.urls.join(', ') || '(no public routes)'}`);
        for(const s of app.services ?? []) console.log(`  ${s.name}: ${s.state}/${s.health} | CPU ${s.cpu ?? 'n/a'} | RAM ${s.memory ?? 'n/a'} | ${s.image}`);
      }
      if(!data.apps.length) console.log('No managed applications found.');
    } else emit(data);
    return;
  }
  if (!['synth','doctor','plan','deploy','status','logs','rollback'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const manifest=p.target==='compose'?renderCompose(p):renderKubernetes(p);
  if(command==='synth') {
    const out=path.resolve(values.out!);fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,p.target==='compose'?'compose.yaml':'kubernetes.yaml'),manifest);
    if(p.target==='compose') fs.writeFileSync(path.join(out,'route.caddy'),renderCaddy(p));
    emit({...report,out},`Generated ${out}`);return;
  }
  if(command==='deploy'||command==='rollback') requireTarget(p,values);
  if(p.target==='compose') {
    if(command==='doctor') {emit({...report,healthy:true,output:ssh(p,doctorScript(p),true)});return;}
    if(command==='plan'||command==='deploy') {
      const data=snapshot(p),plan=buildPlan(p,data);
      if(command==='plan') {emit(plan,formatPlan(plan));return;}
      if(!values.json) console.log(formatPlan(plan));
      enforcePlan(plan,!!values['allow-service-removal'],!!values['allow-storage-change']);
      ssh(p,doctorScript(p),true);
      const release=`${Date.now()}-${randomBytes(4).toString('hex')}`;
      const output=ssh(p,deployScript(p,release,false,{imageLock:data.imageLock,currentRelease:data.currentRelease}),true);
      const verification=values['skip-verify'] ? {ok:true,skipped:true,endpoints:[]} : await verifyProject(p,verificationOptions);
      emit({...report,release,deployed:true,plan,verification,output});
      if(!verification.ok) {process.exitCode=1;if(!values.json) console.error('Containers deployed, but public verification failed. The active release is retained; inspect DNS/TLS/health or explicitly roll back.');}
      return;
    }
    if(command==='rollback') {
      ssh(p,doctorScript(p),true);
      const output=ssh(p,deployScript(p,`${Date.now()}`,true),true);
      const active=remoteOperation(p,'active');
      // Older releases lack health-path metadata; don't claim their public verification succeeded.
      const verification=active.config && !values['skip-verify'] ? await verifyProject(validateProject(active.config),verificationOptions) : {ok:true,skipped:true,endpoints:[]};
      emit({...report,release:active.release,rolledBack:true,verification,output});
      if(!verification.ok) process.exitCode=1;
      return;
    }
    emit({...report,output:ssh(p,operationScript(p,command as 'status'|'logs',positionals[1]),true)});return;
  }
  const args=['--context',p.kubernetes!.context],service=positionals[1];
  if(service&&!Object.hasOwn(p.services,service)) throw new Error(`Unknown service: ${service}`);
  const kubectl=(more:string[],input?:string)=>run('kubectl',[...args,...more],input,true);
  let output='';
  switch(command) {
    case 'doctor': output=kubectl(['cluster-info']);break;
    case 'plan': {
      const {spawnSync}=require('child_process');
      const r=spawnSync('kubectl',[...args,'diff','-f','-'],{input:manifest,encoding:'utf8'});
      if(r.error||r.status===null||r.status>1) throw new Error(r.error?.message??r.stderr);
      output=r.stdout;break;
    }
    case 'deploy': {
      output=kubectl(['apply','-f','-'],manifest);
      for(const n of Object.keys(p.services)) output+=kubectl(['-n',projectName(p),'rollout','status',`deployment/${n}`,'--timeout=120s']);
      const verification=values['skip-verify']?{ok:true,skipped:true,endpoints:[]}:await verifyProject(p,verificationOptions);
      emit({...report,deployed:true,verification,output});if(!verification.ok) process.exitCode=1;return;
    }
    case 'status':output=kubectl(['-n',projectName(p),'get','deployments,pods,services,ingresses','-o','json']);break;
    case 'logs':if(!service)throw new Error('Kubernetes logs requires a service name');output=kubectl(['-n',projectName(p),'logs',`deployment/${service}`,'--tail=100']);break;
    case 'rollback': {
      const rollbackable = Object.entries(p.services).filter(([,service]) => !(service.volumes ?? []).some(volume => volume.mode === 'persistent')).map(([name]) => name);
      const skipped = Object.entries(p.services).filter(([,service]) => (service.volumes ?? []).some(volume => volume.mode === 'persistent')).map(([name]) => name);
      if (!rollbackable.length) throw new Error('Kubernetes rollback skipped: all services declare persistent volumes. Roll back manually with a reviewed manifest/image set.');
      for (const n of rollbackable) {
        output+=kubectl(['-n',projectName(p),'rollout','undo',`deployment/${n}`]);
        output+=kubectl(['-n',projectName(p),'rollout','status',`deployment/${n}`,'--timeout=120s']);
      }
      if (skipped.length) output += `\nSkipped rollback for persistent-volume services: ${skipped.join(', ')}\n`;
      const verification=values['skip-verify']?{ok:true,skipped:true,endpoints:[]}:await verifyProject(p,verificationOptions);
      emit({...report,rolledBack:true,verification,output});if(!verification.ok) process.exitCode=1;return;
    }
  }
  emit({...report,output});
}
if(require.main===module) main().catch(error=>{
  const message=error instanceof Error?error.message:String(error);
  console.error(process.argv.includes('--json')?JSON.stringify({error:message}):message);process.exitCode=1;
});
