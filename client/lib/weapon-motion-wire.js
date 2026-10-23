// Pure protocol state. Capabilities can change between matches, but every
// prepared match carries a copied version value for the whole simulation.
export function createWeaponMotionWire(){
  let peerVersion=0;
  return {
    get peerVersion(){return peerVersion;},
    receiveCosmetic(message){peerVersion=message?.weaponMotionVersion===1?1:0;},
    cosmetic(fields){return {...fields,weaponMotionVersion:1};},
    match(fields,requested=peerVersion){return {...fields,weaponMotionVersion:requested===1&&peerVersion===1?1:0};},
  };
}
export function readWeaponMatch(message){
  const version=message?.weaponMotionVersion;
  if(version!==undefined&&version!==0&&version!==1)return null;
  return {...message,weaponMotionVersion:version===1?1:0};
}
