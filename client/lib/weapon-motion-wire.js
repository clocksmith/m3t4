// Pure protocol state. Capabilities can change between matches, but every
// prepared match carries a copied version value for the whole simulation.
export function createWeaponMotionWire(){
  let peerVersion=0;
  return {
    get peerVersion(){return peerVersion;},
    receiveCosmetic(message){peerVersion=message?.weaponMotionVersion===2?2:message?.weaponMotionVersion===1?1:0;},
    cosmetic(fields){return {...fields,weaponMotionVersion:2};},
    match(fields,requested=peerVersion){return {...fields,weaponMotionVersion:Math.min(requested===2?2:requested===1?1:0,peerVersion)};},
  };
}
export function readWeaponMatch(message){
  const version=message?.weaponMotionVersion;
  if(version!==undefined&&version!==0&&version!==1&&version!==2)return null;
  return {...message,weaponMotionVersion:version===2?2:version===1?1:0};
}
