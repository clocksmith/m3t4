// A gesture belongs to one banner and pointer. Cancellation never dispatches.
export function bindNotificationGestures(root, {getNotification, getThresholds, resolve, dispatch}) {
  let drag=null, suppressClickUntil=0;
  const clear=()=>{drag=null;};
  root.addEventListener('pointerdown',e=>{
    if(e.isPrimary===false || e.button!==0)return;
    const banner=e.target.closest('[data-notification]'); if(!banner)return;
    const n=getNotification(banner.dataset.notification);if(!n)return;
    drag={id:e.pointerId,x:e.clientX,y:e.clientY,banner,n};
    // Capture on the actual target so an ordinary tap still reaches its button.
    e.target.setPointerCapture?.(e.pointerId);
  });
  const cancel=()=>{if(drag)suppressClickUntil=Date.now()+700;clear();};
  root.addEventListener('pointercancel',cancel);
  root.addEventListener('lostpointercapture',cancel);
  root.addEventListener('pointerup',e=>{
    if(!drag || drag.id!==e.pointerId)return;
    const start=drag;clear();
    const dx=e.clientX-start.x,dy=e.clientY-start.y,ax=Math.abs(dx),ay=Math.abs(dy);
    const {distancePx,axisRatio}=getThresholds(start.n);
    if(Math.max(ax,ay)<distancePx)return;
    suppressClickUntil=Date.now()+700;
    e.preventDefault();
    if(!start.banner.isConnected || !getNotification(start.n.id))return;
    const gesture=ax>=ay*axisRatio?(dx<0?'swipeLeft':'swipeRight'):ay>=ax*axisRatio?(dy<0?'swipeUp':'swipeDown'):null;
    const target=gesture&&resolve(start.n,gesture);if(target)dispatch(target);
  });
  root.addEventListener('click',e=>{
    if(e.detail!==0 && Date.now()<suppressClickUntil){e.preventDefault();e.stopImmediatePropagation();}
  },true);
}
