'use strict';

const http=require('http');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {WebSocketServer,WebSocket}=require('ws');
const RELEASE_CONFIG=require('../release.json');
const {isCompatibleClient}=require('../lib/protocol-compatibility');

const PORT=Number(process.env.PORT)||3000;
const HOST=process.env.HOST||'0.0.0.0';
const SITE_ROOT=path.resolve(__dirname,'..');
const HOME_FILE='index.html';
const RELEASE_VERSION=RELEASE_CONFIG.releaseVersion;
const PROTOCOL_ID=RELEASE_CONFIG.multiplayer.protocolId;
const MAX_PLAYERS=9;
const MAX_MESSAGES=60;
const MAX_CHAT_LENGTH=200;
const MAX_PAYLOAD_BYTES=1024*1024;
const RECONNECT_GRACE_MS=45000;
const LOBBY_IDLE_MS=60*60*1000;
const ROOM_MAX_AGE_MS=6*60*60*1000;
const ROOM_CODE_LENGTH=6;
const ROOM_CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RACES=new Set(['human','orc','undead','nightelf','naga']);
const CUSTOM_TOWERS=Object.freeze({
    orc:['orc-watchtower','orc-spiked-bunker','orc-war-forge','orc-war-hut','orc-fel-well','orc-dragon-pit'],
    undead:['undead-blighted-altar','undead-ember-spire','undead-frost-spire','undead-bone-cage','undead-soul-prism','undead-bonefire-tower'],
    nightelf:['nightelf-ancient-protector','nightelf-moonwell','nightelf-lunar-sentinel','nightelf-runestone','nightelf-flame-warden','nightelf-ancient-of-lore'],
    naga:['naga-coral-bed','naga-tidal-guardian','naga-altar-of-depths','naga-spawning-grounds','naga-shrine-of-azshara','naga-temple-of-tides']
});
const HUMAN_TOWERS=['alliance-arrow-tower','crystal-sentinel','merchant-house','command-banner','dwarven-cannon','grand-fire-spire'];
const TOWER_RACES=new Map([
    ...HUMAN_TOWERS.map(typeId=>[typeId,'human']),
    ...Object.entries(CUSTOM_TOWERS).flatMap(([race,typeIds])=>typeIds.map(typeId=>[typeId,race]))
]);
const TOWER_IDS=new Set(TOWER_RACES.keys());
const HUMAN_TOWER_COSTS=new Map([
    ['alliance-arrow-tower',75],['crystal-sentinel',100],['merchant-house',150],
    ['command-banner',200],['dwarven-cannon',125],['grand-fire-spire',400]
]);
const HUMAN_UPGRADE_COSTS=new Map([
    ['alliance-arrow-tower',[125,175]],['crystal-sentinel',[125,175]],['dwarven-cannon',[200,225]],
    ['merchant-house',[150,200]],['command-banner',[200,225]],['grand-fire-spire',[450,425]]
]);
const ORC_UPGRADE_COSTS=new Map([
    ['orc-spiked-bunker',[90,100]],['orc-watchtower',[175,200]],['orc-war-forge',[275,275]],
    ['orc-war-hut',[250,175]],['orc-fel-well',[200,300]],['orc-dragon-pit',[475,525]]
]);
const UNDEAD_UPGRADE_COSTS=new Map([
    ['undead-ember-spire',[130,165]],['undead-frost-spire',[165,210]],['undead-bone-cage',[200,225]],
    ['undead-blighted-altar',[420,500]],['undead-bonefire-tower',[400,475]],['undead-soul-prism',[450,550]]
]);
const NIGHTELF_UPGRADE_COSTS=new Map([
    ['nightelf-moonwell',[140,180]],['nightelf-ancient-protector',[200,220]],['nightelf-flame-warden',[175,250]],
    ['nightelf-lunar-sentinel',[450,350]],['nightelf-runestone',[500,500]],['nightelf-ancient-of-lore',[500,650]]
]);
const ORC_TOWER_COSTS=new Map([['orc-spiked-bunker',25],['orc-watchtower',100],['orc-war-forge',150],['orc-war-hut',175],['orc-fel-well',300],['orc-dragon-pit',500]]);
const UNDEAD_TOWER_COSTS=new Map([['undead-ember-spire',80],['undead-frost-spire',120],['undead-bone-cage',190],['undead-blighted-altar',320],['undead-bonefire-tower',440],['undead-soul-prism',600]]);
const NIGHTELF_TOWER_COSTS=new Map([['nightelf-moonwell',80],['nightelf-ancient-protector',130],['nightelf-flame-warden',210],['nightelf-lunar-sentinel',325],['nightelf-runestone',460],['nightelf-ancient-of-lore',650]]);
const NAGA_TOWER_COSTS=new Map([['naga-coral-bed',85],['naga-tidal-guardian',130],['naga-altar-of-depths',210],['naga-spawning-grounds',310],['naga-shrine-of-azshara',440],['naga-temple-of-tides',620]]);
const NAGA_UPGRADE_COSTS=new Map([['naga-coral-bed',[140,180]],['naga-tidal-guardian',[230,260]],['naga-altar-of-depths',[300,350]],['naga-spawning-grounds',[420,480]],['naga-shrine-of-azshara',[550,600]],['naga-temple-of-tides',[720,800]]]);
const TOWER_COSTS=new Map([...TOWER_IDS].map(typeId=>[typeId,HUMAN_TOWER_COSTS.get(typeId)??ORC_TOWER_COSTS.get(typeId)??UNDEAD_TOWER_COSTS.get(typeId)??NIGHTELF_TOWER_COSTS.get(typeId)??NAGA_TOWER_COSTS.get(typeId)??0]));
const UPGRADE_COSTS=new Map([...TOWER_IDS].map(typeId=>[
    typeId,new Map((HUMAN_UPGRADE_COSTS.get(typeId)||ORC_UPGRADE_COSTS.get(typeId)||UNDEAD_UPGRADE_COSTS.get(typeId)||NIGHTELF_UPGRADE_COSTS.get(typeId)||NAGA_UPGRADE_COSTS.get(typeId)||[0,0]).map((cost,index)=>[index+1,cost]))
]));
const COLORS=['#ff3b3b','#3b82ff','#3fffe6','#ffb52e','#fff86a','#b066ff','#35ed65','#ff8fc9','#b8c0cc'];
const MIME_TYPES={
    '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
    '.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
    '.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.mp3':'audio/mpeg','.wav':'audio/wav',
    '.mp4':'video/mp4','.webm':'video/webm','.ogg':'audio/ogg','.tdml':'text/plain; charset=utf-8'
};

const rooms=new Map();
const clients=new Map();
const disconnectTimers=new Map();

function id(){return crypto.randomUUID?.()||crypto.randomBytes(16).toString('hex');}
function cleanText(value,max,fallback=''){
    const text=String(value??'').replace(/[\u0000-\u001f\u007f<>]/g,'').trim().slice(0,max);
    return text||fallback;
}
function cleanCode(value){return String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,ROOM_CODE_LENGTH);}
function cleanRace(value){return RACES.has(value)?value:'human';}
function roomCode(){
    for(let attempt=0;attempt<100;attempt++){
        let code='';const bytes=crypto.randomBytes(ROOM_CODE_LENGTH);
        for(const byte of bytes)code+=ROOM_CODE_CHARS[byte%ROOM_CODE_CHARS.length];
        if(!rooms.has(code))return code;
    }
    throw new Error('Unable to allocate a room code.');
}
function systemMessage(text){return {id:id(),kind:'system',text,at:Date.now()};}
function publicRoom(room){
    return {
        code:room.code,status:room.status,hostId:room.hostId,createdAt:room.createdAt,startedAt:room.startedAt||null,reconnectDeadline:room.reconnectDeadline||null,
        players:room.players.map(player=>({...player,isHost:player.id===room.hostId})),messages:room.messages
    };
}
function send(client,type,payload={}){
    if(client.ws.readyState===WebSocket.OPEN)client.ws.send(JSON.stringify({type,...payload}));
}
function fail(client,code,message){send(client,'error',{code,message});}
function broadcast(room,type,payload={}){
    for(const player of room.players){const client=clients.get(player.id);if(client)send(client,type,payload);}
}
function touchRoom(room){room.updatedAt=Date.now();}
function broadcastState(room){touchRoom(room);broadcast(room,'room_state',{room:publicRoom(room)});}
function addMessage(room,message){room.messages.push(message);room.messages=room.messages.slice(-MAX_MESSAGES);}
function availableColor(room,requested){
    const used=new Set(room.players.map(player=>player.color));
    if(COLORS.includes(requested)&&!used.has(requested))return requested;
    return COLORS.find(color=>!used.has(color))||COLORS[room.players.length%COLORS.length];
}
function playerFor(client,payload,room){
    return {id:client.id,name:cleanText(payload.name,15,'Player'),race:cleanRace(payload.race),color:availableColor(room,payload.color),ready:false,gameReady:false,connected:true,disconnectedAt:null};
}
function currentRoom(client){return client.roomCode?rooms.get(client.roomCode):null;}
function clearDisconnectTimer(playerId){const timer=disconnectTimers.get(playerId);if(timer){clearTimeout(timer);disconnectTimers.delete(playerId);}}
function closeMatchRoom(room,message){
    for(const player of room.players){
        clearDisconnectTimer(player.id);const remaining=clients.get(player.id);if(!remaining)continue;
        remaining.roomCode=null;send(remaining,'room_closed',{message});
    }
    rooms.delete(room.code);
}
function finishMatchRoom(room,outcome,wave){
    for(const player of room.players){
        clearDisconnectTimer(player.id);const remaining=clients.get(player.id);if(!remaining)continue;
        remaining.roomCode=null;send(remaining,'match_ended',{outcome,wave});
    }
    rooms.delete(room.code);
}
function removeFromRoom(client,announce=true){
    clearDisconnectTimer(client.id);
    const room=currentRoom(client);client.roomCode=null;
    if(!room)return;
    const departing=room.players.find(player=>player.id===client.id);
    room.players=room.players.filter(player=>player.id!==client.id);
    if(!room.players.length){rooms.delete(room.code);return;}
    if(room.hostId===client.id&&room.status!=='lobby'){
        closeMatchRoom(room,'The host left, so the synchronized match ended.');return;
    }
    if(room.hostId===client.id){
        room.hostId=room.players[0].id;
        addMessage(room,systemMessage(`${room.players[0].name} is now the host.`));
    }
    if(announce&&departing)addMessage(room,systemMessage(`${departing.name} left the room.`));
    broadcastState(room);
}
function expireDisconnectedPlayer(playerId,code){
    disconnectTimers.delete(playerId);
    const room=rooms.get(code),player=room?.players.find(item=>item.id===playerId);
    if(!room||!player||player.connected)return;
    if(room.hostId===playerId&&room.status!=='lobby'){
        closeMatchRoom(room,'The host did not reconnect in time, so the match ended.');return;
    }
    removeFromRoom({id:playerId,roomCode:code},true);
}
function handleDisconnect(client){
    const room=currentRoom(client);if(!room)return;
    const player=room.players.find(item=>item.id===client.id);if(!player)return;
    player.connected=false;player.gameReady=false;player.disconnectedAt=Date.now();
    if(room.hostId===client.id&&room.status!=='lobby'){
        room.resumeStatus=room.status==='paused'?(room.resumeStatus||'playing'):room.status;
        room.status='paused';room.reconnectDeadline=Date.now()+RECONNECT_GRACE_MS;
        broadcast(room,'match_paused',{roomCode:room.code,reconnectDeadline:room.reconnectDeadline,message:'Host disconnected. Waiting up to 45 seconds for reconnection.'});
    }
    broadcastState(room);
    clearDisconnectTimer(client.id);
    const timer=setTimeout(()=>expireDisconnectedPlayer(client.id,room.code),RECONNECT_GRACE_MS);timer.unref?.();disconnectTimers.set(client.id,timer);
}
function findRoomForPlayer(playerId){for(const room of rooms.values()){if(room.players.some(player=>player.id===playerId))return room;}return null;}
function resumeSession(client){
    const room=findRoomForPlayer(client.id);if(!room)return false;
    const player=room.players.find(item=>item.id===client.id);if(!player)return false;
    clearDisconnectTimer(client.id);client.roomCode=room.code;player.connected=true;player.disconnectedAt=null;player.gameReady=false;
    send(client,'resume_session',{room:publicRoom(room),matchActive:room.status!=='lobby',revision:room.gameRevision,state:room.lastGameState,checkpoint:room.lastCheckpoint||room.lastGameState});
    broadcastState(room);return true;
}
function createRoom(client,payload){
    removeFromRoom(client);
    const code=roomCode();
    const room={code,status:'lobby',hostId:client.id,createdAt:Date.now(),updatedAt:Date.now(),startedAt:null,players:[],messages:[],gameRevision:0,lastGameState:null,lastCheckpoint:null,commandSequence:0,resumeStatus:null,reconnectDeadline:null};
    const host=playerFor(client,payload,room);host.ready=true;room.players.push(host);
    addMessage(room,systemMessage(`${host.name} created room ${code}.`));
    rooms.set(code,room);client.roomCode=code;broadcastState(room);
}
function joinRoom(client,payload){
    const code=cleanCode(payload.code),room=rooms.get(code);
    if(code.length!==ROOM_CODE_LENGTH)return fail(client,'invalid_code','Enter a valid six-character room code.');
    if(!room)return fail(client,'room_not_found',`Room ${code} was not found.`);
    if(room.status!=='lobby')return fail(client,'match_started','That match has already started.');
    if(room.players.length>=MAX_PLAYERS)return fail(client,'room_full','That room is full.');
    removeFromRoom(client);
    const player=playerFor(client,payload,room);room.players.push(player);client.roomCode=code;
    addMessage(room,systemMessage(`${player.name} joined the room.`));broadcastState(room);
}
function updateProfile(client,payload){
    const room=currentRoom(client);if(!room)return fail(client,'not_in_room','Join a room first.');
    if(room.status!=='lobby')return fail(client,'match_started','The match has already started.');
    const player=room.players.find(item=>item.id===client.id);if(!player)return;
    if(payload.name!==undefined)player.name=cleanText(payload.name,15,player.name);
    if(payload.race!==undefined){player.race=cleanRace(payload.race);player.ready=player.id===room.hostId;}
    if(payload.color!==undefined){
        if(!COLORS.includes(payload.color))return fail(client,'invalid_color','That player color is unavailable.');
        if(room.players.some(item=>item.id!==client.id&&item.color===payload.color))return fail(client,'color_taken','That player color is already in use.');
        player.color=payload.color;player.ready=player.id===room.hostId;
    }
    broadcastState(room);
}
function toggleReady(client){
    const room=currentRoom(client);if(!room)return fail(client,'not_in_room','Join a room first.');
    if(room.status!=='lobby')return fail(client,'match_started','The match has already started.');
    const player=room.players.find(item=>item.id===client.id);if(!player)return;
    if(player.id===room.hostId){player.ready=true;broadcastState(room);return;}
    player.ready=!player.ready;
    addMessage(room,systemMessage(`${player.name} is ${player.ready?'ready':'not ready'}.`));broadcastState(room);
}
function chat(client,payload){
    const room=currentRoom(client);if(!room)return fail(client,'not_in_room','Join a room first.');
    const player=room.players.find(item=>item.id===client.id);if(!player)return;
    const text=cleanText(payload.text,MAX_CHAT_LENGTH);if(!text)return;
    addMessage(room,{id:id(),kind:'player',name:player.name,text,at:Date.now()});broadcastState(room);
}
function startMatch(client){
    const room=currentRoom(client);if(!room)return fail(client,'not_in_room','Join a room first.');
    if(room.hostId!==client.id)return fail(client,'host_only','Only the host can start the match.');
    if(room.status!=='lobby')return fail(client,'match_started','The match has already started.');
    if(!room.players.length||room.players.some(player=>!player.ready||!player.connected))return fail(client,'players_not_ready','Every connected player must be ready before the host can start.');
    room.status='starting';room.startedAt=Date.now();room.gameRevision=0;room.lastGameState=null;room.lastCheckpoint=null;room.commandSequence=0;room.resumeStatus=null;room.reconnectDeadline=null;
    room.players.forEach(player=>{player.gameReady=false;});addMessage(room,systemMessage('The host started the match.'));
    broadcastState(room);broadcast(room,'match_start',{roomCode:room.code,startedAt:room.startedAt});
}
function gameReady(client){
    const room=currentRoom(client);if(!room||!['starting','playing','paused'].includes(room.status))return fail(client,'match_inactive','There is no active match.');
    const player=room.players.find(item=>item.id===client.id);if(!player)return;
    player.gameReady=true;
    if(client.id===room.hostId){
        const wasPaused=room.status==='paused';room.status='playing';room.resumeStatus=null;room.reconnectDeadline=null;
        if(wasPaused)broadcast(room,'match_resumed',{roomCode:room.code,message:'Host reconnected. Match resumed.'});
    }
    broadcastState(room);
    if(room.lastGameState)send(client,'game_state',{roomCode:room.code,revision:room.gameRevision,state:room.lastGameState});
}
function sanitizeGameCommand(value){
    if(!value||typeof value!=='object')return null;
    const action=String(value.action||'');
    if(action==='place_tower'){
        const x=Number(value.x),y=Number(value.y),typeId=cleanText(value.typeId,48);
        if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>99||y>99||!TOWER_IDS.has(typeId))return null;
        return {action,typeId,x,y};
    }
    if(action==='upgrade_tower'){
        const towerId=Number(value.towerId),upgradePath=Number(value.path);
        if(!Number.isInteger(towerId)||towerId<1||!Number.isInteger(upgradePath)||![1,2].includes(upgradePath))return null;
        return {action,towerId,path:upgradePath};
    }
    if(action==='sell_tower'){
        const towerId=Number(value.towerId);if(!Number.isInteger(towerId)||towerId<1)return null;
        return {action,towerId};
    }
    if(action==='start_wave')return {action};
    return null;
}
function gameCommand(client,payload){
    const room=currentRoom(client);if(!room||room.status!=='playing')return fail(client,'match_inactive','The host game is not ready.');
    const player=room.players.find(item=>item.id===client.id);if(!player?.gameReady)return fail(client,'client_not_ready','Your game is still loading.');
    const now=Date.now();if(now-client.commandWindow>2000){client.commandWindow=now;client.commandCount=0;}client.commandCount+=1;
    if(client.commandCount>48)return fail(client,'command_rate_limited','Too many game actions were submitted at once.');
    const command=sanitizeGameCommand(payload.command);if(!command)return fail(client,'invalid_game_command','That game action is invalid.');
    if(command.action==='start_wave'&&client.id!==room.hostId)return fail(client,'host_only','Only the host controls waves.');
    if(command.action==='place_tower'&&TOWER_RACES.get(command.typeId)!==player.race)return fail(client,'wrong_race_tower','That tower is not available to your selected race.');
    if((command.action==='upgrade_tower'||command.action==='sell_tower')&&room.lastGameState){
        const tower=room.lastGameState.towers.find(item=>item.id===command.towerId);
        if(!tower)return fail(client,'tower_missing','That tower no longer exists.');
        if(tower.ownerId&&tower.ownerId!==client.id)return fail(client,'not_tower_owner','Only the player who owns a tower can change it.');
        if(command.action==='upgrade_tower'){
            const baseTypeId=tower.baseTypeId||tower.typeId,cost=UPGRADE_COSTS.get(baseTypeId)?.get(command.path);
            if(cost===undefined||tower.upgradePath)return fail(client,'upgrade_unavailable','That upgrade is not available.');
            if((room.lastGameState.playerGold?.[client.id]??0)<cost)return fail(client,'not_enough_gold','You do not have enough gold for that upgrade.');
        }
    }
    if(command.action==='place_tower'&&room.lastGameState&&(room.lastGameState.playerGold?.[client.id]??0)<TOWER_COSTS.get(command.typeId))return fail(client,'not_enough_gold','You do not have enough gold for that tower.');
    const host=clients.get(room.hostId);if(!host)return fail(client,'host_missing','The host is unavailable.');
    command.commandId=++room.commandSequence;command.actorId=client.id;command.actorName=player.name;command.actorRace=player.race;command.actorIsHost=client.id===room.hostId;
    send(host,'game_command',{roomCode:room.code,command});
}
function gameState(client,payload){
    const room=currentRoom(client);if(!room||room.status!=='playing')return fail(client,'match_inactive','There is no active match.');
    if(client.id!==room.hostId)return fail(client,'host_only','Only the host can publish game state.');
    const state=payload.state;
    const playerIds=new Set(room.players.map(player=>player.id)),ledger=state?.playerGold;
    const validLedger=ledger&&typeof ledger==='object'&&!Array.isArray(ledger)&&Object.keys(ledger).length===playerIds.size&&Object.entries(ledger).every(([playerId,gold])=>playerIds.has(playerId)&&Number.isInteger(gold)&&gold>=0&&gold<=1000000000);
    const validOwners=Array.isArray(state?.towers)&&state.towers.every(tower=>!tower.ownerId||playerIds.has(tower.ownerId));
    const projectiles=state?.projectileEvents;
    const attackModes=new Set(['projectile','meteor','sky-strike','beam-strike','radial','wave','tidal-wave','ring','boomerang','breath','naga-chain','naga-lance','naga-brood']);
    const attackRoles=new Set(['arrow','orc-arrow','longbow','eagle','crystal','frost','arcane','cannon','thunder','siege','fire','magma','phoenix','aura','command','fel','shaman-orb','ethereal-red','ethereal-purple','ethereal-ice','bone-spike','bone-spike-large','bone-spike-venom','ancient-rock','ancient-fire-rock','ancient-blue','bonefire-fire','poison-vial','blight-meteor','blight-lightning','sky-thunder','water-wave','soul-ring-blue','soul-ring-purple','moon-boomerang','nature-boomerang','dragon','dragon-frost','moonbeam','nature-beam','rock','ice-beam','naga-coral','naga-reef','naga-bloom','naga-guardian','naga-depth-orb','naga-chain','naga-lance','naga-storm','naga-whirlpool','naga-pearl','naga-pearl-fan','naga-brood-pod','naga-broodling','naga-scepter','naga-queen','naga-abyss','naga-tide','naga-maelstrom']);
    const attackShapes={projectile:'circle',meteor:'circle','sky-strike':'circle','beam-strike':'circle',radial:'segment',wave:'expanding-ring','tidal-wave':'expanding-wavefront',ring:'expanding-ring',boomerang:'swept-circle',breath:'cone','naga-chain':'circle','naga-lance':'segment','naga-brood':'circle'};
    const validAttackProjectiles=items=>items===undefined||(Array.isArray(items)&&items.length<=128&&items.every(projectile=>projectile&&Number.isSafeInteger(projectile.id)&&projectile.id>0&&attackModes.has(projectile.mode)&&attackRoles.has(projectile.role)&&projectile.collisionShape===attackShapes[projectile.mode]&&['x','y','fromX','fromY','toX','toY','angle','age','lifetime','radius','maxRadius','spread','breathHalfAngle','stage'].every(key=>Number.isFinite(projectile[key]))&&['x','y','fromX','fromY','toX','toY'].every(key=>projectile[key]>=0&&projectile[key]<=4096)&&projectile.age>=0&&projectile.lifetime>0&&projectile.lifetime<=4&&projectile.age<=projectile.lifetime+.5&&projectile.radius>=0&&projectile.radius<=4096&&projectile.maxRadius>=0&&projectile.maxRadius<=4096&&projectile.spread>=0&&projectile.spread<=4096&&(projectile.stage===0||projectile.stage===1)));
    const validProjectile=projectile=>{
        if(!projectile||!Number.isSafeInteger(projectile.id)||projectile.id<=0||![projectile.fromX,projectile.fromY,projectile.toX,projectile.toY].every(value=>Number.isFinite(value)&&value>=0&&value<=4096)||!Number.isFinite(projectile.at)||projectile.at<0)return false;
        if(projectile.kind==='shot')return ['arrow','orc-arrow','longbow','eagle','crystal','frost','arcane','cannon','thunder','siege','fire','magma','phoenix','aura','command','fel','shaman-orb','ethereal-red','ethereal-purple','ethereal-ice','bone-spike','bone-spike-large','bone-spike-venom','ancient-rock','ancient-fire-rock','ancient-blue','bonefire-fire','poison-vial'].includes(projectile.role);
        if(projectile.kind==='breath')return ['dragon','dragon-frost'].includes(projectile.role)&&Number.isFinite(projectile.spread)&&projectile.spread>0&&projectile.spread<=4096;
        if(['lightning','beam','mist'].includes(projectile.kind))return ({lightning:['sky-thunder'],beam:['ice-beam','nature-beam'],mist:['purple-mist']})[projectile.kind].includes(projectile.role);
        if(['meteor','moonbeam'].includes(projectile.kind))return ({meteor:['blight-meteor','blight-lightning'],moonbeam:['moonbeam','nature-beam']})[projectile.kind].includes(projectile.role);
        if(['ring','poisonburst','wave'].includes(projectile.kind))return ({ring:['soul-ring-blue','soul-ring-purple','naga-surge'],poisonburst:['poison-burst'],wave:['water-wave']})[projectile.kind].includes(projectile.role)&&Number.isFinite(projectile.radius)&&projectile.radius>0&&projectile.radius<=4096;
        if(projectile.kind==='boomerang')return ['moon-boomerang','nature-boomerang'].includes(projectile.role)&&Number.isFinite(projectile.duration)&&projectile.duration>=.3&&projectile.duration<=4;
        if(projectile.kind==='ghost')return projectile.role==='homing-ghost'&&Number.isFinite(projectile.duration)&&projectile.duration>=.2&&projectile.duration<=.8;
        return false;
    };
    const validProjectiles=projectiles===undefined||(Array.isArray(projectiles)&&projectiles.length<=128&&projectiles.every(validProjectile));
    const validAttackState=validAttackProjectiles(state?.attackProjectiles);
    const earthquakeFields=state?.earthquakeFields;
    const validEarthquakeFields=earthquakeFields===undefined||(Array.isArray(earthquakeFields)&&earthquakeFields.length<=1024&&earthquakeFields.every(field=>field&&Number.isSafeInteger(field.id)&&field.id>0&&Number.isFinite(field.x)&&field.x>=0&&field.x<=4096&&Number.isFinite(field.y)&&field.y>=0&&field.y<=4096&&Number.isFinite(field.radius)&&field.radius>0&&field.radius<=4096&&Number.isFinite(field.dps)&&field.dps>=0&&field.dps<=100000&&Number.isFinite(field.expiresAt)&&field.expiresAt>=0&&['normal','piercing','magic','siege','elemental','support','economic'].includes(field.attackType||'siege')&&(!field.ownerId||playerIds.has(field.ownerId))));
    if(!state||typeof state!=='object'||!Array.isArray(state.towers)||!Array.isArray(state.enemies)||state.towers.length>1000||state.enemies.length>2000||!validLedger||!validOwners||!validProjectiles||!validAttackState||!validEarthquakeFields)return fail(client,'invalid_game_state','The game snapshot is invalid.');
    room.lastGameState=state;room.gameRevision+=1;
    touchRoom(room);
    for(const player of room.players){
        if(player.id===client.id)continue;
        const recipient=clients.get(player.id);
        if(recipient&&recipient.ws.bufferedAmount<=256*1024)send(recipient,'game_state',{roomCode:room.code,revision:room.gameRevision,state});
    }
}
function gameCheckpoint(client,payload){
    const room=currentRoom(client);if(!room||room.status!=='playing'||client.id!==room.hostId)return;
    const checkpoint=payload.checkpoint;
    const playerIds=new Set(room.players.map(player=>player.id)),ledger=checkpoint?.playerGold;
    const validLedger=ledger&&typeof ledger==='object'&&!Array.isArray(ledger)&&Object.keys(ledger).length===playerIds.size&&Object.entries(ledger).every(([playerId,gold])=>playerIds.has(playerId)&&Number.isInteger(gold)&&gold>=0&&gold<=1000000000);
    const earthquakeFields=checkpoint?.earthquakeFields;
    const attackSimulation=checkpoint?.attackSimulation;
    const validAttackSimulation=attackSimulation===undefined||(Array.isArray(attackSimulation)&&attackSimulation.length<=128&&attackSimulation.every(projectile=>projectile&&Number.isSafeInteger(projectile.id)&&projectile.id>0&&Number.isFinite(projectile.x)&&projectile.x>=0&&projectile.x<=4096&&Number.isFinite(projectile.y)&&projectile.y>=0&&projectile.y<=4096&&Number.isFinite(projectile.age)&&projectile.age>=0&&Number.isFinite(projectile.lifetime)&&projectile.lifetime>0&&projectile.lifetime<=4&&Array.isArray(projectile.hitIds)&&projectile.hitIds.length<=200&&projectile.weapon&&typeof projectile.weapon==='object'&&!Array.isArray(projectile.weapon)));
    const validEarthquakeFields=earthquakeFields===undefined||(Array.isArray(earthquakeFields)&&earthquakeFields.length<=1024&&earthquakeFields.every(field=>field&&Number.isSafeInteger(field.id)&&field.id>0&&Number.isFinite(field.x)&&field.x>=0&&field.x<=4096&&Number.isFinite(field.y)&&field.y>=0&&field.y<=4096&&Number.isFinite(field.radius)&&field.radius>0&&field.radius<=4096&&Number.isFinite(field.dps)&&field.dps>=0&&field.dps<=100000&&Number.isFinite(field.expiresAt)&&field.expiresAt>=0&&['normal','piercing','magic','siege','elemental','support','economic'].includes(field.attackType||'siege')&&(!field.ownerId||playerIds.has(field.ownerId))));
    if(!checkpoint||typeof checkpoint!=='object'||!Array.isArray(checkpoint.towers)||!Array.isArray(checkpoint.enemies)||!Array.isArray(checkpoint.spawnQueue)||checkpoint.towers.length>1000||checkpoint.enemies.length>2000||checkpoint.spawnQueue.length>200||!validLedger||!validAttackSimulation||!validEarthquakeFields)return fail(client,'invalid_checkpoint','The recovery checkpoint is invalid.');
    room.lastCheckpoint=checkpoint;
    touchRoom(room);
}
function gameCommandResult(client,payload){
    const room=currentRoom(client);if(!room||client.id!==room.hostId)return;
    const actorId=cleanText(payload.actorId,64),target=clients.get(actorId);
    if(!target||target.roomCode!==room.code)return;
    send(target,'game_command_result',{commandId:Number(payload.commandId)||0,actorId,success:Boolean(payload.success),message:cleanText(payload.message,120)});
}
function endMatch(client,payload){
    const room=currentRoom(client);if(!room||room.status!=='playing')return fail(client,'match_inactive','There is no active match.');
    if(client.id!==room.hostId)return fail(client,'host_only','Only the host can end the match.');
    const wave=Math.max(1,Math.min(999,Math.floor(Number(payload.wave)||room.lastGameState?.currentWave||1)));
    finishMatchRoom(room,payload.outcome==='victory'?'victory':'defeat',wave);
}
function rateLimited(client){
    const now=Date.now();if(now-client.rateWindow>10000){client.rateWindow=now;client.rateCount=0;}
    client.rateCount+=1;return client.rateCount>180;
}
function handleClientMessage(client,raw){
    let payload;try{payload=JSON.parse(raw.toString());}catch(error){return fail(client,'invalid_json','Invalid multiplayer message.');}
    if(!payload||typeof payload.type!=='string')return fail(client,'invalid_message','Invalid multiplayer message.');
    if(!['game_state','game_checkpoint','latency_ping'].includes(payload.type)&&rateLimited(client))return fail(client,'rate_limited','Too many requests. Please slow down.');
    switch(payload.type){
        case 'latency_ping':send(client,'latency_pong',{clientTime:Number(payload.clientTime)||0,serverTime:Date.now()});break;
        case 'create_room':createRoom(client,payload);break;
        case 'join_room':joinRoom(client,payload);break;
        case 'update_profile':updateProfile(client,payload);break;
        case 'toggle_ready':toggleReady(client);break;
        case 'chat':chat(client,payload);break;
        case 'start_match':startMatch(client);break;
        case 'game_ready':gameReady(client);break;
        case 'game_command':gameCommand(client,payload);break;
        case 'game_state':gameState(client,payload);break;
        case 'game_checkpoint':gameCheckpoint(client,payload);break;
        case 'game_command_result':gameCommandResult(client,payload);break;
        case 'end_match':endMatch(client,payload);break;
        case 'leave_room':removeFromRoom(client);break;
        default:fail(client,'unknown_message','Unknown multiplayer message.');
    }
}

const server=http.createServer((request,response)=>{
    const requestUrl=new URL(request.url,'http://localhost');
    let pathname;
    try{pathname=decodeURIComponent(requestUrl.pathname);}catch(error){response.writeHead(400);response.end('Bad request');return;}
    if(pathname==='/health'){
        response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
        response.end(JSON.stringify({ok:true,releaseVersion:RELEASE_VERSION,protocolId:PROTOCOL_ID,protocolVersion:PROTOCOL_ID,rooms:rooms.size,players:[...rooms.values()].reduce((sum,room)=>sum+room.players.length,0)}));return;
    }
    if(pathname==='/')pathname=`/${HOME_FILE}`;
    const filePath=path.resolve(SITE_ROOT,`.${pathname}`);
    if(filePath!==SITE_ROOT&&!filePath.startsWith(`${SITE_ROOT}${path.sep}`)){response.writeHead(403);response.end('Forbidden');return;}
    fs.stat(filePath,(statError,stat)=>{
        if(statError||!stat.isFile()){response.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});response.end('Not found');return;}
        const etag=`W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
        const lastModified=stat.mtime.toUTCString();
        const headers={
            'Content-Type':MIME_TYPES[path.extname(filePath).toLowerCase()]||'application/octet-stream',
            'Cache-Control':'no-cache, must-revalidate',
            'ETag':etag,
            'Last-Modified':lastModified
        };
        const ifNoneMatch=request.headers['if-none-match'];
        const ifModifiedSince=request.headers['if-modified-since'];
        const etagMatches=ifNoneMatch&&ifNoneMatch.split(',').some(value=>value.trim()==='*'||value.trim()===etag||value.trim()===etag.slice(2));
        const dateMatches=!ifNoneMatch&&ifModifiedSince&&Date.parse(ifModifiedSince)>=Math.floor(stat.mtimeMs/1000)*1000;
        if((request.method==='GET'||request.method==='HEAD')&&(etagMatches||dateMatches)){
            response.writeHead(304,headers);response.end();return;
        }
        response.writeHead(200,headers);
        if(request.method==='HEAD'){response.end();return;}
        fs.createReadStream(filePath).pipe(response);
    });
});

const wss=new WebSocketServer({noServer:true,maxPayload:MAX_PAYLOAD_BYTES});
server.on('upgrade',(request,networkSocket,head)=>{
    const pathname=new URL(request.url,'http://localhost').pathname;
    if(pathname!=='/ws'){networkSocket.destroy();return;}
    const allowedOrigin=process.env.ALLOWED_ORIGIN;
    if(allowedOrigin&&request.headers.origin!==allowedOrigin){networkSocket.destroy();return;}
    wss.handleUpgrade(request,networkSocket,head,ws=>wss.emit('connection',ws,request));
});
wss.on('connection',(ws,request)=>{
    ws._socket?.setNoDelay?.(true);
    const requestUrl=new URL(request.url,'http://localhost');
    const requestedProtocol=requestUrl.searchParams.get('protocol');
    const requestedRelease=requestUrl.searchParams.get('release')||requestUrl.searchParams.get('version');
    const compatible=isCompatibleClient(RELEASE_CONFIG.multiplayer,requestedProtocol,requestedRelease);
    if(!compatible){
        const message=`Client ${requestedRelease||'unknown release'} (${requestedProtocol||'legacy protocol'}) is incompatible with server ${RELEASE_VERSION} (${PROTOCOL_ID}). Update to a compatible game release.`;
        ws.send(JSON.stringify({type:'incompatible_version',requiredReleaseVersion:RELEASE_VERSION,requiredProtocolId:PROTOCOL_ID,requestedReleaseVersion:requestedRelease,requestedProtocolId:requestedProtocol,message}));
        ws.close(1008,'Version mismatch');return;
    }
    const requestedSession=requestUrl.searchParams.get('session');
    const clientId=/^[A-Za-z0-9-]{20,80}$/.test(requestedSession||'')?requestedSession:id();
    const existing=clients.get(clientId);
    const client={id:clientId,ws,roomCode:null,isAlive:true,rateWindow:Date.now(),rateCount:0,commandWindow:Date.now(),commandCount:0};clients.set(client.id,client);
    if(existing&&existing.ws!==ws)existing.ws.terminate();
    send(client,'welcome',{clientId:client.id,serverTime:Date.now(),releaseVersion:RELEASE_VERSION,protocolId:PROTOCOL_ID,protocolVersion:PROTOCOL_ID});
    if(!resumeSession(client))send(client,'session_status',{resumed:false});
    ws.on('pong',()=>{client.isAlive=true;});
    ws.on('message',raw=>handleClientMessage(client,raw));
    ws.on('close',()=>{if(clients.get(client.id)!==client)return;clients.delete(client.id);handleDisconnect(client);});
    ws.on('error',()=>{});
});
const heartbeat=setInterval(()=>{
    for(const client of clients.values()){
        if(!client.isAlive){client.ws.terminate();continue;}
        client.isAlive=false;client.ws.ping();
    }
},30000);

const roomCleanup=setInterval(()=>{
    const now=Date.now();
    for(const room of rooms.values()){
        const tooOld=now-room.createdAt>ROOM_MAX_AGE_MS;
        const idleLobby=room.status==='lobby'&&now-room.updatedAt>LOBBY_IDLE_MS;
        if(tooOld||idleLobby)closeMatchRoom(room,tooOld?'The room reached its six-hour safety limit.':'The inactive lobby expired.');
    }
},60000);roomCleanup.unref?.();

server.listen(PORT,HOST,()=>console.log(`Wintermaul v${RELEASE_VERSION} server (${PROTOCOL_ID}): http://localhost:${PORT}`));
function shutdown(){clearInterval(heartbeat);clearInterval(roomCleanup);disconnectTimers.forEach(timer=>clearTimeout(timer));wss.close(()=>server.close(()=>process.exit(0)));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
