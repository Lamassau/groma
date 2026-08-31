import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { load } from 'js-yaml';
import { starterProject, serializeProject } from '../src/deployment/init';

jest.mock('../build/deployment/config',()=>require('../src/deployment/config'),{virtual:true});
const {contract,requireReviewers,buildDefinition}=require('../scripts/ci-contract.cjs');
const {collectImages}=require('../scripts/ci-deploy.cjs');

describe('Reusable workflow safety contract',()=>{
  let root:string;
  beforeEach(()=>{
    root=fs.mkdtempSync(path.join(os.tmpdir(),'groma-ci-'));
    fs.writeFileSync(path.join(root,'Dockerfile'),'FROM nginx:1.28-alpine\n');
    fs.writeFileSync(path.join(root,'groma.yaml'),serializeProject(starterProject({host:'deploy@host.example.com'})));
  });
  afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
  const toolkitHead=()=>execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const input=()=>({environment:'dev',target:'deploy@host.example.com',gromaRef:toolkitHead(),config:'groma.yaml',overlay:'',services:JSON.stringify([{service:'web',context:'.',dockerfile:'Dockerfile'}])});
  it('validates build definitions and explicit target',()=>{
    expect(contract(input(),root).matrix).toHaveLength(1);
    expect(()=>contract({...input(),target:'deploy@other.example.com'},root)).toThrow(/target/);
    expect(()=>contract({...input(),gromaRef:'main'},root)).toThrow(/commit SHA/);
    expect(()=>contract({...input(),services:'[{"service":"web","context":"../outside","dockerfile":"Dockerfile"}]'},root)).toThrow(/context/);
  });
  it('accepts reviewed target, build args, platforms and secret IDs without accepting secret values',()=>{
    const item=buildDefinition({service:'web',context:'.',dockerfile:'Dockerfile',target:'production',buildArgs:{PUBLIC_URL:'https://example.com'},platforms:['linux/amd64','linux/arm64'],secrets:['NPM_TOKEN']},new Set());
    expect(item.target).toBe('production');
    expect(item.buildArgsText).toContain('PUBLIC_URL=https://example.com');
    expect(item.platformsText).toBe('linux/amd64,linux/arm64');
    expect(()=>buildDefinition({service:'web',context:'.',dockerfile:'Dockerfile',buildArgs:{BAD:'one\ntwo'}},new Set())).toThrow(/buildArgs/);
    expect(()=>buildDefinition({service:'web',context:'.',dockerfile:'Dockerfile',secrets:['TOKEN=value']},new Set())).toThrow(/secret IDs/);
  });
  it('refuses accidental production deployment via a dev environment',()=>{
    const p=starterProject({host:'deploy@host.example.com'});p.profile='production';
    fs.writeFileSync(path.join(root,'groma.yaml'),serializeProject(p));
    expect(()=>contract(input(),root)).toThrow(/Production profile/);
    expect(contract({...input(),environment:'production'},root).project).toBe('my-app-dev');
  });
  it('fails closed without a real independent production review policy',()=>{
    for(const policy of [{},{protection_rules:[]},{protection_rules:[{type:'required_reviewers',reviewers:[],prevent_self_review:true}]},{protection_rules:[{type:'required_reviewers',reviewers:[{}],prevent_self_review:false}]}]) {
      expect(()=>requireReviewers(policy)).toThrow(/required reviewers/);
    }
    expect(()=>requireReviewers({protection_rules:[{type:'required_reviewers',reviewers:[{id:1}],prevent_self_review:true}]})).not.toThrow();
  });
  it('requires one immutable image artifact for each built service',()=>{
    fs.writeFileSync(path.join(root,'web.json'),JSON.stringify({service:'web',image:'ghcr.io/org/app-web@sha256:'+'a'.repeat(64)}));
    expect(collectImages(root,['web']).web).toContain('@sha256:');
    expect(()=>collectImages(root,['web','api'])).toThrow(/Missing/);
    fs.writeFileSync(path.join(root,'web.json'),JSON.stringify({service:'web',image:'ghcr.io/org/app-web:latest'}));
    expect(()=>collectImages(root,['web'])).toThrow(/Invalid/);
  });
  it('verifies the explicit toolkit SHA and supports richer builds',()=>{
    const workflow:any=load(fs.readFileSync('.github/workflows/deploy.yml','utf8'));
    expect(workflow.on.workflow_call).toBeDefined();
    expect(workflow.on.workflow_call.inputs['groma-ref'].required).toBe(true);
    expect(workflow.jobs.validate.if).toContain("github.event_name == 'push'");
    expect(workflow.jobs.validate.if).not.toContain('pull_request');
    expect(workflow.jobs.deploy.environment).toBe('${{ inputs.environment }}');
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    const toolkitCheckout=workflow.jobs.validate.steps.find((s:any)=>s.with?.repository==='Lamassau/groma');
    expect(toolkitCheckout.with.ref).toBe('${{ inputs.groma-ref }}');
    const build=workflow.jobs.build.steps.find((s:any)=>s.uses==='docker/build-push-action@v6');
    expect(build.with.target).toBe('${{ matrix.target }}');
    expect(build.with.platforms).toBe('${{ matrix.platformsText }}');
    expect(build.with['secret-files']).toBe('${{ steps.build-secrets.outputs.files }}');
  });
});
