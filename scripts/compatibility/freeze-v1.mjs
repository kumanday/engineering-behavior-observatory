// Rebuild a trusted source revision in isolation. Imported packets cannot select source code.
import {build,version as esbuildVersion} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sourceCommit='fb1dfd7397836de1eab370090534433f0383f45f',id='ebo-v1.4-atif-20261107';
const target=join(repo,'compatibility',id),temporary=mkdtempSync(join(tmpdir(),'ebo-freeze-v1-'));
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const exportsByModule={
 'retained-evidence':['createRetainedBehaviorEvidence'],
 'structural-observations':['createRetainedStructuralObservationSet','validateStructuralObservationSet'],
 'behavior-assertions':['validateRetainedBehaviorAssertion'],
 'atlas-packet':['verifyPacket','roCrate'],
 'atlas':['loadAtlas','queryAtlas'],
};
const walk=(root,path='')=>readdirSync(join(root,path),{withFileTypes:true}).flatMap(entry=>{
 const next=path?`${path}/${entry.name}`:entry.name;if(entry.isSymbolicLink())throw Error('Frozen runtime assets cannot contain links.');
 return entry.isDirectory()?walk(root,next):[next];
}).sort();
function dependencyVersion(name,require){
 let path;try{path=require.resolve(`${name}/package.json`);}catch{path=(require.resolve.paths(name)??[]).map(root=>join(root,name,"package.json")).find(existsSync);if(!path)path=require.resolve(name);}
 let current=dirname(path);
 for(let i=0;i<16;i++){const file=join(current,'package.json');if(existsSync(file)){const value=JSON.parse(readFileSync(file));if(value.name===name)return value.version;}const parent=dirname(current);if(parent===current)break;current=parent;}
 throw Error(`Cannot identify frozen reader dependency ${name}.`);
}
try{
 const archive=execFileSync('git',['archive',sourceCommit,'src','schemas','contracts','ontology','package.json','LICENSE'],{cwd:repo,maxBuffer:32*1024*1024});
 execFileSync('tar',['-xf','-','-C',temporary],{input:archive});
 symlinkSync(join(repo,'node_modules'),join(temporary,'node_modules'),'dir');
 const entry=Object.entries(exportsByModule).map(([module,names])=>`export {${names.join(',')}} from './src/${module}.ts';`).join('\n')+'\n';
 writeFileSync(join(temporary,'compatibility-entry.ts'),entry);
 const snapshot=join(temporary,'snapshot');mkdirSync(join(snapshot,'dist/src'),{recursive:true});
 const result=await build({absWorkingDir:temporary,entryPoints:['compatibility-entry.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:join(snapshot,'dist/src/reader.mjs'),metafile:true,logLevel:'silent'});
 for(const directory of ['schemas','contracts','ontology'])cpSync(join(temporary,directory),join(snapshot,directory),{recursive:true});
 cpSync(join(temporary,'LICENSE'),join(snapshot,'LICENSE'));
 const require=createRequire(join(temporary,'package.json')),dependencies={};
 for(const output of Object.values(result.metafile.outputs))for(const item of output.imports){
  if(!item.external||item.path.startsWith('node:'))continue;
  const name=item.path.startsWith('@')?item.path.split('/').slice(0,2).join('/'):item.path.split('/')[0];dependencies[name]=dependencyVersion(name,require);
 }
 const files=walk(snapshot).map(path=>{const bytes=readFileSync(join(snapshot,path));return{path,bytes:bytes.length,digest:sha(bytes)};});
 const manifest={schemaVersion:'ebo.analysis-runtime-snapshot/v1',id,source:{repository:'https://github.com/kumanday/engineering-behavior-observatory',commit:sourceCommit},nodeVersion:'24.19.0',builder:{id:'esbuild',version:esbuildVersion},entry:'dist/src/reader.mjs',exports:Object.values(exportsByModule).flat().sort(),dependencies:Object.fromEntries(Object.entries(dependencies).sort(([a],[b])=>a.localeCompare(b))),files};
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');writeFileSync(join(snapshot,'runtime-manifest.json'),bytes);
 if(existsSync(target)){
  if(lstatSync(target).isSymbolicLink())throw Error('Frozen runtime destination cannot be a link.');
  if(JSON.stringify(walk(target))!==JSON.stringify(walk(snapshot)))throw Error('Frozen runtime inventory differs from its reconstruction.');
  for(const path of walk(snapshot))if(!readFileSync(join(target,path)).equals(readFileSync(join(snapshot,path))))throw Error(`Frozen runtime reconstruction differs: ${path}`);
 }else{mkdirSync(dirname(target),{recursive:true});cpSync(snapshot,target,{recursive:true,errorOnExist:true,force:false});}
 console.log(JSON.stringify({id,sourceCommit,manifestDigest:sha(bytes),files:files.length,bytes:files.reduce((sum,file)=>sum+file.bytes,0),verified:existsSync(target)}));
}finally{rmSync(temporary,{recursive:true,force:true});}
