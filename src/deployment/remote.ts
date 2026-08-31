import { spawnSync } from 'child_process';
import { Project, projectName } from './config';
import { renderCompose, renderCaddy, renderRoutes } from './render';

export const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export function run(command: string, args: string[], input?: string, capture = false): string {
  const r = spawnSync(command,args,{input,encoding:'utf8',stdio:[input === undefined ? 'inherit' : 'pipe',capture ? 'pipe':'inherit',capture ? 'pipe':'inherit'],maxBuffer:16*1024*1024});
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} failed (exit ${r.status ?? r.signal})${capture ? `: ${r.stderr}` : ''}`);
  return r.stdout ?? '';
}
export function ssh(p: Project, script: string, capture = false): string {
  return run('ssh',[...(process.env.GROMA_SSH_CONFIG ? ['-F',process.env.GROMA_SSH_CONFIG] : []),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','-p',String(p.host!.port ?? 22),'--',p.host!.ssh,'bash -se'],script,capture);
}
const put = (name: string, data: string) => `printf '%s' ${quote(Buffer.from(data).toString('base64'))} | base64 -d > ${quote(name)}`;
export function doctorScript(p: Project): string {
  return `set -eu\ncommand -v python3 >/dev/null\ncommand -v ss >/dev/null\n[ "$(docker version --format '{{.Server.Version}}' | cut -d. -f1)" -ge 28 ] || { echo 'Docker Engine 28+ required' >&2; exit 1; }\ndocker info >/dev/null\ndocker compose version\ndocker compose config --help | grep -q -- --lock-image-digests\ndocker compose up --help | grep -q -- --wait-timeout\ncommand -v flock >/dev/null\ntest -d /opt/groma\ntest -w /opt/groma\n${Object.values(p.services).some(s=>s.route) ? 'sudo -n caddy validate --config /etc/caddy/Caddyfile\ngrep -Fxq "import /etc/caddy/groma/*.caddy" /etc/caddy/Caddyfile\nsystemctl is-active --quiet caddy' : ''}\n${Object.values(p.secrets ?? {}).map(s=>`test -r ${quote(s.file!)} && test -f ${quote(s.file!)}`).join('\n')}\n`;
}
/** Releases contain references to host secret files, never secret contents. Host-wide lock protects ports and proxy changes. */
export function deployScript(p: Project, release: string, rollback = false, approved?: { imageLock: string; currentRelease: string | null }, deployedBy = process.env.GITHUB_ACTOR ?? process.env.USER ?? 'unknown'): string {
  if (!/^[a-zA-Z0-9-]+$/.test(release)) throw new Error('Invalid release identifier');
  const name = projectName(p), root = `/opt/groma/${name}`;
  return `set -eu
umask 077
exec 9>/opt/groma/.deploy.lock
flock -w 120 9
root=${quote(root)}
mkdir -p "$root/releases"
old=""
if [ -L "$root/current" ]; then
  old=$(readlink -f "$root/current")
  printf '%s' ${quote(p.name + ':' + p.environment)} | cmp -s "$old/identity" - || { echo 'Project identity collision or missing release metadata' >&2; exit 1; }
fi
${approved ? `expected=${quote(approved.currentRelease ?? '')}
actual=""
if [ -n "$old" ]; then actual=$(basename "$old"); fi
[ "$actual" = "$expected" ] || { echo 'Active release changed since plan; run plan again.' >&2; exit 1; }` : ''}
${rollback ? 'next=$(readlink -f "$root/previous")\ntest -f "$next/compose.yaml"' : `next="$root/releases/${release}"
mkdir "$next"
cd "$next"
${put('identity',p.name + ':' + p.environment)}
${put('project.json',JSON.stringify(p))}
${approved ? put('images.lock.yaml',approved.imageLock) : ''}
${put('compose.yaml',renderCompose(p))}
${put('route.caddy',renderCaddy(p))}
${put('routes.tsv',renderRoutes(p))}
${put('release.json',JSON.stringify({release,project:name,deployedBy,deployedAt:new Date().toISOString(),images:Object.fromEntries(Object.entries(p.services).map(([n,s])=>[n,s.image]))},null,2))}`}
# Compare all other active GROMa projects before touching containers.
for manifest in /opt/groma/*/current/routes.tsv; do
  [ -f "$manifest" ] || continue
  [ "$manifest" = "$root/current/routes.tsv" ] && continue
  awk 'NR==FNR {if(NF==2){domains[$1]=1;ports[$2]=1};next} NF==2 && (domains[$1] || ports[$2]) {exit 1}' "$manifest" "$next/routes.tsv" || { echo 'Domain or host port already owned by another GROMa project' >&2; exit 1; }
done
compose() {
  directory="$1"; shift
  files=(-f "$directory/compose.yaml")
  [ ! -f "$directory/images.lock.yaml" ] || files+=( -f "$directory/images.lock.yaml" )
  [ ! -f "$directory/secret-env.override.json" ] || files+=( -f "$directory/secret-env.override.json" )
  docker compose --project-name ${quote(name)} --project-directory "$directory" "\${files[@]}" "$@"
}
compose "$next" config --quiet
if [ -z "$old" ] && [ -n "$(docker ps -aq --filter label=com.docker.compose.project=${quote(name)})" ]; then
  echo 'Existing containers have this project name but no GROMa release record; refusing takeover.' >&2; exit 1
fi
while read -r domain port; do
  [ -n "$port" ] || continue
  if [ -n "$old" ] && awk -v p="$port" '$2==p {found=1} END {exit !found}' "$old/routes.tsv"; then continue; fi
  if ss -H -ltn | awk -v p="$port" '$4 ~ ":"p"$" {found=1} END {exit !found}'; then
    echo "Host port $port is already in use" >&2; exit 1
  fi
done < "$next/routes.tsv"
if [ ! -f "$next/images.lock.yaml" ]; then
  compose "$next" config --lock-image-digests > "$next/images.lock.tmp"
  test -s "$next/images.lock.tmp"
  mv "$next/images.lock.tmp" "$next/images.lock.yaml"
fi
compose "$next" pull
${Object.values(p.services).some(s=>s.secretEnv && Object.keys(s.secretEnv).length) ? `${put('secret-env-entrypoint',`#!/bin/sh
set -eu
while IFS='=' read -r variable file; do
  [ -n "$variable" ] || continue
  eval "present=\${$variable+x}"
  [ "$present" = x ] && continue
  if [ ! -r "$file" ]; then echo "GROMa secretEnv: $variable cannot read $file" >&2; exit 78; fi
  value=$(cat "$file")
  if [ -z "$value" ]; then echo "GROMa secretEnv: $variable secret file is empty" >&2; exit 78; fi
  export "$variable=$value"
done <<GROMA_SECRET_ENV_EOF
$GROMA_SECRET_ENV
GROMA_SECRET_ENV_EOF
unset GROMA_SECRET_ENV
exec "$@"
`)}
chmod 700 "$next/secret-env-entrypoint"
python3 - "$next" ${quote(name)} <<'GROMA_SECRET_ENV_PY'
import json, pathlib, subprocess, sys
release=pathlib.Path(sys.argv[1]); project_name=sys.argv[2]
project=json.loads((release/'project.json').read_text())
base=['docker','compose','--project-name',project_name,'--project-directory',str(release),'-f',str(release/'compose.yaml')]
if (release/'images.lock.yaml').is_file(): base += ['-f',str(release/'images.lock.yaml')]
effective=json.loads(subprocess.check_output(base+['config','--format','json'],text=True))
override={'services':{}}
for name,service in project['services'].items():
    mapping=service.get('secretEnv') or {}
    if not mapping: continue
    image=effective['services'][name]['image']
    info=json.loads(subprocess.check_output(['docker','image','inspect',image],text=True))[0]['Config']
    entry=info.get('Entrypoint') or []
    cmd=service.get('command') if service.get('command') is not None else (info.get('Cmd') or [])
    if not isinstance(entry,list) or not isinstance(cmd,list) or not entry+cmd:
        raise SystemExit(f'secretEnv cannot preserve image entrypoint/command for service {name}')
    # The mounted shim is intentionally explicit. Distroless/scratch images should use
    # native *_FILE support or Kubernetes secretKeyRef until a static shim is shipped.
    probe=subprocess.run(['docker','run','--rm','--entrypoint','/bin/sh',image,'-c','exit 0'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if probe.returncode:
        raise SystemExit(f'secretEnv requires /bin/sh inside service {name}; use native *_FILE or Kubernetes for this image')
    pairs='\n'.join(f'{variable}=/run/secrets/{secret}' for variable,secret in mapping.items())
    override['services'][name]={
      'entrypoint':['/bin/sh','/run/groma/secret-env-entrypoint'],
      'command':entry+cmd,
      'environment':{'GROMA_SECRET_ENV':pairs},
      'volumes':[{'type':'bind','source':str(release/'secret-env-entrypoint'),'target':'/run/groma/secret-env-entrypoint','read_only':True}],
    }
(release/'secret-env.override.json').write_text(json.dumps(override,separators=(',',':')))
GROMA_SECRET_ENV_PY
` : ''}
route=/etc/caddy/groma/${name}.caddy
had_route=0
proxy_changed=0
if sudo -n test -f "$route"; then sudo -n cat "$route" > "$next/old-route.caddy"; had_route=1; fi
diagnose_health() {
  for id in $(docker ps -aq --filter label=com.docker.compose.project=${quote(name)}); do
    service=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$id" 2>/dev/null || true)
    health=$(docker inspect --format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}none{{ end }}' "$id" 2>/dev/null || true)
    if [ "$health" != healthy ] && [ "$health" != none ]; then
      echo "Healthcheck failed for service $service ($health); the healthcheck executable must exist inside the image. Last health-check output follows:" >&2
      docker inspect --format '{{ if .State.Health }}{{ range .State.Health.Log }}{{ .Output }}{{ end }}{{ end }}' "$id" 2>/dev/null | tail -c 4096 >&2 || true
    fi
  done
}
recover() {
  code=$?
  [ "$code" -eq 0 ] || diagnose_health
  trap - EXIT
  set +e
  if [ "$code" -ne 0 ]; then
    echo 'Deployment failed; attempting to restore the previous application configuration.' >&2
    if [ -n "$old" ] && [ -f "$old/compose.yaml" ]; then
      compose "$old" up -d --remove-orphans --wait --wait-timeout 120 || echo 'Application recovery FAILED; inspect services manually.' >&2
    else
      compose "$next" down || echo 'Cleanup FAILED; inspect services manually.' >&2
    fi
    if [ "$proxy_changed" = 1 ]; then
      if [ "$had_route" = 1 ]; then sudo -n install -m 644 "$next/old-route.caddy" "$route"; else sudo -n rm -f "$route"; fi
      sudo -n systemctl reload caddy || echo 'Proxy recovery FAILED.' >&2
    fi
  fi
  exit "$code"
}
trap recover EXIT
compose "$next" up -d --remove-orphans --wait --wait-timeout 120
# Reload the proxy only after the application is healthy. Also remove old routes on route deletion.
if [ -s "$next/route.caddy" ] || [ "$had_route" = 1 ]; then
  proxy_changed=1
  sudo -n install -m 644 "$next/route.caddy" "$route"
  sudo -n caddy validate --config /etc/caddy/Caddyfile
  sudo -n systemctl reload caddy
fi
if [ -n "$old" ] && [ "$old" != "$next" ]; then ln -sfn "$old" "$root/previous.new"; mv -Tf "$root/previous.new" "$root/previous"; fi
ln -sfn "$next" "$root/current.new"
mv -Tf "$root/current.new" "$root/current"
trap - EXIT
compose "$next" ps
`;
}
export function operationScript(p: Project, operation: 'status'|'logs'|'plan', service?: string): string {
  const root = `/opt/groma/${projectName(p)}`;
  const prefix = `set -eu\nroot=${quote(root)}\n`;
  if (operation === 'plan') return prefix + `if [ -f "$root/current/compose.yaml" ]; then\n${put('/dev/stdout',renderCompose(p))} | diff -u "$root/current/compose.yaml" - || { code=$?; [ "$code" = 1 ] || exit "$code"; }\nelse echo 'New project'; fi\n`;
  if (service && !Object.hasOwn(p.services,service)) throw new Error(`Unknown service: ${service}`);
  return prefix + `test -f "$root/current/compose.yaml"\ndocker compose --project-name ${quote(projectName(p))} --project-directory "$root/current" -f "$root/current/compose.yaml" ${operation === 'status' ? 'ps --format json' : `logs --tail 100 --no-color ${service ? quote(service) : ''}`}\n`;
}
