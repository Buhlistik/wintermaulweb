'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const release=require('../scripts/release');
const config=release.validateReleaseConfig(JSON.parse(fs.readFileSync(path.join(__dirname,'../release.json'),'utf8')));
const root=path.resolve(__dirname,'..');

assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,config.releaseVersion);
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8')).version,config.releaseVersion);
assert.equal(release.compatibleClient(config,{protocolId:config.multiplayer.protocolId,releaseVersion:'9.9.9'}),true,'matching protocols remain compatible across game releases');
assert.equal(release.compatibleClient(config,{releaseVersion:'0.97.0'}),true,'explicitly supported legacy releases remain compatible');
assert.equal(release.compatibleClient(config,{releaseVersion:'0.98.0'}),true,'the previous release remains compatible during rollout');
assert.equal(release.compatibleClient(config,{releaseVersion:'0.79.0'}),false,'unknown legacy releases are rejected');
assert.equal(release.compatibleClient(config,{protocolId:'wintermaul-mp/2',releaseVersion:'0.98.0'}),false,'an explicit incompatible protocol cannot use the legacy release allowance');

const generated=release.generatedReleaseConfig(config);
assert.ok(generated.includes(config.releaseVersion),'the loader cache key comes from the release manifest');
assert.ok(generated.includes(config.multiplayer.protocolId),'the browser receives the canonical protocol identifier');
let loadedScript='';const browser={window:{},document:{write(value){loadedScript=value;}},encodeURIComponent};
vm.runInNewContext(generated,browser);
assert.equal(browser.window.WINTERMAUL_RELEASE_INFO.releaseVersion,config.releaseVersion);
assert.match(loadedScript,new RegExp(`multiplayer-lobby\\.js\\?v=${config.releaseVersion.replace(/\./g,'\\.')}`),'the generated cache key matches the one release version');
assert.deepEqual(release.diffWebhostFiles({ 'index.html':'old','assets/towers/a.png':'same' },{ 'index.html':'new','assets/towers/a.png':'same','assets/js/release-config.js':'new' }),{
    changed:['assets/js/release-config.js','index.html'],removed:[]
},'webhost packages contain only added or changed paths');

const client=fs.readFileSync(path.join(root,'assets/js/multiplayer-lobby.js'));
assert.deepEqual(client,fs.readFileSync(path.join(root,'multiplayer-lobby.js')),'the webhost and repository client copies must match');
assert.ok(fs.readFileSync(path.join(root,'server/server.js'),'utf8').includes("require('../release.json')"));
console.log('Release source, protocol compatibility, client/server copies, and changed-file selection passed.');
