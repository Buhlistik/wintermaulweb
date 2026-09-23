'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const start=html.indexOf("const LIFETIME_STATS_KEY = 'wintermaul:lifetime-stats:v1';");
const end=html.indexOf('\nfunction loadSavedSettings(){',start);
assert.ok(start>=0&&end>start,'local lifetime statistics module is present');
const storage=new Map();let isMultiplayer=false;
const context={
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    window:{addEventListener(){}},document:{addEventListener(){}},
    setTimeout(fn){context.pendingSave=fn;return 1;},clearTimeout(){},Intl,JSON,Number,Math,
    playerRace:'human',game:{playerRace:'human'},
    multiplayerGameplayActive(){return isMultiplayer;},localEconomyPlayerId(){return 'local-player';}
};
vm.createContext(context);vm.runInContext(html.slice(start,end),context);
context.recordLifetimeStat('damage',14.6,'undead',null);
context.recordLifetimeStat('kills',2,'undead',null);
context.recordLifetimeStat('goldSpent',75,'orc',null);
context.flushLifetimeStats();
let saved=JSON.parse(storage.get('wintermaul:lifetime-stats:v1'));
assert.equal(saved.total.damage,14.6);assert.equal(saved.races.undead.kills,2);assert.equal(saved.races.orc.goldSpent,75);
isMultiplayer=true;
context.recordLifetimeStat('damage',100,'human','another-player');
context.recordLifetimeStat('damage',8,'human','local-player');
context.flushLifetimeStats();
saved=JSON.parse(storage.get('wintermaul:lifetime-stats:v1'));
assert.equal(saved.total.damage,22.6,'multiplayer only persists this browser player’s contribution');
assert.equal(saved.races.human.damage,8);
console.log('Lifetime statistics persist locally by race and filter multiplayer contributions to this player.');
