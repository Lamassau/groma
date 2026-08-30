import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { load, loadAll } from 'js-yaml';
import { loadProject, validateProject, Project } from '../src/deployment/config';
import { renderCompose, renderKubernetes, renderCaddy } from '../src/deployment/render';
import { deployScript, doctorScript, operationScript, quote } from '../src/deployment/remote';
import { hostSetupScript } from '../src/deployment/host';
import { starter, main } from '../src/cli';

const fixture = (): Project => validateProject(load(starter('compose','demo')));

describe('Deployment configuration boundary', () => {
  it('collects errors and rejects unsupported capabilities', () => {
    expect(()=>validateProject({schemaVersion:2,services:{web:{image:'bad image',replicas:2}}})).toThrow(/schemaVersion:[\s\S]*replicas:/);
  });
  it.each(['false',false,null,{},1])('rejects invalid service object %p', value => {
    const p: any = fixture(); p.services.web = value;
    expect(()=>validateProject(p)).toThrow(/services.web/);
  });
  it('rejects command injection in target and hostname', () => {
    const p = fixture(); p.host!.ssh = 'deploy@host;touch /tmp/pwned';
    expect(()=>validateProject(p)).toThrow(/host.ssh/);
    p.host!.ssh = 'deploy@host'; p.services.web.route!.domain = 'example.com { respond evil }';
    expect(()=>validateProject(p)).toThrow(/route.domain/);
  });
  it('requires real numbers, explicit storage modes and valid secrets', () => {
    const p: any = fixture(); p.services.web.port = '80';
    p.services.web.secrets = ['missing']; p.services.web.volumes = [{name:'data',mount:'/',mode:'maybe'}];
    expect(()=>validateProject(p)).toThrow(/port:[\s\S]*secrets:[\s\S]*volumes/);
  });
  it('rejects duplicated routes and dependency cycles', () => {
    const p = fixture(); p.services.api = structuredClone(p.services.web);
    expect(()=>validateProject(p)).toThrow(/duplicate domain/);
    delete p.services.api.route;
    p.services.api.dependsOn = ['web']; p.services.web.dependsOn = ['api'];
    expect(()=>validateProject(p)).toThrow(/dependency cycle/);
  });
  it('requires image digests in production', () => {
    const p = fixture(); p.profile = 'production';
    expect(()=>validateProject(p)).toThrow(/immutable/);
  });
  it('loads overlays relative to the config and fails on a missing environment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'groma-config-'));
    try {
      fs.writeFileSync(path.join(dir,'groma.yaml'),starter('compose','demo'));
      fs.mkdirSync(path.join(dir,'environments'));
      fs.writeFileSync(path.join(dir,'environments/staging.yaml'),'profile: shared-dev\nservices:\n  web:\n    resources: {cpu: 0.25, memory: 128Mi}\n');
      expect(loadProject(path.join(dir,'groma.yaml'),'staging').services.web.resources!.cpu).toBe(0.25);
      expect(()=>loadProject(path.join(dir,'groma.yaml'),'missing')).toThrow(/overlay not found/);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('does not execute a deployment without explicit matching target approval', () => {
    expect(()=>main(['deploy','--config','examples/compose/groma.yaml'])).toThrow(/expect-target/);
  });
});

describe('Target generation', () => {
  it('publishes only loopback route ports, escapes dollar interpolation and isolates storage', () => {
    const p = fixture(); p.services.web.environment = {LITERAL:'${SECRET} $HOME'};
    p.services.db = {image:'postgres:17-alpine',volumes:[{name:'data',mount:'/var/lib/postgresql/data',mode:'persistent'}]};
    p.services.cache = {image:'redis:7-alpine',volumes:[{name:'data',mount:'/data',mode:'ephemeral'}]};
    const c: any = load(renderCompose(validateProject(p)));
    expect(c.services.web.ports).toEqual(['127.0.0.1:18080:80']);
    expect(c.services.db.ports).toBeUndefined();
    expect(c.services.web.environment.LITERAL).toBe('$${SECRET} $$HOME');
    expect(c.volumes).toEqual({'db-data':{}});
    expect(c.services.cache.tmpfs).toEqual(['/data']);
    expect(c.services.web.volumes).toBeUndefined();
    expect(renderCaddy(p)).toContain('reverse_proxy 127.0.0.1:18080');
  });
  it('secret files remain references and are granted only to selected services', () => {
    const p = fixture(); p.secrets = {password:{file:'/opt/secrets/password'}}; p.services.db = {image:'postgres:17-alpine',secrets:['password']};
    const c: any = load(renderCompose(validateProject(p)));
    expect(c.secrets.password.file).toBe('/opt/secrets/password');
    expect(c.services.web.secrets).toBeUndefined();
  });
  it('supports arbitrary Kubernetes services without mandatory databases or Traefik CRDs', () => {
    const p = validateProject(load(starter('kubernetes','demo')));
    p.services.worker = {image:'busybox:1.37',command:['sleep','3600']};
    const docs: any[] = loadAll(renderKubernetes(p));
    expect(docs.filter(d=>d.kind==='Deployment')).toHaveLength(2);
    expect(docs.some(d=>d.kind==='IngressRoute')).toBe(false);
    expect(docs.some(d=>d.kind==='Secret')).toBe(false);
  });
});

describe('Remote script safety', () => {
  it('shell-quotes apostrophes and substitutions literally', () => {
    const value = "one'$(echo bad)";
    expect(spawnSync('bash',['-c',`printf '%s' ${quote(value)}`],{encoding:'utf8'}).stdout).toBe(value);
  });
  it('all generated scripts pass bash syntax checks', () => {
    const p = fixture();
    for (const script of [doctorScript(p),deployScript(p,'test'),deployScript(p,'test',true),operationScript(p,'plan'),operationScript(p,'status'),operationScript(p,'logs','web'),hostSetupScript(p)]) {
      const result = spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
      expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    }
  });
  it('refuses invalid release identifiers and unknown log services', () => {
    expect(()=>deployScript(fixture(),'../bad')).toThrow(/release/);
    expect(()=>operationScript(fixture(),'logs','unknown')).toThrow(/Unknown service/);
  });
});

/** Execute real generated Bash, replacing only machine paths and external executables. */
describe('Release transaction integration (simulated Docker and Caddy)', () => {
  let dir: string, root: string, env: NodeJS.ProcessEnv;
  const execute = (p: Project, id: string, rollback=false) => spawnSync('bash',['-se'],{
    input:deployScript(p,id,rollback).replaceAll('/opt/groma',root).replaceAll('/etc/caddy',path.join(dir,'caddy')),
    env,encoding:'utf8',
  });
  beforeEach(()=>{
    dir=fs.mkdtempSync(path.join(os.tmpdir(),'groma-release-')); root=path.join(dir,'apps');
    fs.mkdirSync(root); fs.mkdirSync(path.join(dir,'bin')); fs.mkdirSync(path.join(dir,'caddy/groma'),{recursive:true});
    const script=(name:string,body:string)=>fs.writeFileSync(path.join(dir,'bin',name),'#!/bin/bash\n'+body,{mode:0o755});
    script('docker',`if [[ "$*" == *'--lock-image-digests'* ]]; then echo 'services: {}'; fi\necho "$*" >> "$TEST_DIR/commands"\nif [[ "$*" == *' up '* && -f "$TEST_DIR/fail-health" ]]; then rm "$TEST_DIR/fail-health"; exit 1; fi\nexit 0\n`);
    script('sudo','[ "$1" = "-n" ] && shift\nexec "$@"\n');
    script('caddy',`if [ -f "$TEST_DIR/fail-proxy" ]; then rm "$TEST_DIR/fail-proxy"; exit 1; fi\nexit 0\n`);
    script('systemctl','exit 0\n'); script('ss','exit 0\n');
    env={...process.env,PATH:path.join(dir,'bin')+':'+process.env.PATH,TEST_DIR:dir};
  });
  afterEach(()=>fs.rmSync(dir,{recursive:true,force:true}));
  it('deploys, upgrades and rolls back while preserving release history', ()=>{
    const p=fixture();
    expect(execute(p,'first').status).toBe(0);
    p.services.web.image='nginx:1.28';
    expect(execute(p,'second').status).toBe(0);
    expect(fs.realpathSync(path.join(root,'demo-dev/current'))).toContain('second');
    expect(execute(p,'unused',true).status).toBe(0);
    expect(fs.realpathSync(path.join(root,'demo-dev/current'))).toContain('first');
  });
  it('does not advance the release after failed health checks or proxy validation', ()=>{
    const p=fixture(); expect(execute(p,'first').status).toBe(0);
    for (const failure of ['fail-health','fail-proxy']) {
      fs.writeFileSync(path.join(dir,failure),'');
      expect(execute(p,failure).status).not.toBe(0);
      expect(fs.realpathSync(path.join(root,'demo-dev/current'))).toContain('first');
      expect(fs.readFileSync(path.join(dir,'caddy/groma/demo-dev.caddy'),'utf8')).toBe(renderCaddy(p));
    }
  });
  it('rejects another project taking an existing domain or port', ()=>{
    const p=fixture(); expect(execute(p,'first').status).toBe(0);
    p.name='another';
    const result=execute(p,'second');
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('already owned');
  });
  it('allows two independent apps with distinct domains and ports', ()=>{
    const p=fixture(); expect(execute(p,'first').status).toBe(0);
    p.name='another'; p.services.web.route={domain:'another.example.com',hostPort:18081};
    expect(execute(p,'second').status).toBe(0);
    expect(fs.existsSync(path.join(root,'demo-dev/current'))).toBe(true);
    expect(fs.existsSync(path.join(root,'another-dev/current'))).toBe(true);
  });
  it('cleans up a failed first deployment without deleting volumes', ()=>{
    fs.writeFileSync(path.join(dir,'fail-health'),'');
    expect(execute(fixture(),'first').status).not.toBe(0);
    const commands=fs.readFileSync(path.join(dir,'commands'),'utf8');
    expect(commands).toContain(' down'); expect(commands).not.toContain('--volumes');
    expect(fs.existsSync(path.join(root,'demo-dev/current'))).toBe(false);
  });
});
