import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readAtifFile} from '../src/atif-reader.js';
test('inspection can describe unreadable sources while retained admission propagates read failures',async()=>{
 const missing=join(tmpdir(),'ebo-missing-atif-read-0000','trajectory.json');assert.equal((await readAtifFile(missing)).document,undefined);await assert.rejects(readAtifFile(missing,{propagateReadErrors:true}),{code:'ENOENT'});
 const root=mkdtempSync(join(tmpdir(),'ebo-retained-io-'));try{
  const program=`import assert from 'node:assert/strict';import {mock} from 'node:test';import * as scheduler from './dist/src/scheduler.js';
const destination=process.argv[1];mock.module(new URL('./dist/src/scheduler.js',import.meta.url).href,{namedExports:{...scheduler,readBoundedFile:(path,...args)=>{if(String(path).startsWith(destination+'/'))throw Object.assign(new Error('synthetic storage failure'),{code:'EIO'});return scheduler.readBoundedFile(path,...args);}}});
const {importAtifFile,AtifAdmissionError}=await import('./dist/src/atif-import.js');const {listAtifProducerProfiles}=await import('./dist/src/atif-profiles.js');
await assert.rejects(importAtifFile({sourcePath:'test/fixtures/atif/pi/parallel-failure-cache-write.atif.json',destination,runId:'r',attemptId:'a',producer:listAtifProducerProfiles()[0].producer}),error=>error.code==='EIO'&&!(error instanceof AtifAdmissionError));`;
  const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',program,join(root,'bundle')],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr);
 }finally{rmSync(root,{recursive:true,force:true});}
});
