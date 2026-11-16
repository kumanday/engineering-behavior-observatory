// Reconstruct the fixed historical reader dependency from retained npm source.
import {build,version} from '@ebo-compat/esbuild';
import {createHash} from 'node:crypto';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../compatibility/deepseek-sdk-client-0.2.0-rc.2/',import.meta.url));
const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
if(version!==manifest.builder.version)throw Error('Historical dependency builder differs.');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const temporary=realpathSync(mkdtempSync(join(tmpdir(),'ebo-rebuild-historical-sdk-')));
try{
 for(const source of manifest.sources){
  const destination=join(temporary,'node_modules',source.name);mkdirSync(destination,{recursive:true});
  for(const file of source.files){const bytes=readFileSync(join(root,file.path));if(bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw Error('Historical dependency source differs: '+file.path);}
  cpSync(join(root,'source',source.name.split('/').at(-1)),destination,{recursive:true});
 }
 const result=await build({stdin:{contents:'export * from "@deepseek-ai/dsh-sdk-client";',resolveDir:temporary,sourcefile:join(temporary,'compatibility-entry.mjs')},absWorkingDir:temporary,
  bundle:true,platform:'node',format:'esm',target:'node24',outfile:join(temporary,'sdk.mjs'),write:false,metafile:true,treeShaking:true,legalComments:'external',logLevel:'silent'});
 const output=result.outputFiles.find(file=>file.path.endsWith('/sdk.mjs'))?.contents;
 if(!output||output.length!==manifest.bytes||sha(output)!==manifest.sha256||!Buffer.from(output).equals(readFileSync(join(root,manifest.entry))))throw Error('Historical SDK reconstruction differs.');
 const inputs=Object.keys(result.metafile.inputs).filter(name=>name!=='compatibility-entry.mjs');
 if(inputs.length!==2||inputs.some(name=>!['node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js','node_modules/@deepseek-ai/dsh-sdk-protocol/lib/index.js'].includes(name)))throw Error('Historical SDK dependency inputs changed: '+JSON.stringify(inputs));
 if(Object.values(result.metafile.outputs).some(out=>out.imports.some(item=>!item.external||!item.path.startsWith('node:'))))throw Error('Historical SDK has an unexpected external dependency.');
 if(JSON.stringify(result.metafile)!==JSON.stringify(JSON.parse(readFileSync(join(root,'metafile.json'),'utf8'))))throw Error('Historical SDK metafile differs.');
 console.log(JSON.stringify({dependency:manifest.name,version:manifest.version,bytes:output.length,sha256:manifest.sha256,reconstructed:true,captureQualified:false}));
}finally{rmSync(temporary,{recursive:true,force:true});}
