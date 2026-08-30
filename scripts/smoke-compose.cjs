// Disposable CI-only projects. Never connects to SSH or changes host infrastructure.
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {validateProject} = require('../build/deployment/config');
const {renderCompose} = require('../build/deployment/render');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'groma-smoke-'));
const projects=[];
const docker=(args)=>execFileSync('docker',args,{stdio:'inherit'});
try {
  for (let i=0;i<2;i++) {
    const name=`groma-smoke-${process.pid}-${i}`;
    const config=validateProject({schemaVersion:1,name,environment:'ci',profile:'shared-dev',target:'compose',host:{ssh:'test@localhost'},services:{web:{image:'nginx:1.28-alpine',port:80,healthcheck:['wget','-q','-O','/dev/null','http://127.0.0.1/'],environment:{LITERAL:'${DO_NOT_EXPAND}'}}}});
    const file=path.join(root,`${name}.yaml`); fs.writeFileSync(file,renderCompose(config));
    projects.push(file);
    docker(['compose','-f',file,'config','--quiet']);
    docker(['compose','-f',file,'up','-d','--wait','--wait-timeout','120']);
    docker(['compose','-f',file,'exec','-T','web','sh','-c','test "$LITERAL" = \'${DO_NOT_EXPAND}\'']);
  }
} finally {
  for(const file of projects) { try { docker(['compose','-f',file,'down']); } catch {} }
  fs.rmSync(root,{recursive:true,force:true});
}
