(function(){
    'use strict';

    const MAX_PLAYERS=9;
    const CONNECT_TIMEOUT_MS=6000;
    const PROTOCOL_VERSION='0.94.0';
    const MAX_CHAT_LENGTH=200;
    const SESSION_KEY='wintermaul:multiplayer-session';
    const sessionToken=(()=>{
        let value='';try{value=sessionStorage.getItem(SESSION_KEY)||'';}catch(error){}
        if(!/^[A-Za-z0-9-]{20,80}$/.test(value))value=crypto.randomUUID?.()||`session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        try{sessionStorage.setItem(SESSION_KEY,value);}catch(error){}
        return value;
    })();
    let socket=null;
    let connectPromise=null;
    let clientId=null;
    let roomCode=null;
    let room=null;
    let launchedMatch=false;
    let closingIntentionally=false;
    let gameReadyFlag=false;
    let pendingGameState=null;
    let lastGameRevision=0;
    let publishTimer=null;
    let checkpointTimer=null;
    let reconnectTimer=null;
    let reconnectAttempt=0;
    let reconnecting=false;
    let resumingMatch=false;
    let needsAuthorityRestore=false;
    let pendingCheckpoint=null;
    let pingTimer=null;
    let lastPingSent=0;
    let versionBlocked=false;

    function normalizeCode(value){return String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);}
    function playerName(){
        const input=document.getElementById('multiplayer-player-name');
        return String(input?.value||currentUsername||'Player').trim().slice(0,15)||'Player';
    }
    function serverUrl(){
        const configured=window.WINTERMAUL_MULTIPLAYER_URL?String(window.WINTERMAUL_MULTIPLAYER_URL):null;
        const base=configured||(location.protocol==='file:'?'ws://localhost:3000/ws':`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);
        const url=new URL(base);url.searchParams.set('session',sessionToken);url.searchParams.set('version',PROTOCOL_VERSION);return url.toString();
    }
    function setStatus(message,type=''){
        const status=document.getElementById('multiplayer-status');
        if(!status)return;
        status.textContent=message;
        status.className=`multiplayer-status ${type}`.trim();
    }
    function send(type,payload={}){
        if(!socket||socket.readyState!==WebSocket.OPEN){setStatus('The multiplayer server is not connected.','error');return false;}
        socket.send(JSON.stringify({type,...payload}));return true;
    }
    function ensureConnected(){
        if(versionBlocked)return Promise.reject(new Error('This game build is incompatible with the multiplayer server.'));
        if(socket?.readyState===WebSocket.OPEN)return Promise.resolve();
        if(connectPromise)return connectPromise;
        setStatus('Connecting to the multiplayer server...');
        connectPromise=new Promise((resolve,reject)=>{
            let settled=false;
            const candidate=new WebSocket(serverUrl());
            socket=candidate;
            const timeout=setTimeout(()=>{
                if(settled)return;
                settled=true;candidate.close();reject(new Error('Connection timed out.'));
            },CONNECT_TIMEOUT_MS);
            candidate.addEventListener('open',()=>{
                if(settled)return;
                settled=true;clearTimeout(timeout);reconnectAttempt=0;startLatencyChecks();setStatus('Connected. Host a match or enter a room code.','success');resolve();
            });
            candidate.addEventListener('message',event=>handleMessage(event.data));
            candidate.addEventListener('error',()=>{
                if(settled)return;
                settled=true;clearTimeout(timeout);reject(new Error('Unable to reach the multiplayer server.'));
            });
            candidate.addEventListener('close',()=>{
                clearTimeout(timeout);
                if(!settled){settled=true;reject(new Error('The multiplayer server closed the connection.'));}
                connectPromise=null;
                if(socket===candidate)socket=null;
                handleDisconnect();
            });
        }).catch(error=>{setStatus(`${error.message} Check the multiplayer server and try again.`,'error');throw error;})
          .finally(()=>{connectPromise=null;});
        return connectPromise;
    }
    function prepareMenu(){
        const name=document.getElementById('multiplayer-player-name');
        const code=document.getElementById('multiplayer-room-code-input');
        if(name)name.value=currentUsername||'Buhlistik';
        if(code)code.value='';
        ensureConnected().catch(()=>{});
    }
    function syncLocalGlobals(){
        const me=localPlayer();if(!me)return;
        currentUsername=me.name;playerRace=me.race;playerColor=me.color;
        const optionsName=document.getElementById('username-input');if(optionsName)optionsName.value=currentUsername;
        const multiplayerName=document.getElementById('multiplayer-player-name');if(multiplayerName)multiplayerName.value=currentUsername;
    }
    function enterLobby(){
        launchedMatch=false;
        const menu=document.getElementById('multiplayer-menu');if(menu)menu.style.display='none';
        if(document.getElementById('lobby-screen')?.style.display!=='block')openLobby();
        renderLobby();
    }
    async function hostRoom(){
        try{currentUsername=playerName();await ensureConnected();send('create_room',{name:currentUsername,race:playerRace,color:playerColor});}catch(error){}
    }
    async function joinRoom(){
        const input=document.getElementById('multiplayer-room-code-input');
        const code=normalizeCode(input?.value);if(input)input.value=code;
        if(code.length!==6){setStatus('Enter a six-character room code.','error');return;}
        try{currentUsername=playerName();await ensureConnected();send('join_room',{code,name:currentUsername,race:playerRace,color:playerColor});}catch(error){}
    }
    function isActive(){return Boolean(roomCode&&room);}
    function isHost(){return Boolean(room&&room.hostId===clientId);}
    function isGameActive(){return Boolean(isActive()&&launchedMatch);}
    function getClientId(){return clientId;}
    function getPlayers(){return room?.players?[...room.players]:[];}
    function localPlayer(){return room?.players?.find(player=>player.id===clientId)||null;}
    function updateProfile(changes){if(isActive())send('update_profile',{name:changes.name,race:changes.race,color:changes.color});}
    function toggleReady(){if(isActive())send('toggle_ready');}
    function sendChat(text){
        if(!isActive())return false;
        const value=String(text||'').trim().slice(0,MAX_CHAT_LENGTH);
        return Boolean(value&&send('chat',{text:value}));
    }
    function requestMatchStart(){return isActive()&&send('start_match');}
    function reportMatchEnd(outcome,wave){
        if(!isGameActive()||!isHost())return false;
        stopPublishing();gameReadyFlag=false;
        return send('end_match',{outcome:outcome==='victory'?'victory':'defeat',wave:Math.max(1,Number(wave)||1)});
    }
    function launchRoomMatch(){
        if(launchedMatch)return;
        launchedMatch=true;gameReadyFlag=false;pendingGameState=null;lastGameRevision=0;
        const ready=document.getElementById('lobby-ready-btn');if(ready)ready.disabled=true;
        const start=document.getElementById('lobby-start-game-btn');if(start){start.disabled=true;start.textContent='Starting...';}
        window.startGameFromMultiplayer?.();
    }
    function leaveRoom(announce=true){
        if(roomCode&&announce)send('leave_room');
        stopPublishing();stopReconnect();roomCode=null;room=null;launchedMatch=false;gameReadyFlag=false;pendingGameState=null;pendingCheckpoint=null;lastGameRevision=0;resumingMatch=false;
    }
    function requestGameCommand(command){
        if(!isGameActive()||!gameReadyFlag||reconnecting||room?.status==='paused')return false;
        if(isHost()){
            const me=localPlayer();
            const localCommand={...command,actorId:clientId,actorName:me?.name||currentUsername,actorRace:me?.race||playerRace,actorIsHost:true};
            const result=window.MultiplayerGame?.applyCommand?.(localCommand)||{success:false,message:'That action could not be completed.'};
            if(!result.success&&result.message)showToast(result.message);
            if(result.success)publishGameState(true);
            return Boolean(result.success);
        }
        return send('game_command',{command});
    }
    function publishGameState(force=false){
        if(!gameReadyFlag||!isHost()||!window.MultiplayerGame?.captureState)return false;
        if(!force&&socket?.bufferedAmount>128*1024)return false;
        const state=window.MultiplayerGame.captureState();
        return Boolean(state&&send('game_state',{state}));
    }
    function startPublishing(){
        stopPublishing();publishTimer=setInterval(()=>publishGameState(false),50);checkpointTimer=setInterval(publishCheckpoint,750);publishGameState(true);publishCheckpoint();
    }
    function publishCheckpoint(){
        if(!gameReadyFlag||!isHost()||!window.MultiplayerGame?.captureCheckpoint||socket?.readyState!==WebSocket.OPEN)return false;
        const checkpoint=window.MultiplayerGame.captureCheckpoint();return Boolean(checkpoint&&send('game_checkpoint',{checkpoint}));
    }
    function stopPublishing(){if(publishTimer){clearInterval(publishTimer);publishTimer=null;}if(checkpointTimer){clearInterval(checkpointTimer);checkpointTimer=null;}}
    function startLatencyChecks(){
        stopLatencyChecks();
        const ping=()=>{if(socket?.readyState===WebSocket.OPEN){lastPingSent=performance.now();send('latency_ping',{clientTime:Date.now()});}};
        ping();pingTimer=setInterval(ping,2500);
    }
    function stopLatencyChecks(){if(pingTimer){clearInterval(pingTimer);pingTimer=null;}}
    function updateNetworkRole(){
        if(!gameReadyFlag||!window.MultiplayerGame)return;
        window.MultiplayerGame.setNetworkRole(isHost()?'host':'guest');
        window.MultiplayerGame.syncPlayers?.(room?.players||[]);
        if(room?.status==='paused')window.MultiplayerGame.setPaused?.(true,'Match paused · Waiting for host');
        if(isHost()&&room?.status==='playing')startPublishing();else stopPublishing();
    }
    function gameReady(){
        if(!isGameActive())return;
        if(isHost()&&needsAuthorityRestore&&pendingCheckpoint)window.MultiplayerGame?.restoreAuthority?.(pendingCheckpoint);
        needsAuthorityRestore=false;pendingCheckpoint=null;gameReadyFlag=true;updateNetworkRole();send('game_ready');
        if(!isHost()&&pendingGameState){window.MultiplayerGame?.applyState?.(pendingGameState);pendingGameState=null;}
        resumingMatch=false;
    }
    function gameEnded(){stopPublishing();gameReadyFlag=false;pendingGameState=null;pendingCheckpoint=null;resumingMatch=false;}
    function stopReconnect(){if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}reconnecting=false;reconnectAttempt=0;}
    function scheduleReconnect(){
        if(closingIntentionally||versionBlocked||reconnectTimer||socket)return;
        reconnecting=true;const delay=Math.min(5000,500*(2**Math.min(reconnectAttempt++,4)));
        reconnectTimer=setTimeout(()=>{reconnectTimer=null;ensureConnected().catch(()=>scheduleReconnect());},delay);
    }
    function resumeFromServer(message){
        room=message.room;roomCode=room.code;lastGameRevision=Number(message.revision)||0;pendingGameState=message.state||null;pendingCheckpoint=message.checkpoint||message.state||null;
        reconnecting=false;syncLocalGlobals();
        if(!message.matchActive){launchedMatch=false;enterLobby();return;}
        launchedMatch=true;resumingMatch=true;
        const alreadyRunning=Boolean(window.MultiplayerGame?.isRunning?.());
        needsAuthorityRestore=isHost()&&!alreadyRunning;
        if(alreadyRunning){gameReadyFlag=true;updateNetworkRole();if(!isHost()&&pendingGameState)window.MultiplayerGame.applyState(pendingGameState);send('game_ready');resumingMatch=false;}
        else window.resumeGameFromMultiplayer?.();
    }
    function handleMessage(raw){
        let message;try{message=JSON.parse(raw);}catch(error){return;}
        if(message.type==='welcome'){clientId=message.clientId;return;}
        if(message.type==='latency_pong'){window.MultiplayerGame?.setLatency?.(performance.now()-lastPingSent);return;}
        if(message.type==='incompatible_version'){
            versionBlocked=true;closingIntentionally=true;stopReconnect();stopLatencyChecks();
            setStatus(message.message||'This game build does not match the multiplayer server.','error');showToast(message.message||'Multiplayer version mismatch.');return;
        }
        if(message.type==='resume_session'&&message.room){stopReconnect();resumeFromServer(message);return;}
        if(message.type==='session_status'&&!message.resumed){
            if(reconnecting&&isActive()){roomCode=null;room=null;launchedMatch=false;gameReadyFlag=false;window.MultiplayerGame?.setPaused?.(true,'Session expired');showToast('The reconnect window expired. Return to Multiplayer to join again.');}
            reconnecting=false;return;
        }
        if(message.type==='room_state'&&message.room){
            room=message.room;roomCode=message.room.code;syncLocalGlobals();
            if(launchedMatch)updateNetworkRole();else enterLobby();
            return;
        }
        if(message.type==='match_start'){if(message.roomCode===roomCode)launchRoomMatch();return;}
        if(message.type==='match_paused'&&message.roomCode===roomCode){
            if(room)room.status='paused';stopPublishing();window.MultiplayerGame?.setPaused?.(true,'Match paused · Reconnecting host');showToast(message.message||'Match paused while the host reconnects.');return;
        }
        if(message.type==='match_resumed'&&message.roomCode===roomCode){
            if(room)room.status='playing';window.MultiplayerGame?.setPaused?.(false);updateNetworkRole();showToast(message.message||'Match resumed.');return;
        }
        if(message.type==='game_state'&&message.roomCode===roomCode&&message.revision>lastGameRevision){
            lastGameRevision=message.revision;
            if(isHost())return;
            if(gameReadyFlag)window.MultiplayerGame?.applyState?.(message.state);else pendingGameState=message.state;
            return;
        }
        if(message.type==='game_command'&&isHost()&&gameReadyFlag){
            const result=window.MultiplayerGame?.applyCommand?.(message.command)||{success:false,message:'The host could not apply that action.'};
            send('game_command_result',{commandId:message.command?.commandId,actorId:message.command?.actorId,success:Boolean(result.success),message:result.message});
            publishGameState(true);return;
        }
        if(message.type==='game_command_result'){
            if(message.message&&(!message.success||message.actorId===clientId))showToast(message.message);
            return;
        }
        if(message.type==='match_ended'){
            stopPublishing();stopReconnect();roomCode=null;room=null;launchedMatch=false;gameReadyFlag=false;pendingGameState=null;pendingCheckpoint=null;lastGameRevision=0;resumingMatch=false;
            window.MultiplayerGame?.showMatchEnd?.(message.outcome,message.wave);
            return;
        }
        if(message.type==='room_closed'){
            stopPublishing();stopReconnect();roomCode=null;room=null;gameReadyFlag=false;pendingCheckpoint=null;
            const text=message.message||'The room was closed.';
            if(launchedMatch){showToast(text);const indicator=document.getElementById('network-game-status');if(indicator){indicator.className='visible error';indicator.textContent='Multiplayer connection ended';}}
            else{appendLobbySystemMessage(text);disableLobbyControls();}
            launchedMatch=false;return;
        }
        if(message.type==='error'){
            const text=message.message||'The multiplayer server rejected that request.';
            setStatus(text,'error');
            if(document.getElementById('lobby-screen')?.style.display==='block'){
                syncLocalGlobals();renderLobby();appendLobbySystemMessage(text);
            }
        }
    }
    function handleDisconnect(){
        const wasActive=isActive(),wasPlaying=launchedMatch;stopPublishing();stopLatencyChecks();gameReadyFlag=false;
        if(closingIntentionally)return;
        reconnecting=true;setStatus('Connection lost. Attempting to reconnect...','error');
        if(wasPlaying){showToast('Connection lost. Reconnecting...');window.MultiplayerGame?.setPaused?.(true,'Reconnecting to server');}
        else if(wasActive){appendLobbySystemMessage('Connection lost. Attempting to reconnect...');disableLobbyControls();}
        scheduleReconnect();
    }
    function disableLobbyControls(){
        const ready=document.getElementById('lobby-ready-btn');if(ready)ready.disabled=true;
        const start=document.getElementById('lobby-start-game-btn');if(start){start.disabled=true;start.textContent='Disconnected';}
    }
    function escapeHtml(value){return String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));}
    function raceOptions(selected,editable){
        const options=Object.entries(raceNames).map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''}>${label}</option>`).join('');
        return `<select class="slot-select race-select" ${editable?'onchange="selectRace(this.value)"':'disabled'}>${options}</select>`;
    }
    function colorControl(player,editable,usedColors){
        if(!editable)return `<div class="closed-color-swatch" aria-label="${escapeHtml(player.name)} color" style="background:${player.color};"></div>`;
        return `<div class="color-picker"><button type="button" class="color-select" aria-label="Choose player color" onclick="toggleColorPicker(event)" style="background:${player.color};"></button><div class="color-palette" role="listbox" aria-label="Player colors">${slotColors.map(color=>{const taken=color!==player.color&&usedColors.has(color);return `<button type="button" class="color-option ${color===player.color?'selected':''} ${taken?'taken':''}" aria-label="${taken?'Color already selected':`Select ${color}`}" ${taken?'disabled':''} onclick="choosePlayerColor('${color}',event)" style="background:${color};"></button>`;}).join('')}</div></div>`;
    }
    function renderChat(){
        const log=document.getElementById('chat-log');if(!log||!room)return;
        log.replaceChildren();
        (room.messages||[]).forEach(message=>{
            const line=document.createElement('div');line.className=message.kind==='player'?'player-msg':'system-msg';
            line.textContent=message.kind==='player'?`[${message.name}]: ${message.text}`:`[System]: ${message.text}`;log.appendChild(line);
        });
        log.scrollTop=log.scrollHeight;
    }
    function renderLobby(){
        if(!isActive())return;
        const grid=document.getElementById('slots-grid');if(!grid)return;
        const me=localPlayer(),players=room.players||[],usedColors=new Set(players.map(player=>player.color));
        const playersByColor=new Map(players.map(player=>[player.color,player]));
        let html='';
        slotColors.forEach(color=>{
            const player=playersByColor.get(color);
            if(player){
                const local=player.id===clientId;
                const connected=player.connected!==false,status=!connected?'Reconnecting':(player.ready?'Ready':(player.isHost?'Host':'Waiting'));
                html+=`<div class="slot-row ${local?'local-player':''} ${player.isHost?'host-player':''} ${connected?'':'closed'}"><div class="slot-name">${escapeHtml(player.name)}${local?' (You)':''}</div>${raceOptions(player.race,local&&connected&&room.status==='lobby')}<select class="slot-select" disabled><option>Team 1</option></select>${colorControl(player,local&&connected&&room.status==='lobby',usedColors)}<div class="ready-state ${player.ready&&connected?'ready':''} ${player.isHost?'host':''}">${status}</div></div>`;
            }else html+=`<div class="slot-row closed"><div class="slot-name">Open Slot</div><select class="slot-select" disabled><option>-</option></select><select class="slot-select" disabled><option>-</option></select><div class="closed-color-swatch" style="background:${color};"></div><div class="ready-state">Open</div></div>`;
        });
        grid.innerHTML=html;
        if(me){playerRace=me.race;playerColor=me.color;currentUsername=me.name;}
        ['lobby-room-row','lobby-player-count-row'].forEach(id=>{const element=document.getElementById(id);if(element)element.style.display='flex';});
        document.getElementById('lobby-room-code').textContent=room.code;
        document.getElementById('lobby-player-count').textContent=`${players.length} / ${MAX_PLAYERS}`;
        const readyButton=document.getElementById('lobby-ready-btn');readyButton.style.display=me?.isHost?'none':'block';readyButton.disabled=room.status!=='lobby';readyButton.textContent=me?.ready?'Unready':'Ready Up';
        const startButton=document.getElementById('lobby-start-game-btn'),allReady=players.some(player=>player.id===room.hostId&&player.ready&&player.connected!==false)&&players.filter(player=>player.id!==room.hostId).every(player=>player.ready&&player.connected!==false);
        startButton.style.display='block';
        if(room.status==='starting'){startButton.disabled=true;startButton.textContent='Starting...';}
        else if(me?.isHost){startButton.disabled=!allReady;startButton.textContent=allReady?'Start Match':'Waiting for Ready';}
        else{startButton.disabled=true;startButton.textContent='Waiting for Host';}
        renderChat();attachMenuSounds();
    }
    function init(){
        const codeInput=document.getElementById('multiplayer-room-code-input');
        codeInput?.addEventListener('input',()=>{codeInput.value=normalizeCode(codeInput.value);});
        codeInput?.addEventListener('keydown',event=>{if(event.key==='Enter')joinRoom();});
        window.addEventListener('beforeunload',()=>{closingIntentionally=true;stopPublishing();stopLatencyChecks();});
        ensureConnected().catch(()=>scheduleReconnect());
    }

    window.MultiplayerLobby={hostRoom,joinRoom,leaveRoom,isActive,isHost,isGameActive,getClientId,getPlayers,prepareMenu,renderLobby,updateProfile,toggleReady,sendChat,requestMatchStart,requestGameCommand,publishGameState,gameReady,gameEnded,reportMatchEnd};
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
