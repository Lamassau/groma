import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AddressInfo } from 'net';
import { probeHttps } from '../src/deployment/verify';

describe('Real TLS endpoint probes',()=>{
  let directory:string,certificate:string,key:string;
  let server:https.Server,port:number;
  beforeAll(()=>{
    directory=fs.mkdtempSync(path.join(os.tmpdir(),'groma-tls-'));
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','30','-subj','/CN=route.example.test','-addext','subjectAltName=DNS:route.example.test','-keyout',path.join(directory,'key.pem'),'-out',path.join(directory,'cert.pem')],{stdio:'ignore'});
    certificate=fs.readFileSync(path.join(directory,'cert.pem'),'utf8');key=fs.readFileSync(path.join(directory,'key.pem'),'utf8');
  });
  beforeEach(async()=>{
    server=https.createServer({key,cert:certificate},(request,response)=>{
      if(request.url==='/hang')return;
      response.writeHead(request.url==='/health'?200:503);response.end('ready');
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));port=(server.address() as AddressInfo).port;
  });
  afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  afterAll(()=>fs.rmSync(directory,{recursive:true,force:true}));
  it('checks the real hostname and returns the peer certificate expiry',async()=>{
    const result=await probeHttps('route.example.test','127.0.0.1','/health',2000,port,certificate);
    expect(result.status).toBe(200);expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });
  it('rejects untrusted and wrong-host certificates',async()=>{
    await expect(probeHttps('route.example.test','127.0.0.1','/health',2000,port)).rejects.toThrow();
    await expect(probeHttps('wrong.example.test','127.0.0.1','/health',2000,port,certificate)).rejects.toThrow();
  });
  it('enforces an overall HTTP timeout even when the server never responds',async()=>{
    await expect(probeHttps('route.example.test','127.0.0.1','/hang',100,port,certificate)).rejects.toThrow(/timed out/);
  });
});
