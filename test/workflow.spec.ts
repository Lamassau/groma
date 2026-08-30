import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { load } from 'js-yaml';
import { starterProject, serializeProject } from '../src/deployment/init';

jest.mock('../build/deployment/config',()=>require('../src/deployment/config'),{virtual:true});
const {contract,requireReviewers}=require('../scripts/ci-contract.cjs');
const {collectImages}=require('../scripts/ci-deploy.cjs');

describe('Reusable workflow safety contract',()=>{
  let root:string;
  beforeEach(()=>{
    root=fs.mkdtempSync(path.join(os.tmpdir(),'groma-ci-'));
    fs.writeFileSync(path.join(root,'Dockerfile'),'FROM nginx:1.28-alpine\n');
    fs.writeFileSync(path.join(root,'groma.yaml'),serializeProject(starterProject({host:'deploy@host.example.com'})));
  });
  afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
  const input=()=>({environment:'dev',target:'deploy@host.example.com',gromaRef:'a'.repeat(40),config:'groma.yaml',overlay:'',services:JSON.stringify([{service:'web',context:'.',dockerfile:'Dockerfile'}])});
  it('validates build definitions and explicit target',()=>{
    expect(contract(input(),root).matrix).toHaveLength(1);
    expect(()=>contract({...input(),target:'deploy@other.example.com'},root)).toThrow(/target/);
    expect(()=>contract({...input(),gromaRef:'main'},root)).toThrow(/commit SHA/);
    expect(()=>contract({...input(),services:'[{"service":"web","context":"../outside","dockerfile":"Dockerfile"}]'},root)).toThrow(/context/);
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
  it('binds the deploy job to the environment and never runs for a pull request',()=>{
    const workflow:any=load(fs.readFileSync('.github/workflows/deploy.yml','utf8'));
    expect(workflow.on.workflow_call).toBeDefined();
    expect(workflow.jobs.validate.if).toContain("github.event_name == 'push'");
    expect(workflow.jobs.validate.if).not.toContain('pull_request');
    expect(workflow.jobs.deploy.environment).toBe('${{ inputs.environment }}');
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.jobs.deploy.steps.some((s:any)=>s.name==='Recheck production approval policy')).toBe(true);
  });
});
