// Disposable local/CI Docker projects only. No SSH, cloud changes, or production secrets.
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {validateProject, projectName} = require('../build/deployment/config');
const {renderCompose} = require('../build/deployment/render');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'groma-smoke-'));
const projects=[];
const docker=args=>execFileSync('docker',args,{stdio:'inherit'});
const agent=(action,request)=>JSON.parse(execFileSync('python3',['-c',
  'import runpy,json,sys; Agent=runpy.run_path(sys.argv[1])["Agent"]; print(json.dumps(Agent(sys.argv[2]).dispatch(sys.argv[3],json.loads(sys.argv[4]))))',
  path.resolve(__dirname,'../build/deployment/agent.py'),root,action,JSON.stringify(request)],{encoding:'utf8'}));
try {
  for(let i=0;i<2;i++) {
    const name=`groma-smoke-${process.pid}-${i}`;
    const config=validateProject({schemaVersion:1,name,environment:'ci',profile:'shared-dev',target:'compose',host:{ssh:'test@localhost'},services:{web:{image:'nginx:1.28-alpine',port:80,healthcheck:['wget','-q','-O','/dev/null','http://127.0.0.1/'],environment:{LITERAL:'${DO_NOT_EXPAND}'}}}});
    const project=projectName(config),identity=`${name}:ci`;
    const releases=path.join(root,project,'releases');fs.mkdirSync(releases,{recursive:true});
    for(let release=1;release<=4;release++) {
      const directory=path.join(releases,String(release));fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory,'compose.yaml'),renderCompose(config));
      fs.writeFileSync(path.join(directory,'identity'),identity);
      fs.writeFileSync(path.join(directory,'routes.tsv'),'');
      fs.writeFileSync(path.join(directory,'route.caddy'),'');
      fs.writeFileSync(path.join(directory,'release.json'),JSON.stringify({release:String(release),project}));
    }
    fs.symlinkSync(path.join(releases,'4'),path.join(root,project,'current'));
    fs.symlinkSync(path.join(releases,'3'),path.join(root,project,'previous'));
    const file=path.join(releases,'4','compose.yaml');projects.push(file);
    docker(['compose','-f',file,'config','--quiet']);
    docker(['compose','-f',file,'up','-d','--wait','--wait-timeout','120']);
    docker(['compose','-f',file,'exec','-T','web','sh','-c','test "$LITERAL" = \'${DO_NOT_EXPAND}\'']);
    const plan=agent('snapshot',{project,identity,compose:renderCompose(config),routes:''});
    assert.ok(plan.candidate.services.web.image.includes('@sha256:'));
    assert.equal(plan.currentRelease,'4');
    agent('stop',{project,identity});
    const stopped=agent('apps',{}).apps.find(app=>app.project===project);
    assert.equal(stopped.services[0].state,'exited');
    agent('start',{project,identity});
    const running=agent('apps',{}).apps.find(app=>app.project===project);
    assert.equal(running.services[0].health,'healthy');
    assert.ok(running.services[0].memory);
    const preview=agent('prune',{project,identity,keep:2,minAgeHours:0});
    assert.equal(preview.dryRun,true);assert.equal(preview.releases.length,2);
    agent('prune',{project,identity,keep:2,minAgeHours:0,execute:true});
    assert.deepEqual(fs.readdirSync(releases).sort(),['3','4']);
  }
  assert.equal(agent('apps',{}).apps.length,2);
} finally {
  for(const file of projects) {try{docker(['compose','-f',file,'down']);}catch{}}
  fs.rmSync(root,{recursive:true,force:true});
}
