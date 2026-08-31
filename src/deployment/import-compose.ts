import * as fs from 'fs';
import * as path from 'path';
import { dump, load } from 'js-yaml';

const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const safeName=(value:string)=>value.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,30).replace(/^[^a-z]+/,'app-')||'imported-app';
const secretKey=(key:string)=>/(pass(word)?|secret|token|credential|api[_-]?key|private[_-]?key|database[_-]?url|dsn)/i.test(key);
const memory=(value:any):string|undefined=>{
  if(typeof value==='number'&&value>0) return `${Math.ceil(value/1048576)}Mi`;
  if(typeof value!=='string') return undefined;
  const match=value.trim().match(/^(\d+)([kKmMgG])(?:[bB])?$/); if(!match) return /^\d+(Mi|Gi)$/.test(value)?value:undefined;
  const amount=Number(match[1]),unit=match[2].toLowerCase();
  if(unit==='g') return `${amount}Gi`; if(unit==='m') return `${amount}Mi`; return `${Math.ceil(amount/1024)}Mi`;
};
const envObject=(value:any):Record<string,string>=>{
  if(object(value)) return Object.fromEntries(Object.entries(value).filter(([,v])=>typeof v==='string'||typeof v==='number'||typeof v==='boolean').map(([k,v])=>[k,String(v)]));
  if(Array.isArray(value)) return Object.fromEntries(value.filter(v=>typeof v==='string'&&v.includes('=')).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)];}));
  return {};
};
const dependencyNames=(value:any)=>Array.isArray(value)?value.filter(v=>typeof v==='string'):object(value)?Object.keys(value):[];
function portFrom(value:any):number|undefined {
  if(typeof value==='number') return value;
  if(typeof value==='string') {const raw=value.split('/')[0],part=raw.split(':').pop();return /^\d+$/.test(part??'')?Number(part):undefined;}
  if(object(value)) {const target=value.target;return Number.isInteger(target)?target:undefined;}
  return undefined;
}

export interface ComposeImportResult { yaml:string; warnings:string[] }
export function importCompose(file:string, options:{name?:string;host?:string}={}):ComposeImportResult {
  const absolute=path.resolve(file); const source:any=load(fs.readFileSync(absolute,'utf8'));
  if(!object(source)||!object(source.services)||!Object.keys(source.services).length) throw new Error('Compose file must contain services');
  const name=safeName(options.name??source.name??path.basename(path.dirname(absolute)));
  const warnings:string[]=[
    'TODO: review every imported service image and healthcheck before deployment.',
    'TODO: add route blocks only for services that should be public; GROMa does not guess domains.',
    'TODO: review each imported volume as persistent vs ephemeral and set external when adopting existing data.',
  ];
  const secretNames=new Set<string>(); const services:Record<string,any>={};
  for(const [rawName,raw] of Object.entries(source.services) as [string,any][]) {
    if(!object(raw)) {warnings.push(`TODO: service ${rawName} was not an object and was skipped.`);continue;}
    const serviceName=safeName(rawName); const service:any={image:typeof raw.image==='string'?raw.image:'TODO_IMAGE'};
    if(typeof raw.image!=='string') warnings.push(`TODO: service ${rawName} used build-only/no image; set services.${serviceName}.image.`);
    const p=Array.isArray(raw.ports)?raw.ports.map(portFrom).find(Boolean):undefined; if(p) service.port=p;
    const environment=envObject(raw.environment); const kept:Record<string,string>={};
    for(const [key,value] of Object.entries(environment)) {
      if(secretKey(key)) {secretNames.add(key.toLowerCase().replace(/_/g,'-'));warnings.push(`TODO: ${rawName}.${key} looked credential-related and was omitted; provision it as a GROMa secret.`);}
      else kept[key]=value;
    }
    if(Object.keys(kept).length) service.environment=kept;
    if(raw.env_file!==undefined) warnings.push(`TODO: ${rawName} uses env_file; values were not imported. Review it and move credentials to secrets.`);
    const health=raw.healthcheck?.test;
    if(Array.isArray(health)&&health[0]==='CMD'&&health.slice(1).every((v:any)=>typeof v==='string')) service.healthcheck=health.slice(1);
    else if(health!==undefined) warnings.push(`TODO: ${rawName} healthcheck is shell/unsupported syntax; replace it with an exec array or {http: /path}.`);
    const depends=dependencyNames(raw.depends_on); if(depends.length) service.dependsOn=depends.map(safeName);
    const resources:any={}; const cpu=Number(raw.cpus); if(Number.isFinite(cpu)&&cpu>0) resources.cpu=cpu;
    const mem=memory(raw.mem_limit); if(mem) resources.memory=mem; if(Object.keys(resources).length===2) service.resources=resources;
    else if(Object.keys(resources).length) warnings.push(`TODO: ${rawName} had only part of the resource limit; complete cpu and memory together.`);
    if(Array.isArray(raw.volumes)) {
      const volumes:any[]=[]; let index=0;
      for(const volume of raw.volumes) {
        let sourceName:string|undefined,target:string|undefined;
        if(typeof volume==='string') {const parts=volume.split(':');if(parts.length>=2){sourceName=parts[0];target=parts[1];}}
        else if(object(volume)&&volume.type==='volume'){sourceName=volume.source;target=volume.target;}
        if(!target||!target.startsWith('/')) {warnings.push(`TODO: ${rawName} has an unsupported bind/volume declaration that was skipped.`);continue;}
        if(!sourceName||sourceName.startsWith('.')||sourceName.startsWith('/')) {warnings.push(`TODO: ${rawName}:${target} is anonymous/bind storage and was skipped; choose persistent or ephemeral explicitly.`);continue;}
        const top=object(source.volumes?.[sourceName])?source.volumes[sourceName]:{};
        volumes.push({name:safeName(sourceName)||`data-${++index}`,mount:target,mode:'persistent',...(top.external===true&&typeof top.name==='string'?{external:top.name}:{})});
      }
      if(volumes.length) service.volumes=volumes;
    }
    services[serviceName]=service;
  }
  const project:any={schemaVersion:1,name,environment:'dev',profile:'shared-dev',target:'compose',host:{ssh:options.host??'deploy@your-host.example.com'},services};
  let yaml=dump(project,{noRefs:true,lineWidth:-1});
  if(secretNames.size||Object.values(source.services).some((s:any)=>s?.env_file!==undefined)) yaml += `\n# TODO: secrets were intentionally not copied from Compose. Example:\n# secrets:\n#   app-secret:\n#     file: /opt/groma-secrets/${name}/app-secret\n# services:\n#   SERVICE:\n#     secrets: [app-secret]\n#     secretEnv: {APP_SECRET: app-secret}\n`;
  yaml += '\n'+warnings.map(w=>`# ${w}`).join('\n')+'\n'; return {yaml,warnings};
}
