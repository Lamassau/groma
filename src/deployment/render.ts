import { dump } from 'js-yaml';
import { App, Chart, ApiObject } from 'cdk8s';
import { AppService, Project, Route, projectName } from './config';

const literal = (v: string) => v.replace(/\$/g, '$$$$');
const cleanPrefix = (value: string) => value.length > 1 ? value.replace(/\/$/, '') : value;
const secretEnvironment = (s: AppService) => Object.fromEntries(Object.entries(s.secretEnv ?? {}).map(([variable,secret])=>[`${variable}_FILE`,`/run/secrets/${secret}`]));
const httpShell = (port: number, path: string) => {
  const url=`http://127.0.0.1:${port}${path}`;
  return `if command -v wget >/dev/null 2>&1; then wget -q -O /dev/null ${url}; elif command -v curl >/dev/null 2>&1; then curl -fsS -o /dev/null ${url}; elif command -v node >/dev/null 2>&1; then node -e "fetch('${url}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; else echo 'GROMa HTTP healthcheck requires wget, curl, or node inside the image' >&2; exit 127; fi`;
};

export function renderCompose(p: Project): string {
  const services: Record<string, any> = {}, volumes: Record<string, any> = {};
  for (const [name,s] of Object.entries(p.services)) {
    const mounts: any[] = [], tmpfs: string[] = [];
    for (const v of s.volumes ?? []) {
      if (v.mode === 'ephemeral') tmpfs.push(v.mount);
      else {
        const key = `${name}-${v.name}`;
        volumes[key] = v.external ? {external:true,name:v.external} : {};
        mounts.push({ type: 'volume', source: key, target: v.mount });
      }
    }
    const environment={...secretEnvironment(s),...(s.environment ?? {})};
    const health=s.healthcheck ? Array.isArray(s.healthcheck)
      ? { test: ['CMD', ...s.healthcheck.map(literal)], interval: '10s', timeout: '5s', retries: 12, start_period: '10s' }
      : { test:['CMD-SHELL',httpShell(s.port!,s.healthcheck.http)], interval:'10s',timeout:'5s',retries:12,start_period:'10s' }
      : undefined;
    services[name] = {
      image: s.image, restart: 'unless-stopped', init: true,
      cpus: s.resources?.cpu ?? 0.5, mem_limit: (s.resources?.memory ?? '256Mi').replace('Mi','m').replace('Gi','g'),
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      ...(s.command ? { command: s.command.map(literal) } : {}),
      ...(Object.keys(environment).length ? { environment: Object.fromEntries(Object.entries(environment).map(([k,v]) => [k,literal(v)])) } : {}),
      ...(s.secrets ? { secrets: s.secrets } : {}),
      ...(s.route ? { ports: [`127.0.0.1:${s.route.hostPort}:${s.port}`] } : {}),
      ...(health ? {healthcheck:health} : {}),
      ...(s.dependsOn ? { depends_on: Object.fromEntries(s.dependsOn.map(n => [n,{condition:'service_healthy'}])) } : {}),
      ...(mounts.length ? { volumes: mounts } : {}), ...(tmpfs.length ? { tmpfs } : {}),
    };
  }
  return dump({ name: projectName(p), services, networks: { default: {} },
    ...(Object.keys(volumes).length ? { volumes } : {}),
    ...(p.secrets ? { secrets: Object.fromEntries(Object.entries(p.secrets).map(([k,v]) => [k,{file:v.file}])) } : {}),
  }, { noRefs: true, lineWidth: -1 });
}

function caddyPath(route: Route, port: number, index: number): string[] {
  const prefix=cleanPrefix(route.path ?? '/');
  if(prefix==='/') return [`  handle {`,`    reverse_proxy 127.0.0.1:${port}`,`  }`];
  if(route.stripPathPrefix) return [
    `  handle_path ${prefix}/* {`,`    reverse_proxy 127.0.0.1:${port}`,`  }`,
    `  handle ${prefix} {`,`    uri strip_prefix ${prefix}`,`    reverse_proxy 127.0.0.1:${port}`,`  }`,
  ];
  const matcher=`@groma_route_${index}`;
  const lines=[`  ${matcher} path ${prefix} ${prefix}/*`,`  handle ${matcher} {`];
  if(route.rewritePrefix!==undefined) {
    lines.push(`    uri strip_prefix ${prefix}`);
    if(route.rewritePrefix!=='/') lines.push(`    uri prepend ${cleanPrefix(route.rewritePrefix)}`);
  }
  lines.push(`    reverse_proxy 127.0.0.1:${port}`,`  }`); return lines;
}
export function renderCaddy(p: Project): string {
  const byDomain=new Map<string,Array<{route:Route;port:number}>>();
  for(const service of Object.values(p.services)) if(service.route) {
    const list=byDomain.get(service.route.domain) ?? []; list.push({route:service.route,port:service.route.hostPort!}); byDomain.set(service.route.domain,list);
  }
  const blocks:string[]=[];
  for(const [domain,entries] of [...byDomain.entries()].sort(([a],[b])=>a.localeCompare(b))) {
    entries.sort((a,b)=>cleanPrefix(b.route.path??'/').length-cleanPrefix(a.route.path??'/').length);
    const lines=[`${domain} {`]; let index=0;
    for(const entry of entries) lines.push(...caddyPath(entry.route,entry.port,index++));
    lines.push('}'); blocks.push(lines.join('\n')+'\n');
  }
  return blocks.join('\n');
}
export function renderRoutes(p: Project): string {
  return Object.values(p.services).filter(s => s.route).map(s => `${s.route!.domain}\t${s.route!.hostPort}`).join('\n') + '\n';
}

/** Neutral schema -> CDK8s API objects. Legacy FullStackChart remains available unchanged as an API. */
export function renderKubernetes(p: Project): string {
  const app = new App(), chart = new Chart(app, projectName(p));
  const ns = projectName(p);
  let index = 0;
  const add = (apiVersion: string, kind: string, name: string, body: any = {}) => new ApiObject(chart, `resource-${index++}`, {
    apiVersion, kind, metadata: { name, ...(kind === 'Namespace' ? {} : { namespace: ns }), labels: {'app.kubernetes.io/part-of': p.name}, ...(body.metadata ?? {}) }, ...Object.fromEntries(Object.entries(body).filter(([k])=>k!=='metadata')),
  });
  add('v1','Namespace',ns);
  for (const [name,s] of Object.entries(p.services)) {
    const labels = {'app.kubernetes.io/name':name,'app.kubernetes.io/part-of':p.name};
    const volumes: any[] = [], volumeMounts: any[] = [];
    for (const v of s.volumes ?? []) {
      const id = `${name}-${v.name}`;
      if (v.mode === 'persistent') {
        add('v1','PersistentVolumeClaim',id,{spec:{accessModes:['ReadWriteOnce'], resources:{requests:{storage:v.size}}, ...(p.kubernetes?.storageClass ? {storageClassName:p.kubernetes.storageClass} : {})}});
        volumes.push({name:`data-${v.name}`,persistentVolumeClaim:{claimName:id}});
      } else volumes.push({name:`data-${v.name}`,emptyDir:{}});
      volumeMounts.push({name:`data-${v.name}`,mountPath:v.mount});
    }
    const envSecretRefs=new Set(Object.values(s.secretEnv ?? {}));
    for (const secret of s.secrets ?? []) {
      if(envSecretRefs.has(secret)) continue;
      const ref = p.secrets![secret];
      volumes.push({name:`secret-${secret}`,secret:{secretName:ref.secretName,items:[{key:ref.key,path:secret}]}});
      volumeMounts.push({name:`secret-${secret}`,mountPath:`/run/secrets/${secret}`,subPath:secret,readOnly:true});
    }
    const env:any[]=Object.entries(s.environment ?? {}).map(([name,value])=>({name,value}));
    for(const [variable,secret] of Object.entries(s.secretEnv ?? {})) if(!Object.hasOwn(s.environment ?? {},variable)) {
      const ref=p.secrets![secret]; env.push({name:variable,valueFrom:{secretKeyRef:{name:ref.secretName,key:ref.key}}});
    }
    const probe=s.healthcheck ? Array.isArray(s.healthcheck)
      ? {exec:{command:s.healthcheck},periodSeconds:10,timeoutSeconds:5}
      : {httpGet:{path:s.healthcheck.http,port:s.port},periodSeconds:10,timeoutSeconds:5}
      : undefined;
    add('apps/v1','Deployment',name,{spec:{replicas:s.replicas ?? 1, ...(s.volumes?.some(v=>v.mode==='persistent') ? {strategy:{type:'Recreate'}} : {}), selector:{matchLabels:labels},template:{metadata:{labels},spec:{containers:[{
      name,image:s.image,
      ...(s.command ? {args:s.command} : {}),
      ...(s.port ? {ports:[{containerPort:s.port}]} : {}),
      env,
      resources:{limits:{cpu:String(s.resources?.cpu ?? 0.5),memory:s.resources?.memory ?? '256Mi'}},
      ...(probe ? {readinessProbe:probe,livenessProbe:{...probe,initialDelaySeconds:30}} : {}),
      volumeMounts,
    }],volumes}}}});
    if (s.port) add('v1','Service',name,{spec:{selector:labels,ports:[{port:s.port,targetPort:s.port}]}});
    if (s.route) {
      const prefix=cleanPrefix(s.route.path ?? '/');
      const rewrite=s.route.stripPathPrefix||s.route.rewritePrefix!==undefined;
      const ingressPath=rewrite&&prefix!=='/' ? `^${prefix}(/|$)(.*)` : prefix;
      const target=s.route.stripPathPrefix ? '/$2' : s.route.rewritePrefix!==undefined ? `${cleanPrefix(s.route.rewritePrefix)==='/'?'':cleanPrefix(s.route.rewritePrefix)}/$2` || '/$2' : undefined;
      const annotations:Record<string,string>={};
      if(rewrite) {annotations['nginx.ingress.kubernetes.io/use-regex']='true';annotations['nginx.ingress.kubernetes.io/rewrite-target']=target!;}
      add('networking.k8s.io/v1','Ingress',name,{...(Object.keys(annotations).length?{metadata:{annotations}}:{}),spec:{
        ...(p.kubernetes?.ingressClass ? {ingressClassName:p.kubernetes.ingressClass}:{}),
        ...(p.kubernetes?.tlsSecret ? {tls:[{secretName:p.kubernetes.tlsSecret,hosts:[s.route.domain]}]}:{}),
        rules:[{host:s.route.domain,http:{paths:[{path:ingressPath,pathType:rewrite?'ImplementationSpecific':'Prefix',backend:{service:{name,port:{number:s.port}}}}]}}],
      }});
    }
  }
  return app.synthYaml();
}
