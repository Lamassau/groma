import * as fs from 'fs';
import * as path from 'path';
import { dump, load } from 'js-yaml';
import { isIP } from 'net';

export type Healthcheck = string[] | { http: string };
export interface Route {
  domain: string;
  hostPort?: number;
  path?: string;
  stripPathPrefix?: boolean;
  rewritePrefix?: string;
  healthPath?: string;
  expectedStatus?: number;
  expectedAddresses?: string[];
}
export interface ServiceVolume {
  name: string;
  mount: string;
  mode: 'persistent' | 'ephemeral';
  size?: string;
  /** Compose only: adopt an already-existing Docker named volume. */
  external?: string;
}
export interface AppService {
  image: string;
  replicas?: number;
  port?: number;
  command?: string[];
  environment?: Record<string, string>;
  secrets?: string[];
  /** Plain environment variable -> declared secret name. */
  secretEnv?: Record<string, string>;
  dependsOn?: string[];
  healthcheck?: Healthcheck;
  route?: Route;
  resources?: { cpu: number; memory: string };
  volumes?: ServiceVolume[];
}
export interface ProjectDefaults {
  environment?: Record<string, string>;
  resources?: { cpu?: number; memory?: string };
}
export interface Project {
  schemaVersion: 1;
  name: string;
  /** Deployment environment name; shared service env belongs under defaults.environment. */
  environment: string;
  profile: 'local' | 'shared-dev' | 'production';
  target: 'compose' | 'kubernetes';
  host?: { ssh: string; port?: number };
  kubernetes?: { context: string; ingressClass?: string; tlsSecret?: string; storageClass?: string };
  secrets?: Record<string, { file?: string; secretName?: string; key?: string }>;
  defaults?: ProjectDefaults;
  services: Record<string, AppService>;
}
export interface ImageLockEntry { image: string; tag: string; resolvedAt: string }
export interface ImageLock {
  schemaVersion: 1;
  environment: string;
  generatedAt: string;
  services: Record<string, ImageLockEntry>;
}
export interface LoadProjectOptions { useImageLock?: boolean; allowProductionTags?: boolean }

const nameRE = /^[a-z][a-z0-9-]{0,29}$/;
const domainRE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const envRE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const imageRE = /^[a-zA-Z0-9][a-zA-Z0-9./:@_-]+$/;
const digestRE = /@sha256:[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const safePath = (v: unknown) => typeof v === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(v) && !v.split('/').includes('..');
const urlPath = (v: unknown) => typeof v === 'string' && /^\/(?!\/)[^\s#?]*$/.test(v);
const cleanPrefix = (value: string) => value.length > 1 ? value.replace(/\/$/, '') : value;

const groupedError = (errors: string[]) => {
  const groups = new Map<string, string[]>();
  for (const error of errors) {
    const key = error.match(/^([^:]+):\s/)?.[1] ?? error;
    const section = key.includes('.') ? key.split('.')[0] : key;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section)!.push(error);
  }
  const lines = ['Invalid GROMa configuration:'];
  for (const [section, entries] of [...groups.entries()].sort(([a],[b]) => a.localeCompare(b))) {
    lines.push(`  ${section}:`);
    for (const entry of entries) lines.push(`    - ${entry}`);
  }
  lines.push('Action: fix the sections above, then rerun groma validate.');
  return lines.join('\n');
};

const deepMerge = (a: any, b: any): any => {
  if (!object(a) || !object(b)) return b;
  const out = Object.assign(Object.create(null), a);
  for (const [k,v] of Object.entries(b)) {
    if (['__proto__','prototype','constructor'].includes(k)) throw new Error(`Unsafe config key: ${k}`);
    out[k] = deepMerge(a[k],v);
  }
  return out;
};
const serviceDefaults = (defaults: any) => ({
  ...(object(defaults?.environment) ? {environment: defaults.environment} : {}),
  ...(object(defaults?.resources) ? {resources: defaults.resources} : {}),
});
function mergeProject(base: any, overlay?: any): any {
  if (!overlay) {
    if (!object(base) || !object(base.services)) return base;
    return {...base, services:Object.fromEntries(Object.entries(base.services).map(([name,service])=>[name,deepMerge(serviceDefaults(base.defaults),service)]))};
  }
  const merged = deepMerge(base, overlay);
  const baseServices = object(base?.services) ? base.services : {};
  const overlayServices = object(overlay?.services) ? overlay.services : {};
  const names = new Set([...Object.keys(baseServices), ...Object.keys(overlayServices)]);
  const services: Record<string,unknown> = Object.create(null);
  for (const name of names) {
    if (overlayServices[name] === null) continue;
    let service:any = serviceDefaults(base?.defaults);
    if (baseServices[name] !== undefined) service = deepMerge(service,baseServices[name]);
    service = deepMerge(service,serviceDefaults(overlay?.defaults));
    if (overlayServices[name] !== undefined) service = deepMerge(service,overlayServices[name]);
    services[name]=service;
  }
  merged.services=services;
  return merged;
}

export function imageLockPath(configFile: string): string {
  return path.join(path.dirname(path.resolve(configFile)), 'deploy', 'images.lock.yaml');
}
export function readImageLock(configFile: string): ImageLock | null {
  const file=imageLockPath(configFile);
  if(!fs.existsSync(file)) return null;
  const value:any=load(fs.readFileSync(file,'utf8'),{schema:require('js-yaml').JSON_SCHEMA});
  if(!object(value)||value.schemaVersion!==1||typeof value.environment!=='string'||typeof value.generatedAt!=='string'||!object(value.services)) throw new Error(`Invalid image lockfile: ${file}`);
  for(const [service,entry] of Object.entries(value.services) as [string,any][]) {
    if(!nameRE.test(service)||!object(entry)||typeof entry.tag!=='string'||!imageRE.test(entry.tag)||typeof entry.image!=='string'||!digestRE.test(entry.image)||typeof entry.resolvedAt!=='string') throw new Error(`Invalid image lock entry: ${service}`);
  }
  return value as ImageLock;
}
export function writeImageLock(configFile: string, lock: ImageLock): string {
  const file=imageLockPath(configFile); fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp,dump(lock,{noRefs:true,lineWidth:-1}),{mode:0o600});
  fs.renameSync(tmp,file); return file;
}
function applyImageLock(value: any, configFile: string): any {
  if(!object(value)||!object(value.services)||value.profile!=='production') return value;
  const lock=readImageLock(configFile); if(!lock) return value;
  if(lock.environment!==value.environment) return value;
  const out=structuredClone(value);
  for(const [name,service] of Object.entries(out.services) as [string,any][]) {
    if(typeof service?.image!=='string'||digestRE.test(service.image)) continue;
    const entry=lock.services[name];
    if(entry?.tag===service.image) service.image=entry.image;
  }
  return out;
}

/** Validate at the boundary: TypeScript casts are not runtime validation. Unknown keys fail closed. */
export function validateProject(input: unknown, options: {allowProductionTags?:boolean} = {}): Project {
  const errors: string[] = [];
  const check = (ok: unknown, key: string, message: string) => { if (!ok) errors.push(`${key}: ${message}`); };
  const keys = (v: any, allowed: string[], at: string) => {
    if (!object(v)) { errors.push(`${at}: expected an object`); return; }
    for (const k of Object.keys(v)) check(allowed.includes(k), `${at}.${k}`, 'unknown or unsupported setting');
  };
  keys(input, ['schemaVersion','name','environment','profile','target','host','kubernetes','secrets','defaults','services'], 'config');
  const p: any = object(input) ? input : {};
  check(p.schemaVersion === 1, 'schemaVersion', 'must be 1');
  for (const k of ['name','environment']) check(typeof p[k] === 'string' && nameRE.test(p[k]), k, 'use 1–30 lowercase letters, digits or hyphens, starting with a letter');
  check(['local','shared-dev','production'].includes(p.profile), 'profile', 'must be local, shared-dev or production');
  check(['compose','kubernetes'].includes(p.target), 'target', 'must be compose or kubernetes');
  if (p.defaults !== undefined) {
    keys(p.defaults,['environment','resources'],'defaults');
    if(p.defaults?.environment!==undefined) {
      check(object(p.defaults.environment),'defaults.environment','expected an object');
      for(const [k,v] of Object.entries(object(p.defaults.environment)?p.defaults.environment:{})) check(envRE.test(k)&&typeof v==='string'&&!v.includes('\0'),`defaults.environment.${k}`,'environment values must be strings');
    }
    if(p.defaults?.resources!==undefined) {
      keys(p.defaults.resources,['cpu','memory'],'defaults.resources');
      check(p.defaults.resources.cpu===undefined||typeof p.defaults.resources.cpu==='number'&&Number.isFinite(p.defaults.resources.cpu)&&p.defaults.resources.cpu>0,'defaults.resources.cpu','positive number required');
      check(p.defaults.resources.memory===undefined||typeof p.defaults.resources.memory==='string'&&/^[1-9][0-9]*(Mi|Gi)$/.test(p.defaults.resources.memory),'defaults.resources.memory','use positive Mi or Gi quantity');
    }
  }
  if (p.target === 'compose') {
    keys(p.host, ['ssh','port'], 'host');
    check(typeof p.host?.ssh === 'string' && /^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(p.host.ssh), 'host.ssh', 'must be user@hostname or user@IPv4');
    check(p.host?.port === undefined || Number.isInteger(p.host.port) && p.host.port > 0 && p.host.port <= 65535, 'host.port', 'must be a valid SSH port');
    check(p.kubernetes === undefined, 'kubernetes', 'not supported by Compose');
  } else if (p.target === 'kubernetes') {
    keys(p.kubernetes, ['context','ingressClass','tlsSecret','storageClass'], 'kubernetes');
    check(typeof p.kubernetes?.context === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(p.kubernetes.context), 'kubernetes.context', 'explicit context required');
    check(p.host === undefined, 'host', 'not used by Kubernetes');
    for (const k of ['ingressClass','tlsSecret','storageClass']) check(p.kubernetes?.[k] === undefined || typeof p.kubernetes[k] === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(p.kubernetes[k]), `kubernetes.${k}`, 'invalid resource name');
  }
  if (p.secrets !== undefined) {
    check(object(p.secrets), 'secrets', 'expected an object');
    for (const [n, s] of Object.entries(object(p.secrets) ? p.secrets : {}) as [string, any][]) {
      check(nameRE.test(n), `secrets.${n}`, 'invalid name');
      keys(s, p.target === 'compose' ? ['file'] : ['secretName','key'], `secrets.${n}`);
      if (p.target === 'compose') check(safePath(s?.file), `secrets.${n}.file`, 'absolute file path on the remote host required');
      else {
        check(typeof s?.secretName === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(s.secretName), `secrets.${n}.secretName`, 'existing Kubernetes Secret required');
        check(typeof s?.key === 'string' && /^[a-zA-Z0-9_.-]+$/.test(s.key), `secrets.${n}.key`, 'existing Secret key required');
      }
    }
  }
  check(object(p.services) && Object.keys(p.services).length > 0, 'services', 'at least one service required');
  const services = object(p.services) ? p.services : {};
  const routes = new Set<string>(), ports = new Set<number>();
  for (const [n, s] of Object.entries(services) as [string, any][]) {
    const at = `services.${n}`;
    check(nameRE.test(n), at, 'invalid name');
    keys(s, ['image','replicas','port','command','environment','secrets','secretEnv','dependsOn','healthcheck','route','resources','volumes'], at);
    if (!object(s)) continue;
    check(typeof s.image === 'string' && imageRE.test(s.image), `${at}.image`, 'container image required (no substitutions)');
    if (p.profile === 'production' && !options.allowProductionTags) check(typeof s.image === 'string' && digestRE.test(s.image), `${at}.image`, 'production requires an immutable sha256 digest; run groma pin or pass an immutable --image override');
    if (p.target === 'compose') check(s.replicas === undefined, `${at}.replicas`, 'unsupported by Compose; scale by adding services or using Kubernetes');
    else check(s.replicas === undefined || (Number.isInteger(s.replicas) && s.replicas > 0 && s.replicas <= 1000), `${at}.replicas`, 'must be an integer from 1 to 1000');
    check(s.port === undefined || Number.isInteger(s.port) && s.port > 0 && s.port <= 65535, `${at}.port`, 'must be an integer from 1 to 65535');
    for (const k of ['command','secrets','dependsOn']) if (s[k] !== undefined) check(Array.isArray(s[k]) && s[k].length > 0 && s[k].every((x: any) => typeof x === 'string' && x.length > 0 && !x.includes('\0')), `${at}.${k}`, 'non-empty string array required');
    if(s.healthcheck!==undefined) {
      const exec=Array.isArray(s.healthcheck)&&s.healthcheck.length>0&&s.healthcheck.every((x:any)=>typeof x==='string'&&x.length>0&&!x.includes('\0'));
      const http=object(s.healthcheck)&&Object.keys(s.healthcheck).length===1&&urlPath(s.healthcheck.http);
      check(exec||http,`${at}.healthcheck`,'use a non-empty exec array or {http: /path}');
      if(http) check(s.port!==undefined,`${at}.port`,'required for an HTTP healthcheck');
    }
    if (s.environment !== undefined) {
      check(object(s.environment), `${at}.environment`, 'expected an object');
      for (const [k,v] of Object.entries(object(s.environment) ? s.environment : {})) check(envRE.test(k) && typeof v === 'string' && !v.includes('\0'), `${at}.environment.${k}`, 'environment values must be strings');
    }
    if (s.secretEnv !== undefined) {
      check(object(s.secretEnv),`${at}.secretEnv`,'expected an object');
      for(const [variable,ref] of Object.entries(object(s.secretEnv)?s.secretEnv:{})) {
        check(envRE.test(variable),`${at}.secretEnv.${variable}`,'invalid environment variable name');
        check(typeof ref==='string'&&object(p.secrets)&&Object.hasOwn(p.secrets,ref),`${at}.secretEnv.${variable}`,`unknown secret ${String(ref)}`);
        check(Array.isArray(s.secrets)&&s.secrets.includes(ref),`${at}.secretEnv.${variable}`,`secret ${String(ref)} must also be granted in services.${n}.secrets`);
      }
    }
    if (Array.isArray(s.secrets)) for (const ref of s.secrets) check(object(p.secrets) && Object.hasOwn(p.secrets, ref), `${at}.secrets`, `unknown secret ${ref}`);
    if (Array.isArray(s.dependsOn)) for (const ref of s.dependsOn) {
      check(ref !== n && Object.hasOwn(services, ref), `${at}.dependsOn`, `invalid dependency ${ref}`);
      check(services[ref]?.healthcheck !== undefined, `${at}.dependsOn`, `${ref} must have a healthcheck`);
    }
    if (p.target === 'kubernetes') check(s.dependsOn === undefined, `${at}.dependsOn`, 'Kubernetes applications must retry dependencies; startup ordering is unsupported');
    if (s.resources !== undefined) {
      keys(s.resources, ['cpu','memory'], `${at}.resources`);
      check(typeof s.resources?.cpu === 'number' && Number.isFinite(s.resources.cpu) && s.resources.cpu > 0, `${at}.resources.cpu`, 'positive number required');
      check(typeof s.resources?.memory === 'string' && /^[1-9][0-9]*(Mi|Gi)$/.test(s.resources.memory), `${at}.resources.memory`, 'use positive Mi or Gi quantity');
    }
    if (s.route !== undefined) {
      keys(s.route, ['domain','hostPort','path','stripPathPrefix','rewritePrefix','healthPath','expectedStatus','expectedAddresses'], `${at}.route`);
      check(typeof s.route?.domain === 'string' && domainRE.test(s.route.domain), `${at}.route.domain`, 'DNS hostname required');
      check(s.route?.path===undefined||urlPath(s.route.path),`${at}.route.path`,'must be an absolute URL path without query/fragment');
      check(s.route?.stripPathPrefix===undefined||typeof s.route.stripPathPrefix==='boolean',`${at}.route.stripPathPrefix`,'must be boolean');
      check(s.route?.rewritePrefix===undefined||urlPath(s.route.rewritePrefix),`${at}.route.rewritePrefix`,'must be an absolute URL path');
      check(!(s.route?.stripPathPrefix&&s.route?.rewritePrefix!==undefined),`${at}.route`,'stripPathPrefix and rewritePrefix are mutually exclusive');
      const routePath=cleanPrefix(typeof s.route?.path==='string'?s.route.path:'/');
      if(routePath==='/') check(!s.route?.stripPathPrefix&&s.route?.rewritePrefix===undefined,`${at}.route`,'stripPathPrefix/rewritePrefix require a non-root route.path');
      const routeKey=`${s.route?.domain}\n${routePath}`;
      check(!routes.has(routeKey),`${at}.route`,'duplicate domain/path pair'); routes.add(routeKey);
      check(s.route?.healthPath === undefined || urlPath(s.route.healthPath), `${at}.route.healthPath`, 'must be an absolute URL path without query/fragment');
      check(s.route?.expectedStatus === undefined || Number.isInteger(s.route.expectedStatus) && s.route.expectedStatus >= 200 && s.route.expectedStatus <= 299, `${at}.route.expectedStatus`, 'must be a 2xx status');
      check(s.route?.expectedAddresses === undefined || Array.isArray(s.route.expectedAddresses) && s.route.expectedAddresses.length > 0 && s.route.expectedAddresses.every((a: unknown) => typeof a === 'string' && isIP(a)), `${at}.route.expectedAddresses`, 'non-empty IP address array required');
      check(s.port !== undefined, `${at}.port`, 'required for a route');
      if (p.target === 'compose') {
        check(Number.isInteger(s.route?.hostPort) && s.route.hostPort >= 1024 && s.route.hostPort <= 65535, `${at}.route.hostPort`, 'unique loopback port 1024–65535 required');
        check(!ports.has(s.route?.hostPort), `${at}.route.hostPort`, 'duplicate host port'); ports.add(s.route?.hostPort);
      } else {
        check(s.route?.hostPort === undefined, `${at}.route.hostPort`, 'only supported by Compose');
        if((s.route?.stripPathPrefix||s.route?.rewritePrefix)&&p.kubernetes?.ingressClass) check(/nginx/i.test(p.kubernetes.ingressClass),`${at}.route`,'path rewriting currently requires an nginx ingressClass');
      }
    }
    if (p.profile === 'production') {
      check(s.healthcheck !== undefined, `${at}.healthcheck`, 'required in production');
      if (p.target === 'kubernetes' && s.route) check(p.kubernetes?.tlsSecret, 'kubernetes.tlsSecret', 'required for production routes');
    }
    if (s.volumes !== undefined) {
      check(Array.isArray(s.volumes), `${at}.volumes`, 'expected an array');
      const names = new Set(), mounts = new Set();
      for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
        keys(v, ['name','mount','mode','size','external'], `${at}.volumes`);
        check(typeof v?.name === 'string' && nameRE.test(v.name) && !names.has(v.name), `${at}.volumes.name`, 'unique volume name required'); names.add(v?.name);
        check(safePath(v?.mount) && v.mount !== '/' && !mounts.has(v.mount), `${at}.volumes.mount`, 'unique absolute mount path other than / required'); mounts.add(v?.mount);
        check(['persistent','ephemeral'].includes(v?.mode), `${at}.volumes.mode`, 'must be persistent or ephemeral');
        check(v?.external===undefined||typeof v.external==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v.external),`${at}.volumes.external`,'must be an existing Docker volume name');
        if(v?.external!==undefined) { check(p.target==='compose',`${at}.volumes.external`,'only supported by Compose'); check(v.mode==='persistent',`${at}.volumes.external`,'only persistent volumes can be external'); }
        if (p.target === 'kubernetes' && v?.mode === 'persistent') check(typeof v.size === 'string' && /^[1-9][0-9]*(Mi|Gi)$/.test(v.size), `${at}.volumes.size`, 'PVC size required');
      }
    }
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (n: string) => {
    if (visiting.has(n)) { errors.push(`services.${n}.dependsOn: dependency cycle`); return; }
    if (done.has(n)) return;
    visiting.add(n);
    for (const d of Array.isArray(services[n]?.dependsOn) ? services[n].dependsOn : []) if (Object.hasOwn(services,d)) visit(d);
    visiting.delete(n); done.add(n);
  };
  for (const n of Object.keys(services)) visit(n);
  if (errors.length) throw new Error(groupedError(errors));
  return p as Project;
}

function publicHealthPath(route: Route): string {
  const base=cleanPrefix(route.path ?? '/'); const health=route.healthPath ?? '/';
  if(base==='/'||health===base||health.startsWith(base+'/')) return health;
  return health==='/' ? base+'/' : base+health;
}
export function routeVerificationPath(route: Route): string { return publicHealthPath(route); }

export function loadProject(file: string, environment?: string, images: Record<string, string> = {}, options: LoadProjectOptions = {}): Project {
  const absolute = path.resolve(file);
  const base = load(fs.readFileSync(absolute, 'utf8'), { schema: require('js-yaml').JSON_SCHEMA });
  let value:any=base;
  if (environment) {
    if (!nameRE.test(environment)) throw new Error('Invalid environment name');
    const overlay = path.join(path.dirname(absolute), 'environments', `${environment}.yaml`);
    if (!fs.existsSync(overlay)) throw new Error(`Environment overlay not found: ${overlay}`);
    value={...mergeProject(base,load(fs.readFileSync(overlay,'utf8'),{schema:require('js-yaml').JSON_SCHEMA})),environment};
  } else value=mergeProject(base);
  if(options.useImageLock!==false) value=applyImageLock(value,absolute);
  if (object(value) && object(value.services)) for (const [service, image] of Object.entries(images)) {
    if (!Object.hasOwn(value.services, service)) throw new Error(`Unknown image override service: ${service}`);
    value.services[service] = { ...value.services[service], image };
  }
  const project=validateProject(value,{allowProductionTags:options.allowProductionTags});
  // healthPath is a public path. Prefix a path-scoped route so verify checks the routed URL.
  for(const service of Object.values(project.services)) if(service.route) service.route.healthPath=publicHealthPath(service.route);
  return project;
}
export const projectName = (p: Project) => `${p.name}-${p.environment}`;
