#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { randomBytes } from 'crypto';
import { loadProject, Project, projectName } from './deployment/config';
import { renderCompose, renderKubernetes, renderCaddy } from './deployment/render';
import { deployScript, doctorScript, operationScript, run, ssh } from './deployment/remote';
import { hostSetupScript } from './deployment/host';

export const help = `GROMa — application deployment to Compose hosts or Kubernetes

  groma init [--target compose|kubernetes] [--name my-app]
  groma validate [--config groma.yaml] [--env dev]
  groma synth [--out dist]
  groma doctor
  groma plan                         Read-only comparison against the target
  groma deploy --yes --expect-target user@host|context
  groma status
  groma logs [service]                Last 100 lines; application output may contain secrets
  groma rollback --yes --expect-target user@host  Compose only; data is NOT rolled back
  groma host setup                    Print Ubuntu host setup script
  groma host setup --execute --yes --expect-target user@host

Common flags: --config PATH, --env NAME, --json. No registry publication or DNS changes.
Secret values belong in pre-provisioned host files or Kubernetes Secrets, never YAML.
`;
export function starter(target: string, name: string): string {
  if (!['compose','kubernetes'].includes(target)) throw new Error('Target must be compose or kubernetes');
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(name)) throw new Error('Invalid application name');
  return `schemaVersion: 1\nname: ${name}\nenvironment: dev\nprofile: shared-dev\ntarget: ${target}\n${target === 'compose' ? 'host:\n  ssh: deploy@your-droplet.example.com' : 'kubernetes:\n  context: your-context\n  ingressClass: nginx'}\nservices:\n  web:\n    image: nginx:1.28-alpine\n    port: 80\n    healthcheck: [wget, -q, -O, /dev/null, http://127.0.0.1/]\n    route:\n      domain: ${name}.example.com\n${target === 'compose' ? '      hostPort: 18080\n' : ''}`;
}
function requireTarget(p: Project, values: Record<string, any>) {
  const target = p.target === 'compose' ? p.host!.ssh : p.kubernetes!.context;
  if (!values.yes || values['expect-target'] !== target) throw new Error(`Mutation requires --yes --expect-target ${target}`);
}
export function main(argv = process.argv.slice(2)): void {
  const {values,positionals} = parseArgs({args:argv,allowPositionals:true,options:{config:{type:'string',default:'groma.yaml'},env:{type:'string'},out:{type:'string',default:'dist'},target:{type:'string',default:'compose'},name:{type:'string',default:'my-app'},yes:{type:'boolean'},execute:{type:'boolean'},'expect-target':{type:'string'},json:{type:'boolean'},help:{type:'boolean'}}});
  const command = positionals[0];
  if (!command || values.help) { console.log(help); return; }
  if (command === 'init') {
    fs.writeFileSync(values.config!,starter(values.target!,values.name!),{flag:'wx'});
    console.log(`Created ${values.config}. Set your target, images and domains, then run groma validate.`); return;
  }
  const p = loadProject(values.config!,values.env);
  const target = p.target === 'compose' ? p.host!.ssh : p.kubernetes!.context;
  const report = {project:projectName(p),target,type:p.target,profile:p.profile,urls:Object.values(p.services).filter(s=>s.route).map(s=>`https://${s.route!.domain}`)};
  if (command === 'validate') { console.log(values.json ? JSON.stringify({...report,valid:true}) : `Valid: ${report.project} → ${target}`); return; }
  if (command === 'host') {
    if (positionals[1] !== 'setup' || p.target !== 'compose') throw new Error('Use host setup with a Compose project');
    const script = hostSetupScript(p);
    if (values.execute) { requireTarget(p,values); ssh(p,script); } else console.log(script);
    return;
  }
  if (!['synth','doctor','plan','deploy','status','logs','rollback'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const manifest = p.target === 'compose' ? renderCompose(p) : renderKubernetes(p);
  if (command === 'synth') {
    const out = path.resolve(values.out!); fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,p.target === 'compose' ? 'compose.yaml':'kubernetes.yaml'),manifest);
    if (p.target === 'compose') fs.writeFileSync(path.join(out,'route.caddy'),renderCaddy(p));
    console.log(values.json ? JSON.stringify({...report,out}) : `Generated ${out}`); return;
  }
  if (command === 'deploy' || command === 'rollback') requireTarget(p,values);
  if (p.target === 'compose') {
    if (command === 'doctor') { const output = ssh(p,doctorScript(p),true); console.log(values.json ? JSON.stringify({...report,healthy:true,output}) : output); }
    else if (command === 'deploy' || command === 'rollback') {
      ssh(p,doctorScript(p),true);
      const release = `${Date.now()}-${randomBytes(4).toString('hex')}`;
      const output = ssh(p,deployScript(p,release,command === 'rollback'),true);
      console.log(values.json ? JSON.stringify({...report,success:true,output}) : `${command} complete: ${report.urls.join(', ')}`);
    } else {
      const output = ssh(p,operationScript(p,command as 'plan'|'status'|'logs',positionals[1]),true);
      console.log(values.json ? JSON.stringify({...report,output}) : `${report.project} → ${target}\n${output}`);
    }
    return;
  }
  const args = ['--context',p.kubernetes!.context];
  const service = positionals[1];
  if (service && !Object.hasOwn(p.services,service)) throw new Error(`Unknown service: ${service}`);
  const kubectl = (more: string[], input?: string) => run('kubectl',[...args,...more],input,true);
  let output = '';
  switch (command) {
    case 'doctor': output = kubectl(['cluster-info']); break;
    case 'plan': {
      // kubectl diff returns 1 for differences, >1 for errors.
      const {spawnSync} = require('child_process');
      const r = spawnSync('kubectl',[...args,'diff','-f','-'],{input:manifest,encoding:'utf8'});
      if (r.error || r.status === null || r.status > 1) throw new Error(r.error?.message ?? r.stderr);
      output = r.stdout; break;
    }
    case 'deploy':
      output = kubectl(['apply','-f','-'],manifest);
      for (const n of Object.keys(p.services)) output += kubectl(['-n',projectName(p),'rollout','status',`deployment/${n}`,'--timeout=120s']);
      break;
    case 'status': output = kubectl(['-n',projectName(p),'get','deployments,pods,services,ingresses','-o','json']); break;
    case 'logs':
      if (!service) throw new Error('Kubernetes logs requires a service name');
      output = kubectl(['-n',projectName(p),'logs',`deployment/${service}`,'--tail=100']); break;
    case 'rollback': throw new Error('Kubernetes rollback is not automated; redeploy a reviewed prior configuration. Database state is never rolled back.');
  }
  console.log(values.json ? JSON.stringify({...report,output}) : output);
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
