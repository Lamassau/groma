import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { guidedProject, starterProject, serializeProject } from '../src/deployment/init';
import { validateProject, loadProject } from '../src/deployment/config';
import { verifyProject, VerifyDependencies } from '../src/deployment/verify';
import { buildPlan, enforcePlan, Snapshot } from '../src/deployment/operations';
import { deployScript } from '../src/deployment/remote';
import { spawnSync } from 'child_process';

const digest=(n:string)=>'example.com/web@sha256:'+n.repeat(64);

describe('Guided initialization',()=>{
  it('collects host, image, domain, ports, health and database choices',async()=>{
    const answers:Record<string,string>={name:'demo',host:'deploy@server.example.com','service.0.image':'example.com/demo:v1','service.0.port':'3000','service.0.domain':'demo.example.com','service.0.hostPort':'18099','service.0.healthPath':'/health','service.0.healthCommand':'["node","health.js"]',database:'postgres',storage:'persistent'};
    const p=await guidedProject({},async(id,_q,initial)=>answers[id]??initial);
    expect(p.host!.ssh).toBe('deploy@server.example.com');
    expect(p.services.web.route).toEqual({domain:'demo.example.com',hostPort:18099,healthPath:'/health'});
    expect(p.services.database.volumes![0].mode).toBe('persistent');
    expect(p.secrets!['db-password'].file).toBe('/opt/groma-secrets/demo/db-password');
    expect(serializeProject(p)).not.toContain('password: ');
  });
  it('supports worker-only applications and Kubernetes database references',async()=>{
    const answers:Record<string,string>={target:'kubernetes','service.0.name':'worker','service.0.public':'no','service.0.healthCommand':'[]',database:'postgres',storage:'persistent'};
    const p=await guidedProject({},async(id,_q,initial)=>answers[id]??initial);
    expect(p.services.worker.route).toBeUndefined();
    expect(p.services.worker.replicas).toBe(1);
    expect(p.services.database.volumes![0].size).toBe('5Gi');
    expect(p.secrets!['db-password'].secretName).toBe('my-app-database');
  });
  it('rejects invalid answers and malformed health commands',async()=>{
    await expect(guidedProject({},async(id,_q,initial)=>id==='service.0.port'?'oops':initial)).rejects.toThrow(/port/);
    await expect(guidedProject({},async(id,_q,initial)=>id==='service.0.healthCommand'?'curl localhost':initial)).rejects.toThrow(/healthCommand/);
  });
  it('supports digest overrides before production validation without changing files',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'groma-images-'));
    try {
      const p=starterProject();p.profile='production';
      const file=path.join(dir,'groma.yaml');fs.writeFileSync(file,serializeProject(p));
      expect(loadProject(file,undefined,{web:digest('a')}).services.web.image).toBe(digest('a'));
      expect(fs.readFileSync(file,'utf8')).toContain('nginx:1.28-alpine');
      expect(()=>loadProject(file,undefined,{unknown:digest('b')})).toThrow(/Unknown image/);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});

describe('Public verification',()=>{
  let clock:number,deps:VerifyDependencies;
  beforeEach(()=>{
    clock=Date.parse('2026-01-01T00:00:00Z');
    deps={resolve:jest.fn(async()=>['203.0.113.1']),probe:jest.fn(async()=>({status:200,expiresAt:'2026-04-01T00:00:00Z'})),now:()=>clock,sleep:async ms=>{clock+=ms;}};
  });
  it('verifies DNS, HTTPS and configured health path on every A/AAAA address',async()=>{
    const p=starterProject();p.services.web.route!.healthPath='/health';
    deps.resolve=jest.fn(async()=>['203.0.113.1','2001:db8::1']);
    const result=await verifyProject(p,{},deps);
    expect(result.ok).toBe(true);expect(result.endpoints[0].certificates).toHaveLength(2);
    expect(deps.probe).toHaveBeenCalledWith('my-app.example.com','2001:db8::1','/health',10000);
  });
  it('fails before HTTPS when even one DNS address points elsewhere',async()=>{
    deps.resolve=async name=>name==='my-app.example.com'?['203.0.113.1','203.0.113.9']:['203.0.113.1'];
    const result=await verifyProject(starterProject(),{},deps);
    expect(result.ok).toBe(false);expect(result.endpoints[0].error).toContain('DNS:');expect(deps.probe).not.toHaveBeenCalled();
  });
  it('supports explicit expected proxy addresses',async()=>{
    const p=starterProject();p.services.web.route!.expectedAddresses=['203.0.113.1'];
    const result=await verifyProject(p,{},deps);expect(result.ok).toBe(true);expect(deps.resolve).toHaveBeenCalledTimes(1);
  });
  it.each([301,500])('rejects unhealthy/redirect status %i',async status=>{
    deps.probe=async()=>({status,expiresAt:'2026-04-01'});
    const result=await verifyProject(starterProject(),{},deps);expect(result.ok).toBe(false);expect(result.endpoints[0].error).toContain('HTTP health');
  });
  it('reports expiring and invalid certificates without calling the deployment healthy',async()=>{
    for(const expiresAt of ['2026-01-03','invalid']){
      deps.probe=async()=>({status:200,expiresAt});
      expect((await verifyProject(starterProject(),{},deps)).ok).toBe(false);
    }
    deps.probe=async()=>{throw new Error('self-signed certificate');};
    expect((await verifyProject(starterProject(),{},deps)).endpoints[0].error).toContain('self-signed');
  });
  it('retries transient issuance failures and stops at the configured deadline',async()=>{
    let calls=0;deps.probe=async()=>{if(++calls===1)throw new Error('not ready');return {status:200,expiresAt:'2026-04-01'};};
    expect((await verifyProject(starterProject(),{waitMs:10000},deps)).ok).toBe(true);
    deps.probe=async()=>{throw new Error('still failing');};clock=0;
    expect((await verifyProject(starterProject(),{waitMs:5000},deps)).ok).toBe(false);expect(clock).toBe(5000);
  });
  it('marks no-route verification as skipped and validates options',async()=>{
    const p=starterProject();delete p.services.web.route;
    expect((await verifyProject(p,{},deps)).skipped).toBe(true);
    await expect(verifyProject(p,{waitMs:Infinity},deps)).rejects.toThrow(/Invalid verification/);
    p.services.web.route={domain:'demo.example.com',hostPort:18080,healthPath:'//elsewhere'};
    expect(()=>validateProject(p)).toThrow(/healthPath/);
  });
});

describe('Deployment plan',()=>{
  const data=():Snapshot=>({currentRelease:'one',current:{services:{web:{image:digest('a'),environment:{TOKEN:'private-old'},volumes:[{type:'volume',source:'data',target:'/data'}]},old:{image:'old:1'}}},candidate:{services:{web:{image:digest('b'),environment:{TOKEN:'private-new'},tmpfs:['/data']}}},imageLock:'services: {}',currentRoutes:'old.example.com {}',candidateRoutes:'new.example.com {}'});
  it('detects image changes under an unchanged tag and redacts environment values',()=>{
    const plan=buildPlan(starterProject(),data());
    expect(plan.services.find(s=>s.name==='web')!.image).toEqual({from:digest('a'),to:digest('b')});
    expect(JSON.stringify(plan)).not.toContain('private-');
    expect(plan.risks).toEqual(expect.arrayContaining(['service-removal','persistent-storage-change','route-change']));
    expect(()=>enforcePlan(plan,false,false)).toThrow(/service-removal/);
    expect(()=>enforcePlan(plan,true,false)).toThrow(/storage-change/);
    expect(()=>enforcePlan(plan,true,true)).not.toThrow();
  });
  it('compares canonical objects rather than key order',()=>{
    const state=data();state.candidate=JSON.parse(JSON.stringify(state.current));state.candidateRoutes=state.currentRoutes;
    expect(buildPlan(starterProject(),state).changed).toBe(false);
  });
  it('binds deployment to the planned release and locked images',()=>{
    const script=deployScript(starterProject(),'new',false,{imageLock:'services: {}',currentRelease:'old'});
    expect(script).toContain('Active release changed since plan');
    expect(script).toContain('images.lock.yaml');
    expect(spawnSync('bash',['-n'],{input:script,encoding:'utf8'}).status).toBe(0);
  });
});
