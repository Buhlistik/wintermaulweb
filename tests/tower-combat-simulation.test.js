'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const catalogDefinitions=html.slice(html.indexOf('const RACE_TOWER_CATALOG = Object.freeze('),html.indexOf('\nconst RACE_TOWER_UPGRADE_PATHS'));
const pathDefinitions=html.slice(html.indexOf('const RACE_TOWER_UPGRADE_PATHS = Object.freeze('),html.indexOf('\n// 750G'));
const variants=html.slice(html.indexOf('const VARIANT_BEHAVIOR_DEFAULTS'),html.indexOf('\nfunction selectedUpgradePath'));
const variantContext={};vm.createContext(variantContext);
vm.runInContext(`${catalogDefinitions}\n${pathDefinitions}\nthis.catalog=RACE_TOWER_CATALOG;this.paths=RACE_TOWER_UPGRADE_PATHS;\n${variants}`,variantContext);
let variantCount=0;
for(const [baseId,paths] of Object.entries(variantContext.paths)){
    for(const pathDefinition of paths){
        const tower=variantContext.compileTowerVariant(baseId,pathDefinition);variantCount++;
        for(const key of ['id','typeId','baseTypeId','name','sprite','race','role','attackBehavior','attackType','damage','range','aoe','attackRate','effects','ability'])assert.ok(tower[key]!==undefined,`${baseId} path ${pathDefinition.path} defines ${key}`);
        assert.ok(Object.isFrozen(tower),`${tower.name} is immutable after validation`);
    }
}
assert.equal(variantCount,48,'every tower path compiles to a complete validated definition');
const ember=variantContext.catalog.undead.find(tower=>tower.id==='undead-ember-spire');
const wraithPath=variantContext.paths['undead-ember-spire'][1];
const upgraded=variantContext.constructUpgradedTower({...ember,typeId:ember.id,id:9,x:12,y:18,ownerId:'p1',ownerName:'Player',level:1,invested:80,cooldown:.2,spookyChance:.08,focusStacks:4},wraithPath);
assert.equal(upgraded.spookyChance,0,'variant construction clears the base fear proc when its definition omits it');
assert.equal(upgraded.focusStacks,undefined,'unrelated combat runtime state is not copied into a replacement tower');
assert.equal(upgraded.invested,80+wraithPath.cost);
assert.equal(upgraded.ownerId,'p1');assert.equal(upgraded.x,12);assert.equal(upgraded.y,18);

const simulation=html.slice(html.indexOf('const TOWER_TRANSIENT_ATTACK_FIELDS'),html.indexOf('\nfunction renderTowerAttackEffect'));
const context={Math,Number,Set,Array,clamp:(value,min,max)=>Math.max(min,Math.min(max,value)),CELL_W:40,
    game:{projectiles:[],nextProjectileId:1,elapsed:1,enemies:[],towers:[],magmaPools:[],nextMagmaId:1},
    cellCenter:()=>({x:0,y:0}),towerDamageAgainst:(weapon)=>weapon.damage,
    applyTrackedDamage:(enemy,damage,source)=>{enemy.hp-=damage;enemy.lastHitOwnerId=source.ownerId;enemy.lastHitRace=source.race;},
    applyTowerSlow(){},applyStun(){},applySpookyEffect(){},applyPoison(){},applyRoot(){},applyTowerStatus(){},applyPushback(){},
    applyUniqueSlow(){},createMagmaPool(){},applyDragonFrost(){},enemyHasStatus:()=>false,curseDamageMultiplier:()=>1,
    armorDamageMultiplier:()=>1,freezeEnemy(){},MathRandom:()=>0};
vm.createContext(context);vm.runInContext(simulation,context);
function fixture(){const enemy={id:3,x:100,y:0,hp:100,size:7,armorType:'unarmored'};context.game.projectiles=[];context.game.enemies=[enemy];return enemy;}
const tower={id:1,role:'arrow',race:'human',damage:10,attackRate:1,attackType:'normal',aoe:0,range:4,projectileStyle:'arrow',ownerId:'p1'};
const bonuses={damage:1,speed:1,range:1};
let enemy=fixture();const shot=context.createSimulatedAttack(tower,enemy,bonuses,{origin:{x:0,y:0},speed:200});
assert.equal(shot.collisionShape,'circle');assert.ok(shot.lifetime>0);assert.deepEqual(Array.from(shot.hitIds),[]);
context.updateSimulatedAttacks(.1);assert.equal(enemy.hp,100,'a projectile does not damage before it reaches collision range');
context.updateSimulatedAttacks(.4);assert.equal(enemy.hp,90,'a projectile applies damage on collision');
assert.equal(context.game.projectiles.length,0);

enemy=fixture();enemy.y=100;context.createSimulatedAttack(tower,enemy,bonuses,{mode:'meteor',start:{x:100,y:0},lifetime:.3,speed:500});
context.updateSimulatedAttacks(.1);assert.equal(enemy.hp,100,'a meteor has no damage before its fall reaches the enemy');
context.updateSimulatedAttacks(.1);assert.equal(enemy.hp,90,'a meteor impacts and damages when it reaches the enemy');

enemy={id:4,x:30,y:0,hp:100,size:7,armorType:'unarmored'};context.game.projectiles=[];context.game.enemies=[enemy];
context.createSimulatedAttack({...tower,role:'pushWave'},enemy,bonuses,{mode:'wave',origin:{x:0,y:0},end:{x:0,y:0},maxRadius:40,lifetime:.4});
context.updateSimulatedAttacks(.1);assert.equal(enemy.hp,100,'an expanding wave does not damage ahead of its front');
context.updateSimulatedAttacks(.25);assert.equal(enemy.hp,90,'an expanding wave damages when its front reaches an enemy');

const combat=html.slice(html.indexOf('function runTowerCombat(dt){'),html.indexOf('\nfunction completeWave(){'));
Object.assign(context,{updateContactEffects(){},updateSupportTowerBuffs(){},updateMagmaPools(){},updateEarthquakeFields(){},updateStatusEffects(){},resolvePoisonDeathBursts(){},
    towerCombatBonuses:()=>bonuses,cellCenter:()=>({x:0,y:0}),multiplayerGameplayActive:()=>false,currentKillGoldBonus:()=>0,
    addPlayerGold(){},recordLifetimeStat(){},localEconomyPlayerId:()=> 'solo'});
vm.runInContext(combat,context);
enemy=fixture();context.game.towers=[{...tower,attackRate:4,cooldown:0,x:0,y:0}];context.game.elapsed=0;
context.runTowerCombat(.01);assert.equal(enemy.hp,100,'a fired tower shot does not apply damage at launch');
for(let i=0;i<8;i++){context.game.elapsed+=.02;context.runTowerCombat(.02);}
assert.equal(enemy.hp,90,'the tower combat loop applies damage when its simulated shot collides');
console.log('All 48 tower variants compile cleanly; replacement clears stale abilities and projectile, meteor, and wave damage resolve on simulated collision.');
