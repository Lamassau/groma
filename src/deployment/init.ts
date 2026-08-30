import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { dump } from 'js-yaml';
import { Project, AppService, validateProject } from './config';

export interface InitOptions {
  target?: string; name?: string; environment?: string; host?: string; sshPort?: number;
  context?: string; image?: string; domain?: string; port?: number; hostPort?: number;
  healthPath?: string; healthCommand?: string[]; database?: string; storage?: string; secretFile?: string;
}
export type Ask = (id: string, question: string, initial: string) => Promise<string>;
export function starterProject(options: InitOptions = {}): Project {
  const name = options.name ?? 'my-app';
  const target = options.target ?? 'compose';
  const p: any = {
    schemaVersion: 1, name, environment: options.environment ?? 'dev', profile: 'shared-dev', target,
    ...(target === 'compose' ? {host: {ssh: options.host ?? 'deploy@your-droplet.example.com', ...(options.sshPort ? {port:options.sshPort} : {})}}
      : {kubernetes: {context: options.context ?? 'your-context', ingressClass: 'nginx'}}),
    services: {web: {
      image: options.image ?? 'nginx:1.28-alpine', port: options.port ?? 80,
      healthcheck: options.healthCommand ?? ['wget','-q','-O','/dev/null',`http://127.0.0.1:${options.port ?? 80}${options.healthPath ?? '/'}`],
      route: {domain:options.domain ?? `${name}.example.com`, healthPath:options.healthPath ?? '/',
        ...(target === 'compose' ? {hostPort:options.hostPort ?? 18080} : {})},
    }},
  };
  addDatabase(p, options.database ?? 'none', options.storage ?? 'ephemeral', options.secretFile);
  return validateProject(p);
}
function addDatabase(p: Project, database: string, storage: string, secretFile?: string): void {
  if (!['none','postgres','mysql'].includes(database)) throw new Error('Database must be none, postgres or mysql');
  if (database === 'none') return;
  if (!['persistent','ephemeral'].includes(storage)) throw new Error('Storage must be persistent or ephemeral');
  if (Object.hasOwn(p.services,'database')) throw new Error('The name database is reserved for the selected database preset');
  p.secrets = {'db-password': p.target === 'compose'
    ? {file:secretFile ?? `/opt/groma-secrets/${p.name}/db-password`}
    : {secretName:`${p.name}-database`,key:'password'}};
  if (database === 'mysql') p.secrets['db-root-password'] = p.target === 'compose'
    ? {file:(secretFile ?? `/opt/groma-secrets/${p.name}/db-password`) + '.root'}
    : {secretName:`${p.name}-database`,key:'root-password'};
  p.services.database = database === 'postgres' ? {
    image:'postgres:17-alpine', environment:{POSTGRES_USER:p.name,POSTGRES_DB:p.name,POSTGRES_PASSWORD_FILE:'/run/secrets/db-password'},
    secrets:['db-password'], healthcheck:['pg_isready','-U',p.name,'-d',p.name],
    volumes:[{name:'data',mount:'/var/lib/postgresql/data',mode:storage as any,...(p.target === 'kubernetes' && storage === 'persistent' ? {size:'5Gi'} : {})}],
    resources:{cpu:0.5,memory:'512Mi'},
  } : {
    image:'mysql:8.4',environment:{MYSQL_DATABASE:p.name,MYSQL_USER:p.name,MYSQL_PASSWORD_FILE:'/run/secrets/db-password',MYSQL_ROOT_PASSWORD_FILE:'/run/secrets/db-root-password'},
    secrets:['db-password','db-root-password'],healthcheck:['mysqladmin','ping','-h','127.0.0.1','--silent'],
    volumes:[{name:'data',mount:'/var/lib/mysql',mode:storage as any,...(p.target === 'kubernetes' && storage === 'persistent' ? {size:'5Gi'} : {})}],
    resources:{cpu:0.5,memory:'512Mi'},
  };
}

/** Prompt dependency is injectable so the complete wizard is testable without a terminal. */
export async function guidedProject(options: InitOptions = {}, providedAsk?: Ask): Promise<Project> {
  const terminal = providedAsk ? undefined : createInterface({input:stdin,output:stdout});
  const ask: Ask = providedAsk ?? (async (_id, question, initial) => {
    const value = (await terminal!.question(`${question}${initial ? ` [${initial}]` : ''}: `)).trim();
    return value || initial;
  });
  const checked = async (id: string, question: string, initial: string, valid: (s: string) => boolean, error: string) => {
    for (;;) {
      const answer = (await ask(id, question, initial)).trim();
      if (valid(answer)) return answer;
      if (!providedAsk) stdout.write(`${error}\n`);
      else throw new Error(`${id}: ${error}`);
    }
  };
  const nameCheck = (s: string) => /^[a-z][a-z0-9-]{0,29}$/.test(s);
  const integer = (min: number, max: number) => (s: string) => /^\d+$/.test(s) && Number(s) >= min && Number(s) <= max;
  try {
    const target = await checked('target','Deployment target',options.target ?? 'compose',s=>['compose','kubernetes'].includes(s),'Choose compose or kubernetes');
    const name = await checked('name','Application name',options.name ?? 'my-app',nameCheck,'Use lowercase letters, digits and hyphens, starting with a letter (max 30)');
    const environment = await checked('environment','Environment name',options.environment ?? 'dev',nameCheck,'Invalid environment name');
    const p: Project = {schemaVersion:1,name,environment,profile:'shared-dev',target:target as any,services:{}};
    if (target === 'compose') {
      const ssh = await checked('host','SSH target (existing account)',options.host ?? 'deploy@your-droplet.example.com',s=>/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(s),'Use user@hostname');
      const port = Number(await checked('sshPort','SSH port',String(options.sshPort ?? 22),integer(1,65535),'Invalid SSH port'));
      p.host={ssh,port};
    } else p.kubernetes={context:await checked('context','Existing Kubernetes context',options.context ?? 'your-context',s=>/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(s),'Invalid context')};
    let index = 0;
    do {
      const service = await checked(`service.${index}.name`,'Service name',index === 0 ? 'web' : 'worker',s=>nameCheck(s) && !Object.hasOwn(p.services,s),'Invalid or duplicate service name');
      const image = await checked(`service.${index}.image`,'Container image',options.image ?? 'nginx:1.28-alpine',s=>/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]+$/.test(s),'Invalid image reference');
      const s: AppService = {image};
      const publicRoute = await checked(`service.${index}.public`,'Expose through public HTTPS? (yes/no)',index === 0 ? 'yes':'no',s=>['yes','no'].includes(s),'Choose yes or no');
      if (publicRoute === 'yes') {
        s.port=Number(await checked(`service.${index}.port`,'Container HTTP port',String(options.port ?? 80),integer(1,65535),'Invalid port'));
        const domain=await checked(`service.${index}.domain`,'Public domain',options.domain ?? (index === 0 ? `${name}.example.com` : `${service}.${name}.example.com`),s=>/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(s),'Use a DNS hostname');
        const healthPath=await checked(`service.${index}.healthPath`,'Public health URL path',options.healthPath ?? '/',s=>/^\/(?!\/)[^\s#]*$/.test(s),'Use an absolute path such as /health');
        s.route={domain,healthPath};
        if (target === 'compose') s.route.hostPort=Number(await checked(`service.${index}.hostPort`,'Unused loopback host port',String((options.hostPort ?? 18080)+index),integer(1024,65535),'Invalid host port'));
      }
      const initialCommand=options.healthCommand ?? (s.port ? ['wget','-q','-O','/dev/null',`http://127.0.0.1:${s.port}${s.route?.healthPath ?? '/'}`] : []);
      const health=await checked(`service.${index}.healthCommand`,'Health command JSON array (executable must exist in image; [] disables)',JSON.stringify(initialCommand),value=>{
        try { const a=JSON.parse(value); return Array.isArray(a) && a.every(v=>typeof v==='string' && v.length>0); } catch { return false; }
      },'Use a JSON array of command arguments');
      const parsed=JSON.parse(health); if(parsed.length) s.healthcheck=parsed;
      p.services[service]=s;
      index++;
    } while (await checked('another','Add another service? (yes/no)','no',s=>['yes','no'].includes(s),'Choose yes or no') === 'yes');
    const database=await checked('database','Database preset (none/postgres/mysql)',options.database ?? 'none',s=>['none','postgres','mysql'].includes(s),'Choose none, postgres or mysql');
    let storage='ephemeral',secretFile=options.secretFile;
    if(database !== 'none') {
      storage=await checked('storage','Database storage (ephemeral loses data when stopped)',options.storage ?? 'ephemeral',s=>['ephemeral','persistent'].includes(s),'Choose ephemeral or persistent');
      if(target === 'compose') secretFile=await checked('secretFile','Existing host password-file path (no passwords are collected)',secretFile ?? `/opt/groma-secrets/${name}/db-password`,s=>/^\/[a-zA-Z0-9_./-]+$/.test(s) && !s.split('/').includes('..'),'Use an absolute host path');
    }
    addDatabase(p,database,storage,secretFile);
    return validateProject(p);
  } finally { terminal?.close(); }
}
export function serializeProject(p: Project): string { return dump(p,{noRefs:true,lineWidth:-1}); }
