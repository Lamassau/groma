const fs = require('node:fs');
const path = require('node:path');
const {loadProject} = require('../build/deployment/config');

function relative(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !/[\r\n\0]/.test(value);
}
function contract(input, appRoot) {
  if (!['dev','staging','production'].includes(input.environment)) throw new Error('Deployment environment must be dev, staging or production');
  if (!/^[a-f0-9]{40}$/.test(input.gromaRef)) throw new Error('Pin groma-ref to a reviewed full commit SHA');
  if (!relative(input.config)) throw new Error('config-path must stay inside the application repository');
  const inside = candidate => {
    const real=fs.realpathSync(path.resolve(appRoot,candidate));
    if (!real.startsWith(fs.realpathSync(appRoot)+path.sep)) throw new Error('Path escapes application repository');
    return real;
  };
  const config=inside(input.config);
  const matrix=JSON.parse(input.services);
  if(!Array.isArray(matrix)||!matrix.length||matrix.length>20) throw new Error('services must contain 1–20 build definitions');
  const overrides={},names=new Set();
  for(const item of matrix) {
    if(!item||Object.keys(item).some(k=>!['service','context','dockerfile'].includes(k))||!/^[a-z][a-z0-9-]{0,29}$/.test(item.service)||names.has(item.service)) throw new Error('Invalid or duplicate service build definition');
    names.add(item.service);
    for(const key of ['context','dockerfile']) if(!relative(item[key])) throw new Error(`Invalid ${key}`);
    const context=path.resolve(appRoot,item.context);
    if(fs.realpathSync(context)!==fs.realpathSync(appRoot)) inside(item.context);
    if(!fs.statSync(context).isDirectory()||!fs.statSync(inside(item.dockerfile)).isFile()) throw new Error('Build context/Dockerfile missing');
    // Validate production configuration before build without requiring a pre-known digest for built services.
    overrides[item.service]='validation.invalid/image@sha256:'+'0'.repeat(64);
  }
  const p=loadProject(config,input.overlay||undefined,overrides);
  if(p.target!=='compose') throw new Error('Reusable droplet workflow requires target: compose');
  if(p.host.ssh!==input.target) throw new Error('expected-target differs from the effective project SSH target');
  if((input.environment==='production')!==(p.profile==='production')) throw new Error('Production profile must use the production protected environment, and vice versa');
  return {matrix,project:p.name+'-'+p.environment};
}
function requireReviewers(environment) {
  const rules=environment?.protection_rules;
  if(!Array.isArray(rules)||!rules.some(r=>r.type==='required_reviewers'&&Array.isArray(r.reviewers)&&r.reviewers.length>0&&r.prevent_self_review===true)) {
    throw new Error('Production requires an existing GitHub environment with required reviewers and prevent-self-review enabled');
  }
}
function normalize(input) {return {environment:input.environment,target:input['expected-target'],gromaRef:input['groma-ref'],config:input['config-path'],overlay:input.overlay,services:input.services};}
module.exports={contract,requireReviewers,normalize};
if(require.main===module) {
  const input=normalize(JSON.parse(process.env.GROMA_INPUT));
  const result=contract(input,process.env.APP_ROOT);
  fs.appendFileSync(process.env.GITHUB_OUTPUT,`matrix=${JSON.stringify(result.matrix)}\nproject=${result.project}\n`);
}
