'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server/server.js'),'utf8');
function readObject(start,end){
    const from=html.indexOf(start),to=html.indexOf(end,from);
    assert.notEqual(from,-1,`missing ${start}`);assert.notEqual(to,-1,`missing ${end}`);
    const expression=html.slice(from+start.length,to).trim().replace(/\);\s*$/,'');
    return vm.runInNewContext(`Object.freeze(${expression})`,{Object});
}
const catalog=readObject('const RACE_TOWER_CATALOG = Object.freeze(','\n\nconst RACE_TOWER_UPGRADE_PATHS');
const paths=readObject('const RACE_TOWER_UPGRADE_PATHS = Object.freeze(','\n\n// 750G');
const raceMapNames={human:'HUMAN',orc:'ORC',undead:'UNDEAD',nightelf:'NIGHTELF'};
for(const [race,towers] of Object.entries(catalog)){
    const costs=towers.map(tower=>tower.cost||0);
    if(race!=='human')assert.deepEqual(costs.slice().sort((a,b)=>a-b),costs,`${race} towers should be listed cheapest to most expensive`);
}
for(const [towerId,variants] of Object.entries(paths)){
    assert.equal(variants.length,2,`${towerId} should have two variants`);
    for(const variant of variants){
        assert.ok(variant.cost>0,`${towerId} variant ${variant.path} needs a purchase cost`);
        assert.ok(variant.summary.length<=38,`${towerId} variant summary must fit the two-line UI: ${variant.summary}`);
        assert.doesNotMatch(variant.summary,/TBD|placeholder/i,`${towerId} variant description must be populated`);
        assert.ok(fs.existsSync(path.join(root,variant.sprite.replace(/^\.\//,''))),`missing sprite ${variant.sprite}`);
    }
    const race=Object.values(catalog).flat().find(tower=>tower.id===towerId)?.race;
    const mapName=raceMapNames[race];assert.ok(mapName,`no race for ${towerId}`);
    const match=server.match(new RegExp(`const ${mapName}_UPGRADE_COSTS=new Map\\(\\[([\\s\\S]*?)\\]\\);`));
    assert.ok(match,`missing server upgrade costs for ${race}`);
    const entry=match[1].match(new RegExp(`\\['${towerId}',\\[([^\\]]+)\\]\\]`));
    assert.ok(entry,`missing server upgrade cost entry for ${towerId}`);
    const serverCosts=entry[1].split(',').map(Number);
    assert.deepEqual(Array.from(variants,item=>item.cost),serverCosts,`${towerId} UI and server upgrade costs must agree`);
}
console.log('Tower catalogs, upgrade prices, summaries, and variant sprites passed integrity checks.');
