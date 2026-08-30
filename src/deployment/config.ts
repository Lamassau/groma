import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import { isIP } from 'net';

export interface AppService {
  image: string;
  port?: number;
  command?: string[];
  environment?: Record<string, string>;
  secrets?: string[];
  dependsOn?: string[];
  healthcheck?: string[];
  route?: { domain: string; hostPort?: number; healthPath?: string; expectedStatus?: number; expectedAddresses?: string[] };
  resources?: { cpu: number; memory: string };
  volumes?: Array<{ name: string; mount: string; mode: 'persistent' | 'ephemeral'; size?: string }>;
}
export interface Project {
  schemaVersion: 1;
  name: string;
  environment: string;
  profile: 'local' | 'shared-dev' | 'production';
  target: 'compose' | 'kubernetes';
  host?: { ssh: string; port?: number };
  kubernetes?: { context: string; ingressClass?: string; tlsSecret?: string; storageClass?: string };
  secrets?: Record<string, { file?: string; secretName?: string; key?: string }>;
  services: Record<string, AppService>;
}
const nameRE = /^[a-z][a-z0-9-]{0,29}$/;
const domainRE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const safePath = (v: unknown) => typeof v === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(v) && !v.split('/').includes('..');

/** Validate at the boundary: TypeScript casts are not runtime validation. Unknown keys fail closed. */
export function validateProject(input: unknown): Project {
  const errors: string[] = [];
  const check = (ok: unknown, key: string, message: string) => { if (!ok) errors.push(`${key}: ${message}`); };
  const keys = (v: any, allowed: string[], at: string) => {
    if (!object(v)) { errors.push(`${at}: expected an object`); return; }
    for (const k of Object.keys(v)) check(allowed.includes(k), `${at}.${k}`, 'unknown or unsupported setting');
  };
  keys(input, ['schemaVersion','name','environment','profile','target','host','kubernetes','secrets','services'], 'config');
  const p: any = object(input) ? input : {};
  check(p.schemaVersion === 1, 'schemaVersion', 'must be 1');
  for (const k of ['name','environment']) check(typeof p[k] === 'string' && nameRE.test(p[k]), k, 'use 1–30 lowercase letters, digits or hyphens, starting with a letter');
  check(['local','shared-dev','production'].includes(p.profile), 'profile', 'must be local, shared-dev or production');
  check(['compose','kubernetes'].includes(p.target), 'target', 'must be compose or kubernetes');
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
  const domains = new Set<string>(), ports = new Set<number>();
  for (const [n, s] of Object.entries(services) as [string, any][]) {
    const at = `services.${n}`;
    check(nameRE.test(n), at, 'invalid name');
    keys(s, ['image','port','command','environment','secrets','dependsOn','healthcheck','route','resources','volumes'], at);
    if (!object(s)) continue;
    check(typeof s.image === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9./:@_-]+$/.test(s.image), `${at}.image`, 'container image required (no substitutions)');
    if (p.profile === 'production') check(typeof s.image === 'string' && /@sha256:[a-f0-9]{64}$/.test(s.image), `${at}.image`, 'production requires an immutable sha256 digest');
    check(s.port === undefined || Number.isInteger(s.port) && s.port > 0 && s.port <= 65535, `${at}.port`, 'must be an integer from 1 to 65535');
    for (const k of ['command','healthcheck','secrets','dependsOn']) if (s[k] !== undefined) check(Array.isArray(s[k]) && s[k].length > 0 && s[k].every((x: any) => typeof x === 'string' && x.length > 0 && !x.includes('\0')), `${at}.${k}`, 'non-empty string array required');
    if (s.environment !== undefined) {
      check(object(s.environment), `${at}.environment`, 'expected an object');
      for (const [k,v] of Object.entries(object(s.environment) ? s.environment : {})) check(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && !v.includes('\0'), `${at}.environment.${k}`, 'environment values must be strings');
    }
    if (Array.isArray(s.secrets)) for (const ref of s.secrets) check(object(p.secrets) && Object.hasOwn(p.secrets, ref), `${at}.secrets`, `unknown secret ${ref}`);
    if (Array.isArray(s.dependsOn)) for (const ref of s.dependsOn) {
      check(ref !== n && Object.hasOwn(services, ref), `${at}.dependsOn`, `invalid dependency ${ref}`);
      check(Array.isArray(services[ref]?.healthcheck), `${at}.dependsOn`, `${ref} must have a healthcheck`);
    }
    if (p.target === 'kubernetes') check(s.dependsOn === undefined, `${at}.dependsOn`, 'Kubernetes applications must retry dependencies; startup ordering is unsupported');
    if (s.resources !== undefined) {
      keys(s.resources, ['cpu','memory'], `${at}.resources`);
      check(typeof s.resources?.cpu === 'number' && Number.isFinite(s.resources.cpu) && s.resources.cpu > 0, `${at}.resources.cpu`, 'positive number required');
      check(typeof s.resources?.memory === 'string' && /^[1-9][0-9]*(Mi|Gi)$/.test(s.resources.memory), `${at}.resources.memory`, 'use positive Mi or Gi quantity');
    }
    if (s.route !== undefined) {
      keys(s.route, ['domain','hostPort','healthPath','expectedStatus','expectedAddresses'], `${at}.route`);
      check(typeof s.route?.domain === 'string' && domainRE.test(s.route.domain), `${at}.route.domain`, 'DNS hostname required');
      check(!domains.has(s.route?.domain), `${at}.route.domain`, 'duplicate domain'); domains.add(s.route?.domain);
      check(s.route?.healthPath === undefined || typeof s.route.healthPath === 'string' && /^\/(?!\/)[^\s#]*$/.test(s.route.healthPath), `${at}.route.healthPath`, 'must be an absolute URL path without a fragment');
      check(s.route?.expectedStatus === undefined || Number.isInteger(s.route.expectedStatus) && s.route.expectedStatus >= 200 && s.route.expectedStatus <= 299, `${at}.route.expectedStatus`, 'must be a 2xx status');
      check(s.route?.expectedAddresses === undefined || Array.isArray(s.route.expectedAddresses) && s.route.expectedAddresses.length > 0 && s.route.expectedAddresses.every((a: unknown) => typeof a === 'string' && isIP(a)), `${at}.route.expectedAddresses`, 'non-empty IP address array required');
      check(s.port !== undefined, `${at}.port`, 'required for a route');
      if (p.target === 'compose') {
        check(Number.isInteger(s.route?.hostPort) && s.route.hostPort >= 1024 && s.route.hostPort <= 65535, `${at}.route.hostPort`, 'unique loopback port 1024–65535 required');
        check(!ports.has(s.route?.hostPort), `${at}.route.hostPort`, 'duplicate host port'); ports.add(s.route?.hostPort);
      } else check(s.route?.hostPort === undefined, `${at}.route.hostPort`, 'only supported by Compose');
    }
    if (p.profile === 'production') {
      check(s.healthcheck !== undefined, `${at}.healthcheck`, 'required in production');
      if (p.target === 'kubernetes' && s.route) check(p.kubernetes?.tlsSecret, 'kubernetes.tlsSecret', 'required for production routes');
    }
    if (s.volumes !== undefined) {
      check(Array.isArray(s.volumes), `${at}.volumes`, 'expected an array');
      const names = new Set(), mounts = new Set();
      for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
        keys(v, ['name','mount','mode','size'], `${at}.volumes`);
        check(typeof v?.name === 'string' && nameRE.test(v.name) && !names.has(v.name), `${at}.volumes.name`, 'unique volume name required'); names.add(v?.name);
        check(safePath(v?.mount) && v.mount !== '/' && !mounts.has(v.mount), `${at}.volumes.mount`, 'unique absolute mount path other than / required'); mounts.add(v?.mount);
        check(['persistent','ephemeral'].includes(v?.mode), `${at}.volumes.mode`, 'must be persistent or ephemeral');
        if (p.target === 'kubernetes' && v?.mode === 'persistent') check(typeof v.size === 'string' && /^[1-9][0-9]*(Mi|Gi)$/.test(v.size), `${at}.volumes.size`, 'PVC size required');
      }
    }
  }
  // Detect dependency cycles before Compose gets involved.
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (n: string) => {
    if (visiting.has(n)) { errors.push(`services.${n}.dependsOn: dependency cycle`); return; }
    if (done.has(n)) return;
    visiting.add(n);
    for (const d of Array.isArray(services[n]?.dependsOn) ? services[n].dependsOn : []) if (Object.hasOwn(services,d)) visit(d);
    visiting.delete(n); done.add(n);
  };
  for (const n of Object.keys(services)) visit(n);
  if (errors.length) throw new Error(`Invalid GROMa configuration:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  return p as Project;
}

export function loadProject(file: string, environment?: string, images: Record<string, string> = {}): Project {
  const absolute = path.resolve(file);
  const base = load(fs.readFileSync(absolute, 'utf8'), { schema: require('js-yaml').JSON_SCHEMA });
  const withImages = (value: any): Project => {
    if (!object(value) || !object(value.services)) return validateProject(value);
    for (const [service, image] of Object.entries(images)) {
      if (!Object.hasOwn(value.services, service)) throw new Error(`Unknown image override service: ${service}`);
      value.services[service] = { ...value.services[service], image };
    }
    return validateProject(value);
  };
  if (!environment) return withImages(base);
  if (!nameRE.test(environment)) throw new Error('Invalid environment name');
  const overlay = path.join(path.dirname(absolute), 'environments', `${environment}.yaml`);
  if (!fs.existsSync(overlay)) throw new Error(`Environment overlay not found: ${overlay}`);
  const merge = (a: any, b: any): any => {
    if (!object(a) || !object(b)) return b;
    const out = Object.assign(Object.create(null), a);
    for (const [k,v] of Object.entries(b)) {
      if (['__proto__','prototype','constructor'].includes(k)) throw new Error(`Unsafe config key: ${k}`);
      out[k] = merge(a[k],v);
    }
    return out;
  };
  return withImages({ ...merge(base, load(fs.readFileSync(overlay,'utf8'))), environment });
}
export const projectName = (p: Project) => `${p.name}-${p.environment}`;
