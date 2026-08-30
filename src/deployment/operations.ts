import * as fs from 'fs';
import * as path from 'path';
import { Project, projectName } from './config';
import { quote, ssh } from './remote';
import { renderCompose, renderCaddy } from './render';

export interface Snapshot {
  currentRelease: string | null;
  current: any | null;
  candidate: any;
  imageLock: string;
  currentRoutes: string;
  candidateRoutes: string;
}
export interface DeploymentPlan {
  project: string;
  currentRelease: string | null;
  services: Array<{ name: string; action: 'add' | 'remove' | 'change'; image?: { from?: string; to?: string }; fields: string[] }>;
  routes: { changed: boolean; before: string; after: string };
  risks: string[];
  changed: boolean;
}
export function agentScript(p: Project, action: string, extra: Record<string, unknown> = {}): string {
  const source = fs.readFileSync(path.join(__dirname, 'agent.py'), 'utf8');
  const payload = Buffer.from(JSON.stringify({ project: projectName(p), identity: `${p.name}:${p.environment}`, ...extra })).toString('base64');
  return `set -eu\npython3 -c ${quote(source)} ${quote(action)} ${quote(payload)}\n`;
}
export function remoteOperation(p: Project, action: string, extra: Record<string, unknown> = {}): any {
  return JSON.parse(ssh(p, agentScript(p, action, extra), true));
}
export function snapshot(p: Project): Snapshot {
  return remoteOperation(p, 'snapshot', { compose: renderCompose(p), routes: renderCaddy(p) });
}
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Return field names, never environment or command values, so CI plans don't leak accidentally embedded credentials. */
export function buildPlan(p: Project, data: Snapshot): DeploymentPlan {
  const before = data.current?.services ?? {};
  const after = data.candidate.services ?? {};
  const services: DeploymentPlan['services'] = [];
  const risks = new Set<string>();
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const old = before[name], next = after[name];
    if (same(old, next)) continue;
    const fields = [...new Set([...Object.keys(old ?? {}), ...Object.keys(next ?? {})])].filter(key => !same(old?.[key], next?.[key])).sort();
    services.push({ name, action: !old ? 'add' : !next ? 'remove' : 'change',
      ...(!same(old?.image, next?.image) ? { image: { from: old?.image, to: next?.image } } : {}), fields });
    if (old && !next) risks.add('service-removal');
    const persistent = (s: any) => (s?.volumes ?? []).filter((v: any) => v.type === 'volume');
    if (old && persistent(old).length && !same(persistent(old), persistent(next))) risks.add('persistent-storage-change');
    if (old && !same(old.tmpfs, next?.tmpfs)) risks.add('ephemeral-storage-change');
  }
  if (data.current && !same(data.current.volumes, data.candidate.volumes)) risks.add('volume-definition-change');
  if (data.current && !same(data.current.secrets, data.candidate.secrets)) risks.add('secret-reference-change');
  const routesChanged = data.currentRoutes !== data.candidateRoutes;
  if (data.current && routesChanged) risks.add('route-change');
  return { project: projectName(p), currentRelease: data.currentRelease, services,
    routes: { changed: routesChanged, before: data.currentRoutes, after: data.candidateRoutes },
    risks: [...risks].sort(), changed: services.length > 0 || routesChanged || risks.size > 0 };
}
export function formatPlan(plan: DeploymentPlan): string {
  const lines = [`${plan.project}: ${plan.currentRelease ?? 'new deployment'}`];
  for (const service of plan.services) {
    lines.push(`  ${service.action.toUpperCase()} ${service.name}: ${service.fields.join(', ')}`);
    if (service.image) lines.push(`    image: ${service.image.from ?? '(none)'} -> ${service.image.to ?? '(none)'}`);
  }
  if (plan.routes.changed) lines.push(`  Routes before:\n${plan.routes.before || '(none)'}\n  Routes after:\n${plan.routes.after || '(none)'}`);
  if (plan.risks.length) lines.push(`  Review: ${plan.risks.join(', ')}`);
  if (!plan.changed) lines.push('  No configuration or image digest changes.');
  return lines.join('\n');
}
export function enforcePlan(plan: DeploymentPlan, allowRemoval: boolean, allowStorage: boolean): void {
  if (plan.risks.includes('service-removal') && !allowRemoval) throw new Error('Plan removes services. Review it and pass --allow-service-removal explicitly.');
  if (plan.risks.some(r => ['persistent-storage-change','ephemeral-storage-change','volume-definition-change'].includes(r)) && !allowStorage) {
    throw new Error('Plan changes storage. Review it and pass --allow-storage-change explicitly. No volume data will be deleted.');
  }
}
