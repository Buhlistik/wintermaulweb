'use strict';

const assert=require('assert');
const net=require('net');
const path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');

function freePort(){
    return new Promise((resolve,reject)=>{
        const server=net.createServer();
        server.once('error',reject);server.listen(0,'127.0.0.1',()=>{
            const {port}=server.address();server.close(error=>error?reject(error):resolve(port));
        });
    });
}
function waitForServer(child){
    return new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Phase 5 server did not start.')),5000);
        child.stdout.on('data',chunk=>{if(chunk.toString().includes('Phase 5 server')){clearTimeout(timeout);resolve();}});
        child.stderr.on('data',chunk=>process.stderr.write(chunk));
        child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Phase 5 server exited with code ${code}.`));});
    });
}
function connect(baseUrl,session,version='0.94.0'){
    return new Promise((resolve,reject)=>{
        const url=new URL(baseUrl);url.searchParams.set('session',session);url.searchParams.set('version',version);
        const ws=new WebSocket(url),messages=[],waiters=[];
        const client={
            ws,messages,
            send(type,payload={}){ws.send(JSON.stringify({type,...payload}));},
            waitFor(predicate,timeoutMs=4000){
                const foundIndex=messages.findIndex(predicate);
                if(foundIndex>=0)return Promise.resolve(messages.splice(foundIndex,1)[0]);
                return new Promise((resolveWait,rejectWait)=>{
                    const waiter={predicate,resolve:resolveWait,reject:rejectWait};waiters.push(waiter);
                    waiter.timer=setTimeout(()=>{
                        const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);
                        rejectWait(new Error('Timed out waiting for server message.'));
                    },timeoutMs);
                });
            },
            close(){return new Promise(resolve=>{if(ws.readyState===WebSocket.CLOSED)return resolve();ws.once('close',resolve);ws.close();});}
        };
        ws.on('message',raw=>{
            const message=JSON.parse(raw.toString());
            const waiterIndex=waiters.findIndex(waiter=>waiter.predicate(message));
            if(waiterIndex>=0){const [waiter]=waiters.splice(waiterIndex,1);clearTimeout(waiter.timer);waiter.resolve(message);}
            else messages.push(message);
        });
        ws.once('open',()=>resolve(client));ws.once('error',reject);
    });
}

(async()=>{
    const externalUrl=process.env.TEST_WS_URL;
    let child=null;
    const port=externalUrl?null:await freePort();
    const baseUrl=externalUrl||`ws://127.0.0.1:${port}/ws`;
    if(!externalUrl){
        child=spawn(process.execPath,[path.resolve(__dirname,'../server/server.js')],{
            cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']
        });
        await waitForServer(child);
    }

    let host,guest,hostReturn,guestReturn;
    try{
        const siteUrl=new URL(baseUrl);siteUrl.protocol=siteUrl.protocol==='wss:'?'https:':'http:';siteUrl.pathname='/';siteUrl.search='';
        const healthResponse=await fetch(new URL('/health',siteUrl));
        assert.deepEqual(await healthResponse.json(),{ok:true,protocolVersion:'0.94.0',rooms:0,players:0});

        const outdated=await connect(baseUrl,'phase5-old-client-000001','0.79.0');
        const mismatch=await outdated.waitFor(message=>message.type==='incompatible_version');
        assert.equal(mismatch.requiredVersion,'0.94.0');await outdated.close();

        const hostSession='phase5-host-session-000001';
        const guestSession='phase5-guest-session-00001';
        host=await connect(baseUrl,hostSession);guest=await connect(baseUrl,guestSession);
        const [hostWelcome,guestWelcome]=await Promise.all([
            host.waitFor(message=>message.type==='welcome'),guest.waitFor(message=>message.type==='welcome')
        ]);
        assert.equal(hostWelcome.clientId,hostSession);assert.equal(guestWelcome.clientId,guestSession);
        assert.equal(hostWelcome.protocolVersion,'0.94.0');
        host.send('latency_ping',{clientTime:123});
        const pong=await host.waitFor(message=>message.type==='latency_pong');assert.equal(pong.clientTime,123);assert.ok(pong.serverTime>0);

        host.send('create_room',{name:'Host',race:'human',color:'#ff3b3b'});
        const created=await host.waitFor(message=>message.type==='room_state'&&message.room.players.length===1);
        assert.equal(created.room.players[0].ready,true,'host should start ready automatically');
        const code=created.room.code;
        guest.send('join_room',{code,name:'Guest',race:'undead',color:'#3b82ff'});
        const joined=await host.waitFor(message=>message.type==='room_state'&&message.room.players.length===2);
        assert.equal(joined.room.players.find(player=>player.id===hostSession).ready,true);
        assert.equal(joined.room.players.find(player=>player.id===guestSession).ready,false);
        host.send('start_match');
        await host.waitFor(message=>message.type==='error'&&message.code==='players_not_ready');
        guest.send('chat',{text:'x'.repeat(260)});
        const longChat=await host.waitFor(message=>message.type==='room_state'&&message.room.messages.some(item=>item.kind==='player'&&item.text.length===200));
        assert.equal(longChat.room.messages.find(item=>item.kind==='player').text.length,200);
        guest.send('toggle_ready');
        await host.waitFor(message=>message.type==='room_state'&&message.room.players.every(player=>player.ready));
        host.send('start_match');
        await Promise.all([
            host.waitFor(message=>message.type==='match_start'&&message.roomCode===code),
            guest.waitFor(message=>message.type==='match_start'&&message.roomCode===code)
        ]);
        guest.send('update_profile',{race:'human'});
        await guest.waitFor(message=>message.type==='error'&&message.code==='match_started');
        guest.send('update_profile',{color:'#ff3b3b'});
        await guest.waitFor(message=>message.type==='error'&&message.code==='match_started');
        guest.send('game_ready');host.send('game_ready');
        await guest.waitFor(message=>message.type==='room_state'&&message.room.status==='playing');

        const projectile={id:1,kind:'shot',fromX:100,fromY:120,toX:260,toY:180,role:'arrow',at:18.48};
        const earthquakeField={id:1,sourceTowerId:3,ownerId:hostSession,x:120,y:150,radius:12.8,dps:16,attackType:'siege',expiresAt:21.5};
        const state={gold:900,playerGold:{[hostSession]:900,[guestSession]:825},lives:24,currentWave:3,maxWaves:25,waveActive:true,gameOver:false,speedMultiplier:1,elapsed:18.5,nextTowerId:4,nextEnemyId:3,nextMagmaId:1,nextEarthquakeId:2,nextProjectileId:2,projectileEvents:[projectile],outcome:null,towers:[{id:1,typeId:'alliance-arrow-tower',x:12,y:18,ownerId:guestSession},{id:3,typeId:'alliance-arrow-tower',x:22,y:18,ownerId:hostSession}],enemies:[{id:2,typeId:'enemy-grunt',x:11,y:9,hp:75,maxHp:100}],magmaPools:[],earthquakeFields:[earthquakeField]};
        const checkpoint={...state,enemies:[{...state.enemies[0],path:[[10,9],[11,9],[12,9]],pathIndex:1,slowEffects:{}}],spawnQueue:[[]],spawnTimer:.2,spawnInterval:.28};
        host.send('game_state',{state});host.send('game_checkpoint',{checkpoint});
        const splitGold=await guest.waitFor(message=>message.type==='game_state'&&message.revision===1);
        assert.equal(splitGold.state.playerGold[hostSession],900);assert.equal(splitGold.state.playerGold[guestSession],825);
        assert.deepEqual(splitGold.state.projectileEvents,[projectile]);
        assert.deepEqual(splitGold.state.earthquakeFields,[earthquakeField]);
        const breath={id:2,kind:'breath',fromX:100,fromY:120,toX:400,toY:120,spread:180,role:'dragon',at:18.49};
        host.send('game_state',{state:{...state,nextProjectileId:3,projectileEvents:[breath]}});
        const splitBreath=await guest.waitFor(message=>message.type==='game_state'&&message.revision===2);
        assert.deepEqual(splitBreath.state.projectileEvents,[breath]);
        const orcArrow={id:3,kind:'shot',fromX:110,fromY:145,toX:280,toY:190,role:'orc-arrow',at:18.5};
        host.send('game_state',{state:{...state,nextProjectileId:4,projectileEvents:[orcArrow]}});
        const splitOrcShot=await guest.waitFor(message=>message.type==='game_state'&&message.revision===3);
        assert.deepEqual(splitOrcShot.state.projectileEvents,[orcArrow]);
        const specialEffects=[
            {id:4,kind:'lightning',fromX:160,fromY:40,toX:160,toY:200,role:'sky-thunder',at:18.5},
            {id:5,kind:'beam',fromX:140,fromY:80,toX:250,toY:110,role:'ice-beam',at:18.5},
            {id:6,kind:'mist',fromX:180,fromY:130,toX:180,toY:130,role:'purple-mist',at:18.5},
            {id:7,kind:'breath',fromX:100,fromY:120,toX:400,toY:120,spread:220,role:'dragon-frost',at:18.5}
        ];
        host.send('game_state',{state:{...state,nextProjectileId:8,projectileEvents:specialEffects}});
        const splitSpecialEffects=await guest.waitFor(message=>message.type==='game_state'&&message.revision===4);
        assert.deepEqual(splitSpecialEffects.state.projectileEvents,specialEffects);
        const newRaceEffects=[
            {id:8,kind:'meteor',fromX:180,fromY:30,toX:180,toY:200,role:'blight-meteor',duration:.58,at:18.5},
            {id:9,kind:'moonbeam',fromX:220,fromY:25,toX:220,toY:200,role:'moonbeam',at:18.5},
            {id:10,kind:'ring',fromX:210,fromY:160,toX:280,toY:160,radius:70,role:'soul-prism',at:18.5},
            {id:11,kind:'boomerang',fromX:180,fromY:160,toX:320,toY:100,duration:1.2,role:'moon-boomerang',at:18.5},
            {id:12,kind:'poisonburst',fromX:300,fromY:220,toX:300,toY:220,radius:20,role:'poison-burst',at:18.5}
        ];
        host.send('game_state',{state:{...state,nextProjectileId:13,projectileEvents:newRaceEffects}});
        const splitNewRaceEffects=await guest.waitFor(message=>message.type==='game_state'&&message.revision===5);
        assert.deepEqual(splitNewRaceEffects.state.projectileEvents,newRaceEffects);
        host.send('game_state',{state:{...state,projectileEvents:[{...projectile,role:'script'}]}});
        await host.waitFor(message=>message.type==='error'&&message.code==='invalid_game_state');

        host.send('game_command',{command:{action:'sell_tower',towerId:1}});
        await host.waitFor(message=>message.type==='error'&&message.code==='not_tower_owner');
        guest.send('game_command',{command:{action:'sell_tower',towerId:1}});
        const ownerSell=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='sell_tower');
        assert.equal(ownerSell.command.actorId,guestSession);
        host.send('game_state',{state:{...state,playerGold:{[hostSession]:74,[guestSession]:825}}});
        host.send('game_command',{command:{action:'place_tower',typeId:'alliance-arrow-tower',x:14,y:15}});
        await host.waitFor(message=>message.type==='error'&&message.code==='not_enough_gold');
        host.send('game_state',{state:{...state,playerGold:{[hostSession]:75,[guestSession]:825}}});
        host.send('game_command',{command:{action:'place_tower',typeId:'alliance-arrow-tower',x:14,y:15}});
        const paidHumanPlacement=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='place_tower');
        assert.equal(paidHumanPlacement.command.typeId,'alliance-arrow-tower');
        host.send('game_state',{state:{...state,playerGold:{[hostSession]:124,[guestSession]:825}}});
        host.send('game_command',{command:{action:'upgrade_tower',towerId:3,path:1}});
        await host.waitFor(message=>message.type==='error'&&message.code==='not_enough_gold');
        host.send('game_state',{state:{...state,playerGold:{[hostSession]:125,[guestSession]:825}}});
        host.send('game_command',{command:{action:'upgrade_tower',towerId:3,path:1}});
        const paidHumanUpgrade=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='upgrade_tower');
        assert.equal(paidHumanUpgrade.command.path,1);
        const orcTowerState={...state,towers:[{id:4,typeId:'orc-spiked-bunker',baseTypeId:'orc-spiked-bunker',x:20,y:20,ownerId:hostSession}],playerGold:{[hostSession]:89,[guestSession]:825}};
        host.send('game_state',{state:orcTowerState});
        host.send('game_command',{command:{action:'upgrade_tower',towerId:4,path:1}});
        await host.waitFor(message=>message.type==='error'&&message.code==='not_enough_gold');
        host.send('game_state',{state:{...orcTowerState,playerGold:{[hostSession]:90,[guestSession]:825}}});
        host.send('game_command',{command:{action:'upgrade_tower',towerId:4,path:1}});
        const paidOrcUpgrade=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='upgrade_tower');
        assert.equal(paidOrcUpgrade.command.path,1,'server should charge the configured Orc variant price');
        guest.send('game_command',{command:{action:'place_tower',typeId:'orc-watchtower',x:15,y:15}});
        await guest.waitFor(message=>message.type==='error'&&message.code==='wrong_race_tower');
        guest.send('game_command',{command:{action:'place_tower',typeId:'undead-blighted-altar',x:15,y:15}});
        const undeadPlacement=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='place_tower');
        assert.equal(undeadPlacement.command.typeId,'undead-blighted-altar');assert.equal(undeadPlacement.command.actorRace,'undead');
        host.send('game_state',{state:{...state,towers:[{id:1,typeId:'undead-blighted-altar',baseTypeId:'undead-blighted-altar',x:15,y:15,ownerId:guestSession}],playerGold:{[hostSession]:900,[guestSession]:825}}});
        guest.send('game_command',{command:{action:'upgrade_tower',towerId:1,path:1}});
        const freeUpgrade=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='upgrade_tower');
        assert.equal(freeUpgrade.command.path,1);
        const undeadGoldState={...state,towers:[],playerGold:{[hostSession]:900,[guestSession]:79}};
        host.send('game_state',{state:undeadGoldState});
        guest.send('game_command',{command:{action:'place_tower',typeId:'undead-ember-spire',x:12,y:14}});
        await guest.waitFor(message=>message.type==='error'&&message.code==='not_enough_gold');
        host.send('game_state',{state:{...undeadGoldState,playerGold:{[hostSession]:900,[guestSession]:80}}});
        guest.send('game_command',{command:{action:'place_tower',typeId:'undead-ember-spire',x:12,y:14}});
        const paidUndeadPlacement=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='place_tower');
        assert.equal(paidUndeadPlacement.command.typeId,'undead-ember-spire');
        host.send('game_state',{state:{...state,playerGold:{[hostSession]:900}}});
        await host.waitFor(message=>message.type==='error'&&message.code==='invalid_game_state');
        host.send('game_state',{state:{...state,playerGold:{[hostSession]:900,[guestSession]:825}}});
        await guest.waitFor(message=>message.type==='game_state'&&message.state.playerGold[guestSession]===825);

        await guest.close();guest=null;
        await host.waitFor(message=>message.type==='room_state'&&message.room.players.some(player=>player.id===guestSession&&player.connected===false));
        guestReturn=await connect(baseUrl,guestSession);
        const guestResume=await guestReturn.waitFor(message=>message.type==='resume_session');
        assert.equal(guestResume.room.code,code);assert.equal(guestResume.room.status,'playing');
        assert.equal(guestResume.state.playerGold[guestSession],825);assert.deepEqual(guestResume.checkpoint.spawnQueue,[[]]);
        guestReturn.send('game_ready');
        await host.waitFor(message=>message.type==='room_state'&&message.room.players.some(player=>player.id===guestSession&&player.connected===true));

        await host.close();host=null;
        const paused=await guestReturn.waitFor(message=>message.type==='match_paused'&&message.roomCode===code);
        assert.ok(paused.reconnectDeadline>Date.now());
        await guestReturn.waitFor(message=>message.type==='room_state'&&message.room.status==='paused');
        hostReturn=await connect(baseUrl,hostSession);
        const hostResume=await hostReturn.waitFor(message=>message.type==='resume_session');
        assert.equal(hostResume.room.status,'paused');assert.equal(hostResume.room.hostId,hostSession);
        assert.equal(hostResume.checkpoint.currentWave,3);assert.equal(hostResume.checkpoint.enemies[0].pathIndex,1);
        hostReturn.send('game_ready');
        await guestReturn.waitFor(message=>message.type==='match_resumed'&&message.roomCode===code);
        await guestReturn.waitFor(message=>message.type==='room_state'&&message.room.status==='playing');

        hostReturn.send('game_command',{command:{action:'cycle_speed'}});
        await hostReturn.waitFor(message=>message.type==='error'&&message.code==='invalid_game_command');
        hostReturn.send('end_match',{outcome:'defeat',wave:3});
        const [hostEnded,guestEnded]=await Promise.all([
            hostReturn.waitFor(message=>message.type==='match_ended'),
            guestReturn.waitFor(message=>message.type==='match_ended')
        ]);
        assert.equal(hostEnded.outcome,'defeat');assert.equal(guestEnded.outcome,'defeat');
        assert.equal(hostEnded.wave,3);assert.equal(guestEnded.wave,3);
        console.log(`Multiplayer safeguards, fixed-speed play, and synchronized match ending passed for room ${code}.`);
    }finally{
        for(const client of [host,guest,hostReturn,guestReturn])if(client?.ws&&client.ws.readyState<2)client.ws.close();
        if(child){child.kill('SIGTERM');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,1500).unref();});}
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
