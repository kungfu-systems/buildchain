import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const manifest=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));
test('public entrypoints resolve current implementations without generation aliases',async()=>{
 for(const [specifier,target]of Object.entries(manifest.exports)){
  assert.doesNotMatch(specifier,/^\.\/v\d+(?:-|\/|$)/);
  if(!target.endsWith('.js'))continue;
  const api=await import(new URL('../'+target,import.meta.url));
  assert.ok(Object.keys(api).length>0,`${specifier} exports its current contract`);
  for(const name of Object.keys(api))assert.doesNotMatch(name,/(?:V\d+(?=[A-Z]|$)|^v\d+(?=[A-Z]|$))/u,`${specifier}: ${name}`);
 }
});
