const fs = require('node:fs');
const path = require('node:path');
const {execFileSync}=require('node:child_process');
const {loadProject} = require('../build/deployment/config');

function relative(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !/[\r\n\0]/.test(value);
}
function verifyToolkitRef(ref) {
  if(!/^[a-f0-9]{40}$/.test(ref||'')) throw new Error('Pin groma-ref to a reviewed full commit SHA');
  const root=path.resolve(__dirname,'..');
  const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(head!==ref) throw new Error(`groma-ref ${ref} does not match the toolkit checkout ${head}`);
}
function buildDefinition(item,names) {
  const allowed=['service','context','dockerfile','target','buildArgs','platforms','secrets'];
  if(!item||Object.keys(item).some(k=>!allowed.includes(k))||!/^[a-z][a-z0-9-]{0,29}$/.test(item.service)||names.has(item.service)) throw new Error('Invalid or duplicate service build definition');
  names.add(item.service);
  for(const key of ['context','dockerfile']) if(!relative(item[key])) throw new Error(`Invalid ${key}`);
  if(item.target!==undefined&&!(typeof item.target==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(item.target))) throw new Error('Invalid Docker build target');
  if(item.buildArgs!==undefined&&(!item.buildArgs||typeof item.buildArgs!=='object'||Array.isArray(item.buildArgs))) throw new Error('buildArgs must be an object');
  const args=[];
  for(const [key,value] of Object.entries(item.buildArgs||{})) {
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof value!=='string'||/[\r\n\0]/.test(value)) throw new Error('Invalid buildArgs entry');
    args.push(`${key}=${value}`);
  }
  const platforms=item.platforms??[];
  if(!Array.isArray(platforms)||platforms.length>5||platforms.some(v=>typeof v!=='string'||!/^linux\/[a-z0-9]+(?:\/v\d+)?$/.test(v))) throw new Error('platforms must be Linux OCI platform strings');
  const secrets=item.secrets??[];
  if(!Array.isArray(secrets)||secrets.length>20||secrets.some(v=>typeof v!=='string'||!/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(v))||new Set(secrets).size!==secrets.length) throw new Error('secrets must contain unique BuildKit secret IDs');
  return {...item,buildArgsText:args.join('\n'),platformsText:platforms.join(',')};
}
function contract(input, appRoot) {
  if (!['dev','staging','production'].includes(input.environment)) throw new Error('Deployment environment must be dev, staging or production');
  verifyToolkitRef(input.gromaRef);
  if (!relative(input.config)) throw new Error('config-path must stay inside the application repository');
  const inside = candidate => {
    const real=fs.realpathSync(path.resolve(appRoot,candidate));
    if (!real.startsWith(fs.realpathSync(appRoot)+path.sep)) throw new Error('Path escapes application repository');
    return real;
  };
  const config=inside(input.config);
  const requested=JSON.parse(input.services);
  if(!Array.isArray(requested)||!requested.length||requested.length>20) throw new Error('services must contain 1–20 build definitions');
  const overrides={},names=new Set(),matrix=[];
  for(const raw of requested) {
    const item=buildDefinition(raw,names); matrix.push(item);
    const context=path.resolve(appRoot,item.context);
    if(fs.realpathSync(context)!==fs.realpathSync(appRoot)) inside(item.context);
    if(!fs.statSync(context).isDirectory()||!fs.statSync(inside(item.dockerfile)).isFile()) throw new Error('Build context/Dockerfile missing');
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
module.exports={contract,requireReviewers,normalize,verifyToolkitRef,buildDefinition};
if(require.main===module) {
  const input=normalize(JSON.parse(process.env.GROMA_INPUT));
  const result=contract(input,process.env.APP_ROOT);
  fs.appendFileSync(process.env.GITHUB_OUTPUT,`matrix=${JSON.stringify(result.matrix)}\nproject=${result.project}\n`);
}
