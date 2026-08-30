import { dump } from 'js-yaml';
import { App, Chart, ApiObject } from 'cdk8s';
import { Project, projectName } from './config';

const literal = (v: string) => v.replace(/\$/g, '$$$$');
export function renderCompose(p: Project): string {
  const services: Record<string, any> = {}, volumes: Record<string, any> = {};
  for (const [name,s] of Object.entries(p.services)) {
    const mounts: any[] = [], tmpfs: string[] = [];
    for (const v of s.volumes ?? []) {
      if (v.mode === 'ephemeral') tmpfs.push(v.mount);
      else { const key = `${name}-${v.name}`; volumes[key] = {}; mounts.push({ type: 'volume', source: key, target: v.mount }); }
    }
    services[name] = {
      image: s.image, restart: 'unless-stopped', init: true,
      cpus: s.resources?.cpu ?? 0.5, mem_limit: (s.resources?.memory ?? '256Mi').replace('Mi','m').replace('Gi','g'),
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      ...(s.command ? { command: s.command.map(literal) } : {}),
      ...(s.environment ? { environment: Object.fromEntries(Object.entries(s.environment).map(([k,v]) => [k,literal(v)])) } : {}),
      ...(s.secrets ? { secrets: s.secrets } : {}),
      ...(s.route ? { ports: [`127.0.0.1:${s.route.hostPort}:${s.port}`] } : {}),
      ...(s.healthcheck ? { healthcheck: { test: ['CMD', ...s.healthcheck.map(literal)], interval: '10s', timeout: '5s', retries: 12, start_period: '10s' } } : {}),
      ...(s.dependsOn ? { depends_on: Object.fromEntries(s.dependsOn.map(n => [n,{condition:'service_healthy'}])) } : {}),
      ...(mounts.length ? { volumes: mounts } : {}), ...(tmpfs.length ? { tmpfs } : {}),
    };
  }
  return dump({ name: projectName(p), services, networks: { default: {} },
    ...(Object.keys(volumes).length ? { volumes } : {}),
    ...(p.secrets ? { secrets: Object.fromEntries(Object.entries(p.secrets).map(([k,v]) => [k,{file:v.file}])) } : {}),
  }, { noRefs: true, lineWidth: -1 });
}
export function renderCaddy(p: Project): string {
  return Object.values(p.services).filter(s => s.route).map(s => `${s.route!.domain} {\n  reverse_proxy 127.0.0.1:${s.route!.hostPort}\n}\n`).join('\n');
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
    apiVersion, kind, metadata: { name, ...(kind === 'Namespace' ? {} : { namespace: ns }), labels: {'app.kubernetes.io/part-of': p.name} }, ...body,
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
    for (const secret of s.secrets ?? []) {
      const ref = p.secrets![secret];
      volumes.push({name:`secret-${secret}`,secret:{secretName:ref.secretName,items:[{key:ref.key,path:secret}]}});
      volumeMounts.push({name:`secret-${secret}`,mountPath:`/run/secrets/${secret}`,subPath:secret,readOnly:true});
    }
    add('apps/v1','Deployment',name,{spec:{replicas:1, ...(s.volumes?.some(v=>v.mode==='persistent') ? {strategy:{type:'Recreate'}} : {}), selector:{matchLabels:labels},template:{metadata:{labels},spec:{containers:[{
      name,image:s.image,
      ...(s.command ? {args:s.command} : {}),
      ...(s.port ? {ports:[{containerPort:s.port}]} : {}),
      env:Object.entries(s.environment ?? {}).map(([name,value])=>({name,value})),
      resources:{limits:{cpu:String(s.resources?.cpu ?? 0.5),memory:s.resources?.memory ?? '256Mi'}},
      ...(s.healthcheck ? {readinessProbe:{exec:{command:s.healthcheck},periodSeconds:10,timeoutSeconds:5},livenessProbe:{exec:{command:s.healthcheck},initialDelaySeconds:30,periodSeconds:10,timeoutSeconds:5}} : {}),
      volumeMounts,
    }],volumes}}}});
    if (s.port) add('v1','Service',name,{spec:{selector:labels,ports:[{port:s.port,targetPort:s.port}]}});
    if (s.route) add('networking.k8s.io/v1','Ingress',name,{spec:{
      ...(p.kubernetes?.ingressClass ? {ingressClassName:p.kubernetes.ingressClass}:{}),
      ...(p.kubernetes?.tlsSecret ? {tls:[{secretName:p.kubernetes.tlsSecret,hosts:[s.route.domain]}]}:{}),
      rules:[{host:s.route.domain,http:{paths:[{path:'/',pathType:'Prefix',backend:{service:{name,port:{number:s.port}}}}]}}],
    }});
  }
  return app.synthYaml();
}
