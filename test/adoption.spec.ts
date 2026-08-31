import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dump, load, loadAll } from 'js-yaml';
import { loadProject, validateProject, writeImageLock, Project } from '../src/deployment/config';
import { renderCaddy, renderCompose, renderKubernetes } from '../src/deployment/render';
import { deployScript } from '../src/deployment/remote';
import { hostAdoptScript, makeImageLock } from '../src/deployment/advanced';
import { importCompose } from '../src/deployment/import-compose';
import { help } from '../src/cli';

const composeProject=():Project=>validateProject({
  schemaVersion:1,name:'demo',environment:'dev',profile:'shared-dev',target:'compose',host:{ssh:'deploy@host.example.com'},
  services:{web:{image:'nginx:1.28-alpine',port:80,healthcheck:{http:'/health'},route:{domain:'demo.example.com',hostPort:18080}}},
});

describe('adoption-oriented schema and rendering',()=>{
  it('routes multiple services on one hostname with longest path first and rewrites safely',()=>{
    const p:any=composeProject();
    p.services.api={image:'nginx:1.28-alpine',port:8080,healthcheck:{http:'/health'},route:{domain:'demo.example.com',path:'/api',rewritePrefix:'/v1',hostPort:18081}};
    const valid=validateProject(p); const caddy=renderCaddy(valid);
    expect(caddy.indexOf('@groma_route_0 path /api /api/*')).toBeLessThan(caddy.indexOf('handle {'));
    expect(caddy).toContain('uri strip_prefix /api');expect(caddy).toContain('uri prepend /v1');
    p.services.other=structuredClone(p.services.api);p.services.other.route.hostPort=18082;
    expect(()=>validateProject(p)).toThrow(/duplicate domain\/path/);
    delete p.services.other;p.services.api.route.stripPathPrefix=true;
    expect(()=>validateProject(p)).toThrow(/mutually exclusive/);
  });
  it('prefixes verification health URLs for path-scoped routes',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'groma-route-'));
    try {
      const p:any=composeProject();p.services.web.route.path='/app';p.services.web.route.healthPath='/health';
      fs.writeFileSync(path.join(dir,'groma.yaml'),dump(p));
      expect(loadProject(path.join(dir,'groma.yaml')).services.web.route!.healthPath).toBe('/app/health');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  it('merges defaults with base/overlay precedence without reusing the environment-name field',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'groma-defaults-'));
    try {
      const p:any=composeProject();p.defaults={environment:{A:'base-default',B:'base-default'},resources:{cpu:.5,memory:'256Mi'}};p.services.web.environment={B:'base-service'};
      fs.writeFileSync(path.join(dir,'groma.yaml'),dump(p));fs.mkdirSync(path.join(dir,'environments'));
      fs.writeFileSync(path.join(dir,'environments/staging.yaml'),`defaults:\n  environment: {A: overlay-default, C: overlay-default}\n  resources: {memory: 512Mi}\nservices:\n  web:\n    environment: {B: overlay-service}\n`);
      const s=loadProject(path.join(dir,'groma.yaml'),'staging').services.web;
      expect(s.environment).toEqual({A:'overlay-default',B:'overlay-service',C:'overlay-default'});expect(s.resources).toEqual({cpu:.5,memory:'512Mi'});
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  it('uses the image lock for production validation while explicit image overrides still win',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'groma-lock-'));
    try {
      const p:any=composeProject();p.environment='production';p.profile='production';p.services.web.image='nginx:1.28-alpine';
      const file=path.join(dir,'groma.yaml');fs.writeFileSync(file,dump(p));
      const pinned='nginx@sha256:'+'a'.repeat(64);writeImageLock(file,{schemaVersion:1,environment:'production',generatedAt:'2026-01-01T00:00:00.000Z',services:{web:{tag:'nginx:1.28-alpine',image:pinned,resolvedAt:'2026-01-01T00:00:00.000Z'}}});
      expect(loadProject(file).services.web.image).toBe(pinned);
      const override='nginx@sha256:'+'b'.repeat(64);expect(loadProject(file,undefined,{web:override}).services.web.image).toBe(override);
      expect(makeImageLock(validateProject({...p,services:{web:{...p.services.web,image:pinned}}}),{web:pinned}).services.web.image).toBe(pinned);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  it('renders HTTP healthcheck sugar and external Compose volumes',()=>{
    const p:any=composeProject();p.services.db={image:'postgres:17-alpine',healthcheck:['pg_isready'],volumes:[{name:'data',mount:'/var/lib/postgresql/data',mode:'persistent',external:'legacy_db_data'}]};
    const c:any=load(renderCompose(validateProject(p)));
    expect(c.services.web.healthcheck.test[0]).toBe('CMD-SHELL');expect(c.services.web.healthcheck.test[1]).toMatch(/wget.*curl.*node/);
    expect(c.volumes['db-data']).toEqual({external:true,name:'legacy_db_data'});
  });
  it('maps secretEnv natively on Kubernetes and path rewrites through nginx Ingress',()=>{
    const p=validateProject({schemaVersion:1,name:'demo',environment:'dev',profile:'shared-dev',target:'kubernetes',kubernetes:{context:'ctx',ingressClass:'nginx'},
      secrets:{password:{secretName:'demo-secret',key:'password'}},services:{api:{image:'nginx:1.28',port:8080,secrets:['password'],secretEnv:{DB_PASSWORD:'password'},healthcheck:{http:'/health'},route:{domain:'demo.example.com',path:'/api',rewritePrefix:'/v1'}}}});
    const docs:any[]=loadAll(renderKubernetes(p));const deployment=docs.find(d=>d.kind==='Deployment');const container=deployment.spec.template.spec.containers[0];
    expect(container.env.find((e:any)=>e.name==='DB_PASSWORD').valueFrom.secretKeyRef).toEqual({name:'demo-secret',key:'password'});
    expect(deployment.spec.template.spec.volumes.some((v:any)=>v.name==='secret-password')).toBe(false);
    expect(container.readinessProbe.httpGet.path).toBe('/health');
    const ingress=docs.find(d=>d.kind==='Ingress');expect(ingress.spec.rules[0].http.paths[0].pathType).toBe('ImplementationSpecific');expect(ingress.metadata.annotations['nginx.ingress.kubernetes.io/rewrite-target']).toContain('/v1');
  });
  it('generates a Compose secretEnv shim that preserves the inspected image entrypoint/command and fails loudly',()=>{
    const p:any=composeProject();p.secrets={password:{file:'/opt/groma-secrets/demo/password'}};p.services.web.secrets=['password'];p.services.web.secretEnv={DB_PASSWORD:'password'};
    const script=deployScript(validateProject(p),'release');
    expect(script).toContain('docker image inspect');expect(script).toContain("'command':entry+cmd");expect(script).toContain('secret file is empty');expect(script).toContain('cannot read');
  });
});

describe('adoption and operations UX',()=>{
  it('imports Compose without copying credential-like values or env files',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'groma-import-'));
    try {
      const file=path.join(dir,'compose.yml');fs.writeFileSync(file,`services:\n  api:\n    image: example/api:1\n    ports: [\"3000:3000\"]\n    environment:\n      NODE_ENV: production\n      DB_PASSWORD: super-secret-value\n    env_file: [.env]\n    healthcheck: {test: [CMD, node, health.js]}\n    volumes: [data:/data]\nvolumes:\n  data: {}\n`);
      const result=importCompose(file,{name:'demo'});expect(result.yaml).toContain('NODE_ENV: production');expect(result.yaml).not.toContain('super-secret-value');expect(result.yaml).toContain('secrets were intentionally not copied');expect(result.yaml).toContain('TODO:');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  it('shared-host adoption is additive and does not touch firewall/package installation',()=>{
    const script=hostAdoptScript(composeProject());expect(script).toContain('import /etc/caddy/groma/*.caddy');expect(script).toContain('docker info');expect(script).not.toContain('ufw');expect(script).not.toContain('apt-get');
  });
  it('documents Compose-only commands in CLI help',()=>{
    expect(help).toContain('Compose-only operations:');expect(help).toContain('groma releases');expect(help).toContain('groma exec <service>');expect(help).toContain('groma init --from-compose');
  });
});
