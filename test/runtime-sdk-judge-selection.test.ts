import assert from "node:assert/strict";
import test from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

test("the public Claude judge selects the frozen SDK when no query callback is supplied", async () => {
  // The development SDK is replaced at its external package boundary. Neither
  // branch can contact a provider, including the regression's failing path.
  const script = String.raw`
    import {registerHooks} from 'node:module';
    import {mkdtemp,rm,writeFile} from 'node:fs/promises';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    globalThis.developmentCalls=0;globalThis.frozenCalls=0;
    const sdk=(counter)=>'export const HOOK_EVENTS=[];export function query(){globalThis.'+counter+'++;return {close(){},async *[Symbol.asyncIterator](){yield {type:"result",subtype:"success",session_id:"fixture",uuid:"result",is_error:false,result:"{}",duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[],stop_reason:null};}};}';
    registerHooks({resolve(specifier,context,next){return specifier==='@anthropic-ai/claude-agent-sdk'?{url:'data:text/javascript,'+encodeURIComponent(sdk('developmentCalls')),shortCircuit:true}:next(specifier,context);}});
    const {fakeSdkRuntimeOptions}=await import('./dist/test/runtime-fixture-helper.js');
    const {freezeStudyRuntimes}=await import('./dist/src/study-runtimes.js');
    const {withStudyRuntime}=await import('./dist/src/runtime-context.js');
    const {runClaudeAgentSdkSemanticJudge}=await import('./dist/src/semantic-judge.js');
    const root=await mkdtemp(join(tmpdir(),'ebo-sdk-judge-default-')),options=fakeSdkRuntimeOptions('9.9.9'),run=options.run;
    options.run=async(command,args,cwd)=>{const result=await run(command,args,cwd);if(args[0]==='ci')await writeFile(join(cwd,'node_modules','@anthropic-ai/claude-agent-sdk','index.js'),sdk('frozenCalls'));return result;};
    try {
      await freezeStudyRuntimes(root,{studyId:'frozen-sdk-judge',roles:['claude-agent-sdk']},options);
      await withStudyRuntime({studyRoot:root,role:'claude-agent-sdk',options},async()=>{
        const result=await runClaudeAgentSdkSemanticJudge('Synthetic fixture',{evaluator:{provider:'anthropic',model:'fixture',effort:'low'},limits:{maxWallClockMs:5000,maxOutputChars:16000,maxTurns:1}});
        if(result.status!=='completed')throw new Error(JSON.stringify(result));
      });
      process.stdout.write(JSON.stringify({developmentCalls:globalThis.developmentCalls,frozenCalls:globalThis.frozenCalls}));
    }finally{await rm(root,{recursive:true,force:true});}
  `;
  const {stdout} = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {cwd: process.cwd(), env: {}, timeout: 15000});
  assert.deepEqual(JSON.parse(stdout), {developmentCalls: 0, frozenCalls: 1});
});
