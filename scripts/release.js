'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {isCompatibleClient}=require('../lib/protocol-compatibility');

const ROOT=path.resolve(__dirname,'..');
const MANIFEST_PATH=path.join(ROOT,'release.json');
const BASELINE_PATH=path.join(ROOT,'.release','webhost-baseline.json');
const OUTPUT_DIR=path.join(ROOT,'release-output');

function npmVersion(version){return version.split('.').length===2?`${version}.0`:version;}
function displayVersion(version){return version.split('.').length===2?version:version.split('.')[1];}

function validateReleaseConfig(config){
    const semver=/^(?:(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)|[1-9]\d*\.(?:0|[1-9]\d?))$/;
    const compare=(left,right)=>npmVersion(left).split('.').map(Number).reduce((result,part,index)=>result||part-Number(npmVersion(right).split('.')[index]),0);
    if(!config||typeof config!=='object'||!semver.test(config.releaseVersion||''))throw new Error('release.json needs a numeric releaseVersion such as 1.10 (legacy 0.109.0 is also supported).');
    if(!config.multiplayer||typeof config.multiplayer.protocolId!=='string'||!/^wintermaul-mp\/\d+$/.test(config.multiplayer.protocolId))throw new Error('release.json needs a multiplayer protocolId such as wintermaul-mp/1.');
    const legacy=config.multiplayer.compatibleLegacyReleaseVersions;
    if(!Array.isArray(legacy)||legacy.some(version=>!semver.test(version))||new Set(legacy).size!==legacy.length||legacy.some(version=>compare(version,config.releaseVersion)>=0)||legacy.some((version,index)=>index>0&&compare(legacy[index-1],version)>=0))throw new Error('compatibleLegacyReleaseVersions must contain unique, older releases in ascending order.');
    return config;
}

function compatibleClient(config,{protocolId,releaseVersion}){
    return isCompatibleClient(config.multiplayer,protocolId,releaseVersion);
}

function fileHash(data){return crypto.createHash('sha256').update(data).digest('hex');}

function diffWebhostFiles(previous,current){
    const changed=Object.keys(current).filter(file=>previous[file]!==current[file]).sort();
    const removed=Object.keys(previous).filter(file=>!(file in current)).sort();
    return {changed,removed};
}

function generatedReleaseConfig(config){
    const legacy=config.multiplayer.compatibleLegacyReleaseVersions;
    const info={
        releaseVersion:config.releaseVersion,
        protocolId:config.multiplayer.protocolId,
        compatibleLegacyReleaseVersions:legacy,
        legacyHandshakeReleaseVersion:legacy.at(-1)||null
    };
    return `window.WINTERMAUL_RELEASE_INFO=Object.freeze(${JSON.stringify(info)});\n`+
        `document.write('<script defer src="./assets/js/multiplayer-lobby.js?v='+encodeURIComponent(window.WINTERMAUL_RELEASE_INFO.releaseVersion)+'"><\\/script>');\n`;
}

function isWebhostPath(relative){
    if(relative==='index.html'||relative==='.htaccess')return true;
    if(!relative.startsWith('assets/'))return false;
    if(relative.startsWith('assets/js/'))return ['assets/js/multiplayer-lobby.js','assets/js/release-config.js'].includes(relative);
    return true;
}

function walkFiles(root,relative='',files=new Map()){
    const directory=path.join(root,relative);
    if(!fs.existsSync(directory))return files;
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
        const child=path.posix.join(relative.split(path.sep).join('/'),entry.name);
        const absolute=path.join(root,child);
        if(entry.isDirectory())walkFiles(root,child,files);
        else if(entry.isFile()&&isWebhostPath(child.split(path.sep).join('/')))files.set(child.split(path.sep).join('/'),fs.readFileSync(absolute));
    }
    return files;
}

function renderedIndex(source,config){
    const visibleVersion=`<title>Wintermaul v.${displayVersion(config.releaseVersion)}</title>`;
    const titlePlaceholder='<title>Wintermaul v.__WINTERMAUL_RELEASE_DISPLAY_VERSION__</title>';
    if(source.split(titlePlaceholder).length!==2)throw new Error('index.html must contain one generated Wintermaul release title placeholder.');
    source=source.replace(titlePlaceholder,visibleVersion);
    const tag=`<script src="./assets/js/release-config.js?v=${config.releaseVersion}"></script>`;
    const scripts=/<script\b[^>]*\bsrc=["']\.\/assets\/js\/(?:multiplayer-lobby|release-config)\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/gi;
    const matches=source.match(scripts)||[];
    if(matches.length!==1)throw new Error(`Expected one multiplayer release script in index.html; found ${matches.length}.`);
    return source.replace(scripts,tag);
}

function projectChecks(config){
    const packageFile=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
    const lockFile=JSON.parse(fs.readFileSync(path.join(ROOT,'package-lock.json'),'utf8'));
    if(packageFile.version!==npmVersion(config.releaseVersion)||lockFile.version!==npmVersion(config.releaseVersion)||lockFile.packages?.['']?.version!==npmVersion(config.releaseVersion))throw new Error('package.json and package-lock.json must match release.json. Run the release package command to synchronize them.');
    const server=fs.readFileSync(path.join(ROOT,'server/server.js'),'utf8');
    if(!server.includes("require('../release.json')")||!server.includes('RELEASE_CONFIG.multiplayer.protocolId'))throw new Error('The server must read its release and protocol values from release.json.');
    const client=fs.readFileSync(path.join(ROOT,'assets/js/multiplayer-lobby.js'));
    const clientText=client.toString('utf8');
    if(!clientText.includes('window.WINTERMAUL_RELEASE_INFO')||clientText.includes('const PROTOCOL_VERSION='))throw new Error('The multiplayer client must read generated release information instead of hardcoded versions.');
    const indexPath=path.join(ROOT,'index.html');
    if(fs.existsSync(indexPath)){
        const index=fs.readFileSync(indexPath,'utf8');
        if(!index.includes('./assets/js/release-config.js?v=__WINTERMAUL_RELEASE_VERSION__'))throw new Error('index.html must use the generated release-config script and version placeholder.');
        if(!index.includes('<title>Wintermaul v.__WINTERMAUL_RELEASE_DISPLAY_VERSION__</title>'))throw new Error('index.html must use the generated release title placeholder.');
    }
}

function readBaseline(){
    if(!fs.existsSync(BASELINE_PATH))throw new Error('No webhost baseline exists. Run the release:baseline command with a webroot snapshot first.');
    const baseline=JSON.parse(fs.readFileSync(BASELINE_PATH,'utf8'));
    if(!baseline.files||typeof baseline.files!=='object')throw new Error('The webhost baseline file is invalid.');
    return baseline;
}

function sourceWebhostFiles(webroot,config,sourceIndexPath){
    const files=walkFiles(webroot);
    const sourceIndex=sourceIndexPath||(fs.existsSync(path.join(ROOT,'index.html'))?path.join(ROOT,'index.html'):path.join(webroot,'index.html'));
    const index=fs.readFileSync(sourceIndex,'utf8');
    files.set('index.html',Buffer.from(renderedIndex(index,config)));
    files.set('assets/js/multiplayer-lobby.js',fs.readFileSync(path.join(ROOT,'assets/js/multiplayer-lobby.js')));
    files.set('assets/js/release-config.js',Buffer.from(generatedReleaseConfig(config)));
    return files;
}

function hashFiles(files){return Object.fromEntries([...files].map(([name,data])=>[name,fileHash(data)]).sort(([a],[b])=>a.localeCompare(b)));}

function syncPackageVersion(config){
    const packagePath=path.join(ROOT,'package.json'),lockPath=path.join(ROOT,'package-lock.json');
    const packageData=JSON.parse(fs.readFileSync(packagePath,'utf8'));
    const lockData=JSON.parse(fs.readFileSync(lockPath,'utf8'));
    packageData.version=npmVersion(config.releaseVersion);
    lockData.version=npmVersion(config.releaseVersion);
    if(lockData.packages?.[''])lockData.packages[''].version=npmVersion(config.releaseVersion);
    fs.writeFileSync(packagePath,`${JSON.stringify(packageData,null,2)}\n`);
    fs.writeFileSync(lockPath,`${JSON.stringify(lockData,null,2)}\n`);
}

function parseWebroot(args){
    const index=args.indexOf('--webroot');
    if(index<0)return ROOT;
    if(!args[index+1])throw new Error('--webroot needs a directory path.');
    return path.resolve(process.cwd(),args[index+1]);
}

function parseSourceIndex(args){
    const index=args.indexOf('--source-index');
    if(index<0)return undefined;
    if(!args[index+1])throw new Error('--source-index needs a file path.');
    return path.resolve(process.cwd(),args[index+1]);
}

function packageRelease(webroot,config,sourceIndexPath){
    const baseline=readBaseline();
    if(!fs.existsSync(path.join(webroot,'index.html')))throw new Error(`No index.html found in webroot ${webroot}.`);
    const files=sourceWebhostFiles(webroot,config,sourceIndexPath),hashes=hashFiles(files);
    const {changed,removed}=diffWebhostFiles(baseline.files,hashes);
    if(!changed.length)throw new Error(`No changed webhost files found since baseline ${baseline.releaseVersion||'unknown'}.`);
    fs.mkdirSync(OUTPUT_DIR,{recursive:true});
    const archive=path.join(OUTPUT_DIR,`Wintermaul-webhost-v${config.releaseVersion}.zip`);
    const staging=fs.mkdtempSync(path.join(os.tmpdir(),'wintermaul-release-'));
    try{
        for(const relative of changed){
            const target=path.join(staging,...relative.split('/'));
            fs.mkdirSync(path.dirname(target),{recursive:true});
            fs.writeFileSync(target,files.get(relative));
        }
        if(fs.existsSync(archive))fs.rmSync(archive);
        execFileSync('zip',['-q',archive,...changed],{cwd:staging,stdio:'ignore'});
    }finally{fs.rmSync(staging,{recursive:true,force:true});}
    console.log(`Created ${archive}`);
    console.log(`Included ${changed.length} changed file(s):\n${changed.map(file=>`  ${file}`).join('\n')}`);
    if(removed.length)console.log(`Remove these files from the webhost manually:\n${removed.map(file=>`  ${file}`).join('\n')}`);
    return {archive,changed,removed,hashes};
}

function markUploaded(webroot,config,sourceIndexPath){
    const files=sourceWebhostFiles(webroot,config,sourceIndexPath);
    const baseline={releaseVersion:config.releaseVersion,files:hashFiles(files)};
    fs.mkdirSync(path.dirname(BASELINE_PATH),{recursive:true});
    fs.writeFileSync(BASELINE_PATH,`${JSON.stringify(baseline,null,2)}\n`);
    console.log(`Recorded ${Object.keys(baseline.files).length} webhost files as uploaded for v${config.releaseVersion}.`);
}

function initializeBaseline(webroot,releaseVersion){
    if(!fs.existsSync(path.join(webroot,'index.html')))throw new Error(`No index.html found in webroot ${webroot}.`);
    const files=walkFiles(webroot);
    const baseline={releaseVersion,files:hashFiles(files)};
    fs.mkdirSync(path.dirname(BASELINE_PATH),{recursive:true});
    fs.writeFileSync(BASELINE_PATH,`${JSON.stringify(baseline,null,2)}\n`);
    console.log(`Recorded ${Object.keys(baseline.files).length} webhost files as the v${releaseVersion} baseline.`);
}

function run(){
    const [command='check',...args]=process.argv.slice(2);
    const config=validateReleaseConfig(JSON.parse(fs.readFileSync(MANIFEST_PATH,'utf8')));
    if(command==='check'){
        projectChecks(config);
        if(args.includes('--webroot')){
            const webroot=parseWebroot(args);
            if(!fs.existsSync(path.join(webroot,'index.html')))throw new Error(`No index.html found in webroot ${webroot}.`);
            renderedIndex(fs.readFileSync(path.join(webroot,'index.html'),'utf8'),config);
        }
        console.log(`Release configuration is consistent: v${config.releaseVersion}, protocol ${config.multiplayer.protocolId}.`);
        return;
    }
    if(command==='package'){
        syncPackageVersion(config);projectChecks(config);packageRelease(parseWebroot(args),config,parseSourceIndex(args));return;
    }
    if(command==='mark-uploaded'){
        projectChecks(config);markUploaded(parseWebroot(args),config,parseSourceIndex(args));return;
    }
    if(command==='baseline'){
        const versionIndex=args.indexOf('--release');
        const version=versionIndex>=0?args[versionIndex+1]:config.releaseVersion;
        initializeBaseline(parseWebroot(args),version);return;
    }
    throw new Error(`Unknown release command: ${command}. Use check, package, or mark-uploaded.`);
}

if(require.main===module){
    try{run();}catch(error){console.error(`Release workflow failed: ${error.message}`);process.exitCode=1;}
}

module.exports={npmVersion,displayVersion,compatibleClient,diffWebhostFiles,generatedReleaseConfig,renderedIndex,validateReleaseConfig};
