import { promises as dns } from 'dns';
import * as https from 'https';
import { isIP } from 'net';
import { TLSSocket } from 'tls';
import { Project } from './config';

export interface EndpointResult {
  service: string;
  url: string;
  addresses: string[];
  expectedAddresses?: string[];
  certificates: Array<{ address: string; expiresAt: string; daysRemaining: number }>;
  ok: boolean;
  error?: string;
}
export interface VerificationResult { ok: boolean; skipped: boolean; endpoints: EndpointResult[] }
export interface VerifyOptions { timeoutMs?: number; waitMs?: number; minCertificateDays?: number }
export interface VerifyDependencies {
  resolve: (hostname: string) => Promise<string[]>;
  probe: (hostname: string, address: string, path: string, timeout: number) => Promise<{ status: number; expiresAt: string }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

async function resolve(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const answers = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = answers.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  if (!addresses.length) throw new Error(`DNS: no A or AAAA records for ${hostname}`);
  return [...new Set(addresses)].sort();
}

/** TLS validation stays enabled. Pin each connection to a resolved address while retaining hostname/SNI checks. */
export function probeHttps(hostname: string, address: string, path: string, timeout: number, port = 443, ca?: string): Promise<{ status: number; expiresAt: string }> {
  return new Promise((done, reject) => {
    const request = https.get({ hostname, port, path, ...(ca ? {ca} : {}), servername: hostname, rejectUnauthorized: true, agent: false,
      lookup: ((_host: string, options: any, callback: Function) => options?.all ? callback(null, [{address, family:isIP(address)}]) : callback(null, address, isIP(address))) as any,
    }, response => {
      const socket = response.socket as TLSSocket;
      const cert = socket.getPeerCertificate();
      clearTimeout(timer);
      response.destroy();
      if (!socket.authorized || !cert.valid_to) reject(new Error('TLS: certificate was not validated'));
      else done({ status: response.statusCode ?? 0, expiresAt: cert.valid_to });
    });
    const timer = setTimeout(() => request.destroy(new Error('HTTPS: request timed out')), timeout);
    request.on('error', error => { clearTimeout(timer); reject(error); });
  });
}
const defaults: VerifyDependencies = { resolve, probe: probeHttps, now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)) };
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS: lookup timed out')), ms); })]); }
  finally { clearTimeout(timer!); }
}

export async function verifyProject(p: Project, options: VerifyOptions = {}, deps: VerifyDependencies = defaults): Promise<VerificationResult> {
  const normalizedIP = (address: string) => isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname : address;
  const timeout = options.timeoutMs ?? 10000;
  const wait = options.waitMs ?? 0;
  const minDays = options.minCertificateDays ?? 7;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000 || !Number.isFinite(wait) || wait < 0 || wait > 600000 || !Number.isFinite(minDays) || minDays < 0 || minDays > 365) {
    throw new Error('Invalid verification timeout, wait period, or certificate threshold');
  }
  const entries = Object.entries(p.services).filter(([, s]) => s.route);
  const deadline = deps.now() + wait;
  let endpoints: EndpointResult[];
  do {
    endpoints = await Promise.all(entries.map(async ([service, s]): Promise<EndpointResult> => {
      const route = s.route!;
      const result: EndpointResult = { service, url: `https://${route.domain}${route.healthPath ?? '/'}`, addresses: [], certificates: [], ok: false };
      try {
        result.addresses = await bounded(deps.resolve(route.domain), timeout);
        result.expectedAddresses = route.expectedAddresses ?? (p.target === 'compose' ? await bounded(deps.resolve(p.host!.ssh.split('@')[1]), timeout) : undefined);
        if (!result.addresses.length) throw new Error('DNS: no addresses returned');
        if (result.expectedAddresses && result.addresses.some(address => !result.expectedAddresses!.map(normalizedIP).includes(normalizedIP(address)))) {
          throw new Error('DNS: one or more public addresses do not match the expected target; check A/AAAA records or set route.expectedAddresses for a proxy');
        }
        // Check every advertised address, so a broken AAAA record cannot hide behind a working A record.
        for (const address of result.addresses) {
          const response = await deps.probe(route.domain, address, route.healthPath ?? '/', timeout);
          const expires = Date.parse(response.expiresAt);
          const daysRemaining = Math.floor((expires - deps.now()) / 86400000);
          if (!Number.isFinite(expires) || daysRemaining < minDays) throw new Error(`TLS: certificate expires in fewer than ${minDays} days`);
          result.certificates.push({ address, expiresAt: new Date(expires).toISOString(), daysRemaining });
          if (response.status !== (route.expectedStatus ?? 200)) throw new Error(`HTTP health: expected ${route.expectedStatus ?? 200}, received ${response.status}`);
        }
        result.ok = true;
      } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
      return result;
    }));
    if (endpoints.every(endpoint => endpoint.ok) || deps.now() >= deadline) break;
    await deps.sleep(Math.min(5000, Math.max(0, deadline - deps.now())));
  } while (true);
  return { ok: endpoints.every(endpoint => endpoint.ok), skipped: entries.length === 0, endpoints };
}
