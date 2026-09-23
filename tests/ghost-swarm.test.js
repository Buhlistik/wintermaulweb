'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const variant=html.match(/name:'Wandering Phantoms'[^\n]+stats:Object\.freeze\((\{[^\n]+?\})\)\}\)/);
assert.ok(variant,'Wandering Phantoms variant is present');
const stats=vm.runInNewContext('('+variant[1]+')');
assert.equal(stats.role,'ghostSwarm','the upgrade must replace Frost Spire’s normal projectile attack');
assert.equal(stats.slowKey,null,'ghost attacks must not inherit the cold slow');

const start=html.indexOf('function runTowerCombat(dt){');
const end=html.indexOf('\nfunction completeWave(){',start);
assert.ok(start>=0&&end>start,'tower combat function is present');
const tower={...stats,id:7,x:0,y:0,ownerId:'solo',cooldown:0};
const enemy={id:11,x:82,y:0,hp:10000,path:[]};
const game={towers:[tower],enemies:[enemy],elapsed:0};
const context={game,CELL_W:40,Math,
    updateContactEffects(){},updateSupportTowerBuffs(){},updateMagmaPools(){},updateEarthquakeFields(){},updateStatusEffects(){},resolvePoisonDeathBursts(){},
    cellCenter(){return {x:0,y:0};},towerCombatBonuses(){return {range:1,speed:1,damage:1};},towerDamageAgainst(t){return t.damage;}
};
vm.runInNewContext(html.slice(start,end),context);
const step=()=>{game.elapsed+=.1;context.runTowerCombat(.1);};
step();
assert.equal(tower.ghostSpirits.length,3,'exactly three ghosts are summoned');
const initialIds=new Set(tower.ghostSpirits.map(spirit=>spirit.id));
game.enemies=[];
for(let i=0;i<10;i++)step();
assert.equal(tower.ghostSpirits.length,3,'ghosts wait for an enemy rather than vanishing before striking');
game.enemies=[enemy];
let secondSummon=false;
for(let i=0;i<70;i++){
    const before=tower.ghostSpirits.slice();
    step();
    assert.ok(tower.ghostSpirits.length<=3,'summons cannot overlap');
    if(tower.ghostSpirits.some(spirit=>!initialIds.has(spirit.id))){
        assert.ok(before.every(spirit=>spirit.fadeUntil&&spirit.fadeUntil<=game.elapsed),'all previous ghosts must finish and disappear before another summon');
        secondSummon=true;break;
    }
}
assert.ok(secondSummon,'tower eventually summons again after the ghosts vanish');
assert.equal(10000-enemy.hp,3*3*stats.damage,'each of the first three ghosts lands three attacks');
console.log('Wandering Phantoms summon, seek, strike, and resummon correctly.');
