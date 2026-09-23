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
function connect(baseUrl,session,version='0.83.0'){
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
        assert.deepEqual(await healthResponse.json(),{ok:true,protocolVersion:'0.83.0',rooms:0,players:0});

        const outdated=await connect(baseUrl,'phase5-old-client-000001','0.79.0');
        const mismatch=await outdated.waitFor(message=>message.type==='incompatible_version');
        assert.equal(mismatch.requiredVersion,'0.83.0');await outdated.close();

        const hostSession='phase5-host-session-000001';
        const guestSession='phase5-guest-session-00001';
        host=await connect(baseUrl,hostSession);guest=await connect(baseUrl,guestSession);
        const [hostWelcome,guestWelcome]=await Promise.all([
            host.waitFor(message=>message.type==='welcome'),guest.waitFor(message=>message.type==='welcome')
        ]);
        assert.equal(hostWelcome.clientId,hostSession);assert.equal(guestWelcome.clientId,guestSession);
        assert.equal(hostWelcome.protocolVersion,'0.83.0');
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
        guest.send('game_ready');host.send('game_ready');
        await guest.waitFor(message=>message.type==='room_state'&&message.room.status==='playing');

        const state={gold:900,playerGold:{[hostSession]:900,[guestSession]:825},lives:24,currentWave:3,maxWaves:25,waveActive:true,gameOver:false,speedMultiplier:1,elapsed:18.5,nextTowerId:2,nextEnemyId:3,nextMagmaId:1,outcome:null,towers:[{id:1,typeId:'alliance-arrow-tower',x:12,y:18,ownerId:guestSession}],enemies:[{id:2,typeId:'enemy-grunt',x:11,y:9,hp:75,maxHp:100}],magmaPools:[]};
        const checkpoint={...state,enemies:[{...state.enemies[0],path:[[10,9],[11,9],[12,9]],pathIndex:1,slowEffects:{}}],spawnQueue:[[]],spawnTimer:.2,spawnInterval:.28};
        host.send('game_state',{state});host.send('game_checkpoint',{checkpoint});
        const splitGold=await guest.waitFor(message=>message.type==='game_state'&&message.revision===1);
        assert.equal(splitGold.state.playerGold[hostSession],900);assert.equal(splitGold.state.playerGold[guestSession],825);

        host.send('game_command',{command:{action:'sell_tower',towerId:1}});
        await host.waitFor(message=>message.type==='error'&&message.code==='not_tower_owner');
        guest.send('game_command',{command:{action:'sell_tower',towerId:1}});
        const ownerSell=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='sell_tower');
        assert.equal(ownerSell.command.actorId,guestSession);
        guest.send('game_command',{command:{action:'place_tower',typeId:'orc-watchtower',x:15,y:15}});
        await guest.waitFor(message=>message.type==='error'&&message.code==='wrong_race_tower');
        guest.send('game_command',{command:{action:'place_tower',typeId:'undead-blighted-altar',x:15,y:15}});
        const undeadPlacement=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='place_tower');
        assert.equal(undeadPlacement.command.typeId,'undead-blighted-altar');assert.equal(undeadPlacement.command.actorRace,'undead');
        guest.send('game_command',{command:{action:'upgrade_tower',towerId:1,path:1}});
        const freeUpgrade=await host.waitFor(message=>message.type==='game_command'&&message.command?.action==='upgrade_tower');
        assert.equal(freeUpgrade.command.path,1);
        host.send('game_state',{state:{...state,playerGold:{[hostSession]:900}}});
        await host.waitFor(message=>message.type==='error'&&message.code==='invalid_game_state');

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
