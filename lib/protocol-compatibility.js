'use strict';

function isCompatibleClient(multiplayer,requestedProtocolId,requestedReleaseVersion){
    if(requestedProtocolId!==undefined&&requestedProtocolId!==null)return requestedProtocolId===multiplayer.protocolId;
    return Array.isArray(multiplayer.compatibleLegacyReleaseVersions)&&multiplayer.compatibleLegacyReleaseVersions.includes(requestedReleaseVersion);
}

module.exports={isCompatibleClient};
